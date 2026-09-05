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
const REGION_COUNT = 4;
const PAYLOAD_BYTES = 1_048_576;
const BLOCK_SIZE = 300;
const QR_SIZE = 480;
const ECC = 'L' as const;
const TIMEOUT_MS = 6 * 60 * 1000;
const ROI_FILL = 0.94;
const CROP_OUTPUT = 520;

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
const video = $<HTMLVideoElement>('camera');
const qrCanvases = [0, 1, 2, 3].map(index => $<HTMLCanvasElement>(`qr${index}`));

const cropCanvases = Array.from({length: REGION_COUNT}, () => {
  const canvas = document.createElement('canvas');
  canvas.width = CROP_OUTPUT;
  canvas.height = CROP_OUTPUT;
  return canvas;
});
const cropReader = new BrowserQRCodeReader();

type ReceiverMeta = ReturnType<typeof captureReceiverMetadata>;
type RegionMetric = {attempts: number; decoded: number; accepted: number; duplicate: number; redundant: number};
type Telemetry = {
  transport: 'fountain-lt-4qr';
  sessionId: string;
  unique: number;
  total: number;
  acceptedSymbols: number;
  duplicateSymbols: number;
  redundantSymbols: number;
  pendingEquations: number;
  decoded: number;
  invalid: number;
  ignoredBeforeManifest: number;
  scanRounds: number;
  scanRoundsPerSecond: number;
  regions: RegionMetric[];
  complete: boolean;
  hashOk: boolean;
  goodput: number;
  timestamp: number;
};

type PendingReset = {id: string; timer: number; resolve: () => void; reject: (error: Error) => void};

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let scanActive = false;
let scanStartedAt = 0;
let scanRounds = 0;
let receiverFlushUntil = 0;
let lastTelemetrySentAt = 0;

let senderRunning = false;
let senderTimer: number | undefined;
let senderStartedAt = 0;
let displayedVisualFrames = 0;
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
let receiverFinalizing = false;
let receiverHashOk = false;
let receiverGoodput = 0;
let regionMetrics = freshRegionMetrics();

function freshRegionMetrics(): RegionMetric[] {
  return Array.from({length: REGION_COUNT}, () => ({attempts: 0, decoded: 0, accepted: 0, duplicate: 0, redundant: 0}));
}

function emptyTelemetry(): Telemetry {
  return {
    transport: 'fountain-lt-4qr', sessionId: '', unique: 0, total: 0,
    acceptedSymbols: 0, duplicateSymbols: 0, redundantSymbols: 0, pendingEquations: 0,
    decoded: 0, invalid: 0, ignoredBeforeManifest: 0,
    scanRounds: 0, scanRoundsPerSecond: 0, regions: freshRegionMetrics(),
    complete: false, hashOk: false, goodput: 0, timestamp: performance.now(),
  };
}

function formatRate(value: number): string {
  return `${(value / 1000).toFixed(2)} KB/s · ${(value / 1024).toFixed(2)} KiB/s`;
}

function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 16000);
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
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    capturedAt: new Date().toISOString(),
    source: 'multiqr-receiver-page' as const,
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
  const scanElapsed = scanStartedAt ? Math.max(0.001, (performance.now() - scanStartedAt) / 1000) : 0;
  return {
    transport: 'fountain-lt-4qr',
    sessionId: receiverSessionId,
    unique: decoder?.solvedCount ?? 0,
    total: manifest?.sourceBlocks ?? 0,
    acceptedSymbols: decoder?.acceptedSymbols ?? 0,
    duplicateSymbols: decoder?.duplicateSymbols ?? 0,
    redundantSymbols: decoder?.redundantSymbols ?? 0,
    pendingEquations: decoder?.pendingEquationCount ?? 0,
    decoded: receiverDecoded,
    invalid: receiverInvalid,
    ignoredBeforeManifest: receiverIgnoredBeforeManifest,
    scanRounds,
    scanRoundsPerSecond: scanElapsed ? scanRounds / scanElapsed : 0,
    regions: regionMetrics.map(metric => ({...metric})),
    complete: receiverComplete,
    hashOk: receiverHashOk,
    goodput: receiverGoodput,
    timestamp: performance.now(),
  };
}

