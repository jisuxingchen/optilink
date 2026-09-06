import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';

const PHYSICAL_HZ = 60;
const TARGET_HZ = 60;
const RENDER_PIXELS = 960;
const CAMERA_WORK_PIXELS = 960;
const PREALIGN_MS = 6000;
const CANDIDATE_MS = 10000;
const MIN_LOCK_SCORE = 0.72;
const MIN_TRACK_SCORE = 0.70;
const MIN_CONTRAST = 16;
const SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-0.18, 0], [0.18, 0], [0, -0.18], [0, 0.18],
];
const CANDIDATES = [160, 240] as const;

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
const senderStatus = $<HTMLPreElement>('senderStatus');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const video = $<HTMLVideoElement>('camera');
const gridCanvas = $<HTMLCanvasElement>('gridCanvas');

gridCanvas.width = RENDER_PIXELS;
gridCanvas.height = RENDER_PIXELS;

const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = CAMERA_WORK_PIXELS;
sampleCanvas.height = CAMERA_WORK_PIXELS;
const sampleContextMaybe = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContextMaybe) throw new Error('Canvas 2D context unavailable');
const sampleContext: CanvasRenderingContext2D = sampleContextMaybe;

type CandidateConfig = {id: string; matrixSize: number; payloadBytes: number; durationMs: number; targetHz: number};
type GeometryLock = {scale: number; offsetX: number; offsetY: number; threshold: number; score: number; contrast: number};
type CandidateMetrics = {
  id: string;
  matrixSize: number;
  payloadBytesPerFrame: number;
  attempts: number;
  validFrames: number;
  uniqueFrames: number;
  duplicateFrames: number;
  acquisitionRejects: number;
  crcOrHeaderRejects: number;
  payloadMismatchRejects: number;
  acquisitionCount: number;
  reacquisitionCount: number;
  trackedFrames: number;
  elapsedSeconds: number;
  validRatio: number;
  uniqueFramesPerSecond: number;
  uniquePayloadBytesPerSecond: number;
  acquisitionP95Ms: number;
  trackingValidationP95Ms: number;
  fastDecodeP95Ms: number;
  totalDecodeP95Ms: number;
  averageReservedScore: number;
  averageContrast: number;
  currentLock: GeometryLock | null;
};
type PendingAck = {id: string; timer: number; resolve: (value?: CandidateMetrics) => void; reject: (error: Error) => void};
type ReceiverMetadata = ReturnType<typeof captureReceiverMetadata>;
type Telemetry = {transport: 'optigrid-v1-physical'; metrics: CandidateMetrics | null; timestamp: number};

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let activeCandidate: CandidateConfig | null = null;
let candidateStartedAt = 0;
let geometryLock: GeometryLock | null = null;
let attempts = 0;
let validFrames = 0;
let duplicateFrames = 0;
let acquisitionRejects = 0;
let crcOrHeaderRejects = 0;
let payloadMismatchRejects = 0;
let acquisitionCount = 0;
let reacquisitionCount = 0;
let trackedFrames = 0;
let scoreSum = 0;
let contrastSum = 0;
let validationCount = 0;
let sequences = new Set<number>();
let acquisitionTimes: number[] = [];
let trackingTimes: number[] = [];
let fastDecodeTimes: number[] = [];
let totalDecodeTimes: number[] = [];
let scanning = false;
let aborted = false;
let senderRunning = false;
let senderSequence = 1;
let latestTelemetry: Telemetry = {transport: 'optigrid-v1-physical', metrics: null, timestamp: performance.now()};
let latestReceiverMetadata: ReceiverMetadata | null = null;
let pendingConfigAck: PendingAck | null = null;
let pendingResultAck: PendingAck | null = null;

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
function deterministicPayload(sequence: number, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x46524f4e) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 29 + (sequence & 0xff)) & 0xff;
  }
  return output;
}
function formatRate(value: number): string { return `${(value / 1000).toFixed(1)} KB/s`; }
function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 24000);
}
function send(message: unknown): void { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

function captureReceiverMetadata() {
  const track = cameraStream?.getVideoTracks()[0];
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    cameraSettings: track?.getSettings?.() || null,
    source: 'tf006-optigrid-v1-receiver-page' as const,
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

function luma(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}
function sampleLumaBilinear(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x));
  const py = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const tx = px - x0, ty = py - y0, stride = image.width * 4;
  const o00 = y0 * stride + x0 * 4, o10 = y0 * stride + x1 * 4;
  const o01 = y1 * stride + x0 * 4, o11 = y1 * stride + x1 * 4;
  const top = luma(image.data, o00) * (1 - tx) + luma(image.data, o10) * tx;
  const bottom = luma(image.data, o01) * (1 - tx) + luma(image.data, o11) * tx;
  return top * (1 - ty) + bottom * ty;
}

