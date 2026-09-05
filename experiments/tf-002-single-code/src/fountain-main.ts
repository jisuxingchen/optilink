import './style.css';
import QRCode from 'qrcode';
import {BrowserQRCodeReader} from '@zxing/browser';

import {FountainDecoder, FountainEncoder, fountainSeedFromSession} from './fountain.ts';
import {
  createSessionId,
  deterministicBytes,
  encodeFountainDataFrame,
  encodeFountainManifest,
  parseFountainFrame,
  sha256Hex,
  type FountainManifestFrame,
} from './protocol.ts';

const PHYSICAL_HZ = 60;
const VISUAL_HZ = 24;
const PAYLOAD_BYTES = 1_048_576;
const BLOCK_SIZE = 300;
const QR_SIZE = 560;
const ECC = 'L' as const;
const TIMEOUT_MS = 8 * 60 * 1000;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const roleValue = new URLSearchParams(location.search).get('role');
const role: 'sender' | 'receiver' | 'both' = roleValue === 'sender' || roleValue === 'receiver' ? roleValue : 'both';

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

type ReceiverMeta = ReturnType<typeof captureReceiverMetadata>;
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

type PendingReset = {
  id: string;
  timer: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

let socket: WebSocket | null = null;
let cameraControls: {stop: () => void} | undefined;
let senderRunning = false;
let senderTimer: number | undefined;
let senderStartedAt = 0;
let displayedFrames = 0;
let displayedSymbols = 0;
let aborted = false;
let pendingReset: PendingReset | null = null;
let latestReceiverMetadata: ReceiverMeta | null = null;
let latestTelemetry = emptyTelemetry();

let manifest: FountainManifestFrame | null = null;
let decoder: FountainDecoder | null = null;
let receiverSessionId = '';
let receiverDecoded = 0;
let receiverInvalid = 0;
let receiverIgnoredBeforeManifest = 0;
let receiverFirstUsefulAt = 0;
let receiverComplete = false;
let receiverHashOk = false;
let receiverGoodput = 0;

function emptyTelemetry(): Telemetry {
  return {
    transport: 'fountain-lt', sessionId: '', unique: 0, total: 0,
    acceptedSymbols: 0, duplicateSymbols: 0, redundantSymbols: 0, pendingEquations: 0,
    decoded: 0, duplicates: 0, invalid: 0, ignoredBeforeManifest: 0,
    complete: false, hashOk: false, goodput: 0, timestamp: performance.now(),
  };
}

function formatRate(value: number): string {
  return `${(value / 1000).toFixed(2)} KB/s · ${(value / 1024).toFixed(2)} KiB/s`;
}

function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 14000);
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
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    capturedAt: new Date().toISOString(),
    source: 'receiver-page' as const,
  };
}

function captureSenderMetadata() {
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    capturedAt: new Date().toISOString(),
  };
}

