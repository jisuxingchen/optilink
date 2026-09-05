import './style.css';
import QRCode from 'qrcode';
import {BrowserQRCodeReader} from '@zxing/browser';

import {
  assembleChunks,
  chunkBytes,
  createSessionId,
  deterministicBytes,
  encodeDataFrame,
  encodeManifest,
  parseFrame,
  sha256Hex,
  type ManifestFrame,
} from './protocol.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const fileInput = $<HTMLInputElement>('fileInput');
const payloadSize = $<HTMLSelectElement>('payloadSize');
const generateButton = $<HTMLButtonElement>('generateButton');
const chunkSizeInput = $<HTMLInputElement>('chunkSize');
const targetHzInput = $<HTMLInputElement>('targetHz');
const qrSizeInput = $<HTMLInputElement>('qrSize');
const eccInput = $<HTMLSelectElement>('ecc');
const startSenderButton = $<HTMLButtonElement>('startSender');
const stopSenderButton = $<HTMLButtonElement>('stopSender');
const senderStatus = $<HTMLPreElement>('senderStatus');
const canvas = $<HTMLCanvasElement>('qrCanvas');

const video = $<HTMLVideoElement>('camera');
const startCameraButton = $<HTMLButtonElement>('startCamera');
const stopCameraButton = $<HTMLButtonElement>('stopCamera');
const resetReceiverButton = $<HTMLButtonElement>('resetReceiver');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const downloadButton = $<HTMLButtonElement>('downloadReceived');

let sourceBytes: Uint8Array | null = null;
let sourceName = '';
let senderRunning = false;
let senderTimer: number | undefined;
let senderStartedAt = 0;
let senderRenderedFrames = 0;
let senderDataFrames = 0;

let cameraControls: {stop: () => void} | undefined;
let receivedManifest: ManifestFrame | null = null;
let receivedSessionId = '';
let receivedChunks = new Map<number, Uint8Array>();
let receiverFirstUsefulAt = 0;
let receiverDecoded = 0;
let receiverDuplicates = 0;
let receiverInvalid = 0;
let receiverLastBlob: Blob | null = null;
let receiverLastName = 'optilink-received.bin';

function numberValue(input: HTMLInputElement, min: number, max: number): number {
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new Error(`Invalid value for ${input.id}`);
  return Math.max(min, Math.min(max, value));
}

function formatRate(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1000).toFixed(1)} KB/s · ${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
}

async function selectedBytes(): Promise<{bytes: Uint8Array; name: string}> {
  const file = fileInput.files?.[0];
  if (file) return {bytes: new Uint8Array(await file.arrayBuffer()), name: file.name};
  if (sourceBytes) return {bytes: sourceBytes, name: sourceName};
  throw new Error('Select a file or generate a benchmark payload first.');
}

function setSenderStatus(lines: string[]): void {
  senderStatus.textContent = lines.join('\n');
}

function setReceiverStatus(extra?: string): void {
  const total = receivedManifest?.totalChunks ?? 0;
  const pct = total ? ((receivedChunks.size / total) * 100).toFixed(1) : '0.0';
  const lines = [
    `session: ${receivedSessionId || '-'}`,
    `unique chunks: ${receivedChunks.size}${total ? ` / ${total} (${pct}%)` : ''}`,
    `decoded QR results: ${receiverDecoded}`,
    `duplicates: ${receiverDuplicates}`,
    `invalid/foreign: ${receiverInvalid}`,
  ];
  if (receivedManifest) {
    lines.push(`file: ${receivedManifest.fileName}`);
    lines.push(`expected SHA-256: ${receivedManifest.sha256}`);
  }
  if (extra) lines.push(extra);
  receiverStatus.textContent = lines.join('\n');
}

function resetReceiverState(): void {
  receivedManifest = null;
  receivedSessionId = '';
  receivedChunks = new Map();
  receiverFirstUsefulAt = 0;
  receiverDecoded = 0;
  receiverDuplicates = 0;
  receiverInvalid = 0;
  receiverLastBlob = null;
  downloadButton.disabled = true;
  setReceiverStatus('waiting for optical frames');
}

