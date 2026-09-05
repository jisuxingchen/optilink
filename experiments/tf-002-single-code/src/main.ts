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
const senderPanel = $<HTMLElement>('senderPanel');

const video = $<HTMLVideoElement>('camera');
const startCameraButton = $<HTMLButtonElement>('startCamera');
const stopCameraButton = $<HTMLButtonElement>('stopCamera');
const resetReceiverButton = $<HTMLButtonElement>('resetReceiver');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const downloadButton = $<HTMLButtonElement>('downloadReceived');
const receiverPanel = $<HTMLElement>('receiverPanel');

const labStartButton = $<HTMLButtonElement>('labStart');
const labStopButton = $<HTMLButtonElement>('labStop');
const labRoleText = $<HTMLElement>('labRoleText');
const labStatus = $<HTMLPreElement>('labStatus');
const labModeInput = $<HTMLSelectElement>('labMode');
const physicalDisplayHzInput = $<HTMLInputElement>('physicalDisplayHz');

const PERFORMANCE_DISPLAY_HZ = 60;
const STABILITY_BYTES = 1048576;
const STABILITY_TIMEOUT_MS = 8 * 60 * 1000;
const STABILITY_CONFIG: SweepConfig = {chunkSize: 300, targetHz: 24, qrSize: 560, ecc: 'L'};

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
let receiverIgnoredBeforeManifest = 0;
let receiverIgnoreUntil = 0;
let receiverLastBlob: Blob | null = null;
let receiverLastName = 'optilink-received.bin';
let receiverComplete = false;
let receiverGoodput = 0;
let receiverHashOk = false;

const roleParam = new URLSearchParams(location.search).get('role');
const role = roleParam === 'sender' || roleParam === 'receiver' ? roleParam : 'both';
let labSocket: WebSocket | null = null;
let latestTelemetry: Telemetry = emptyTelemetry();
let receiverMetadata: ReceiverMetadata | null = null;
let autoLabRunning = false;
let autoLabAbort = false;
const pendingReceiverResets = new Map<string, {resolve: () => void; reject: (error: Error) => void; timer: number}>();

type AutoLabMode = 'benchmark-1mib' | 'calibration';
type Ecc = 'L' | 'M' | 'Q' | 'H';

type Telemetry = {
  sessionId: string;
  unique: number;
  total: number;
  decoded: number;
  duplicates: number;
  invalid: number;
  ignoredBeforeManifest: number;
  complete: boolean;
  hashOk: boolean;
  goodput: number;
  timestamp: number;
};

type ReceiverMetadata = {
  configuredDevice: string;
  userAgent: string;
  platform: string;
  language: string;
  screen: {width: number; height: number; devicePixelRatio: number};
  capturedAt: string;
  source: 'receiver-page';
};

type SenderMetadata = {
  userAgent: string;
  screen: {width: number; height: number; devicePixelRatio: number};
  physicalDisplayRefreshHz: number;
  physicalDisplayRefreshSource: 'owner-configured';
  capturedAt: string;
};

type SweepConfig = {chunkSize: number; targetHz: number; qrSize: number; ecc: Ecc};
type SweepResult = {config: SweepConfig; metrics: {unique: number; decoded: number; duplicates: number; invalid: number; ignoredBeforeManifest: number; uniquePerSecond: number; decodedPerSecond: number; duplicateRatio: number; durationSeconds: number}};
type SenderSessionInfo = {sessionId: string; bytes: number; sha256: string; fileName: string; chunkCount: number; config: SweepConfig};

function emptyTelemetry(): Telemetry {
  return {sessionId: '', unique: 0, total: 0, decoded: 0, duplicates: 0, invalid: 0, ignoredBeforeManifest: 0, complete: false, hashOk: false, goodput: 0, timestamp: performance.now()};
}

function captureReceiverMetadata(): ReceiverMetadata {
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    language: navigator.language || 'unknown',
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
    },
    capturedAt: new Date().toISOString(),
    source: 'receiver-page',
  };
}

function captureSenderMetadata(): SenderMetadata {
  return {
    userAgent: navigator.userAgent,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
    },
    physicalDisplayRefreshHz: numberValue(physicalDisplayHzInput, 1, 360),
    physicalDisplayRefreshSource: 'owner-configured',
    capturedAt: new Date().toISOString(),
  };
}