function publishStatus(extra = '', force = false): void {
  const t = snapshot();
  const pct = t.total ? 100 * t.unique / t.total : 0;
  const regionLine = t.regions.map((metric, index) => `R${index + 1} d${metric.decoded}/a${metric.accepted}`).join(' · ');
  receiverStatus.textContent = [
    'transport: Fountain / 4QR known-grid crop',
    `session: ${t.sessionId || '-'}`,
    `source blocks solved: ${t.unique}${t.total ? ` / ${t.total} (${pct.toFixed(2)}%)` : ''}`,
    `accepted symbols: ${t.acceptedSymbols} · duplicate: ${t.duplicateSymbols} · redundant: ${t.redundantSymbols}`,
    `pending equations: ${t.pendingEquations}`,
    `scan rounds: ${t.scanRounds} · ${t.scanRoundsPerSecond.toFixed(2)} rounds/s · 4 crops/round`,
    regionLine,
    `decoded QR results: ${t.decoded} · invalid/foreign: ${t.invalid} · pre-manifest ignored: ${t.ignoredBeforeManifest}`,
    `camera: ${video.videoWidth || 0}×${video.videoHeight || 0} · center-square ROI ${(ROI_FILL * 100).toFixed(0)}%`,
    extra,
  ].filter(Boolean).join('\n');
  latestTelemetry = t;
  const now = performance.now();
  if (force || now - lastTelemetrySentAt >= 150 || t.complete) {
    lastTelemetrySentAt = now;
    send({type: 'telemetry', telemetry: t});
  }
}

function resetReceiver(flushMs = 400): void {
  manifest = null;
  decoder = null;
  receiverSessionId = '';
  receiverDecoded = 0;
  receiverInvalid = 0;
  receiverIgnoredBeforeManifest = 0;
  receiverFirstUsefulAt = 0;
  receiverComplete = false;
  receiverFinalizing = false;
  receiverHashOk = false;
  receiverGoodput = 0;
  regionMetrics = freshRegionMetrics();
  scanRounds = 0;
  scanStartedAt = performance.now();
  receiverFlushUntil = performance.now() + flushMs;
  publishStatus('waiting for 4QR Fountain manifest', true);
}

async function finalizeReceiver(): Promise<void> {
  if (!manifest || !decoder?.complete || receiverComplete || receiverFinalizing) return;
  receiverFinalizing = true;
  try {
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
    ].join('\n'), true);
  } finally {
    receiverFinalizing = false;
  }
}

async function handleDecoded(text: string, regionIndex: number): Promise<void> {
  const metric = regionMetrics[regionIndex];
  metric.decoded += 1;
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
      publishStatus('waiting for 4QR manifest anchor');
      return;
    }
    receiverSessionId = frame.sessionId;
    manifest = frame;
    decoder = new FountainDecoder(frame.sourceBlocks, frame.blockSize, frame.fountainSeed);
    publishStatus('4QR Fountain manifest received; decoder initialized', true);
    return;
  }

  if (frame.sessionId !== receiverSessionId) {
    receiverInvalid += 1;
    publishStatus(`foreign session ignored: ${frame.sessionId}`);
    return;
  }
  if (frame.kind === 'fountain-manifest') {
    manifest = frame;
    publishStatus();
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
    if (result === 'duplicate') metric.duplicate += 1;
    else if (result === 'redundant') metric.redundant += 1;
    else metric.accepted += 1;
    if (result !== 'duplicate' && !receiverFirstUsefulAt) receiverFirstUsefulAt = performance.now();
  } catch (error) {
    receiverInvalid += 1;
    publishStatus(`decoder rejected symbol: ${String(error)}`);
    return;
  }
  publishStatus();
  await finalizeReceiver();
}

function drawCrop(regionIndex: number): void {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const square = Math.min(sourceWidth, sourceHeight) * ROI_FILL;
  const originX = (sourceWidth - square) / 2;
  const originY = (sourceHeight - square) / 2;
  const half = square / 2;
  const column = regionIndex % 2;
  const row = Math.floor(regionIndex / 2);
  const context = cropCanvases[regionIndex].getContext('2d', {alpha: false});
  if (!context) return;
  context.drawImage(video, originX + column * half, originY + row * half, half, half, 0, 0, CROP_OUTPUT, CROP_OUTPUT);
}

async function scanLoop(): Promise<void> {
  if (!scanActive) return;
  if (performance.now() >= receiverFlushUntil && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    scanRounds += 1;
    for (let regionIndex = 0; regionIndex < REGION_COUNT; regionIndex += 1) {
      const metric = regionMetrics[regionIndex];
      metric.attempts += 1;
      drawCrop(regionIndex);
      try {
        const result = cropReader.decodeFromCanvas(cropCanvases[regionIndex]);
        if (result) await handleDecoded(result.getText(), regionIndex);
      } catch {
        // A crop with no decodable QR is a normal camera sample, not an invalid protocol frame.
      }
      if (receiverComplete) break;
    }
    publishStatus();
  }
  if (scanActive && !receiverComplete) requestAnimationFrame(() => void scanLoop());
}

async function startCamera(): Promise<void> {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}},
  });
  video.srcObject = cameraStream;
  await video.play();
  scanActive = true;
  scanStartedAt = performance.now();
  requestAnimationFrame(() => void scanLoop());
  publishStatus('camera running; align the 2×2 sender grid with the square reticle', true);
}

