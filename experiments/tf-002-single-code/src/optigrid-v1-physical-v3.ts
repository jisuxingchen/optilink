import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';
import {homographyFromUnitSquare, mapHomography, quadInside, type Quad} from './optigrid-geometry.ts';

const PHYSICAL_HZ = 60;
const RENDER_PIXELS = 960;
const CAMERA_WORK_PIXELS = 960;
const PREALIGN_MS = 6000;
const STATIC_SETTLE_MS = 900;
const STATIC_CAPTURE_GAP_MS = 90;
const DYNAMIC_MEASURE_MS = 6000;
const TRAINING_SEQUENCE = 0x4f505433; // "OPT3"
const STATIC_MATRICES = [64, 80, 100, 120, 140, 160, 200, 240] as const;
const DYNAMIC_RATES = [10, 20, 30] as const;
const SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-0.16, 0], [0.16, 0], [0, -0.16], [0, 0.16],
];

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

type CalibrationLock = {
  quad: Quad;
  phaseX: number;
  phaseY: number;
  threshold: number;
  score: number;
  contrast: number;
};
type StaticCalibration = {
  matrixSize: number;
  payloadBytesPerFrame: number;
  score: number;
  contrast: number;
  phaseX: number;
  phaseY: number;
  bitErrors: number;
  totalBits: number;
  ber: number;
  captureBitErrors: number[];
  exactCaptures: number;
  qualified: boolean;
  calibrationMs: number;
  lock: CalibrationLock | null;
};
type DynamicConfig = {id: string; matrixSize: number; targetHz: number; payloadBytes: number; durationMs: number};
type DynamicMetrics = {
  id: string;
  matrixSize: number;
  targetHz: number;
  payloadBytesPerFrame: number;
  attempts: number;
  validFrames: number;
  uniqueFrames: number;
  duplicateFrames: number;
  crcOrHeaderRejects: number;
  payloadMismatchRejects: number;
  elapsedSeconds: number;
  validRatio: number;
  uniqueFramesPerSecond: number;
  uniquePayloadBytesPerSecond: number;
  decodeP95Ms: number;
  reservedScoreAverage: number;
  trainingBer: number;
  senderActualHz?: number;
  grossTargetBytesPerSecond?: number;
  selectionScore?: number;
};
type ReceiverMetadata = ReturnType<typeof captureReceiverMetadata>;
type Pending = {event: string; id: string; timer: number; resolve: (value: unknown) => void; reject: (error: Error) => void};

type ExpectedSample = {row: number; column: number; expected: number};

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let scanning = false;
let aborted = false;
let senderRunning = false;
let senderSequence = 1;
let latestReceiverMetadata: ReceiverMetadata | null = null;
let pending: Pending | null = null;
let currentDynamic: DynamicConfig | null = null;
let currentDynamicStartedAt = 0;
let dynamicLock: CalibrationLock | null = null;
let attempts = 0;
let validFrames = 0;
let duplicateFrames = 0;
let crcOrHeaderRejects = 0;
let payloadMismatchRejects = 0;
let sequences = new Set<number>();
let decodeTimes: number[] = [];
let reservedScoreSum = 0;
let reservedScoreCount = 0;
let calibrationLocks = new Map<number, CalibrationLock>();
let calibrationBers = new Map<number, number>();
let lastTelemetryAt = 0;

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
    source: 'tf006-optigrid-v1-receiver-page-v3' as const,
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

