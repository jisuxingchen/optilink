import './style.css';
import {
  calibrationPayload,
  decodeFrameCells,
  encodeFrameCells,
  payloadCapacityForMatrix,
  reservedCellValue,
  reservedScore,
} from './optigrid.ts';

const PHYSICAL_HZ = 60;
const VISUAL_HZ = 24;
const RENDER_PIXELS = 960;
const SAMPLE_PIXELS_PER_CELL = 4;
const ROI_FILL = 0.90;
const CANDIDATE_SECONDS = 7;
const MATRIX_SIZES = [64, 80, 96, 120, 160] as const;
const MIN_RESERVED_SCORE = 0.82;
const MIN_CONTRAST = 24;

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
const gridCanvas = $<HTMLCanvasElement>('gridCanvas');

gridCanvas.width = RENDER_PIXELS;
gridCanvas.height = RENDER_PIXELS;

const sampleCanvas = document.createElement('canvas');
const sampleContext = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContext) throw new Error('Canvas 2D context unavailable');

type ReceiverMeta = ReturnType<typeof captureReceiverMetadata>;
type CandidateConfig = {
  id: string;
  matrixSize: number;
  payloadBytes: number;
  durationMs: number;
  targetHz: number;
};
type CandidateMetrics = {
  id: string;
  matrixSize: number;
  payloadBytesPerFrame: number;
  attempts: number;
  validFrames: number;
  uniqueFrames: number;
  alignmentRejects: number;
  crcOrHeaderRejects: number;
  payloadMismatchRejects: number;
  duplicateFrames: number;
  elapsedSeconds: number;
  validFramesPerSecond: number;
  uniqueFramesPerSecond: number;
  uniquePayloadBytesPerSecond: number;
  averageDecodeMs: number;
  p95DecodeMs: number;
  averageContrast: number;
  averageReservedScore: number;
};
type Telemetry = {
  transport: 'optigrid-v0';
  activeCandidate: CandidateConfig | null;
  metrics: CandidateMetrics | null;
  timestamp: number;
};

type PendingAck = {id: string; timer: number; resolve: (value?: CandidateMetrics) => void; reject: (error: Error) => void};

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let scanActive = false;
let scanLoopScheduled = false;
let activeCandidate: CandidateConfig | null = null;
let candidateStartedAt = 0;
let attempts = 0;
let validFrames = 0;
let alignmentRejects = 0;
let crcOrHeaderRejects = 0;
let payloadMismatchRejects = 0;
let duplicateFrames = 0;
let contrastSum = 0;
let scoreSum = 0;
let decodeTimes: number[] = [];
let sequences = new Set<number>();
let lastTelemetryAt = 0;
let latestTelemetry: Telemetry = {transport: 'optigrid-v0', activeCandidate: null, metrics: null, timestamp: performance.now()};
let latestReceiverMetadata: ReceiverMeta | null = null;
let senderRunning = false;
let senderTimer: number | undefined;
let senderSequence = 1;
let aborted = false;
let pendingConfigAck: PendingAck | null = null;
let pendingResultAck: PendingAck | null = null;

function formatRate(value: number): string {
  return `${(value / 1000).toFixed(2)} KB/s · ${(value / 1024).toFixed(2)} KiB/s`;
}

function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 20000);
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
    source: 'optigrid-receiver-page' as const,
    capturedAt: new Date().toISOString(),
  };
}

function captureSenderMetadata() {
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    renderPixels: RENDER_PIXELS,
    capturedAt: new Date().toISOString(),
  };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function currentMetrics(): CandidateMetrics | null {
  const config = activeCandidate;
  if (!config) return null;
  const elapsed = Math.max(0.001, (performance.now() - candidateStartedAt) / 1000);
  const averageDecodeMs = decodeTimes.length ? decodeTimes.reduce((sum, value) => sum + value, 0) / decodeTimes.length : 0;
  return {
    id: config.id,
    matrixSize: config.matrixSize,
    payloadBytesPerFrame: config.payloadBytes,
    attempts,
    validFrames,
    uniqueFrames: sequences.size,
    alignmentRejects,
    crcOrHeaderRejects,
    payloadMismatchRejects,
    duplicateFrames,
    elapsedSeconds: elapsed,
    validFramesPerSecond: validFrames / elapsed,
    uniqueFramesPerSecond: sequences.size / elapsed,
    uniquePayloadBytesPerSecond: sequences.size * config.payloadBytes / elapsed,
    averageDecodeMs,
    p95DecodeMs: percentile(decodeTimes, 0.95),
    averageContrast: attempts ? contrastSum / attempts : 0,
    averageReservedScore: attempts ? scoreSum / attempts : 0,
  };
}