function stopCamera(): void {
  scanActive = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}

function clearSenderGrid(): void {
  for (const canvas of qrCanvases) {
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function stopSender(): void {
  senderRunning = false;
  if (senderTimer !== undefined) clearTimeout(senderTimer);
  senderTimer = undefined;
  clearSenderGrid();
}

async function resetReceiverFromSender(): Promise<void> {
  stopSender();
  clearSenderGrid();
  await new Promise(resolve => setTimeout(resolve, 450));
  const id = `mreset-${createSessionId()}`;
  const ack = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingReset?.id === id) pendingReset = null;
      reject(new Error('4QR receiver reset acknowledgement timed out'));
    }, 5000);
    pendingReset = {id, timer, resolve, reject};
  });
  send({type: 'command', action: 'multiqr-reset', resetId: id});
  await ack;
  await new Promise(resolve => setTimeout(resolve, 400));
}

async function startMultiQrSender(bytes: Uint8Array) {
  const sha256 = await sha256Hex(bytes);
  const sessionId = createSessionId();
  const seed = fountainSeedFromSession(sessionId);
  const encoder = new FountainEncoder(bytes, BLOCK_SIZE, seed);
  const fountainManifest: FountainManifestFrame = {
    kind: 'fountain-manifest', sessionId, sourceBlocks: encoder.sourceCount,
    totalBytes: bytes.length, blockSize: BLOCK_SIZE, sha256,
    fileName: 'optilink-4qr-fountain-benchmark-1MiB.bin', fountainSeed: seed,
  };
  const manifestText = encodeFountainManifest(fountainManifest);
  let symbolId = 0;
  let nextDeadline = performance.now();
  senderRunning = true;
  senderStartedAt = performance.now();
  displayedVisualFrames = 0;
  displayedSymbols = 0;

  const render = async (): Promise<void> => {
    if (!senderRunning) return;
    const showManifest = displayedVisualFrames % (VISUAL_HZ + 1) === 0;
    const texts = showManifest
      ? Array.from({length: REGION_COUNT}, () => manifestText)
      : Array.from({length: REGION_COUNT}, () => {
          const id = symbolId++;
          displayedSymbols += 1;
          return encodeFountainDataFrame({kind: 'fountain', sessionId, symbolId: id, sourceBlocks: encoder.sourceCount, payload: encoder.symbol(id)});
        });
    try {
      await Promise.all(texts.map((text, index) => QRCode.toCanvas(qrCanvases[index], text, {
        width: QR_SIZE, margin: 2, errorCorrectionLevel: ECC,
        color: {dark: '#000000', light: '#ffffff'},
      })));
    } catch (error) {
      senderRunning = false;
      senderStatus.textContent = `4QR render error: ${String(error)}`;
      return;
    }
    displayedVisualFrames += 1;
    const elapsed = Math.max(0.001, (performance.now() - senderStartedAt) / 1000);
    const rawCeiling = REGION_COUNT * BLOCK_SIZE * VISUAL_HZ;
    const regionLine = latestTelemetry.regions.map((metric, index) => `R${index + 1}:${metric.accepted}`).join(' · ');
    senderStatus.textContent = [
      'transport: Fountain / 4QR spatial parallelism',
      `session: ${sessionId}`,
      `source: ${bytes.length.toLocaleString()} bytes · SHA-256 ${sha256}`,
      `source blocks: ${encoder.sourceCount} × ${BLOCK_SIZE} B`,
      `display: ${PHYSICAL_HZ} Hz physical · ${VISUAL_HZ} Hz optical target`,
      `actual visual frames: ${(displayedVisualFrames / elapsed).toFixed(2)} Hz`,
      `grid: 2×2 · ${QR_SIZE}px each · ECC ${ECC}`,
      `gross payload ceiling: ${formatRate(rawCeiling)}`,
      `displayed Fountain symbols: ${displayedSymbols}`,
      `receiver solved: ${latestTelemetry.unique}/${latestTelemetry.total || encoder.sourceCount}`,
      `receiver accepted: ${latestTelemetry.acceptedSymbols} · ${regionLine}`,
      `receiver scan: ${latestTelemetry.scanRoundsPerSecond.toFixed(2)} rounds/s`,
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
    log('4QR benchmark: Fountain recovery retained; carrier expanded to four fixed standard QR regions.');
    await resetReceiverFromSender();
    const session = await startMultiQrSender(source);
    const started = senderStartedAt;
    let lastProgress = 0;
    while (!aborted && !latestTelemetry.complete && performance.now() - started < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (performance.now() - lastProgress > 10_000) {
        lastProgress = performance.now();
        const pct = latestTelemetry.total ? 100 * latestTelemetry.unique / latestTelemetry.total : 0;
        log(`progress ${latestTelemetry.unique}/${latestTelemetry.total || session.sourceBlocks} (${pct.toFixed(1)}%) · accepted ${latestTelemetry.acceptedSymbols} · scan ${latestTelemetry.scanRoundsPerSecond.toFixed(2)} rounds/s`);
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
      scanRounds: t.scanRounds,
      scanRoundsPerSecond: t.scanRoundsPerSecond,
      perRegion: t.regions,
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
        schema: 'optilink.tf003.4qr.v1', kind: 'benchmark-1mib-4qr-fountain', evidenceClass: 'performance-experiment',
        status, startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(),
        transport: {family: 'LT-style Fountain / rateless XOR', systematicFirst: true, peelingDecoder: true, seed: `0x${session.seed.toString(16).padStart(8, '0')}`},
        sender: senderMetadata, receiver: latestReceiverMetadata,
        displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, targetOpticalVisualUpdateHz: VISUAL_HZ},
        payload: {kind: 'deterministic-incompressible', bytes: PAYLOAD_BYTES, seed: '0x4f505449', sha256: session.sha256},
        config: {regions: REGION_COUNT, layout: '2x2-known-grid', blockSize: BLOCK_SIZE, qrSize: QR_SIZE, targetHz: VISUAL_HZ, ecc: ECC, carrier: 'four-standard-qr'},
        theoreticalGrossPayloadBytesPerSecond: REGION_COUNT * BLOCK_SIZE * VISUAL_HZ,
        timeoutSeconds: TIMEOUT_MS / 1000,
        result,
        comparison: {singleQrFountain: '1 MiB PASS in 436.235 s at 2403.70 B/s on 60 Hz / 24 Hz / 300 B / 560 px single QR'},
        controlPlane: 'WebSocket telemetry only; payload bytes remain optical',
      },
    });
    send({type: 'command', action: 'multiqr-finished', status, result});
    log(status === 'PASS'
      ? `4QR PASS · SHA-256 verified · ${elapsed.toFixed(2)} s · ${formatRate(goodput)}.`
      : `4QR ${status} · solved ${(completionRatio * 100).toFixed(2)}% · result saved.`);
  } catch (error) {
    stopSender();
    log(`4QR benchmark failed: ${String(error)}`);
  }
}