async function finalizeReceiver(): Promise<void> {
  if (!receivedManifest || receivedChunks.size !== receivedManifest.totalChunks) return;
  const reconstructed = assembleChunks(receivedChunks, receivedManifest.totalChunks, receivedManifest.totalBytes);
  const hashStarted = performance.now();
  const actualHash = await sha256Hex(reconstructed);
  const finishedAt = performance.now();
  const elapsed = Math.max(0.001, (finishedAt - receiverFirstUsefulAt) / 1000);
  const goodput = reconstructed.length / elapsed;
  const hashMs = finishedAt - hashStarted;
  const ok = actualHash === receivedManifest.sha256;

  receiverLastBlob = new Blob([reconstructed], {type: 'application/octet-stream'});
  receiverLastName = receivedManifest.fileName || 'optilink-received.bin';
  downloadButton.disabled = !ok;
  setReceiverStatus([
    `COMPLETE: ${ok ? 'PASS' : 'HASH_MISMATCH'}`,
    `actual SHA-256: ${actualHash}`,
    `elapsed: ${elapsed.toFixed(3)} s`,
    `net goodput: ${formatRate(goodput)}`,
    `hash verification: ${hashMs.toFixed(1)} ms`,
  ].join('\n'));
}

async function handleDecodedText(text: string): Promise<void> {
  receiverDecoded += 1;
  const frame = parseFrame(text);
  if (!frame) {
    receiverInvalid += 1;
    setReceiverStatus();
    return;
  }

  if (receivedSessionId && frame.sessionId !== receivedSessionId) {
    receiverInvalid += 1;
    setReceiverStatus(`ignored foreign session ${frame.sessionId}`);
    return;
  }

  if (!receivedSessionId) receivedSessionId = frame.sessionId;

  if (frame.kind === 'manifest') {
    receivedManifest = frame;
    setReceiverStatus('manifest received');
    await finalizeReceiver();
    return;
  }

  if (!receiverFirstUsefulAt) receiverFirstUsefulAt = performance.now();
  if (receivedChunks.has(frame.index)) {
    receiverDuplicates += 1;
  } else {
    receivedChunks.set(frame.index, frame.payload);
  }
  setReceiverStatus();
  await finalizeReceiver();
}

async function startCamera(): Promise<void> {
  if (cameraControls) return;
  const reader = new BrowserQRCodeReader(undefined, {delayBetweenScanAttempts: 0, delayBetweenScanSuccess: 0});
  cameraControls = await reader.decodeFromConstraints(
    {audio: false, video: {facingMode: {ideal: 'environment'}}},
    video,
    (result) => {
      if (result) void handleDecodedText(result.getText());
    },
  );
  setReceiverStatus('camera running');
}

function stopCamera(): void {
  cameraControls?.stop();
  cameraControls = undefined;
  video.srcObject = null;
  setReceiverStatus('camera stopped');
}