function captureCameraSquare(): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  const side = Math.min(video.videoWidth, video.videoHeight);
  const sx = (video.videoWidth - side) / 2;
  const sy = (video.videoHeight - side) / 2;
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.drawImage(video, sx, sy, side, side, 0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
  return sampleContext.getImageData(0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
}

function sparseReservedSamples(matrixSize: number): Array<{row: number; column: number; expected: number}> {
  const samples: Array<{row: number; column: number; expected: number}> = [];
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reservedCellValueV1(row, column, matrixSize);
      if (expected === null) continue;
      const finder = (row < 10 || row >= matrixSize - 10) && (column < 10 || column >= matrixSize - 10);
      if (finder || ((row + column) & 3) === 0) samples.push({row, column, expected});
    }
  }
  return samples;
}

function evaluateGeometry(image: ImageData, matrixSize: number, scale: number, offsetX: number, offsetY: number): GeometryLock | null {
  const samples = sparseReservedSamples(matrixSize);
  const square = image.width * scale;
  const originX = (image.width - square) / 2 + image.width * offsetX;
  const originY = (image.height - square) / 2 + image.height * offsetY;
  const cell = square / matrixSize;
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  for (const sample of samples) {
    const value = sampleLumaBilinear(image, originX + (sample.column + 0.5) * cell, originY + (sample.row + 0.5) * cell);
    if (sample.expected) { blackSum += value; blackCount += 1; }
    else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  if (contrast <= 0) return null;
  const threshold = (blackMean + whiteMean) / 2;
  let matches = 0;
  for (const sample of samples) {
    const value = sampleLumaBilinear(image, originX + (sample.column + 0.5) * cell, originY + (sample.row + 0.5) * cell);
    const observed = value < threshold ? 1 : 0;
    if (observed === sample.expected) matches += 1;
  }
  return {scale, offsetX, offsetY, threshold, score: matches / samples.length, contrast};
}

function acquireGeometry(image: ImageData, matrixSize: number): GeometryLock | null {
  const scales = [0.84, 0.87, 0.90, 0.93, 0.96];
  const offsets = [-0.04, -0.02, 0, 0.02, 0.04];
  let best: GeometryLock | null = null;
  let bestRank = -Infinity;
  for (const scale of scales) for (const offsetX of offsets) for (const offsetY of offsets) {
    const candidate = evaluateGeometry(image, matrixSize, scale, offsetX, offsetY);
    if (!candidate) continue;
    const rank = candidate.score * 1000 + Math.min(candidate.contrast, 120);
    if (rank > bestRank) { best = candidate; bestRank = rank; }
  }
  if (!best || best.score < MIN_LOCK_SCORE || best.contrast < MIN_CONTRAST) return null;
  return best;
}

function validateGeometry(image: ImageData, matrixSize: number, lock: GeometryLock): GeometryLock | null {
  const current = evaluateGeometry(image, matrixSize, lock.scale, lock.offsetX, lock.offsetY);
  if (!current || current.score < MIN_TRACK_SCORE || current.contrast < MIN_CONTRAST) return null;
  return current;
}

function decodeWithGeometry(image: ImageData, matrixSize: number, lock: GeometryLock): ReturnType<typeof decodeFrameCellsV1> {
  const square = image.width * lock.scale;
  const originX = (image.width - square) / 2 + image.width * lock.offsetX;
  const originY = (image.height - square) / 2 + image.height * lock.offsetY;
  const cell = square / matrixSize;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      let blackVotes = 0;
      for (const [dx, dy] of SAMPLE_OFFSETS) {
        const x = originX + (column + 0.5 + dx) * cell;
        const y = originY + (row + 0.5 + dy) * cell;
        if (sampleLumaBilinear(image, x, y) < lock.threshold) blackVotes += 1;
      }
      cells[row * matrixSize + column] = blackVotes >= 3 ? 1 : 0;
    }
  }
  return decodeFrameCellsV1(cells, matrixSize);
}