function selectedAutoLabMode(): AutoLabMode {
  return labModeInput.value === 'calibration' ? 'calibration' : 'benchmark-1mib';
}

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

function telemetrySnapshot(): Telemetry {
  return {
    sessionId: receivedSessionId,
    unique: receivedChunks.size,
    total: receivedManifest?.totalChunks ?? 0,
    decoded: receiverDecoded,
    duplicates: receiverDuplicates,
    invalid: receiverInvalid,
    ignoredBeforeManifest: receiverIgnoredBeforeManifest,
    complete: receiverComplete,
    hashOk: receiverHashOk,
    goodput: receiverGoodput,
    timestamp: performance.now(),
  };
}

function publishTelemetry(): void {
  latestTelemetry = telemetrySnapshot();
  sendLab({type: 'telemetry', telemetry: latestTelemetry});
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
    `ignored before manifest: ${receiverIgnoredBeforeManifest}`,
  ];
  if (receivedManifest) {
    lines.push(`file: ${receivedManifest.fileName}`);
    lines.push(`expected SHA-256: ${receivedManifest.sha256}`);
  }
  if (extra) lines.push(extra);
  receiverStatus.textContent = lines.join('\n');
  publishTelemetry();
}

function resetReceiverState(ignoreForMs = 0): void {
  receivedManifest = null;
  receivedSessionId = '';
  receivedChunks = new Map();
  receiverFirstUsefulAt = 0;
  receiverDecoded = 0;
  receiverDuplicates = 0;
  receiverInvalid = 0;
  receiverIgnoredBeforeManifest = 0;
  receiverIgnoreUntil = performance.now() + ignoreForMs;
  receiverComplete = false;
  receiverGoodput = 0;
  receiverHashOk = false;
  receiverLastBlob = null;
  downloadButton.disabled = true;
  setReceiverStatus(ignoreForMs ? `reset complete; flushing camera for ${ignoreForMs} ms` : 'waiting for optical frames');
}

async function finalizeReceiver(): Promise<void> {
  if (!receivedManifest || receivedChunks.size !== receivedManifest.totalChunks || receiverComplete) return;
  const reconstructed = assembleChunks(receivedChunks, receivedManifest.totalChunks, receivedManifest.totalBytes);
  const hashStarted = performance.now();
  const actualHash = await sha256Hex(reconstructed);
  const finishedAt = performance.now();
  const elapsed = Math.max(0.001, (finishedAt - receiverFirstUsefulAt) / 1000);
  const goodput = reconstructed.length / elapsed;
  const hashMs = finishedAt - hashStarted;
  const ok = actualHash === receivedManifest.sha256;

  receiverComplete = true;
  receiverGoodput = goodput;
  receiverHashOk = ok;
  const blobBytes = new Uint8Array(reconstructed.length);
  blobBytes.set(reconstructed);
  receiverLastBlob = new Blob([blobBytes.buffer], {type: 'application/octet-stream'});
  receiverLastName = receivedManifest.fileName || 'optilink-received.bin';
  downloadButton.disabled = !ok;
  setReceiverStatus([
    `COMPLETE: ${ok ? 'PASS' : 'HASH_MISMATCH'}`,
    `actual SHA-256: ${actualHash}`,
    `receiver elapsed from first useful frame: ${elapsed.toFixed(3)} s`,
    `receiver-reported goodput: ${formatRate(goodput)}`,
    `hash verification: ${hashMs.toFixed(1)} ms`,
  ].join('\n'));
}

async function handleDecodedText(text: string): Promise<void> {
  if (performance.now() < receiverIgnoreUntil) return;

  receiverDecoded += 1;
  const frame = parseFrame(text);
  if (!frame) {
    receiverInvalid += 1;
    setReceiverStatus();
    return;
  }

  if (!receivedSessionId) {
    if (frame.kind !== 'manifest') {
      receiverIgnoredBeforeManifest += 1;
      setReceiverStatus('waiting for manifest anchor');
      return;
    }
    receivedSessionId = frame.sessionId;
    receivedManifest = frame;
    setReceiverStatus('manifest received; session anchored');
    await finalizeReceiver();
    return;
  }

  if (frame.sessionId !== receivedSessionId) {
    receiverInvalid += 1;
    setReceiverStatus(`ignored foreign session ${frame.sessionId}`);
    return;
  }

  if (frame.kind === 'manifest') {
    receivedManifest = frame;
    setReceiverStatus('manifest received');
    await finalizeReceiver();
    return;
  }

  if (!receiverFirstUsefulAt) receiverFirstUsefulAt = performance.now();
  if (receivedChunks.has(frame.index)) receiverDuplicates += 1;
  else receivedChunks.set(frame.index, frame.payload);
  setReceiverStatus();
  await finalizeReceiver();
}