function snapshot(): Telemetry {
  return {
    transport: 'fountain-lt',
    sessionId: receiverSessionId,
    unique: decoder?.solvedCount ?? 0,
    total: manifest?.sourceBlocks ?? 0,
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

function publishStatus(extra = ''): void {
  const t = snapshot();
  const pct = t.total ? 100 * t.unique / t.total : 0;
  receiverStatus.textContent = [
    'transport: Fountain / LT peeling',
    `session: ${t.sessionId || '-'}`,
    `source blocks solved: ${t.unique}${t.total ? ` / ${t.total} (${pct.toFixed(2)}%)` : ''}`,
    `rateless symbols accepted: ${t.acceptedSymbols}`,
    `duplicate symbol decodes: ${t.duplicateSymbols}`,
    `redundant equations: ${t.redundantSymbols}`,
    `pending equations: ${t.pendingEquations}`,
    `decoded QR results: ${t.decoded}`,
    `invalid/foreign: ${t.invalid}`,
    `ignored before manifest: ${t.ignoredBeforeManifest}`,
    extra,
  ].filter(Boolean).join('\n');
  latestTelemetry = t;
  send({type: 'telemetry', telemetry: t});
}

function resetReceiver(): void {
  manifest = null;
  decoder = null;
  receiverSessionId = '';
  receiverDecoded = 0;
  receiverInvalid = 0;
  receiverIgnoredBeforeManifest = 0;
  receiverFirstUsefulAt = 0;
  receiverComplete = false;
  receiverHashOk = false;
  receiverGoodput = 0;
  publishStatus('waiting for Fountain manifest');
}

async function finalizeReceiver(): Promise<void> {
  if (!manifest || !decoder?.complete || receiverComplete) return;
  const reconstructed = decoder.reconstruct(manifest.totalBytes);
  const hashStarted = performance.now();
  const actualHash = await sha256Hex(reconstructed);
  const finished = performance.now();
  const elapsed = Math.max(0.001, (finished - receiverFirstUsefulAt) / 1000);
  receiverComplete = true;
  receiverHashOk = actualHash === manifest.sha256;
  receiverGoodput = receiverHashOk ? reconstructed.length / elapsed : 0;
  publishStatus([
    `COMPLETE: ${receiverHashOk ? 'PASS' : 'HASH_MISMATCH'}`,
    `actual SHA-256: ${actualHash}`,
    `receiver elapsed: ${elapsed.toFixed(3)} s`,
    `receiver goodput: ${formatRate(receiverGoodput)}`,
    `hash verification: ${(finished - hashStarted).toFixed(1)} ms`,
  ].join('\n'));
}

async function handleDecoded(text: string): Promise<void> {
  receiverDecoded += 1;
  const frame = parseFountainFrame(text);
  if (!frame) {
    receiverInvalid += 1;
    publishStatus();
    return;
  }

  if (!receiverSessionId) {
    if (frame.kind !== 'fountain-manifest') {
      receiverIgnoredBeforeManifest += 1;
      publishStatus('waiting for Fountain manifest anchor');
      return;
    }
    receiverSessionId = frame.sessionId;
    manifest = frame;
    decoder = new FountainDecoder(frame.sourceBlocks, frame.blockSize, frame.fountainSeed);
    publishStatus('Fountain manifest received; decoder initialized');
    return;
  }

  if (frame.sessionId !== receiverSessionId) {
    receiverInvalid += 1;
    publishStatus(`foreign session ignored: ${frame.sessionId}`);
    return;
  }

  if (frame.kind === 'fountain-manifest') {
    manifest = frame;
    publishStatus('manifest refreshed');
    return;
  }

  const currentDecoder = decoder;
  const currentManifest = manifest;
  if (!currentDecoder || !currentManifest || frame.sourceBlocks !== currentManifest.sourceBlocks) {
    receiverInvalid += 1;
    publishStatus('Fountain symbol metadata mismatch');
    return;
  }

  try {
    const result = currentDecoder.addSymbol(frame.symbolId, frame.payload);
    if (result !== 'duplicate' && !receiverFirstUsefulAt) receiverFirstUsefulAt = performance.now();
  } catch (error) {
    receiverInvalid += 1;
    publishStatus(`decoder rejected symbol: ${String(error)}`);
    return;
  }
  publishStatus();
  await finalizeReceiver();
}

async function startCamera(): Promise<void> {
  if (cameraControls) return;
  const reader = new BrowserQRCodeReader(undefined, {delayBetweenScanAttempts: 0, delayBetweenScanSuccess: 0});
  cameraControls = await reader.decodeFromConstraints(
    {audio: false, video: {facingMode: {ideal: 'environment'}}},
    video,
    result => { if (result) void handleDecoded(result.getText()); },
  );
  publishStatus('camera running');
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
  if (senderTimer !== undefined) clearTimeout(senderTimer);
  senderTimer = undefined;
  clearCanvas();
}

async function resetReceiverFromSender(): Promise<void> {
  const id = `freset-${createSessionId()}`;
  const ack = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingReset?.id === id) pendingReset = null;
      reject(new Error('receiver reset acknowledgement timed out'));
    }, 5000);
    pendingReset = {id, timer, resolve, reject};
  });
  send({type: 'command', action: 'fountain-reset', resetId: id});
  await ack;
  await new Promise(resolve => setTimeout(resolve, 400));
}