function publishTelemetry(force = false): void {
  const metrics = currentMetrics();
  latestTelemetry = {transport: 'optigrid-v0', activeCandidate, metrics, timestamp: performance.now()};
  if (metrics) {
    receiverStatus.textContent = [
      'carrier: OptiGrid v0 · direct monochrome cell sampling',
      `matrix: ${metrics.matrixSize}×${metrics.matrixSize} · payload ${metrics.payloadBytesPerFrame} B/frame`,
      `unique frames: ${metrics.uniqueFrames} · ${metrics.uniqueFramesPerSecond.toFixed(2)}/s`,
      `valid frames: ${metrics.validFrames} · duplicates ${metrics.duplicateFrames}`,
      `raw unique ingress: ${formatRate(metrics.uniquePayloadBytesPerSecond)}`,
      `rejects: alignment ${metrics.alignmentRejects} · CRC/header ${metrics.crcOrHeaderRejects} · payload ${metrics.payloadMismatchRejects}`,
      `decode CPU: avg ${metrics.averageDecodeMs.toFixed(2)} ms · p95 ${metrics.p95DecodeMs.toFixed(2)} ms`,
      `contrast: ${metrics.averageContrast.toFixed(1)} · reserved score ${(metrics.averageReservedScore * 100).toFixed(1)}%`,
      `camera: ${video.videoWidth || 0}×${video.videoHeight || 0} · ROI ${(ROI_FILL * 100).toFixed(0)}%`,
    ].join('\n');
  } else {
    receiverStatus.textContent = 'OptiGrid receiver ready · waiting for calibration candidate';
  }
  const now = performance.now();
  if (force || now - lastTelemetryAt > 250) {
    lastTelemetryAt = now;
    send({type: 'telemetry', telemetry: latestTelemetry});
  }
}

function resetCandidate(config: CandidateConfig | null): void {
  activeCandidate = config;
  candidateStartedAt = performance.now();
  attempts = 0;
  validFrames = 0;
  alignmentRejects = 0;
  crcOrHeaderRejects = 0;
  payloadMismatchRejects = 0;
  duplicateFrames = 0;
  contrastSum = 0;
  scoreSum = 0;
  decodeTimes = [];
  sequences = new Set<number>();
  publishTelemetry(true);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sampleLuma(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const index = (y * width + x) * 4;
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function sampleCells(matrixSize: number): {cells: Uint8Array; contrast: number; score: number} | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const square = Math.min(sourceWidth, sourceHeight) * ROI_FILL;
  const originX = (sourceWidth - square) / 2;
  const originY = (sourceHeight - square) / 2;
  const sampleSize = matrixSize * SAMPLE_PIXELS_PER_CELL;
  if (sampleCanvas.width !== sampleSize || sampleCanvas.height !== sampleSize) {
    sampleCanvas.width = sampleSize;
    sampleCanvas.height = sampleSize;
    sampleContext.imageSmoothingEnabled = true;
  }
  sampleContext.drawImage(video, originX, originY, square, square, 0, 0, sampleSize, sampleSize);
  const image = sampleContext.getImageData(0, 0, sampleSize, sampleSize);
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reservedCellValue(row, column, matrixSize);
      if (expected === null) continue;
      const x = Math.min(sampleSize - 1, Math.floor((column + 0.5) * SAMPLE_PIXELS_PER_CELL));
      const y = Math.min(sampleSize - 1, Math.floor((row + 0.5) * SAMPLE_PIXELS_PER_CELL));
      const luma = sampleLuma(image.data, sampleSize, x, y);
      if (expected) { blackSum += luma; blackCount += 1; }
      else { whiteSum += luma; whiteCount += 1; }
    }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  const threshold = (whiteMean + blackMean) / 2;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const x = Math.min(sampleSize - 1, Math.floor((column + 0.5) * SAMPLE_PIXELS_PER_CELL));
      const y = Math.min(sampleSize - 1, Math.floor((row + 0.5) * SAMPLE_PIXELS_PER_CELL));
      cells[row * matrixSize + column] = sampleLuma(image.data, sampleSize, x, y) < threshold ? 1 : 0;
    }
  }
  return {cells, contrast, score: reservedScore(cells, matrixSize)};
}