function trainingCells(matrixSize: number): Uint8Array {
  const payloadBytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, TRAINING_SEQUENCE, deterministicPayload(TRAINING_SEQUENCE, payloadBytes));
}
function axisQuad(size: number, scale: number, offsetX: number, offsetY: number): Quad {
  const side = size * scale;
  const left = (size - side) / 2 + size * offsetX;
  const top = (size - side) / 2 + size * offsetY;
  return {tl: {x: left, y: top}, tr: {x: left + side, y: top}, br: {x: left + side, y: top + side}, bl: {x: left, y: top + side}};
}
function cloneQuad(quad: Quad): Quad { return {tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl}}; }
function expectedSamples(matrixSize: number, cells: Uint8Array, density: 'coarse' | 'fine'): ExpectedSample[] {
  const target = density === 'coarse' ? 24 : 42;
  const stride = Math.max(1, Math.floor(matrixSize / target));
  const samples: ExpectedSample[] = [];
  for (let row = 0; row < matrixSize; row += stride) {
    for (let column = 0; column < matrixSize; column += stride) samples.push({row, column, expected: cells[row * matrixSize + column]});
  }
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    if (reservedCellValueV1(row, column, matrixSize) !== null && ((row + column) % Math.max(1, stride) === 0)) {
      samples.push({row, column, expected: cells[row * matrixSize + column]});
    }
  }
  return samples;
}
function evaluateKnown(
  image: ImageData,
  matrixSize: number,
  quad: Quad,
  cells: Uint8Array,
  phaseX: number,
  phaseY: number,
  density: 'coarse' | 'fine',
): CalibrationLock | null {
  if (!quadInside(quad, image.width, image.height, image.width * image.height * 0.05)) return null;
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const samples = expectedSamples(matrixSize, cells, density);
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  for (const sample of samples) {
    const point = mapHomography(h, (sample.column + 0.5 + phaseX) / matrixSize, (sample.row + 0.5 + phaseY) / matrixSize);
    const value = sampleLumaBilinear(image, point.x, point.y);
    if (sample.expected) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  if (contrast <= 0) return null;
  const threshold = (blackMean + whiteMean) / 2;
  let matches = 0;
  for (const sample of samples) {
    const point = mapHomography(h, (sample.column + 0.5 + phaseX) / matrixSize, (sample.row + 0.5 + phaseY) / matrixSize);
    const observed = sampleLumaBilinear(image, point.x, point.y) < threshold ? 1 : 0;
    if (observed === sample.expected) matches += 1;
  }
  return {quad, phaseX, phaseY, threshold, score: matches / samples.length, contrast};
}
function lockObjective(lock: CalibrationLock): number { return lock.score * 1000 + Math.min(120, Math.max(0, lock.contrast)); }
function refineCorners(image: ImageData, matrixSize: number, cells: Uint8Array, initial: CalibrationLock): CalibrationLock {
  let best = initial;
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  for (const step of [8, 4, 2, 1, 0.5]) {
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) for (const axis of ['x', 'y'] as const) for (const direction of [-1, 1]) {
        const quad = cloneQuad(best.quad);
        quad[corner][axis] += step * direction;
        const candidate = evaluateKnown(image, matrixSize, quad, cells, best.phaseX, best.phaseY, 'fine');
        if (candidate && lockObjective(candidate) > lockObjective(best) + 0.02) { best = candidate; improved = true; }
      }
      if (!improved) break;
    }
  }
  return best;
}
function acquireTrainingLock(image: ImageData, matrixSize: number, cells: Uint8Array): CalibrationLock | null {
  let best: CalibrationLock | null = null;
  for (const scale of [0.60, 0.66, 0.72, 0.78, 0.84, 0.90, 0.96]) {
    for (const offsetX of [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]) {
      for (const offsetY of [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]) {
        const candidate = evaluateKnown(image, matrixSize, axisQuad(image.width, scale, offsetX, offsetY), cells, 0, 0, 'coarse');
        if (candidate && (!best || lockObjective(candidate) > lockObjective(best))) best = candidate;
      }
    }
  }
  if (!best || best.contrast < 12 || best.score < 0.55) return null;
  best = refineCorners(image, matrixSize, cells, best);
  let phaseBest = best;
  for (let px = -0.4; px <= 0.4001; px += 0.1) for (let py = -0.4; py <= 0.4001; py += 0.1) {
    const candidate = evaluateKnown(image, matrixSize, best.quad, cells, Number(px.toFixed(2)), Number(py.toFixed(2)), 'fine');
    if (candidate && lockObjective(candidate) > lockObjective(phaseBest)) phaseBest = candidate;
  }
  return refineCorners(image, matrixSize, cells, phaseBest);
}
function sampleCell(image: ImageData, matrixSize: number, lock: CalibrationLock, row: number, column: number): number {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return 0;
  let blackVotes = 0;
  for (const [dx, dy] of SAMPLE_OFFSETS) {
    const point = mapHomography(
      h,
      (column + 0.5 + lock.phaseX + dx) / matrixSize,
      (row + 0.5 + lock.phaseY + dy) / matrixSize,
    );
    if (sampleLumaBilinear(image, point.x, point.y) < lock.threshold) blackVotes += 1;
  }
  return blackVotes >= 3 ? 1 : 0;
}
function fullInteriorBitErrors(image: ImageData, matrixSize: number, lock: CalibrationLock, expected: Uint8Array): {errors: number; bits: number} {
  let errors = 0, bits = 0;
  for (let row = 10; row < matrixSize - 10; row += 1) for (let column = 10; column < matrixSize - 10; column += 1) {
    const observed = sampleCell(image, matrixSize, lock, row, column);
    if (observed !== expected[row * matrixSize + column]) errors += 1;
    bits += 1;
  }
  return {errors, bits};
}
function decodeWithLock(image: ImageData, matrixSize: number, lock: CalibrationLock): ReturnType<typeof decodeFrameCellsV1> {
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    cells[row * matrixSize + column] = sampleCell(image, matrixSize, lock, row, column);
  }
  return decodeFrameCellsV1(cells, matrixSize);
}
function reservedScore(image: ImageData, matrixSize: number, lock: CalibrationLock): number {
  let matches = 0, total = 0;
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    const expected = reservedCellValueV1(row, column, matrixSize);
    if (expected === null || ((row + column) & 3) !== 0) continue;
    if (sampleCell(image, matrixSize, lock, row, column) === expected) matches += 1;
    total += 1;
  }
  return total ? matches / total : 0;
}

