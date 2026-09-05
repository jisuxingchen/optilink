import './style.css';
import QRCode from 'qrcode';
import {BrowserQRCodeReader} from '@zxing/browser';

import {FountainDecoder, FountainEncoder, fountainSeedFromSession} from './fountain.ts';
import {
  createSessionId,
  deterministicBytes,
  encodeFountainDataFrame,
  encodeFountainManifest,
  parseFrame,
  sha256Hex,
  type FountainManifestFrame,
} from './protocol.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const PHYSICAL_DISPLAY_HZ = 60;
const TARGET_VISUAL_HZ = 24;
const PAYLOAD_BYTES = 1048576;
const BLOCK_SIZE = 300;
const QR_SIZE = 560;
const ECC = 'L' as const;
const TIMEOUT_MS = 8 * 60 * 1000;

const roleParam = new URLSearchParams(location.search).get('role');
const role = roleParam === 'sender' || roleParam === 'receiver' ? roleParam : 'both';

const roleTitle = $<HTMLElement>('roleTitle');
const roleText = $<HTMLElement>('roleText');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
const labStatus = $<HTMLPreElement>('labStatus');
const senderView = $<HTMLElement>('senderView');
const receiverView = $<HTMLElement>('receiverView');
const senderStatus = $<HTMLPreElement>('senderStatus');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const canvas = $<HTMLCanvasElement>('qrCanvas');
const video = $<HTMLVideoElement>('camera');

let socket: WebSocket | null = null;
let cameraControls: {stop: () => void} | undefined;
let senderRunning = false;
let senderTimer: number | undefined;
let senderStartedAt = 0;
let displayedFrames = 0;
let displayedSymbols = 0;
let aborted = false;
let latestTelemetry = emptyTelemetry();

let receiverManifest: FountainManifestFrame | null = null;
let receiverSessionId = '';
let receiverDecoder: FountainDecoder | null = null;
let receiverDecoded = 0;
let receiverInvalid = 0;
let receiverIgnoredBeforeManifest = 0;
let receiverFirstUsefulAt = 0;
let receiverComplete = false;
let receiverHashOk = false;
let receiverGoodput = 0;

let pendingReset: {id: string; resolve: () => void; reject: (error: Error) => void; timer: number} | null = null;

type Telemetry = {
  transport: 'fountain-lt';
  sessionId: string;
  unique: number;
  total: number;
  acceptedSymbols: number;
  duplicateSymbols: number;
  redundantSymbols: number;
  pendingEquations: number;
  decoded: number;
  duplicates: number;
  invalid: number;
  ignoredBeforeManifest: number;
  complete: boolean;
  hashOk: boolean;
  goodput: number;
  timestamp: number;
};

function emptyTelemetry(): Telemetry {
  return {
    transport: 'fountain-lt',
    sessionId: '',
    unique: 0,
    total: 0,
    acceptedSymbols: 0,
    duplicateSymbols: 0,
    redundantSymbols: 0,
    pendingEquations: 0,
    decoded: 0,
    duplicates: 0,
    invalid: 0,
    ignoredBeforeManifest: 0,
    complete: false,
    hashOk: false,
    goodput: 0,
    timestamp: performance.now(),
  };
}