async function scanOnce(): Promise<void> {
  const config = activeCandidate;
  if (!scanActive || !config || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const started = performance.now();
  attempts += 1;
  const sampled = sampleCells(config.matrixSize);
  if (!sampled) return;
  contrastSum += sampled.contrast;
  scoreSum += sampled.score;
  if (sampled.contrast < MIN_CONTRAST || sampled.score < MIN_RESERVED_SCORE) {
    alignmentRejects += 1;
  } else {
    const decoded = decodeFrameCells(sampled.cells, config.matrixSize);
    if (!decoded) {
      crcOrHeaderRejects += 1;
    } else if (!sameBytes(decoded.payload, calibrationPayload(decoded.sequence, decoded.payload.length))) {
      payloadMismatchRejects += 1;
    } else {
      validFrames += 1;
      if (sequences.has(decoded.sequence)) duplicateFrames += 1;
      else sequences.add(decoded.sequence);
    }
  }
  decodeTimes.push(performance.now() - started);
  if (decodeTimes.length > 2000) decodeTimes.shift();
  publishTelemetry();
}

async function scanLoop(): Promise<void> {
  scanLoopScheduled = false;
  if (!scanActive) return;
  await scanOnce();
  if (scanActive) {
    scanLoopScheduled = true;
    requestAnimationFrame(() => void scanLoop());
  }
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
  if (!scanLoopScheduled) {
    scanLoopScheduled = true;
    requestAnimationFrame(() => void scanLoop());
  }
  publishTelemetry(true);
}

function stopCamera(): void {
  scanActive = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}

function clearGrid(): void {
  const context = gridCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, gridCanvas.width, gridCanvas.height);
}

function drawGrid(cells: Uint8Array, matrixSize: number): void {
  const context = gridCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  const cell = RENDER_PIXELS / matrixSize;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, RENDER_PIXELS, RENDER_PIXELS);
  context.fillStyle = '#000000';
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      if (!cells[row * matrixSize + column]) continue;
      context.fillRect(column * cell, row * cell, cell, cell);
    }
  }
}

function stopSender(): void {
  senderRunning = false;
  if (senderTimer !== undefined) clearTimeout(senderTimer);
  senderTimer = undefined;
  clearGrid();
}

function makeAck(id: string, kind: 'config' | 'result'): Promise<CandidateMetrics | undefined> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = kind === 'config' ? pendingConfigAck : pendingResultAck;
      if (pending?.id === id) {
        if (kind === 'config') pendingConfigAck = null;
        else pendingResultAck = null;
      }
      reject(new Error(`OptiGrid ${kind} acknowledgement timed out`));
    }, 6000);
    const pending: PendingAck = {id, timer, resolve, reject};
    if (kind === 'config') pendingConfigAck = pending;
    else pendingResultAck = pending;
  });
}

async function configureReceiver(config: CandidateConfig): Promise<void> {
  const ack = makeAck(config.id, 'config');
  send({type: 'command', action: 'optigrid-config', config});
  await ack;
}

async function collectReceiverResult(id: string): Promise<CandidateMetrics> {
  const ack = makeAck(id, 'result');
  send({type: 'command', action: 'optigrid-candidate-finish', candidateId: id});
  const result = await ack;
  if (!result) throw new Error('OptiGrid candidate result missing');
  return result;
}