function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => {
    send({type: 'hello', role: `multiqr-${role}`});
    log(`coordinator connected as multiqr-${role}`);
  });
  socket.addEventListener('close', () => {
    log('coordinator disconnected; reconnecting…');
    setTimeout(connect, 1500);
  });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }

    if (role === 'sender' && message.type === 'telemetry' && message.telemetry?.transport === 'fountain-lt-4qr') {
      latestTelemetry = message.telemetry as Telemetry;
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'multiqr-receiver-ready') {
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      void runBenchmark();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'multiqr-reset') {
      resetReceiver(400);
      latestReceiverMetadata = captureReceiverMetadata();
      window.setTimeout(() => send({type: 'state', event: 'multiqr-reset-complete', resetId: message.resetId, receiver: latestReceiverMetadata}), 400);
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'multiqr-reset-complete') {
      const reset = pendingReset;
      if (!reset || reset.id !== String(message.resetId || '')) return;
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      clearTimeout(reset.timer);
      pendingReset = null;
      reset.resolve();
      return;
    }
    if (message.type === 'command' && message.action === 'multiqr-stop') {
      aborted = true;
      if (role === 'sender') stopSender();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'multiqr-finished') {
      stopCamera();
      startButton.disabled = false;
      stopButton.disabled = true;
      log(`4QR benchmark finished: ${message.status}. Camera stopped automatically.`);
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
  send({type: 'state', event: 'multiqr-receiver-ready', receiver: latestReceiverMetadata});
  log('Camera started. Align the four-code square with the reticle; benchmark will finish or timeout automatically.');
}

function userStop(): void {
  aborted = true;
  send({type: 'command', action: 'multiqr-stop'});
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
  roleText.textContent = '保持电脑页面打开。手机点击 Start 后自动开始 4QR + Fountain 1 MiB 测试。';
  startButton.hidden = true;
  stopButton.hidden = true;
} else if (role === 'receiver') {
  senderView.hidden = true;
  roleTitle.textContent = 'Receiver ready';
  roleText.textContent = '让四码方阵对齐中央正方形取景框，然后只点一次 Start；完成或超时后摄像头自动停止。';
} else {
  roleTitle.textContent = 'Open role-specific URLs';
  roleText.textContent = '电脑使用 ?role=sender，手机使用 ?role=receiver。';
  startButton.disabled = true;
}

clearSenderGrid();
resetReceiver();
connect();