async function startCamera(): Promise<void> {
  if (cameraControls) return;
  const reader = new BrowserQRCodeReader(undefined, {delayBetweenScanAttempts: 0, delayBetweenScanSuccess: 0});
  cameraControls = await reader.decodeFromConstraints(
    {audio: false, video: {facingMode: {ideal: 'environment'}}},
    video,
    result => { if (result) void handleDecodedText(result.getText()); },
  );
  setReceiverStatus('camera running');
}

function stopCamera(updateStatus = true): void {
  cameraControls?.stop();
  cameraControls = undefined;
  video.srcObject = null;
  if (updateStatus) setReceiverStatus('camera stopped');
}

async function startSender(): Promise<SenderSessionInfo | null> {
  if (senderRunning) return null;
  const {bytes, name} = await selectedBytes();
  const chunkSize = Math.round(numberValue(chunkSizeInput, 64, 2100));
  const targetHz = numberValue(targetHzInput, 1, 120);
  const qrSize = Math.round(numberValue(qrSizeInput, 160, 1600));
  const ecc = eccInput.value as Ecc;
  const chunks = chunkBytes(bytes, chunkSize);
  const sha256 = await sha256Hex(bytes);
  const sessionId = createSessionId();
  const manifest: ManifestFrame = {kind: 'manifest', sessionId, totalChunks: chunks.length, totalBytes: bytes.length, chunkSize, sha256, fileName: name};
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
      text = encodeDataFrame({kind: 'data', sessionId, index: nextChunk, totalChunks: chunks.length, payload: chunks[nextChunk]});
      nextChunk = (nextChunk + 1) % chunks.length;
      senderDataFrames += 1;
    }
    try {
      await QRCode.toCanvas(canvas, text, {width: qrSize, margin: 2, errorCorrectionLevel: ecc, color: {dark: '#000000', light: '#ffffff'}});
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
      `physical display refresh: ${numberValue(physicalDisplayHzInput, 1, 360)} Hz (owner-configured)`,
      `target visual rate: ${targetHz.toFixed(2)} Hz`,
      `actual rendered rate: ${actualVisualHz.toFixed(2)} Hz`,
      `QR render size: ${qrSize}px · ECC ${ecc}`,
      `displayed frames: ${senderRenderedFrames} · data frames: ${senderDataFrames}`,
      `raw payload ceiling at target rate: ${formatRate(theoreticalUseful)}`,
      'note: receiver/verified end-to-end metrics are authoritative; raw ceiling is diagnostic only.',
    ]);
    nextDeadline += 1000 / targetHz;
    senderTimer = window.setTimeout(() => void renderNext(), Math.max(0, nextDeadline - performance.now()));
  };
  await renderNext();
  return {sessionId, bytes: bytes.length, sha256, fileName: name, chunkCount: chunks.length, config: {chunkSize, targetHz, qrSize, ecc}};
}

function stopSender(): void {
  senderRunning = false;
  if (senderTimer !== undefined) window.clearTimeout(senderTimer);
  senderTimer = undefined;
  startSenderButton.disabled = false;
  stopSenderButton.disabled = true;
  if (!senderStatus.textContent?.endsWith('STOPPED')) senderStatus.textContent += '\nSTOPPED';
}

function clearSenderCanvas(): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.save();
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function blankSenderDisplay(): void {
  stopSender();
  clearSenderCanvas();
}

function generateSelectedPayload(): void {
  const size = Number(payloadSize.value);
  sourceBytes = deterministicBytes(size, 0x4f505449);
  const label = size < 1048576 ? `${Math.round(size / 1024)}KiB` : `${Math.round(size / 1048576)}MiB`;
  sourceName = `optilink-benchmark-${label}.bin`;
  fileInput.value = '';
  setSenderStatus([`generated deterministic payload: ${sourceName}`, `${sourceBytes.length.toLocaleString()} bytes`, 'seed: 0x4f505449']);
}