async function renderCandidate(config: CandidateConfig): Promise<{renderedFrames: number; actualHz: number}> {
  await configureReceiver(config);
  await new Promise(resolve => setTimeout(resolve, 300));
  let renderedFrames = 0;
  const started = performance.now();
  let nextDeadline = started;
  senderRunning = true;

  await new Promise<void>((resolve, reject) => {
    const render = () => {
      if (!senderRunning || aborted) return resolve();
      const now = performance.now();
      if (now - started >= config.durationMs) return resolve();
      try {
        const sequence = senderSequence++ >>> 0;
        const payload = calibrationPayload(sequence, config.payloadBytes);
        drawGrid(encodeFrameCells(config.matrixSize, sequence, payload), config.matrixSize);
        renderedFrames += 1;
        const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
        senderStatus.textContent = [
          'carrier: OptiGrid v0 · direct binary matrix',
          `candidate: ${config.matrixSize}×${config.matrixSize}`,
          `payload: ${config.payloadBytes} B/frame`,
          `display: ${PHYSICAL_HZ} Hz physical · ${VISUAL_HZ} Hz optical target`,
          `actual render: ${(renderedFrames / elapsed).toFixed(2)} frames/s`,
          `gross payload ceiling: ${formatRate(config.payloadBytes * VISUAL_HZ)}`,
          `receiver unique ingress: ${formatRate(latestTelemetry.metrics?.uniquePayloadBytesPerSecond || 0)}`,
          `receiver reserved score: ${((latestTelemetry.metrics?.averageReservedScore || 0) * 100).toFixed(1)}%`,
        ].join('\n');
      } catch (error) {
        senderRunning = false;
        reject(error);
        return;
      }
      nextDeadline += 1000 / config.targetHz;
      senderTimer = window.setTimeout(render, Math.max(0, nextDeadline - performance.now()));
    };
    render();
  });

  senderRunning = false;
  if (senderTimer !== undefined) clearTimeout(senderTimer);
  senderTimer = undefined;
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return {renderedFrames, actualHz: renderedFrames / elapsed};
}

async function runCalibration(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  const senderMetadata = captureSenderMetadata();
  const results: Array<CandidateMetrics & {renderedFrames: number; senderActualHz: number; grossPayloadBytesPerSecond: number}> = [];
  try {
    log('OptiGrid v0 calibration started: no QR decoder, direct pixel sampling only.');
    clearGrid();
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const matrixSize of MATRIX_SIZES) {
      if (aborted) break;
      const payloadBytes = payloadCapacityForMatrix(matrixSize);
      const id = `og-${matrixSize}-${Date.now().toString(36)}`;
      const config: CandidateConfig = {id, matrixSize, payloadBytes, durationMs: CANDIDATE_SECONDS * 1000, targetHz: VISUAL_HZ};
      log(`testing ${matrixSize}×${matrixSize} · ${payloadBytes} B/frame · gross ${formatRate(payloadBytes * VISUAL_HZ)}`);
      const sender = await renderCandidate(config);
      clearGrid();
      const receiver = await collectReceiverResult(id);
      results.push({...receiver, renderedFrames: sender.renderedFrames, senderActualHz: sender.actualHz, grossPayloadBytesPerSecond: payloadBytes * VISUAL_HZ});
      log(`${matrixSize}×${matrixSize}: unique ${receiver.uniqueFramesPerSecond.toFixed(2)}/s · ingress ${formatRate(receiver.uniquePayloadBytesPerSecond)} · score ${(receiver.averageReservedScore * 100).toFixed(1)}%`);
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    stopSender();
    const best = results.reduce<(typeof results)[number] | null>((winner, candidate) => !winner || candidate.uniquePayloadBytesPerSecond > winner.uniquePayloadBytesPerSecond ? candidate : winner, null);
    const run = {
      schema: 'optilink.tf004.optigrid.calibration.v0',
      kind: 'optigrid-calibration',
      evidenceClass: 'engineering-calibration',
      status: aborted ? 'ABORTED' : 'CALIBRATION_COMPLETE',
      startedBy: 'receiver-one-click',
      finishedAt: new Date().toISOString(),
      sender: senderMetadata,
      receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, targetOpticalVisualUpdateHz: VISUAL_HZ},
      carrier: {
        name: 'OptiGrid v0',
        modulation: 'monochrome 1-bit cells',
        renderPixels: RENDER_PIXELS,
        borderCells: 4,
        framing: 'black/white border rings + corner pilot patterns',
        integrity: 'per-frame CRC32 + deterministic optical payload check',
        receiver: 'known central square ROI + direct cell sampling',
      },
      candidates: results,
      best,
      comparison: {fourQrVerifiedGoodputBytesPerSecond: 3618.1510707535476, firstEngineeringTargetBytesPerSecond: 7236.302141507095},
      controlPlane: 'WebSocket carries calibration commands/telemetry only; frame payload bytes remain screen→camera optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'optigrid-finished', status: run.status});
    log(best
      ? `OptiGrid calibration complete · best ${best.matrixSize}×${best.matrixSize} · ${formatRate(best.uniquePayloadBytesPerSecond)} raw unique ingress.`
      : 'OptiGrid calibration finished without a valid candidate.');
  } catch (error) {
    stopSender();
    send({type: 'command', action: 'optigrid-finished', status: 'ERROR'});
    log(`OptiGrid calibration failed: ${String(error)}`);
  }
}