async function calibrateStatic(matrixSize: number): Promise<StaticCalibration> {
  const started = performance.now();
  const expected = trainingCells(matrixSize);
  const first = captureCameraSquare();
  if (!first) return {
    matrixSize, payloadBytesPerFrame: payloadCapacityForMatrixV1(matrixSize), score: 0, contrast: 0, phaseX: 0, phaseY: 0,
    bitErrors: Number.MAX_SAFE_INTEGER, totalBits: 0, ber: 1, captureBitErrors: [], exactCaptures: 0, qualified: false,
    calibrationMs: performance.now() - started, lock: null,
  };
  const lock = acquireTrainingLock(first, matrixSize, expected);
  if (!lock) return {
    matrixSize, payloadBytesPerFrame: payloadCapacityForMatrixV1(matrixSize), score: 0, contrast: 0, phaseX: 0, phaseY: 0,
    bitErrors: Number.MAX_SAFE_INTEGER, totalBits: 0, ber: 1, captureBitErrors: [], exactCaptures: 0, qualified: false,
    calibrationMs: performance.now() - started, lock: null,
  };
  const captureBitErrors: number[] = [];
  let totalBits = 0;
  for (let index = 0; index < 3; index += 1) {
    if (index) await sleep(STATIC_CAPTURE_GAP_MS);
    const image = captureCameraSquare();
    if (!image) continue;
    const measured = fullInteriorBitErrors(image, matrixSize, lock, expected);
    captureBitErrors.push(measured.errors);
    totalBits = measured.bits;
  }
  const bitErrors = captureBitErrors.length ? Math.min(...captureBitErrors) : Number.MAX_SAFE_INTEGER;
  const exactCaptures = captureBitErrors.filter(value => value === 0).length;
  const ber = totalBits && Number.isFinite(bitErrors) ? bitErrors / totalBits : 1;
  const result: StaticCalibration = {
    matrixSize,
    payloadBytesPerFrame: payloadCapacityForMatrixV1(matrixSize),
    score: lock.score,
    contrast: lock.contrast,
    phaseX: lock.phaseX,
    phaseY: lock.phaseY,
    bitErrors,
    totalBits,
    ber,
    captureBitErrors,
    exactCaptures,
    qualified: exactCaptures >= 2,
    calibrationMs: performance.now() - started,
    lock,
  };
  calibrationLocks.set(matrixSize, lock);
  calibrationBers.set(matrixSize, ber);
  receiverStatus.textContent = [
    `STATIC CALIBRATION ${matrixSize}×${matrixSize}`,
    `training score ${(lock.score * 100).toFixed(2)}% · contrast ${lock.contrast.toFixed(1)}`,
    `sub-cell phase x ${lock.phaseX.toFixed(2)} · y ${lock.phaseY.toFixed(2)}`,
    `bit errors ${captureBitErrors.join(' / ')} of ${totalBits} · best BER ${(ber * 100).toFixed(5)}%`,
    `exact captures ${exactCaptures}/3 · ${result.qualified ? 'QUALIFIED' : 'NOT EXACT'}`,
  ].join('\n');
  return result;
}