generateButton.addEventListener('click', generateSelectedPayload);
fileInput.addEventListener('change', () => {
  sourceBytes = null;
  sourceName = '';
  const file = fileInput.files?.[0];
  setSenderStatus(file ? [`selected: ${file.name}`, `${file.size.toLocaleString()} bytes`, 'manual file mode; not benchmark evidence unless explicitly classified'] : ['no file selected']);
});
startSenderButton.addEventListener('click', () => void startSender().catch(error => setSenderStatus([`sender error: ${String(error)}`])));
stopSenderButton.addEventListener('click', stopSender);
startCameraButton.addEventListener('click', () => void startCamera().catch(error => setReceiverStatus(`camera error: ${String(error)}`)));
stopCameraButton.addEventListener('click', () => stopCamera());
resetReceiverButton.addEventListener('click', () => resetReceiverState());
downloadButton.addEventListener('click', () => {
  if (!receiverLastBlob) return;
  const url = URL.createObjectURL(receiverLastBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = receiverLastName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function sendLab(message: unknown): void {
  if (labSocket?.readyState === WebSocket.OPEN) labSocket.send(JSON.stringify(message));
}

function logLab(message: string): void {
  const now = new Date().toLocaleTimeString();
  labStatus.textContent = `[${now}] ${message}\n${labStatus.textContent || ''}`.slice(0, 12000);
}

function applyConfig(config: SweepConfig): void {
  chunkSizeInput.value = String(config.chunkSize);
  targetHzInput.value = String(config.targetHz);
  qrSizeInput.value = String(config.qrSize);
  eccInput.value = config.ecc;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function waitForReceiverReset(resetId: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingReceiverResets.delete(resetId);
      reject(new Error(`receiver reset acknowledgement timed out: ${resetId}`));
    }, timeoutMs);
    pendingReceiverResets.set(resetId, {resolve, reject, timer});
  });
}