function resetCandidate(config: CandidateConfig | null): void {
  activeCandidate = config;
  candidateStartedAt = performance.now();
  geometryLock = null;
  attempts = validFrames = duplicateFrames = acquisitionRejects = crcOrHeaderRejects = payloadMismatchRejects = 0;
  acquisitionCount = reacquisitionCount = trackedFrames = 0;
  scoreSum = contrastSum = validationCount = 0;
  sequences = new Set<number>();
  acquisitionTimes = []; trackingTimes = []; fastDecodeTimes = []; totalDecodeTimes = [];
  publishTelemetry(true);
}

function currentMetrics(): CandidateMetrics | null {
  const config = activeCandidate;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - candidateStartedAt) / 1000);
  return {
    id: config.id,
    matrixSize: config.matrixSize,
    payloadBytesPerFrame: config.payloadBytes,
    attempts,
    validFrames,
    uniqueFrames: sequences.size,
    duplicateFrames,
    acquisitionRejects,
    crcOrHeaderRejects,
    payloadMismatchRejects,
    acquisitionCount,
    reacquisitionCount,
    trackedFrames,
    elapsedSeconds,
    validRatio: attempts ? validFrames / attempts : 0,
    uniqueFramesPerSecond: sequences.size / elapsedSeconds,
    uniquePayloadBytesPerSecond: sequences.size * config.payloadBytes / elapsedSeconds,
    acquisitionP95Ms: percentile(acquisitionTimes, 0.95),
    trackingValidationP95Ms: percentile(trackingTimes, 0.95),
    fastDecodeP95Ms: percentile(fastDecodeTimes, 0.95),
    totalDecodeP95Ms: percentile(totalDecodeTimes, 0.95),
    averageReservedScore: validationCount ? scoreSum / validationCount : 0,
    averageContrast: validationCount ? contrastSum / validationCount : 0,
    currentLock: geometryLock,
  };
}

let lastTelemetryAt = 0;
function publishTelemetry(force = false): void {
  const metrics = currentMetrics();
  latestTelemetry = {transport: 'optigrid-v1-physical', metrics, timestamp: performance.now()};
  if (metrics) {
    receiverStatus.textContent = [
      `candidate: ${metrics.matrixSize}×${metrics.matrixSize} · ${metrics.payloadBytesPerFrame} B/frame`,
      `unique: ${metrics.uniqueFrames} · ${metrics.uniqueFramesPerSecond.toFixed(2)}/s · raw ingress ${formatRate(metrics.uniquePayloadBytesPerSecond)}`,
      `valid: ${metrics.validFrames}/${metrics.attempts} (${(metrics.validRatio * 100).toFixed(1)}%) · duplicates ${metrics.duplicateFrames}`,
      `rejects: acquisition ${metrics.acquisitionRejects} · CRC/header ${metrics.crcOrHeaderRejects} · payload ${metrics.payloadMismatchRejects}`,
      `lock: acquisitions ${metrics.acquisitionCount} · reacquisitions ${metrics.reacquisitionCount} · tracked ${metrics.trackedFrames}`,
      `decode p95: acquire ${metrics.acquisitionP95Ms.toFixed(1)} ms · track ${metrics.trackingValidationP95Ms.toFixed(1)} ms · fast ${metrics.fastDecodeP95Ms.toFixed(1)} ms · total ${metrics.totalDecodeP95Ms.toFixed(1)} ms`,
      `pilot score ${(metrics.averageReservedScore * 100).toFixed(1)}% · contrast ${metrics.averageContrast.toFixed(1)}`,
    ].join('\n');
  }
  const now = performance.now();
  if (force || now - lastTelemetryAt > 350) { lastTelemetryAt = now; send({type: 'telemetry', telemetry: latestTelemetry}); }
}