function formatRate(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1000).toFixed(2)} KB/s · ${(bytesPerSecond / 1024).toFixed(2)} KiB/s`;
}

function log(message: string): void {
  const time = new Date().toLocaleTimeString();
  labStatus.textContent = `[${time}] ${message}\n${labStatus.textContent || ''}`.slice(0, 14000);
}

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function captureReceiverMetadata() {
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    language: navigator.language || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio: devicePixelRatio},
    capturedAt: new Date().toISOString(),
    source: 'receiver-page',
  };
}

function captureSenderMetadata() {
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio: devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_DISPLAY_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    capturedAt: new Date().toISOString(),
  };
}

function receiverTelemetry(): Telemetry {
  const decoder = receiverDecoder;
  return {
    transport: 'fountain-lt',
    sessionId: receiverSessionId,
    unique: decoder?.solvedCount ?? 0,
    total: receiverManifest?.sourceBlocks ?? 0,
    acceptedSymbols: decoder?.acceptedSymbols ?? 0,
    duplicateSymbols: decoder?.duplicateSymbols ?? 0,
    redundantSymbols: decoder?.redundantSymbols ?? 0,
    pendingEquations: decoder?.pendingEquationCount ?? 0,
    decoded: receiverDecoded,
    duplicates: decoder?.duplicateSymbols ?? 0,
    invalid: receiverInvalid,
    ignoredBeforeManifest: receiverIgnoredBeforeManifest,
    complete: receiverComplete,
    hashOk: receiverHashOk,
    goodput: receiverGoodput,
    timestamp: performance.now(),
  };
}

function publishReceiverStatus(extra?: string): void {
  const t = receiverTelemetry();
  const pct = t.total ? (100 * t.unique / t.total) : 0;
  receiverStatus.textContent = [
    `transport: Fountain / LT peeling`,
    `session: ${t.sessionId || '-'}`,
    `source blocks solved: ${t.unique}${t.total ? ` / ${t.total} (${pct.toFixed(2)}%)` : ''}`,
    `rateless symbols accepted: ${t.acceptedSymbols}`,
    `duplicate symbol decodes: ${t.duplicateSymbols}`,
    `redundant equations: ${t.redundantSymbols}`,
    `pending equations: ${t.pendingEquations}`,
    `decoded QR results: ${t.decoded}`,
    `invalid/foreign: ${t.invalid}`,
    `ignored before manifest: ${t.ignoredBeforeManifest}`,
    extra || '',
  ].filter(Boolean).join('\n');
  latestTelemetry = t;
  send({type: 'telemetry', telemetry: t});
}

function resetReceiver(): void {
  receiverManifest = null;
  receiverSessionId = '';
  receiverDecoder = null;
  receiverDecoded = 0;
  receiverInvalid = 0;
  receiverIgnoredBeforeManifest = 0;
  receiverFirstUsefulAt = 0;
  receiverComplete = false;
  receiverHashOk = false;
  receiverGoodput = 0;
  publishReceiverStatus('waiting for Fountain manifest');
}

async function finalizeReceiver(): Promise<void> {
  if (!receiverManifest || !receiverDecoder?.complete || receiverComplete) return;
  const reconstructed = receiverDecoder.reconstruct(receiverManifest.totalBytes);
  const hashStarted = performance.now();
  const actualHash = await sha256Hex(reconstructed);
  const finished = performance.now();
  const elapsed = Math.max(0.001, (finished - receiverFirstUsefulAt) / 1000);
  const ok = actualHash === receiverManifest.sha256;

  receiverComplete = true;
  receiverHashOk = ok;
  receiverGoodput = ok ? reconstructed.length / elapsed : 0;
  publishReceiverStatus([
    `COMPLETE: ${ok ? 'PASS' : 'HASH_MISMATCH'}`,
    `actual SHA-256: ${actualHash}`,
    `receiver elapsed: ${elapsed.toFixed(3)} s`,
    `receiver goodput: ${formatRate(receiverGoodput)}`,
    `hash verification: ${(finished - hashStarted).toFixed(1)} ms`,
  ].join('\n'));
}

async function handleDecodedText(text: string): Promise<void> {
  receiverDecoded += 1;
  const frame = parseFrame(text);
  if (!frame) {
    receiverInvalid += 1;
    publishReceiverStatus();
    return;
  }

  if (!receiverSessionId) {
    if (frame.kind !== 'fountain-manifest') {
      receiverIgnoredBeforeManifest += 1;
      publishReceiverStatus('waiting for Fountain manifest anchor');
      return;
    }
    receiverSessionId = frame.sessionId;
    receiverManifest = frame;
    receiverDecoder = new FountainDecoder(frame.sourceBlocks, frame.blockSize, frame.fountainSeed);
    publishReceiverStatus('Fountain manifest received; decoder initialized');
    return;
  }

  if (frame.sessionId !== receiverSessionId) {
    receiverInvalid += 1;
    publishReceiverStatus(`foreign session ignored: ${frame.sessionId}`);
    return;
  }

  if (frame.kind === 'fountain-manifest') {
    receiverManifest = frame;
    publishReceiverStatus('manifest refreshed');
    return;
  }

  if (frame.kind !== 'fountain' || !receiverDecoder || !receiverManifest) {
    receiverInvalid += 1;
    publishReceiverStatus('non-Fountain frame ignored');
    return;
  }
  if (frame.sourceBlocks !== receiverManifest.sourceBlocks) {
    receiverInvalid += 1;
    publishReceiverStatus('source-block count mismatch');
    return;
  }

  try {
    const result = receiverDecoder.addSymbol(frame.symbolId, frame.payload);
    if (result !== 'duplicate' && !receiverFirstUsefulAt) receiverFirstUsefulAt = performance.now();
  } catch (error) {
    receiverInvalid += 1;
    publishReceiverStatus(`decoder rejected symbol: ${String(error)}`);
    return;
  }

  publishReceiverStatus();
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
  publishReceiverStatus('camera running');
}

function stopCamera(): void {
  cameraControls?.stop();
  cameraControls = undefined;
  video.srcObject = null;
}

function clearCanvas(): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function stopSender(): void {
  senderRunning = false;
  if (senderTimer !== undefined) window.clearTimeout(senderTimer);
  senderTimer = undefined;
  clearCanvas();
}

async function waitForReceiverReset(): Promise<void> {
  const id = `freset-${createSessionId()}`;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingReset = null;
      reject(new Error('receiver reset acknowledgement timed out'));
    }, 5000);
    pendingReset = {id, resolve, reject, timer};
  });
  send({type: 'command', action: 'fountain-reset', resetId: id});
  await promise;
  await new Promise(resolve => window.setTimeout(resolve, 400));
}

async function startFountainSender(bytes: Uint8Array) {
  const sha256 = await sha256Hex(bytes);
  const sessionId = createSessionId();
  const seed = fountainSeedFromSession(sessionId);
  const encoder = new FountainEncoder(bytes, BLOCK_SIZE, seed);
  const manifest: FountainManifestFrame = {
    kind: 'fountain-manifest',
    sessionId,
    sourceBlocks: encoder.sourceCount,
    totalBytes: bytes.length,
    blockSize: BLOCK_SIZE,
    sha256,
    fileName: 'optilink-fountain-benchmark-1MiB.bin',
    fountainSeed: seed,
  };
  const manifestText = encodeFountainManifest(manifest);
  const manifestEvery = TARGET_VISUAL_HZ;
  let symbolId = 0;
  let nextDeadline = performance.now();

  senderRunning = true;
  senderStartedAt = performance.now();
  displayedFrames = 0;
  displayedSymbols = 0;

  const renderNext = async (): Promise<void> => {
    if (!senderRunning) return;
    const showManifest = displayedFrames % (manifestEvery + 1) === 0;
    let text = manifestText;
    if (!showManifest) {
      text = encodeFountainDataFrame({
        kind: 'fountain',
        sessionId,
        symbolId,
        sourceBlocks: encoder.sourceCount,
        payload: encoder.symbol(symbolId),
      });
      symbolId += 1;
      displayedSymbols += 1;
    }

    try {
      await QRCode.toCanvas(canvas, text, {width: QR_SIZE, margin: 2, errorCorrectionLevel: ECC, color: {dark: '#000000', light: '#ffffff'}});
    } catch (error) {
      senderRunning = false;
      senderStatus.textContent = `QR render error: ${String(error)}`;
      return;
    }

    displayedFrames += 1;
    const elapsed = Math.max(0.001, (performance.now() - senderStartedAt) / 1000);
    senderStatus.textContent = [
      `transport: Fountain / LT rateless`,
      `session: ${sessionId}`,
      `source: ${bytes.length.toLocaleString()} bytes · SHA-256 ${sha256}`,
      `source blocks: ${encoder.sourceCount} × ${BLOCK_SIZE} B`,
      `display: ${PHYSICAL_DISPLAY_HZ} Hz physical · ${TARGET_VISUAL_HZ} Hz optical target`,
      `actual rendered: ${(displayedFrames / elapsed).toFixed(2)} Hz`,
      `QR: ${QR_SIZE}px · ECC ${ECC}`,
      `displayed Fountain symbols: ${displayedSymbols}`,
      `receiver solved: ${latestTelemetry.unique}/${latestTelemetry.total || encoder.sourceCount}`,
      `receiver accepted symbols: ${latestTelemetry.acceptedSymbols}`,
      `receiver pending equations: ${latestTelemetry.pendingEquations}`,
    ].join('\n');

    nextDeadline += 1000 / TARGET_VISUAL_HZ;
    senderTimer = window.setTimeout(() => void renderNext(), Math.max(0, nextDeadline - performance.now()));
  };

  await renderNext();
  return {sessionId, seed, sourceBlocks: encoder.sourceCount, sha256};
}

async function runBenchmark(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  startButton.disabled = true;
  stopButton.disabled = false;
  latestTelemetry = emptyTelemetry();
  const bytes = deterministicBytes(PAYLOAD_BYTES, 0x4f505449);
  const senderMetadata = captureSenderMetadata();

  try {
    log('Fountain 1 MiB benchmark authorized. Carrier stays single black/white QR; only transport recovery changes.');
    await waitForReceiverReset();
    const session = await startFountainSender(bytes);
    const started = senderStartedAt;
    let lastLog = 0;

    while (!aborted && !latestTelemetry.complete && performance.now() - started < TIMEOUT_MS) {
      await new Promise(resolve => window.setTimeout(resolve, 250));
      const now = performance.now();
      if (now - lastLog > 10000) {
        lastLog = now;
        const pct = latestTelemetry.total ? (100 * latestTelemetry.unique / latestTelemetry.total) : 0;
        log(`progress ${latestTelemetry.unique}/${latestTelemetry.total || session.sourceBlocks} source blocks (${pct.toFixed(1)}%) · accepted symbols ${latestTelemetry.acceptedSymbols} · pending equations ${latestTelemetry.pendingEquations}`);
      }
    }

    const finished = performance.now();
    const telemetry = {...latestTelemetry};
    const elapsedSeconds = Math.max(0.001, (finished - started) / 1000);
    const status = aborted ? 'ABORTED' : telemetry.complete ? (telemetry.hashOk ? 'PASS' : 'HASH_MISMATCH') : 'TIMEOUT';
    const goodput = status === 'PASS' ? PAYLOAD_BYTES / elapsedSeconds : 0;
    const completionRatio = telemetry.total ? telemetry.unique / telemetry.total : telemetry.unique / session.sourceBlocks;
    const acceptedOverheadRatio = session.sourceBlocks ? telemetry.acceptedSymbols / session.sourceBlocks : 0;
    const displayAcceptanceRatio = displayedSymbols ? telemetry.acceptedSymbols / displayedSymbols : 0;

    stopSender();
    const run = {
      schema: 'optilink.tf002b.fountain.v1',
      kind: 'benchmark-1mib-fountain',
      evidenceClass: 'performance-experiment',
      status,
      startedBy: 'receiver-one-click',
      finishedAt: new Date().toISOString(),
      transport: {
        family: 'LT-style Fountain / rateless XOR',
        systematicFirst: true,
        degreeDistribution: 'robust-soliton-inspired; max degree 128',
        peelingDecoder: true,
        seed: `0x${session.seed.toString(16).padStart(8, '0')}`,
      },
      sender: senderMetadata,
      receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_DISPLAY_HZ, targetOpticalVisualUpdateHz: TARGET_VISUAL_HZ},
      payload: {kind: 'deterministic-incompressible', bytes: PAYLOAD_BYTES, seed: '0x4f505449', sha256: session.sha256},
      config: {blockSize: BLOCK_SIZE, qrSize: QR_SIZE, targetHz: TARGET_VISUAL_HZ, ecc: ECC, carrier: 'single-standard-qr'},
      timeoutSeconds: TIMEOUT_MS / 1000,
      result: {
        completionRatio,
        solvedSourceBlocks: telemetry.unique,
        totalSourceBlocks: telemetry.total || session.sourceBlocks,
        acceptedSymbols: telemetry.acceptedSymbols,
        displayedSymbols,
        duplicateSymbolDecodes: telemetry.duplicateSymbols,
        redundantSymbols: telemetry.redundantSymbols,
        pendingEquations: telemetry.pendingEquations,
        decodedQrResults: telemetry.decoded,
        invalid: telemetry.invalid,
        ignoredBeforeManifest: telemetry.ignoredBeforeManifest,
        acceptedSymbolOverheadRatio: acceptedOverheadRatio,
        distinctDisplayAcceptanceRatio: displayAcceptanceRatio,
        hashOk: telemetry.hashOk,
        receiverReportedGoodputBytesPerSecond: telemetry.goodput,
        senderObservedElapsedSeconds: elapsedSeconds,
        labEndToEndGoodputBytesPerSecond: goodput,
      },
      comparison: {cyclicBaseline: '1 MiB TIMEOUT at 92.02% after 480 s on same 60 Hz / 24 Hz / single-QR physical baseline'},
      controlPlane: 'WebSocket telemetry only; payload bytes remain optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'fountain-finished', status, result: run.result});
    log(status === 'PASS'
      ? `PASS · SHA-256 verified · ${elapsedSeconds.toFixed(2)} s · ${formatRate(goodput)} · accepted-symbol overhead ${(acceptedOverheadRatio * 100).toFixed(1)}% of source block count.`
      : `${status} · solved ${(completionRatio * 100).toFixed(2)}% · result saved.`);
  } catch (error) {
    stopSender();
    log(`Fountain benchmark failed: ${String(error)}`);
  } finally {
    startButton.disabled = role !== 'sender';
    stopButton.disabled = true;
  }
}

let latestReceiverMetadata: ReturnType<typeof captureReceiverMetadata> | null = null;

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/lab`);
  socket.addEventListener('open', () => {
    send({type: 'hello', role: `fountain-${role}`});
    log(`coordinator connected as fountain-${role}`);
  });
  socket.addEventListener('close', () => {
    log('coordinator disconnected; reconnecting…');
    window.setTimeout(connect, 1500);
  });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }

    if (message.type === 'telemetry' && role === 'sender' && message.telemetry?.transport === 'fountain-lt') {
      latestTelemetry = message.telemetry as Telemetry;
    }
    if (message.type === 'state' && message.event === 'fountain-receiver-ready' && role === 'sender') {
      latestReceiverMetadata = message.receiver || null;
      void runBenchmark();
    }
    if (message.type === 'command' && message.action === 'fountain-reset' && role === 'receiver') {
      resetReceiver();
      latestReceiverMetadata = captureReceiverMetadata();
      send({type: 'state', event: 'fountain-reset-complete', resetId: message.resetId, receiver: latestReceiverMetadata});
    }
    if (message.type === 'state' && message.event === 'fountain-reset-complete' && role === 'sender' && pendingReset?.id === message.resetId) {
      if (message.receiver) latestReceiverMetadata = message.receiver;
      window.clearTimeout(pendingReset.timer);
      const resolve = pendingReset.resolve;
      pendingReset = null;
      resolve();
    }
    if (message.type === 'command' && message.action === 'fountain-stop') {
      aborted = true;
      if (role === 'sender') stopSender();
    }
    if (message.type === 'command' && message.action === 'fountain-finished' && role === 'receiver') {
      stopCamera();
      startButton.disabled = false;
      stopButton.disabled = true;
      log(`Fountain benchmark finished: ${message.status}. Camera stopped automatically.`);
    }
    if (message.type === 'server' && message.event === 'result-saved') {
      log(`result saved${message.publish?.published ? ' and posted to GitHub' : ''}`);
    }
  });
}