function acknowledgeReceiverReset(resetId: string): void {
  const pending = pendingReceiverResets.get(resetId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  pendingReceiverResets.delete(resetId);
  pending.resolve();
}

async function prepareReceiverForMeasurement(): Promise<void> {
  blankSenderDisplay();
  await sleep(450);
  latestTelemetry = emptyTelemetry();
  const resetId = `reset-${createSessionId()}`;
  const resetAck = waitForReceiverReset(resetId);
  sendLab({type: 'command', action: 'receiver-reset', resetId});
  await resetAck;
  latestTelemetry = emptyTelemetry();
  await sleep(400);
}

async function measureConfig(config: SweepConfig, seconds = 6): Promise<SweepResult> {
  applyConfig(config);
  payloadSize.value = '65536';
  generateSelectedPayload();
  await prepareReceiverForMeasurement();

  await startSender();
  const started = performance.now();
  while (!autoLabAbort && performance.now() - started < seconds * 1000) await sleep(250);
  const finished = performance.now();
  blankSenderDisplay();
  await sleep(250);

  const duration = Math.max(0.001, (finished - started) / 1000);
  const t = latestTelemetry;
  const result: SweepResult = {
    config,
    metrics: {
      unique: t.unique,
      decoded: t.decoded,
      duplicates: t.duplicates,
      invalid: t.invalid,
      ignoredBeforeManifest: t.ignoredBeforeManifest,
      uniquePerSecond: t.unique / duration,
      decodedPerSecond: t.decoded / duration,
      duplicateRatio: t.decoded ? t.duplicates / t.decoded : 0,
      durationSeconds: duration,
    },
  };
  logLab(`${config.chunkSize} B · ${config.qrSize}px · ${config.targetHz}Hz · ${config.ecc}: unique ${result.metrics.uniquePerSecond.toFixed(2)}/s, decoded ${result.metrics.decodedPerSecond.toFixed(2)}/s, invalid ${result.metrics.invalid}, pre-manifest ${result.metrics.ignoredBeforeManifest}, dup ${(result.metrics.duplicateRatio * 100).toFixed(0)}%`);
  return result;
}

async function runAutoSweep(): Promise<void> {
  if (autoLabRunning) return;
  autoLabRunning = true;
  autoLabAbort = false;
  labStopButton.disabled = false;
  labStartButton.disabled = true;
  const results: SweepResult[] = [];
  logLab('Engineering calibration started. These results are tuning evidence, not the post-60Hz performance baseline.');
  try {
    const densityConfigs: SweepConfig[] = [
      {chunkSize: 300, targetHz: 8, qrSize: 560, ecc: 'L'},
      {chunkSize: 600, targetHz: 8, qrSize: 640, ecc: 'L'},
      {chunkSize: 900, targetHz: 8, qrSize: 720, ecc: 'L'},
      {chunkSize: 1200, targetHz: 8, qrSize: 800, ecc: 'L'},
    ];
    for (const config of densityConfigs) {
      if (autoLabAbort) break;
      results.push(await measureConfig(config));
    }
    if (!results.length) return;
    const densityBest = [...results].sort((a, b) => b.metrics.uniquePerSecond - a.metrics.uniquePerSecond)[0];
    for (const targetHz of [6, 12, 18, 24]) {
      if (autoLabAbort) break;
      results.push(await measureConfig({...densityBest.config, targetHz}));
    }
    const best = [...results].sort((a, b) => (b.config.chunkSize * b.metrics.uniquePerSecond) - (a.config.chunkSize * a.metrics.uniquePerSecond))[0];
    const run = {
      schema: 'optilink.tf002.lab.v3',
      kind: 'calibration',
      evidenceClass: 'engineering-calibration',
      status: autoLabAbort ? 'ABORTED' : 'CALIBRATION_COMPLETE',
      startedBy: 'receiver-one-click',
      finishedAt: new Date().toISOString(),
      sender: captureSenderMetadata(),
      receiver: receiverMetadata,
      measurementSynchronization: {
        senderBlankBeforeResetMs: 450,
        receiverResetAck: true,
        receiverFlushWindowMs: 350,
        senderPostAckWaitMs: 400,
        sessionAnchor: 'manifest-first',
      },
      controlPlane: 'WebSocket telemetry only; payload bytes remain optical',
      results,
      best,
    };
    sendLab({type: 'lab-result', run});
    sendLab({type: 'command', action: 'lab-finished', mode: 'calibration', status: run.status, best});
    logLab(`Calibration finished. Best useful-byte candidate: ${best.config.chunkSize} B/frame, ${best.config.qrSize}px, ${best.config.targetHz} Hz, ECC ${best.config.ecc}.`);
  } catch (error) {
    logLab(`Calibration failed: ${String(error)}`);
  } finally {
    blankSenderDisplay();
    autoLabRunning = false;
    labStartButton.disabled = false;
    labStopButton.disabled = true;
  }
}

async function runOneMiBStabilityBenchmark(): Promise<void> {
  if (autoLabRunning) return;
  autoLabRunning = true;
  autoLabAbort = false;
  labStopButton.disabled = false;
  labStartButton.disabled = true;

  applyConfig(STABILITY_CONFIG);
  payloadSize.value = String(STABILITY_BYTES);
  generateSelectedPayload();

  try {
    const sender = captureSenderMetadata();
    if (sender.physicalDisplayRefreshHz !== PERFORMANCE_DISPLAY_HZ) {
      logLab(`Warning: physical display refresh is recorded as ${sender.physicalDisplayRefreshHz} Hz; current performance baseline is ${PERFORMANCE_DISPLAY_HZ} Hz.`);
    }
    logLab('1 MiB performance stability benchmark started. No file upload or Generate click is required.');
    logLab(`Environment: physical display ${sender.physicalDisplayRefreshHz} Hz; optical update ${STABILITY_CONFIG.targetHz} Hz; ${STABILITY_CONFIG.chunkSize} B/frame; ${STABILITY_CONFIG.qrSize}px; ECC ${STABILITY_CONFIG.ecc}.`);

    await prepareReceiverForMeasurement();
    const session = await startSender();
    if (!session) throw new Error('sender did not start');
    const measurementStartedAt = senderStartedAt;
    let lastProgressLog = 0;

    while (!autoLabAbort && !latestTelemetry.complete && performance.now() - measurementStartedAt < STABILITY_TIMEOUT_MS) {
      await sleep(250);
      const now = performance.now();
      if (now - lastProgressLog > 10000) {
        lastProgressLog = now;
        const t = latestTelemetry;
        const pct = t.total ? (100 * t.unique / t.total) : 0;
        logLab(`1 MiB progress: ${t.unique}/${t.total || session.chunkCount} unique (${pct.toFixed(1)}%), decoded ${t.decoded}, dup ${t.duplicates}.`);
      }
    }

    const measurementFinishedAt = performance.now();
    const telemetry = {...latestTelemetry};
    const elapsedSeconds = Math.max(0.001, (measurementFinishedAt - measurementStartedAt) / 1000);
    const completionRatio = telemetry.total ? telemetry.unique / telemetry.total : telemetry.unique / session.chunkCount;
    const status = autoLabAbort
      ? 'ABORTED'
      : telemetry.complete
        ? (telemetry.hashOk ? 'PASS' : 'HASH_MISMATCH')
        : 'TIMEOUT';
    const labEndToEndGoodput = status === 'PASS' ? STABILITY_BYTES / elapsedSeconds : 0;

    blankSenderDisplay();
    const run = {
      schema: 'optilink.tf002.stability.v1',
      kind: 'benchmark-1mib',
      evidenceClass: 'performance-baseline',
      status,
      startedBy: 'receiver-one-click',
      finishedAt: new Date().toISOString(),
      sender,
      receiver: receiverMetadata,
      displayBaseline: {
        physicalRefreshHz: sender.physicalDisplayRefreshHz,
        targetOpticalVisualUpdateHz: STABILITY_CONFIG.targetHz,
        note: 'Physical display refresh and OptiLink visual-code update rate are separate quantities.',
      },
      payload: {
        kind: 'deterministic-incompressible',
        bytes: STABILITY_BYTES,
        seed: '0x4f505449',
        sha256: session.sha256,
        fileName: session.fileName,
      },
      config: STABILITY_CONFIG,
      timeoutSeconds: STABILITY_TIMEOUT_MS / 1000,
      result: {
        completionRatio,
        uniqueChunks: telemetry.unique,
        totalChunks: telemetry.total || session.chunkCount,
        decoded: telemetry.decoded,
        duplicates: telemetry.duplicates,
        invalid: telemetry.invalid,
        ignoredBeforeManifest: telemetry.ignoredBeforeManifest,
        hashOk: telemetry.hashOk,
        receiverReportedGoodputBytesPerSecond: telemetry.goodput,
        senderObservedElapsedSeconds: elapsedSeconds,
        labEndToEndGoodputBytesPerSecond: labEndToEndGoodput,
      },
      measurementNote: 'labEndToEndGoodput uses sender start through receipt of receiver completion telemetry and is conservative because control-plane completion latency is included. Official offline acceptance remains separate.',
      controlPlane: 'WebSocket telemetry only; payload bytes remain optical',
    };

    sendLab({type: 'lab-result', run});
    sendLab({type: 'command', action: 'lab-finished', mode: 'benchmark-1mib', status, result: run.result});

    if (status === 'PASS') {
      logLab(`1 MiB PASS · SHA-256 verified · sender-observed ${elapsedSeconds.toFixed(2)} s · lab end-to-end ${formatRate(labEndToEndGoodput)}.`);
    } else {
      logLab(`1 MiB ${status} · completion ${(completionRatio * 100).toFixed(2)}% · ${telemetry.unique}/${telemetry.total || session.chunkCount} unique chunks · result saved.`);
    }
  } catch (error) {
    logLab(`1 MiB benchmark failed: ${String(error)}`);
  } finally {
    blankSenderDisplay();
    autoLabRunning = false;
    labStartButton.disabled = false;
    labStopButton.disabled = true;
  }
}

function runSelectedAutoLab(mode: AutoLabMode): void {
  if (mode === 'calibration') void runAutoSweep();
  else void runOneMiBStabilityBenchmark();
}

function connectLab(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  labSocket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  labSocket.addEventListener('open', () => {
    sendLab({type: 'hello', role});
    logLab(`Coordinator connected as ${role}.`);
  });
  labSocket.addEventListener('close', () => {
    logLab('Coordinator disconnected. Reconnecting…');
    window.setTimeout(connectLab, 1500);
  });
  labSocket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === 'telemetry' && role === 'sender') latestTelemetry = message.telemetry as Telemetry;
    if (message.type === 'state' && message.event === 'receiver-ready' && role === 'sender') {
      if (message.receiver) receiverMetadata = message.receiver as ReceiverMetadata;
      const mode: AutoLabMode = message.mode === 'calibration' ? 'calibration' : 'benchmark-1mib';
      labModeInput.value = mode;
      runSelectedAutoLab(mode);
    }
    if (message.type === 'state' && message.event === 'receiver-reset-complete' && role === 'sender') {
      if (message.receiver) receiverMetadata = message.receiver as ReceiverMetadata;
      acknowledgeReceiverReset(String(message.resetId || ''));
    }
    if (message.type === 'command' && message.action === 'receiver-reset' && role === 'receiver') {
      const resetId = String(message.resetId || '');
      resetReceiverState(350);
      const metadata = captureReceiverMetadata();
      receiverMetadata = metadata;
      sendLab({type: 'state', event: 'receiver-reset-complete', resetId, receiver: metadata});
    }
    if (message.type === 'command' && message.action === 'lab-stop') {
      autoLabAbort = true;
      if (role === 'sender') blankSenderDisplay();
    }
    if (message.type === 'command' && message.action === 'lab-finished' && role === 'receiver') {
      stopCamera(false);
      labStartButton.disabled = false;
      labStopButton.disabled = true;
      const label = message.mode === 'benchmark-1mib' ? '1 MiB benchmark' : 'calibration';
      logLab(`${label} finished: ${message.status || 'done'}. Camera stopped automatically; no Finish click is required.`);
    }
    if (message.type === 'server' && message.event === 'result-saved') logLab(`Result saved by coordinator${message.publish?.published ? ' and posted to GitHub issue #9' : ''}.`);
  });
}