function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => {
    send({type: 'hello', role: `optigrid-${role}`});
    log(`coordinator connected as optigrid-${role}`);
  });
  socket.addEventListener('close', () => {
    log('coordinator disconnected; reconnecting…');
    setTimeout(connect, 1500);
  });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (role === 'sender' && message.type === 'telemetry' && message.telemetry?.transport === 'optigrid-v0') {
      latestTelemetry = message.telemetry as Telemetry;
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'optigrid-receiver-ready') {
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      void runCalibration();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'optigrid-config') {
      const config = message.config as CandidateConfig;
      resetCandidate(config);
      latestReceiverMetadata = captureReceiverMetadata();
      send({type: 'state', event: 'optigrid-config-ready', candidateId: config.id, receiver: latestReceiverMetadata});
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'optigrid-config-ready') {
      const pending = pendingConfigAck;
      if (!pending || pending.id !== String(message.candidateId || '')) return;
      latestReceiverMetadata = message.receiver as ReceiverMeta;
      clearTimeout(pending.timer);
      pendingConfigAck = null;
      pending.resolve();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'optigrid-candidate-finish') {
      const metrics = currentMetrics();
      const candidateId = String(message.candidateId || '');
      if (metrics && metrics.id === candidateId) send({type: 'state', event: 'optigrid-candidate-result', candidateId, metrics});
      resetCandidate(null);
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'optigrid-candidate-result') {
      const pending = pendingResultAck;
      if (!pending || pending.id !== String(message.candidateId || '')) return;
      clearTimeout(pending.timer);
      pendingResultAck = null;
      pending.resolve(message.metrics as CandidateMetrics);
      return;
    }
    if (message.type === 'command' && message.action === 'optigrid-stop') {
      aborted = true;
      if (role === 'sender') stopSender();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'optigrid-finished') {
      stopCamera();
      startButton.disabled = false;
      stopButton.disabled = true;
      log(`OptiGrid calibration finished: ${message.status}. Camera stopped automatically.`);
      return;
    }
    if (message.type === 'server' && message.event === 'result-saved') {
      log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
    }
  });
}

async function receiverStart(): Promise<void> {
  resetCandidate(null);
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  startButton.disabled = true;
  stopButton.disabled = false;
  send({type: 'state', event: 'optigrid-receiver-ready', receiver: latestReceiverMetadata});
  log('Camera started. Align the complete OptiGrid square with the reticle; calibration runs automatically.');
}

function userStop(): void {
  aborted = true;
  send({type: 'command', action: 'optigrid-stop'});
  if (role === 'receiver') stopCamera();
  if (role === 'sender') stopSender();
  startButton.disabled = false;
  stopButton.disabled = true;
  log('stopped by user');
}

startButton.addEventListener('click', () => {
  if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`));
  else if (role === 'sender') void runCalibration();
});
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  receiverView.hidden = true;
  roleTitle.textContent = 'OptiGrid sender ready';
  roleText.textContent = '保持页面打开。手机点击 Start 后自动扫描 64→160 格密度；无需上传文件。';
  startButton.hidden = true;
  stopButton.hidden = true;
} else if (role === 'receiver') {
  senderView.hidden = true;
  roleTitle.textContent = 'OptiGrid receiver ready';
  roleText.textContent = '让整个黑白方阵贴合中央取景框，然后只点一次 Start。程序自动测试不同密度。';
} else {
  roleTitle.textContent = 'Open role-specific OptiGrid URLs';
  roleText.textContent = '电脑使用 ?role=sender，手机使用 ?role=receiver。';
  startButton.disabled = true;
}

clearGrid();
connect();