function resetDynamic(config: DynamicConfig): void {
  currentDynamic = config;
  currentDynamicStartedAt = performance.now();
  dynamicLock = calibrationLocks.get(config.matrixSize) || null;
  attempts = validFrames = duplicateFrames = crcOrHeaderRejects = payloadMismatchRejects = 0;
  sequences = new Set<number>();
  decodeTimes = [];
  reservedScoreSum = reservedScoreCount = 0;
}
function currentDynamicMetrics(): DynamicMetrics | null {
  const config = currentDynamic;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - currentDynamicStartedAt) / 1000);
  return {
    id: config.id,
    matrixSize: config.matrixSize,
    targetHz: config.targetHz,
    payloadBytesPerFrame: config.payloadBytes,
    attempts,
    validFrames,
    uniqueFrames: sequences.size,
    duplicateFrames,
    crcOrHeaderRejects,
    payloadMismatchRejects,
    elapsedSeconds,
    validRatio: attempts ? validFrames / attempts : 0,
    uniqueFramesPerSecond: sequences.size / elapsedSeconds,
    uniquePayloadBytesPerSecond: sequences.size * config.payloadBytes / elapsedSeconds,
    decodeP95Ms: percentile(decodeTimes, 0.95),
    reservedScoreAverage: reservedScoreCount ? reservedScoreSum / reservedScoreCount : 0,
    trainingBer: calibrationBers.get(config.matrixSize) ?? 1,
  };
}
async function scanDynamicFrame(): Promise<void> {
  const config = currentDynamic;
  const lock = dynamicLock;
  if (!scanning || !config || !lock) return;
  const image = captureCameraSquare();
  if (!image) return;
  attempts += 1;
  const started = performance.now();
  const pilot = reservedScore(image, config.matrixSize, lock);
  reservedScoreSum += pilot;
  reservedScoreCount += 1;
  const decoded = decodeWithLock(image, config.matrixSize, lock);
  decodeTimes.push(performance.now() - started);
  if (!decoded) crcOrHeaderRejects += 1;
  else if (!sameBytes(decoded.payload, deterministicPayload(decoded.sequence, decoded.payload.length))) payloadMismatchRejects += 1;
  else {
    validFrames += 1;
    if (sequences.has(decoded.sequence)) duplicateFrames += 1;
    else sequences.add(decoded.sequence);
  }
  const metrics = currentDynamicMetrics();
  if (metrics) {
    receiverStatus.textContent = [
      `DYNAMIC ${metrics.matrixSize}×${metrics.matrixSize} @ ${metrics.targetHz} Hz`,
      `valid ${metrics.validFrames}/${metrics.attempts} (${(metrics.validRatio * 100).toFixed(1)}%) · unique ${metrics.uniqueFrames}`,
      `raw ingress ${formatRate(metrics.uniquePayloadBytesPerSecond)} · CRC/header rejects ${metrics.crcOrHeaderRejects}`,
      `reserved ${(metrics.reservedScoreAverage * 100).toFixed(1)}% · decode p95 ${metrics.decodeP95Ms.toFixed(1)} ms`,
      `static training BER ${(metrics.trainingBer * 100).toFixed(5)}%`,
    ].join('\n');
    const now = performance.now();
    if (now - lastTelemetryAt > 400) { lastTelemetryAt = now; send({type: 'telemetry', telemetry: {transport: 'optigrid-v1-physical-v3', metrics, timestamp: now}}); }
  }
}
function scheduleCameraLoop(): void {
  if (!scanning) return;
  const source = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number};
  if (typeof source.requestVideoFrameCallback === 'function') source.requestVideoFrameCallback(() => { void scanDynamicFrame().finally(scheduleCameraLoop); });
  else requestAnimationFrame(() => { void scanDynamicFrame().finally(scheduleCameraLoop); });
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
    if (cells[row * matrixSize + column]) context.fillRect(column * cell, row * cell, cell + 0.01, cell + 0.01);
  }
}
function drawStatic(matrixSize: number): void { drawGrid(trainingCells(matrixSize), matrixSize); }