async function startReceiverAutoLab(): Promise<void> {
  await startCamera();
  resetReceiverState();
  labStartButton.disabled = true;
  labStopButton.disabled = false;
  const metadata = captureReceiverMetadata();
  receiverMetadata = metadata;
  const mode = selectedAutoLabMode();
  sendLab({type: 'state', event: 'receiver-ready', receiver: metadata, mode});
  logLab(mode === 'benchmark-1mib'
    ? 'Camera started. One-click 1 MiB benchmark authorized; keep the phone fixed until automatic finish.'
    : 'Camera started. Engineering calibration authorized; keep the phone fixed until automatic finish.');
}

function stopAutoLab(): void {
  autoLabAbort = true;
  sendLab({type: 'command', action: 'lab-stop'});
  if (role === 'receiver') stopCamera();
  if (role === 'sender') blankSenderDisplay();
  labStartButton.disabled = false;
  labStopButton.disabled = true;
  logLab('Auto Lab stopped by user.');
}

labStartButton.addEventListener('click', () => {
  if (role === 'receiver') void startReceiverAutoLab().catch(error => logLab(`camera error: ${String(error)}`));
  else if (role === 'sender') runSelectedAutoLab(selectedAutoLabMode());
  else logLab('Open with ?role=sender on the computer and ?role=receiver on the phone for one-click Auto Lab.');
});
labStopButton.addEventListener('click', stopAutoLab);

if (role === 'receiver') {
  senderPanel.hidden = true;
  physicalDisplayHzInput.disabled = true;
  labRoleText.textContent = '手机模式：默认 Benchmark 会自动生成并传输 1 MiB；固定手机后只需 Start，结束后摄像头自动停止。';
  document.body.dataset.role = 'receiver';
} else if (role === 'sender') {
  receiverPanel.hidden = true;
  physicalDisplayHzInput.value = String(PERFORMANCE_DISPLAY_HZ);
  labRoleText.textContent = '电脑模式：当前性能基准显示器物理刷新率记录为 60 Hz。手机 Start 后自动运行，无需点击 Generate。';
  labStartButton.textContent = 'Run locally';
  document.body.dataset.role = 'sender';
} else {
  labRoleText.textContent = '手动双栏模式。低操作量测试请使用 ?role=sender / ?role=receiver。';
}

resetReceiverState();
setSenderStatus(['TF-002 ready', 'Auto Benchmark: phone Start generates 1 MiB automatically. Manual file/Generate controls are optional engineering tools.']);
connectLab();