async function receiverStart(): Promise<void> {
  resetReceiver();
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  startButton.disabled = true;
  stopButton.disabled = false;
  send({type: 'state', event: 'fountain-receiver-ready', receiver: latestReceiverMetadata});
  log('Camera started. Fountain benchmark authorized. Keep phone fixed; it will stop automatically.');
}

function userStop(): void {
  aborted = true;
  send({type: 'command', action: 'fountain-stop'});
  if (role === 'receiver') stopCamera();
  if (role === 'sender') stopSender();
  startButton.disabled = false;
  stopButton.disabled = true;
  log('stopped by user');
}

startButton.addEventListener('click', () => {
  if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`));
  else if (role === 'sender') void runBenchmark();
});
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  receiverView.hidden = true;
  roleTitle.textContent = 'Sender ready';
  roleText.textContent = '保持电脑页面打开。手机点击 Start 后自动开始 Fountain 1 MiB 测试。';
  startButton.hidden = true;
  stopButton.hidden = true;
} else if (role === 'receiver') {
  senderView.hidden = true;
  roleTitle.textContent = 'Receiver ready';
  roleText.textContent = '固定手机后只点一次 Start。程序自动完成或超时后停止摄像头。';
} else {
  roleTitle.textContent = 'Open role-specific URLs';
  roleText.textContent = '电脑使用 ?role=sender，手机使用 ?role=receiver。';
  startButton.disabled = true;
}

clearCanvas();
resetReceiver();
connect();