function waitState(event: string, id: string, timeoutMs = 12000): Promise<unknown> {
  if (pending) throw new Error(`pending state already active: ${pending.event}`);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { pending = null; reject(new Error(`${event} timed out`)); }, timeoutMs);
    pending = {event, id, timer, resolve, reject};
  });
}
function resolvePending(message: any): boolean {
  if (!pending || message.type !== 'state' || message.event !== pending.event || String(message.id || '') !== pending.id) return false;
  window.clearTimeout(pending.timer);
  const resolve = pending.resolve;
  pending = null;
  resolve(message.value);
  return true;
}
async function senderStaticCalibration(matrixSize: number): Promise<StaticCalibration> {
  const id = `static-${matrixSize}-${Date.now().toString(36)}`;
  drawStatic(matrixSize);
  send({type: 'command', action: 'tf006v3-static-config', id, matrixSize});
  await waitState('tf006v3-static-ready', id);
  await sleep(STATIC_SETTLE_MS);
  const response = waitState('tf006v3-calibrated', id, 20000);
  send({type: 'command', action: 'tf006v3-calibrate', id, matrixSize});
  return await response as StaticCalibration;
}
async function renderDynamic(config: DynamicConfig): Promise<{renderedFrames: number; actualHz: number}> {
  const ready = waitState('tf006v3-dynamic-ready', config.id);
  send({type: 'command', action: 'tf006v3-dynamic-start', id: config.id, config});
  await ready;
  senderRunning = true;
  const started = performance.now();
  let renderedFrames = 0;
  let nextChange = started;
  await new Promise<void>(resolve => {
    const frame = (now: number) => {
      if (!senderRunning || aborted || now - started >= config.durationMs) { resolve(); return; }
      if (now >= nextChange) {
        const sequence = senderSequence++ >>> 0;
        drawGrid(encodeFrameCellsV1(config.matrixSize, sequence, deterministicPayload(sequence, config.payloadBytes)), config.matrixSize);
        renderedFrames += 1;
        nextChange += 1000 / config.targetHz;
        if (nextChange < now - 1000 / config.targetHz) nextChange = now + 1000 / config.targetHz;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  senderRunning = false;
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  const resultWait = waitState('tf006v3-dynamic-result', config.id);
  send({type: 'command', action: 'tf006v3-dynamic-finish', id: config.id});
  const metrics = await resultWait as DynamicMetrics;
  return Object.assign({renderedFrames, actualHz: renderedFrames / elapsed}, {metrics}) as unknown as {renderedFrames: number; actualHz: number};
}

async function runSenderExperiment(): Promise<void> {
  aborted = false;
  const senderMetadata = captureSenderMetadata();
  const staticCalibrations: StaticCalibration[] = [];
  const dynamicCandidates: DynamicMetrics[] = [];
  try {
    log('TF-006 v3 started: static optical training frontier first; no payload bytes over network.');
    for (const matrixSize of STATIC_MATRICES) {
      if (aborted) break;
      senderStatus.textContent = `STATIC TRAINING ${matrixSize}×${matrixSize}\nknown optical training frame; receiver derives calibration from camera pixels`;
      const result = await senderStaticCalibration(matrixSize);
      staticCalibrations.push(result);
      log(`static ${matrixSize}: BER ${(result.ber * 100).toFixed(5)}% · exact ${result.exactCaptures}/3 · score ${(result.score * 100).toFixed(1)}%`);
      await sleep(180);
    }
    const exact = staticCalibrations.filter(item => item.qualified).sort((a, b) => b.matrixSize - a.matrixSize);
    const spatialBest = exact[0] || [...staticCalibrations].sort((a, b) => a.ber - b.ber || b.matrixSize - a.matrixSize)[0] || null;
    if (spatialBest?.qualified && !aborted) {
      log(`largest exact static matrix: ${spatialBest.matrixSize}; starting 10/20/30 Hz CRC sweep.`);
      for (const targetHz of DYNAMIC_RATES) {
        if (aborted) break;
        const payloadBytes = payloadCapacityForMatrixV1(spatialBest.matrixSize);
        const config: DynamicConfig = {
          id: `dyn-${spatialBest.matrixSize}-${targetHz}-${Date.now().toString(36)}`,
          matrixSize: spatialBest.matrixSize,
          targetHz,
          payloadBytes,
          durationMs: DYNAMIC_MEASURE_MS,
        };
        const rendered = await renderDynamic(config);
        const metrics = (rendered as unknown as {metrics: DynamicMetrics}).metrics;
        metrics.senderActualHz = rendered.actualHz;
        metrics.grossTargetBytesPerSecond = payloadBytes * targetHz;
        const stability = Math.min(1, metrics.validRatio / 0.90);
        metrics.selectionScore = metrics.uniquePayloadBytesPerSecond * stability;
        dynamicCandidates.push(metrics);
        log(`dynamic ${spatialBest.matrixSize}@${targetHz}: ${formatRate(metrics.uniquePayloadBytesPerSecond)} · valid ${(metrics.validRatio * 100).toFixed(1)}%`);
        drawStatic(spatialBest.matrixSize);
        await sleep(400);
      }
    } else {
      log('No matrix achieved 2/3 exact static captures. Dynamic sweep skipped; BER evidence is sufficient for next algorithm decision.');
    }
    const best = dynamicCandidates.reduce<DynamicMetrics | null>((winner, item) => !winner || (item.selectionScore || 0) > (winner.selectionScore || 0) ? item : winner, null);
    const run = {
      schema: 'optilink.tf006.optigrid-v1.physical.v3',
      kind: 'oracle-aided-optical-calibration-frontier',
      evidenceClass: 'performance-experiment',
      status: aborted ? 'ABORTED' : spatialBest?.qualified ? 'STATIC_FRONTIER_AND_DYNAMIC_COMPLETE' : 'STATIC_FRONTIER_COMPLETE_NO_EXACT_MATRIX',
      finishedAt: new Date().toISOString(),
      sender: senderMetadata,
      receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, dynamicRatesHz: DYNAMIC_RATES},
      carrier: {
        name: 'OptiGrid v1',
        modulation: 'monochrome 1-bit cells',
        renderPixels: RENDER_PIXELS,
        receiverPipeline: 'known optical training frame -> camera-pixel homography refine -> sub-cell phase search -> full interior BER -> qualified dynamic CRC decode',
        calibrationBoundary: 'receiver independently regenerates a public training pattern; sender payload/cells are never passed over WebSocket',
      },
      staticCalibrations,
      spatialBest,
      candidates: dynamicCandidates,
      best,
      target: {netGoodputBytesPerSecond: 100000, note: 'v3 is a calibration/performance experiment, not final file Net Goodput'},
      controlPlane: 'WebSocket carries control/telemetry only; all training and dynamic frame pixels travel screen→camera optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'tf006v3-finished', status: run.status});
    log(`TF-006 v3 complete · ${run.status}.`);
  } catch (error) {
    senderRunning = false;
    send({type: 'command', action: 'tf006v3-finished', status: 'ERROR'});
    log(`TF-006 v3 failed: ${String(error)}`);
  }
}

async function receiverStart(): Promise<void> {
  startButton.disabled = true;
  stopButton.disabled = false;
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  for (let remaining = Math.ceil(PREALIGN_MS / 1000); remaining > 0; remaining -= 1) {
    receiverStatus.textContent = `PREALIGN ${remaining}s\nKeep the complete OptiGrid square inside the green reticle.\nAfter this, do not move the phone.`;
    await sleep(1000);
  }
  latestReceiverMetadata = captureReceiverMetadata();
  send({type: 'state', event: 'tf006v3-receiver-ready', receiver: latestReceiverMetadata});
  receiverStatus.textContent = 'READY · automatic static calibration frontier running';
}

function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf006v3-${role}`}); log(`coordinator connected as tf006v3-${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (resolvePending(message)) return;
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006v3-receiver-ready') {
      latestReceiverMetadata = message.receiver as ReceiverMetadata;
      void runSenderExperiment();
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v3-static-config') {
      send({type: 'state', event: 'tf006v3-static-ready', id: String(message.id), value: true});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v3-calibrate') {
      const id = String(message.id);
      const matrixSize = Number(message.matrixSize);
      void calibrateStatic(matrixSize).then(value => send({type: 'state', event: 'tf006v3-calibrated', id, value}));
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v3-dynamic-start') {
      const config = message.config as DynamicConfig;
      resetDynamic(config);
      send({type: 'state', event: 'tf006v3-dynamic-ready', id: config.id, value: true});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v3-dynamic-finish') {
      const id = String(message.id);
      const value = currentDynamicMetrics();
      currentDynamic = null;
      send({type: 'state', event: 'tf006v3-dynamic-result', id, value});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v3-finished') {
      stopCamera();
      startButton.disabled = false;
      stopButton.disabled = true;
      receiverStatus.textContent += `\n\nFINISHED · ${String(message.status || '')}`;
    }
  });
}

if (role === 'sender') {
  roleTitle.textContent = 'Sender · waiting for phone';
  roleText.textContent = 'The sender first shows known optical training frames, then only runs dynamic payload if the camera proves an exact spatial working point.';
  startButton.disabled = true;
  stopButton.disabled = true;
  drawStatic(64);
} else if (role === 'receiver') {
  roleTitle.textContent = 'Receiver · one-click calibration frontier';
  roleText.textContent = 'Tap Start once. The receiver reads only camera pixels; the known training oracle is regenerated locally after optical capture.';
  startButton.addEventListener('click', () => { void receiverStart().catch(error => { startButton.disabled = false; receiverStatus.textContent = `camera/calibration error: ${String(error)}`; }); });
  stopButton.addEventListener('click', () => { aborted = true; stopCamera(); send({type: 'command', action: 'tf006v3-abort'}); startButton.disabled = false; stopButton.disabled = true; });
} else {
  roleTitle.textContent = 'Choose sender or receiver URL';
  roleText.textContent = 'Use the launcher-generated role-specific URLs for the physical gate.';
  startButton.disabled = true;
}

connect();