async function scanCurrentCameraFrame(): Promise<void> {
  const config = activeCandidate;
  if (!scanning || !config) return;
  const totalStarted = performance.now();
  const image = captureCameraSquare();
  if (!image) return;
  attempts += 1;

  const hadLock = Boolean(geometryLock);
  let validation: GeometryLock | null = null;
  if (geometryLock) {
    const started = performance.now();
    validation = validateGeometry(image, config.matrixSize, geometryLock);
    trackingTimes.push(performance.now() - started);
  }
  if (!validation) {
    const started = performance.now();
    const acquired = acquireGeometry(image, config.matrixSize);
    acquisitionTimes.push(performance.now() - started);
    if (!acquired) {
      geometryLock = null;
      acquisitionRejects += 1;
      totalDecodeTimes.push(performance.now() - totalStarted);
      publishTelemetry();
      return;
    }
    geometryLock = acquired;
    acquisitionCount += 1;
    if (hadLock) reacquisitionCount += 1;
    validation = acquired;
  } else {
    geometryLock = validation;
    trackedFrames += 1;
  }

  scoreSum += validation.score;
  contrastSum += validation.contrast;
  validationCount += 1;
  const fastStarted = performance.now();
  const decoded = decodeWithGeometry(image, config.matrixSize, validation);
  fastDecodeTimes.push(performance.now() - fastStarted);
  if (!decoded) crcOrHeaderRejects += 1;
  else if (!sameBytes(decoded.payload, deterministicPayload(decoded.sequence, decoded.payload.length))) payloadMismatchRejects += 1;
  else {
    validFrames += 1;
    if (sequences.has(decoded.sequence)) duplicateFrames += 1;
    else sequences.add(decoded.sequence);
  }
  totalDecodeTimes.push(performance.now() - totalStarted);
  if (acquisitionTimes.length > 500) acquisitionTimes.shift();
  if (trackingTimes.length > 1000) trackingTimes.shift();
  if (fastDecodeTimes.length > 1000) fastDecodeTimes.shift();
  if (totalDecodeTimes.length > 1000) totalDecodeTimes.shift();
  publishTelemetry();
}

function scheduleCameraLoop(): void {
  if (!scanning) return;
  const withVideoCallback = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number};
  if (typeof withVideoCallback.requestVideoFrameCallback === 'function') {
    withVideoCallback.requestVideoFrameCallback(() => { void scanCurrentCameraFrame().finally(scheduleCameraLoop); });
  } else {
    requestAnimationFrame(() => { void scanCurrentCameraFrame().finally(scheduleCameraLoop); });
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
  scanning = true;
  scheduleCameraLoop();
}
function stopCamera(): void {
  scanning = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}

function drawGrid(cells: Uint8Array, matrixSize: number): void {
  const context = gridCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#fff'; context.fillRect(0, 0, RENDER_PIXELS, RENDER_PIXELS);
  context.fillStyle = '#000';
  const cell = RENDER_PIXELS / matrixSize;
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    if (cells[row * matrixSize + column]) context.fillRect(column * cell, row * cell, cell, cell);
  }
}
function drawAlignmentPattern(): void {
  const matrixSize = 160;
  const payloadBytes = payloadCapacityForMatrixV1(matrixSize);
  drawGrid(encodeFrameCellsV1(matrixSize, 0, deterministicPayload(0, payloadBytes)), matrixSize);
}

function makeAck(id: string, kind: 'config' | 'result'): Promise<CandidateMetrics | undefined> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = kind === 'config' ? pendingConfigAck : pendingResultAck;
      if (pending?.id === id) { if (kind === 'config') pendingConfigAck = null; else pendingResultAck = null; }
      reject(new Error(`TF-006 ${kind} acknowledgement timed out`));
    }, 8000);
    const pending: PendingAck = {id, timer, resolve, reject};
    if (kind === 'config') pendingConfigAck = pending; else pendingResultAck = pending;
  });
}
async function configureReceiver(config: CandidateConfig): Promise<void> {
  const ack = makeAck(config.id, 'config');
  send({type: 'command', action: 'tf006-config', config});
  await ack;
}
async function collectReceiverResult(id: string): Promise<CandidateMetrics> {
  const ack = makeAck(id, 'result');
  send({type: 'command', action: 'tf006-candidate-finish', candidateId: id});
  const metrics = await ack;
  if (!metrics) throw new Error('TF-006 receiver metrics missing');
  return metrics;
}