async function startSender(): Promise<void> {
  if (senderRunning) return;
  const {bytes, name} = await selectedBytes();
  const chunkSize = Math.round(numberValue(chunkSizeInput, 64, 2100));
  const targetHz = numberValue(targetHzInput, 1, 120);
  const qrSize = Math.round(numberValue(qrSizeInput, 160, 1600));
  const ecc = eccInput.value as 'L' | 'M' | 'Q' | 'H';
  const chunks = chunkBytes(bytes, chunkSize);
  const sha256 = await sha256Hex(bytes);
  const sessionId = createSessionId();
  const manifest: ManifestFrame = {
    kind: 'manifest',
    sessionId,
    totalChunks: chunks.length,
    totalBytes: bytes.length,
    chunkSize,
    sha256,
    fileName: name,
  };
  const manifestText = encodeManifest(manifest);
  const manifestEvery = Math.max(8, Math.round(targetHz));
  let nextChunk = 0;
  let nextDeadline = performance.now();

  senderRunning = true;
  senderStartedAt = performance.now();
  senderRenderedFrames = 0;
  senderDataFrames = 0;
  startSenderButton.disabled = true;
  stopSenderButton.disabled = false;

  const renderNext = async (): Promise<void> => {
    if (!senderRunning) return;
    const shouldShowManifest = senderRenderedFrames % (manifestEvery + 1) === 0;
    let text = manifestText;
    if (!shouldShowManifest) {
      text = encodeDataFrame({
        kind: 'data',
        sessionId,
        index: nextChunk,
        totalChunks: chunks.length,
        payload: chunks[nextChunk],
      });
      nextChunk = (nextChunk + 1) % chunks.length;
      senderDataFrames += 1;
    }

    try {
      await QRCode.toCanvas(canvas, text, {
        width: qrSize,
        margin: 2,
        errorCorrectionLevel: ecc,
        color: {dark: '#000000', light: '#ffffff'},
      });
    } catch (error) {
      senderRunning = false;
      startSenderButton.disabled = false;
      stopSenderButton.disabled = true;
      setSenderStatus([`render error: ${String(error)}`, 'Try a smaller chunk size or lower QR ECC.']);
      return;
    }

    senderRenderedFrames += 1;
    const elapsed = Math.max(0.001, (performance.now() - senderStartedAt) / 1000);
    const actualVisualHz = senderRenderedFrames / elapsed;
    const theoreticalUseful = chunkSize * targetHz * (manifestEvery / (manifestEvery + 1));
    setSenderStatus([
      `session: ${sessionId}`,
      `file: ${name} · ${bytes.length.toLocaleString()} bytes`,
      `SHA-256: ${sha256}`,
      `chunks: ${chunks.length} · payload/chunk: ${chunkSize} bytes`,
      `target visual rate: ${targetHz.toFixed(2)} Hz`,
      `actual rendered rate: ${actualVisualHz.toFixed(2)} Hz`,
      `QR render size: ${qrSize}px · ECC ${ecc}`,
      `displayed frames: ${senderRenderedFrames} · data frames: ${senderDataFrames}`,
      `raw payload ceiling at target rate: ${formatRate(theoreticalUseful)}`,
      `note: receiver goodput is authoritative; this sender value excludes optical/decode loss.`,
    ]);

    nextDeadline += 1000 / targetHz;
    const delay = Math.max(0, nextDeadline - performance.now());
    senderTimer = window.setTimeout(() => void renderNext(), delay);
  };

  await renderNext();
}

function stopSender(): void {
  senderRunning = false;
  if (senderTimer !== undefined) window.clearTimeout(senderTimer);
  senderTimer = undefined;
  startSenderButton.disabled = false;
  stopSenderButton.disabled = true;
  senderStatus.textContent += '\nSTOPPED';
}

generateButton.addEventListener('click', () => {
  const size = Number(payloadSize.value);
  sourceBytes = deterministicBytes(size, 0x4f505449);
  sourceName = `optilink-benchmark-${Math.round(size / 1048576)}MiB.bin`;
  fileInput.value = '';
  setSenderStatus([
    `generated deterministic payload: ${sourceName}`,
    `${sourceBytes.length.toLocaleString()} bytes`,
    'seed: 0x4f505449',
  ]);
});

fileInput.addEventListener('change', () => {
  sourceBytes = null;
  sourceName = '';
  const file = fileInput.files?.[0];
  setSenderStatus(file ? [`selected: ${file.name}`, `${file.size.toLocaleString()} bytes`] : ['no file selected']);
});

startSenderButton.addEventListener('click', () => void startSender().catch(error => setSenderStatus([`sender error: ${String(error)}`])));
stopSenderButton.addEventListener('click', stopSender);
startCameraButton.addEventListener('click', () => void startCamera().catch(error => setReceiverStatus(`camera error: ${String(error)}`)));
stopCameraButton.addEventListener('click', stopCamera);
resetReceiverButton.addEventListener('click', resetReceiverState);
downloadButton.addEventListener('click', () => {
  if (!receiverLastBlob) return;
  const url = URL.createObjectURL(receiverLastBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = receiverLastName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

resetReceiverState();
setSenderStatus(['TF-002 ready', 'Generate a benchmark payload or select a file.']);