async function startFountainSender(bytes: Uint8Array) {
  const sha256 = await sha256Hex(bytes);
  const sessionId = createSessionId();
  const seed = fountainSeedFromSession(sessionId);
  const encoder = new FountainEncoder(bytes, BLOCK_SIZE, seed);
  const fountainManifest: FountainManifestFrame = {
    kind: 'fountain-manifest', sessionId, sourceBlocks: encoder.sourceCount,
    totalBytes: bytes.length, blockSize: BLOCK_SIZE, sha256,
    fileName: 'optilink-fountain-benchmark-1MiB.bin', fountainSeed: seed,
  };
  const manifestText = encodeFountainManifest(fountainManifest);
  let symbolId = 0;
  let nextDeadline = performance.now();
  senderRunning = true;
  senderStartedAt = performance.now();
  displayedFrames = 0;
  displayedSymbols = 0;

  const render = async (): Promise<void> => {
    if (!senderRunning) return;
    const showManifest = displayedFrames % (VISUAL_HZ + 1) === 0;
    const text = showManifest
      ? manifestText
      : encodeFountainDataFrame({kind: 'fountain', sessionId, symbolId, sourceBlocks: encoder.sourceCount, payload: encoder.symbol(symbolId)});
    if (!showManifest) {
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
      'transport: Fountain / LT rateless',
      `session: ${sessionId}`,
      `source: ${bytes.length.toLocaleString()} bytes · SHA-256 ${sha256}`,
      `source blocks: ${encoder.sourceCount} × ${BLOCK_SIZE} B`,
      `display: ${PHYSICAL_HZ} Hz physical · ${VISUAL_HZ} Hz optical target`,
      `actual rendered: ${(displayedFrames / elapsed).toFixed(2)} Hz`,
      `QR: ${QR_SIZE}px · ECC ${ECC}`,
      `displayed Fountain symbols: ${displayedSymbols}`,
      `receiver solved: ${latestTelemetry.unique}/${latestTelemetry.total || encoder.sourceCount}`,
      `receiver accepted symbols: ${latestTelemetry.acceptedSymbols}`,
      `receiver pending equations: ${latestTelemetry.pendingEquations}`,
    ].join('\n');
    nextDeadline += 1000 / VISUAL_HZ;
    senderTimer = window.setTimeout(() => void render(), Math.max(0, nextDeadline - performance.now()));
  };

  await render();
  return {seed, sourceBlocks: encoder.sourceCount, sha256};
}