async function renderCandidate(config: CandidateConfig): Promise<{renderedFrames: number; actualHz: number}> {
  await configureReceiver(config);
  await sleep(300);
  senderRunning = true;
  const started = performance.now();
  let renderedFrames = 0;
  await new Promise<void>(resolve => {
    const frame = () => {
      if (!senderRunning || aborted || performance.now() - started >= config.durationMs) { resolve(); return; }
      const sequence = senderSequence++ >>> 0;
      drawGrid(encodeFrameCellsV1(config.matrixSize, sequence, deterministicPayload(sequence, config.payloadBytes)), config.matrixSize);
      renderedFrames += 1;
      const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
      const receiverIngress = latestTelemetry.metrics?.uniquePayloadBytesPerSecond || 0;
      senderStatus.textContent = [
        `TF-006 OptiGrid v1 · ${config.matrixSize}×${config.matrixSize}`,
        `payload ${config.payloadBytes} B/frame · target ${config.targetHz} Hz · physical display ${PHYSICAL_HZ} Hz`,
        `actual sender render ${(renderedFrames / elapsed).toFixed(2)} frames/s`,
        `gross target ${formatRate(config.payloadBytes * config.targetHz)}`,
        `receiver raw unique ingress ${formatRate(receiverIngress)}`,
      ].join('\n');
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  senderRunning = false;
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return {renderedFrames, actualHz: renderedFrames / elapsed};
}

async function runPhysicalGate(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  const senderMetadata = captureSenderMetadata();
  const results: Array<CandidateMetrics & {renderedFrames: number; senderActualHz: number; grossTargetBytesPerSecond: number; selectionScore: number}> = [];
  try {
    log('TF-006 physical gate started. Payload remains optical; WebSocket carries control/telemetry only.');
    for (const matrixSize of CANDIDATES) {
      if (aborted) break;
      const payloadBytes = payloadCapacityForMatrixV1(matrixSize);
      const config: CandidateConfig = {id: `tf006-${matrixSize}-${Date.now().toString(36)}`, matrixSize, payloadBytes, durationMs: CANDIDATE_MS, targetHz: TARGET_HZ};
      log(`testing ${matrixSize}×${matrixSize} · ${payloadBytes} B/frame · target gross ${formatRate(payloadBytes * TARGET_HZ)}`);
      const sender = await renderCandidate(config);
      await sleep(200);
      const receiver = await collectReceiverResult(config.id);
      const stability = Math.min(1, receiver.validRatio / 0.90);
      const selectionScore = receiver.uniquePayloadBytesPerSecond * stability;
      results.push({...receiver, renderedFrames: sender.renderedFrames, senderActualHz: sender.actualHz, grossTargetBytesPerSecond: payloadBytes * TARGET_HZ, selectionScore});
      log(`${matrixSize}×${matrixSize}: ${formatRate(receiver.uniquePayloadBytesPerSecond)} · valid ${(receiver.validRatio * 100).toFixed(1)}% · decode p95 ${receiver.totalDecodeP95Ms.toFixed(1)} ms`);
      drawAlignmentPattern();
      await sleep(600);
    }
    const best = results.reduce<(typeof results)[number] | null>((winner, candidate) => !winner || candidate.selectionScore > winner.selectionScore ? candidate : winner, null);
    const run = {
      schema: 'optilink.tf006.optigrid-v1.physical.v1',
      kind: 'optigrid-v1-physical-calibration',
      evidenceClass: 'performance-experiment',
      status: aborted ? 'ABORTED' : best ? 'PHYSICAL_GATE_COMPLETE' : 'NO_VALID_CANDIDATE',
      startedBy: 'receiver-one-click',
      finishedAt: new Date().toISOString(),
      sender: senderMetadata,
      receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, targetOpticalVisualUpdateHz: TARGET_HZ},
      carrier: {
        name: 'OptiGrid v1', modulation: 'monochrome 1-bit cells', renderPixels: RENDER_PIXELS,
        receiverPipeline: 'central-square acquisition -> tracked geometry validation -> subpixel bilinear 5-point fast decode',
        integrity: 'per-frame CRC32 + deterministic receiver-side payload oracle',
      },
      candidates: results,
      best,
      target: {netGoodputBytesPerSecond: 100000, note: 'this short physical gate measures raw unique optical ingress, not final file Net Goodput'},
      controlPlane: 'WebSocket carries candidate configuration and telemetry only; frame payload bytes remain screen→camera optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'tf006-finished', status: run.status});
    log(best ? `TF-006 complete · selected ${best.matrixSize}×${best.matrixSize} · ${formatRate(best.uniquePayloadBytesPerSecond)} raw unique ingress.` : 'TF-006 completed without a valid candidate.');
  } catch (error) {
    senderRunning = false;
    send({type: 'command', action: 'tf006-finished', status: 'ERROR'});
    log(`TF-006 failed: ${String(error)}`);
  }
}

function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf006-${role}`}); log(`coordinator connected as tf006-${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (role === 'sender' && message.type === 'telemetry' && message.telemetry?.transport === 'optigrid-v1-physical') { latestTelemetry = message.telemetry as Telemetry; return; }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-receiver-ready') { latestReceiverMetadata = message.receiver as ReceiverMetadata; void runPhysicalGate(); return; }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-config') {
      const config = message.config as CandidateConfig;
      resetCandidate(config);
      latestReceiverMetadata = captureReceiverMetadata();
      send({type: 'state', event: 'tf006-config-ready', candidateId: config.id, receiver: latestReceiverMetadata});
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-config-ready') {
      const pending = pendingConfigAck;
      if (!pending || pending.id !== String(message.candidateId || '')) return;
      latestReceiverMetadata = message.receiver as ReceiverMetadata;
      clearTimeout(pending.timer); pendingConfigAck = null; pending.resolve(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-candidate-finish') {
      const metrics = currentMetrics();
      const candidateId = String(message.candidateId || '');
      if (metrics && metrics.id === candidateId) send({type: 'state', event: 'tf006-candidate-result', candidateId, metrics});
      resetCandidate(null);
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-candidate-result') {
      const pending = pendingResultAck;
      if (!pending || pending.id !== String(message.candidateId || '')) return;
      clearTimeout(pending.timer); pendingResultAck = null; pending.resolve(message.metrics as CandidateMetrics); return;
    }
    if (message.type === 'command' && message.action === 'tf006-stop') { aborted = true; senderRunning = false; return; }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-finished') {
      stopCamera(); startButton.disabled = false; stopButton.disabled = true; log(`TF-006 finished: ${message.status}. Camera stopped automatically.`); return;
    }
    if (message.type === 'server' && message.event === 'result-saved') log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
  });
}