async function runBenchmark(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  latestTelemetry = emptyTelemetry();
  const source = deterministicBytes(PAYLOAD_BYTES, 0x4f505449);
  const senderMetadata = captureSenderMetadata();
  try {
    log('Fountain 1 MiB benchmark: same single black/white QR carrier; transport recovery only changes.');
    await resetReceiverFromSender();
    const session = await startFountainSender(source);
    const started = senderStartedAt;
    let lastProgress = 0;
    while (!aborted && !latestTelemetry.complete && performance.now() - started < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (performance.now() - lastProgress > 10_000) {
        lastProgress = performance.now();
        const pct = latestTelemetry.total ? 100 * latestTelemetry.unique / latestTelemetry.total : 0;
        log(`progress ${latestTelemetry.unique}/${latestTelemetry.total || session.sourceBlocks} (${pct.toFixed(1)}%) · accepted ${latestTelemetry.acceptedSymbols} · equations ${latestTelemetry.pendingEquations}`);
      }
    }

    const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
    const t = {...latestTelemetry};
    const status = aborted ? 'ABORTED' : t.complete ? (t.hashOk ? 'PASS' : 'HASH_MISMATCH') : 'TIMEOUT';
    const completionRatio = t.total ? t.unique / t.total : t.unique / session.sourceBlocks;
    const goodput = status === 'PASS' ? PAYLOAD_BYTES / elapsed : 0;
    const result = {
      completionRatio,
      solvedSourceBlocks: t.unique,
      totalSourceBlocks: t.total || session.sourceBlocks,
      acceptedSymbols: t.acceptedSymbols,
      displayedSymbols,
      duplicateSymbolDecodes: t.duplicateSymbols,
      redundantSymbols: t.redundantSymbols,
      pendingEquations: t.pendingEquations,
      decodedQrResults: t.decoded,
      invalid: t.invalid,
      ignoredBeforeManifest: t.ignoredBeforeManifest,
      acceptedSymbolOverheadRatio: session.sourceBlocks ? t.acceptedSymbols / session.sourceBlocks : 0,
      distinctDisplayAcceptanceRatio: displayedSymbols ? t.acceptedSymbols / displayedSymbols : 0,
      hashOk: t.hashOk,
      receiverReportedGoodputBytesPerSecond: t.goodput,
      senderObservedElapsedSeconds: elapsed,
      labEndToEndGoodputBytesPerSecond: goodput,
    };
    stopSender();
    send({
      type: 'lab-result',
      run: {
        schema: 'optilink.tf002b.fountain.v1', kind: 'benchmark-1mib-fountain', evidenceClass: 'performance-experiment',
        status, startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(),
        transport: {family: 'LT-style Fountain / rateless XOR', systematicFirst: true, degreeDistribution: 'robust-soliton-inspired; max degree 128', peelingDecoder: true, seed: `0x${session.seed.toString(16).padStart(8, '0')}`},
        sender: senderMetadata, receiver: latestReceiverMetadata,
        displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, targetOpticalVisualUpdateHz: VISUAL_HZ},
        payload: {kind: 'deterministic-incompressible', bytes: PAYLOAD_BYTES, seed: '0x4f505449', sha256: session.sha256},
        config: {blockSize: BLOCK_SIZE, qrSize: QR_SIZE, targetHz: VISUAL_HZ, ecc: ECC, carrier: 'single-standard-qr'},
        timeoutSeconds: TIMEOUT_MS / 1000,
        result,
        comparison: {cyclicBaseline: '1 MiB TIMEOUT at 92.02% after 480 s on same 60 Hz / 24 Hz / single-QR baseline'},
        controlPlane: 'WebSocket telemetry only; payload bytes remain optical',
      },
    });
    send({type: 'command', action: 'fountain-finished', status, result});
    log(status === 'PASS'
      ? `PASS · SHA-256 verified · ${elapsed.toFixed(2)} s · ${formatRate(goodput)}.`
      : `${status} · solved ${(completionRatio * 100).toFixed(2)}% · result saved.`);
  } catch (error) {
    stopSender();
    log(`Fountain benchmark failed: ${String(error)}`);
  }
}

function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => {
    send({type: 'hello', role: `fountain-${role}`});
    log(`coordinator connected as fountain-${role}`);
  });
  socket.addEventListener('close', () => {
    log('coordinator disconnected; reconnecting…');
    setTimeout(connect, 1500);
  });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }

    if (role === 'sender' && message.type === 'telemetry' && message.telemetry?.transport === 'fountain-lt') {
      latestTelemetry = message.telemetry as Telemetry;
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'fountain-receiver-ready') {
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      void runBenchmark();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'fountain-reset') {
      resetReceiver();
      latestReceiverMetadata = captureReceiverMetadata();
      send({type: 'state', event: 'fountain-reset-complete', resetId: message.resetId, receiver: latestReceiverMetadata});
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'fountain-reset-complete') {
      const reset = pendingReset;
      if (!reset || reset.id !== String(message.resetId || '')) return;
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      clearTimeout(reset.timer);
      pendingReset = null;
      reset.resolve();
      return;
    }
    if (message.type === 'command' && message.action === 'fountain-stop') {
      aborted = true;
      if (role === 'sender') stopSender();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'fountain-finished') {
      stopCamera();
      startButton.disabled = false;
      stopButton.disabled = true;
      log(`Fountain benchmark finished: ${message.status}. Camera stopped automatically.`);
      return;
    }
    if (message.type === 'server' && message.event === 'result-saved') {
      log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
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
  log('Camera started. Keep phone fixed; benchmark will finish or timeout automatically.');
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
  roleText.textContent = '固定手机后只点一次 Start；完成或超时后摄像头自动停止。';
} else {
  roleTitle.textContent = 'Open role-specific URLs';
  roleText.textContent = '电脑使用 ?role=sender，手机使用 ?role=receiver。';
  startButton.disabled = true;
}

clearCanvas();
resetReceiver();
connect();