async function receiverStart(): Promise<void> {
  resetCandidate(null);
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  startButton.disabled = true; stopButton.disabled = false;
  for (let remaining = Math.ceil(PREALIGN_MS / 1000); remaining > 0; remaining -= 1) {
    receiverStatus.textContent = `预对齐 ${remaining}s：让完整 OptiGrid 方阵落入绿色方框并尽量保持正对屏幕。\n随后 160×160 → 240×240 将自动运行。`;
    await sleep(1000);
    if (aborted) return;
  }
  send({type: 'state', event: 'tf006-receiver-ready', receiver: latestReceiverMetadata});
  log('Pre-alignment complete. Physical gate now runs automatically.');
}
function userStop(): void {
  aborted = true; senderRunning = false; send({type: 'command', action: 'tf006-stop'});
  if (role === 'receiver') stopCamera();
  startButton.disabled = false; stopButton.disabled = true; log('stopped by user');
}

startButton.addEventListener('click', () => {
  if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`));
});
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  roleTitle.textContent = 'TF-006 sender ready';
  roleText.textContent = '保持页面打开。手机点击一次 Start 后自动运行两个高密度候选。';
  startButton.hidden = true; stopButton.hidden = true;
} else if (role === 'receiver') {
  roleTitle.textContent = 'TF-006 receiver ready';
  roleText.textContent = '点击 Start 后有 6 秒预对齐时间，然后无需再操作。';
} else {
  roleTitle.textContent = 'Open role-specific TF-006 URLs';
  roleText.textContent = '电脑使用 ?role=sender，手机使用 ?role=receiver。';
  startButton.disabled = true;
}

drawAlignmentPattern();
connect();
