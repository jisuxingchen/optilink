import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';
import {homographyFromUnitSquare, mapHomography, quadInside, type Homography, type Quad} from './optigrid-geometry.ts';
import {
  calibrateLocalMesh,
  countMeshBitErrors,
  sampleCellWithMesh,
  type CellLumaSampler,
  type LocalMeshCalibration,
} from './optigrid-local-mesh.ts';

const PHYSICAL_HZ = 60;
const MAX_SENDER_CSS_PIXELS = 960;
const CAMERA_WORK_PIXELS = 1080;
const PREALIGN_MS = 6000;
const STATIC_SETTLE_MS = 900;
const STATIC_CAPTURE_GAP_MS = 100;
const DYNAMIC_MEASURE_MS = 5500;
const TRAINING_SEQUENCE = 0x4f505434; // OPT4
const STATIC_MATRICES = [48, 56, 64, 72, 80, 96, 120, 160, 240] as const;
const DYNAMIC_RATES = [10, 20, 30] as const;

type CalibrationLock = {quad: Quad; phaseX: number; phaseY: number; threshold: number; score: number; contrast: number};
type RenderGeometry = {backingPixels: number; cssPixels: number; devicePixelsPerCell: number; devicePixelRatio: number};
type StaticCalibration = {
  matrixSize: number;
  payloadBytesPerFrame: number;
  renderGeometry: RenderGeometry | null;
  globalScore: number;
  globalContrast: number;
  globalCenterErrors: number;
  legacyFivePointErrors: number;
  meshBitErrors: number;
  totalBits: number;
  meshBer: number;
  captureMeshErrors: number[];
  exactCaptures: number;
  qualified: boolean;
  calibrationMs: number;
  meshSummary: null | {
    gridSize: number;
    minScore: number;
    averageScore: number;
    minContrast: number;
    averageContrast: number;
    maxAbsPhaseX: number;
    maxAbsPhaseY: number;
    hottestTileErrors: number[];
  };
  lock: CalibrationLock | null;
};
type DynamicConfig = {id: string; matrixSize: number; targetHz: number; payloadBytes: number; durationMs: number};
type DynamicMetrics = {
  id: string; matrixSize: number; targetHz: number; payloadBytesPerFrame: number; attempts: number; validFrames: number;
  uniqueFrames: number; duplicateFrames: number; crcOrHeaderRejects: number; payloadMismatchRejects: number;
  transitionFramesIgnored: number; elapsedSeconds: number; validRatio: number; uniqueFramesPerSecond: number;
  uniquePayloadBytesPerSecond: number; decodeP95Ms: number; trainingBer: number;
  senderActualHz?: number; grossTargetBytesPerSecond?: number; selectionScore?: number;
};
type ReceiverMetadata = ReturnType<typeof captureReceiverMetadata>;
type Pending = {event: string; id: string; timer: number; resolve: (value: unknown) => void; reject: (error: Error) => void};
type ExpectedSample = {row: number; column: number; expected: number};

type CalibratedDecoder = {lock: CalibrationLock; mesh: LocalMeshCalibration};

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
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = CAMERA_WORK_PIXELS;
sampleCanvas.height = CAMERA_WORK_PIXELS;
const sampleContextMaybe = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContextMaybe) throw new Error('Canvas 2D context unavailable');
const sampleContext = sampleContextMaybe;

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
let dynamicDecoder: CalibratedDecoder | null = null;
let attempts = 0;
let validFrames = 0;
let duplicateFrames = 0;
let crcOrHeaderRejects = 0;
let payloadMismatchRejects = 0;
let transitionFramesIgnored = 0;
let sequences = new Set<number>();
let decodeTimes: number[] = [];
const calibratedDecoders = new Map<number, CalibratedDecoder>();
const calibrationBers = new Map<number, number>();
const senderRenderGeometry = new Map<number, RenderGeometry>();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
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
const formatRate = (value: number) => `${(value / 1000).toFixed(1)} KB/s`;
function log(message: string): void { labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 24000); }
function send(message: unknown): void { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

function captureReceiverMetadata() {
  const track = cameraStream?.getVideoTracks()[0];
  return {
    configuredDevice: 'moto razr 40 ultra', userAgent: navigator.userAgent, platform: navigator.platform || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    cameraSettings: track?.getSettings?.() || null, source: 'tf006-optigrid-v1-receiver-page-v4-mesh' as const,
    cameraWorkPixels: CAMERA_WORK_PIXELS,
    capturedAt: new Date().toISOString(),
  };
}
function captureSenderMetadata() {
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    renderMode: 'device-pixel-aligned per matrix',
    renderGeometry: Object.fromEntries(senderRenderGeometry.entries()),
    capturedAt: new Date().toISOString(),
  };
}
function luma(data: Uint8ClampedArray, offset: number): number { return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722; }
function sampleLumaBilinear(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x));
  const py = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const tx = px - x0, ty = py - y0, stride = image.width * 4;
  const o00 = y0 * stride + x0 * 4, o10 = y0 * stride + x1 * 4, o01 = y1 * stride + x0 * 4, o11 = y1 * stride + x1 * 4;
  const top = luma(image.data, o00) * (1 - tx) + luma(image.data, o10) * tx;
  const bottom = luma(image.data, o01) * (1 - tx) + luma(image.data, o11) * tx;
  return top * (1 - ty) + bottom * ty;
}
function captureCameraSquare(): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  const side = Math.min(video.videoWidth, video.videoHeight);
  const sx = (video.videoWidth - side) / 2;
  const sy = (video.videoHeight - side) / 2;
  sampleContext.imageSmoothingEnabled = false;
  // moto razr exposes a 1080-pixel short side, so this is a native 1080 -> 1080 crop with no resampling.
  sampleContext.drawImage(video, sx, sy, side, side, 0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
  return sampleContext.getImageData(0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
}

function trainingCells(matrixSize: number): Uint8Array {
  const payloadBytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, TRAINING_SEQUENCE, deterministicPayload(TRAINING_SEQUENCE, payloadBytes));
}
function axisQuad(size: number, scale: number, offsetX: number, offsetY: number): Quad {
  const side = size * scale, left = (size - side) / 2 + size * offsetX, top = (size - side) / 2 + size * offsetY;
  return {tl: {x: left, y: top}, tr: {x: left + side, y: top}, br: {x: left + side, y: top + side}, bl: {x: left, y: top + side}};
}
function cloneQuad(quad: Quad): Quad { return {tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl}}; }
function expectedSamples(matrixSize: number, cells: Uint8Array, fine: boolean): ExpectedSample[] {
  const target = fine ? 44 : 24;
  const stride = Math.max(1, Math.floor(matrixSize / target));
  const samples: ExpectedSample[] = [];
  for (let row = 0; row < matrixSize; row += stride) for (let column = 0; column < matrixSize; column += stride) samples.push({row, column, expected: cells[row * matrixSize + column]});
  return samples;
}
function evaluateKnown(image: ImageData, matrixSize: number, quad: Quad, cells: Uint8Array, phaseX: number, phaseY: number, fine: boolean): CalibrationLock | null {
  if (!quadInside(quad, image.width, image.height, image.width * image.height * 0.05)) return null;
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const samples = expectedSamples(matrixSize, cells, fine);
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  const values: number[] = [];
  for (const sample of samples) {
    const point = mapHomography(h, (sample.column + 0.5 + phaseX) / matrixSize, (sample.row + 0.5 + phaseY) / matrixSize);
    const value = sampleLumaBilinear(image, point.x, point.y);
    values.push(value);
    if (sample.expected) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount, whiteMean = whiteSum / whiteCount, contrast = whiteMean - blackMean;
  if (!(contrast > 0)) return null;
  const threshold = (blackMean + whiteMean) / 2;
  let matches = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if ((values[index] < threshold ? 1 : 0) === samples[index].expected) matches += 1;
  }
  return {quad, phaseX, phaseY, threshold, score: matches / samples.length, contrast};
}
const lockObjective = (lock: CalibrationLock) => lock.score * 1000 + Math.min(160, Math.max(0, lock.contrast));
function refineCorners(image: ImageData, matrixSize: number, cells: Uint8Array, initial: CalibrationLock): CalibrationLock {
  let best = initial;
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  for (const step of [10, 5, 2.5, 1.25, 0.5]) {
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) for (const axis of ['x', 'y'] as const) for (const direction of [-1, 1]) {
        const quad = cloneQuad(best.quad);
        quad[corner][axis] += step * direction;
        const candidate = evaluateKnown(image, matrixSize, quad, cells, best.phaseX, best.phaseY, true);
        if (candidate && lockObjective(candidate) > lockObjective(best) + 0.02) { best = candidate; improved = true; }
      }
      if (!improved) break;
    }
  }
  return best;
}
function acquireTrainingLock(image: ImageData, matrixSize: number, cells: Uint8Array): CalibrationLock | null {
  let best: CalibrationLock | null = null;
  for (const scale of [0.58, 0.64, 0.70, 0.76, 0.82, 0.88, 0.94]) for (const offsetX of [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]) for (const offsetY of [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]) {
    const candidate = evaluateKnown(image, matrixSize, axisQuad(image.width, scale, offsetX, offsetY), cells, 0, 0, false);
    if (candidate && (!best || lockObjective(candidate) > lockObjective(best))) best = candidate;
  }
  if (!best || best.contrast < 10 || best.score < 0.54) return null;
  best = refineCorners(image, matrixSize, cells, best);
  let phaseBest = best;
  for (let px = -0.5; px <= 0.5001; px += 0.1) for (let py = -0.5; py <= 0.5001; py += 0.1) {
    const candidate = evaluateKnown(image, matrixSize, best.quad, cells, Number(px.toFixed(2)), Number(py.toFixed(2)), true);
    if (candidate && lockObjective(candidate) > lockObjective(phaseBest)) phaseBest = candidate;
  }
  return refineCorners(image, matrixSize, cells, phaseBest);
}
function makeSampler(image: ImageData, matrixSize: number, lock: CalibrationLock): CellLumaSampler | null {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return null;
  return (cellX, cellY) => {
    const point = mapHomography(h, cellX / matrixSize, cellY / matrixSize);
    return sampleLumaBilinear(image, point.x, point.y);
  };
}
function countGlobalCenterErrors(image: ImageData, matrixSize: number, lock: CalibrationLock, expected: Uint8Array): {errors: number; bits: number} {
  const sampler = makeSampler(image, matrixSize, lock);
  if (!sampler) return {errors: Number.MAX_SAFE_INTEGER, bits: 0};
  let errors = 0, bits = 0;
  for (let row = 10; row < matrixSize - 10; row += 1) for (let column = 10; column < matrixSize - 10; column += 1) {
    const observed = sampler(column + 0.5 + lock.phaseX, row + 0.5 + lock.phaseY) < lock.threshold ? 1 : 0;
    if (observed !== expected[row * matrixSize + column]) errors += 1;
    bits += 1;
  }
  return {errors, bits};
}
function countLegacyFivePointErrors(image: ImageData, matrixSize: number, lock: CalibrationLock, expected: Uint8Array): number {
  const sampler = makeSampler(image, matrixSize, lock);
  if (!sampler) return Number.MAX_SAFE_INTEGER;
  const offsets: ReadonlyArray<readonly [number, number]> = [[0, 0], [-0.16, 0], [0.16, 0], [0, -0.16], [0, 0.16]];
  let errors = 0;
  for (let row = 10; row < matrixSize - 10; row += 1) for (let column = 10; column < matrixSize - 10; column += 1) {
    let black = 0;
    for (const [dx, dy] of offsets) if (sampler(column + 0.5 + lock.phaseX + dx, row + 0.5 + lock.phaseY + dy) < lock.threshold) black += 1;
    if ((black >= 3 ? 1 : 0) !== expected[row * matrixSize + column]) errors += 1;
  }
  return errors;
}
function decodeWithMesh(image: ImageData, matrixSize: number, decoder: CalibratedDecoder): ReturnType<typeof decodeFrameCellsV1> {
  const sampler = makeSampler(image, matrixSize, decoder.lock);
  if (!sampler) return null;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 10; row < matrixSize - 10; row += 1) for (let column = 10; column < matrixSize - 10; column += 1) {
    cells[row * matrixSize + column] = sampleCellWithMesh(sampler, decoder.mesh, row, column);
  }
  return decodeFrameCellsV1(cells, matrixSize);
}

async function calibrateStatic(matrixSize: number): Promise<StaticCalibration> {
  const started = performance.now();
  const expected = trainingCells(matrixSize);
  const payloadBytesPerFrame = payloadCapacityForMatrixV1(matrixSize);
  const fail = (): StaticCalibration => ({matrixSize, payloadBytesPerFrame, renderGeometry: null, globalScore: 0, globalContrast: 0, globalCenterErrors: Number.MAX_SAFE_INTEGER, legacyFivePointErrors: Number.MAX_SAFE_INTEGER, meshBitErrors: Number.MAX_SAFE_INTEGER, totalBits: 0, meshBer: 1, captureMeshErrors: [], exactCaptures: 0, qualified: false, calibrationMs: performance.now() - started, meshSummary: null, lock: null});
  const first = captureCameraSquare();
  if (!first) return fail();
  const lock = acquireTrainingLock(first, matrixSize, expected);
  if (!lock) return fail();
  const firstSampler = makeSampler(first, matrixSize, lock);
  if (!firstSampler) return fail();
  const global = countGlobalCenterErrors(first, matrixSize, lock, expected);
  const legacyFivePointErrors = countLegacyFivePointErrors(first, matrixSize, lock, expected);
  const mesh = calibrateLocalMesh(firstSampler, expected, matrixSize, {border: 10});
  const captureMeshErrors: number[] = [];
  let totalBits = 0;
  let hottestTileErrors: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    if (index) await sleep(STATIC_CAPTURE_GAP_MS);
    const image = captureCameraSquare();
    if (!image) continue;
    const sampler = makeSampler(image, matrixSize, lock);
    if (!sampler) continue;
    const measured = countMeshBitErrors(sampler, expected, mesh);
    captureMeshErrors.push(measured.errors);
    totalBits = measured.bits;
    if (!hottestTileErrors.length || measured.errors === Math.min(...captureMeshErrors)) hottestTileErrors = [...measured.tileErrors].sort((a, b) => b - a).slice(0, 10);
  }
  const meshBitErrors = captureMeshErrors.length ? Math.min(...captureMeshErrors) : Number.MAX_SAFE_INTEGER;
  const exactCaptures = captureMeshErrors.filter(value => value === 0).length;
  const meshBer = totalBits && Number.isFinite(meshBitErrors) ? meshBitErrors / totalBits : 1;
  const qualified = exactCaptures >= 2;
  const result: StaticCalibration = {
    matrixSize,
    payloadBytesPerFrame,
    renderGeometry: senderRenderGeometry.get(matrixSize) || null,
    globalScore: lock.score,
    globalContrast: lock.contrast,
    globalCenterErrors: global.errors,
    legacyFivePointErrors,
    meshBitErrors,
    totalBits,
    meshBer,
    captureMeshErrors,
    exactCaptures,
    qualified,
    calibrationMs: performance.now() - started,
    meshSummary: {
      gridSize: mesh.gridSize,
      minScore: mesh.minScore,
      averageScore: mesh.averageScore,
      minContrast: mesh.minContrast,
      averageContrast: mesh.averageContrast,
      maxAbsPhaseX: mesh.maxAbsPhaseX,
      maxAbsPhaseY: mesh.maxAbsPhaseY,
      hottestTileErrors,
    },
    lock,
  };
  calibratedDecoders.set(matrixSize, {lock, mesh});
  calibrationBers.set(matrixSize, meshBer);
  receiverStatus.textContent = `STATIC ${matrixSize}×${matrixSize}\nglobal center ${global.errors}/${global.bits} · legacy5 ${legacyFivePointErrors}/${global.bits}\nmesh ${captureMeshErrors.join(' / ')} · best BER ${(meshBer * 100).toFixed(5)}%\nmesh score avg ${(mesh.averageScore * 100).toFixed(1)}% min ${(mesh.minScore * 100).toFixed(1)}%\nphase max ±${Math.max(mesh.maxAbsPhaseX, mesh.maxAbsPhaseY).toFixed(2)} cell · ${qualified ? 'QUALIFIED' : 'NOT EXACT'}`;
  return result;
}

function resetDynamic(config: DynamicConfig): void {
  currentDynamic = config;
  currentDynamicStartedAt = performance.now();
  dynamicDecoder = calibratedDecoders.get(config.matrixSize) || null;
  attempts = validFrames = duplicateFrames = crcOrHeaderRejects = payloadMismatchRejects = transitionFramesIgnored = 0;
  sequences = new Set<number>();
  decodeTimes = [];
}
function currentDynamicMetrics(): DynamicMetrics | null {
  const config = currentDynamic;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - currentDynamicStartedAt) / 1000);
  return {
    id: config.id, matrixSize: config.matrixSize, targetHz: config.targetHz, payloadBytesPerFrame: config.payloadBytes,
    attempts, validFrames, uniqueFrames: sequences.size, duplicateFrames, crcOrHeaderRejects, payloadMismatchRejects,
    transitionFramesIgnored, elapsedSeconds, validRatio: attempts ? validFrames / attempts : 0,
    uniqueFramesPerSecond: sequences.size / elapsedSeconds,
    uniquePayloadBytesPerSecond: sequences.size * config.payloadBytes / elapsedSeconds,
    decodeP95Ms: percentile(decodeTimes, 0.95), trainingBer: calibrationBers.get(config.matrixSize) ?? 1,
  };
}
async function scanDynamicFrame(): Promise<void> {
  const config = currentDynamic, decoder = dynamicDecoder;
  if (!scanning || !config || !decoder) return;
  const image = captureCameraSquare();
  if (!image) return;
  const started = performance.now();
  const decoded = decodeWithMesh(image, config.matrixSize, decoder);
  decodeTimes.push(performance.now() - started);
  if (decoded?.sequence === TRAINING_SEQUENCE) { transitionFramesIgnored += 1; return; }
  attempts += 1;
  if (!decoded) crcOrHeaderRejects += 1;
  else if (!sameBytes(decoded.payload, deterministicPayload(decoded.sequence, decoded.payload.length))) payloadMismatchRejects += 1;
  else { validFrames += 1; if (sequences.has(decoded.sequence)) duplicateFrames += 1; else sequences.add(decoded.sequence); }
  const metrics = currentDynamicMetrics();
  if (metrics) receiverStatus.textContent = `DYNAMIC ${metrics.matrixSize}×${metrics.matrixSize} @ ${metrics.targetHz} Hz\nvalid ${metrics.validFrames}/${metrics.attempts} (${(metrics.validRatio * 100).toFixed(1)}%) · unique ${metrics.uniqueFrames}\nraw ingress ${formatRate(metrics.uniquePayloadBytesPerSecond)} · CRC/header ${metrics.crcOrHeaderRejects}\ndecode p95 ${metrics.decodeP95Ms.toFixed(1)} ms · training BER ${(metrics.trainingBer * 100).toFixed(5)}%`;
}
function scheduleCameraLoop(): void {
  if (!scanning) return;
  const source = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number};
  if (typeof source.requestVideoFrameCallback === 'function') source.requestVideoFrameCallback(() => { void scanDynamicFrame().finally(scheduleCameraLoop); });
  else requestAnimationFrame(() => { void scanDynamicFrame().finally(scheduleCameraLoop); });
}
async function startCamera(): Promise<void> {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}}});
  video.srcObject = cameraStream;
  await video.play();
  scanning = true;
  scheduleCameraLoop();
}
function stopCamera(): void { scanning = false; cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; video.srcObject = null; }

function chooseRenderGeometry(matrixSize: number): RenderGeometry {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const availableCss = Math.max(240, Math.min(MAX_SENDER_CSS_PIXELS, window.innerWidth * 0.98, window.innerHeight * 0.98));
  const availableDevice = Math.max(matrixSize, Math.floor(availableCss * dpr));
  const devicePixelsPerCell = Math.max(2, Math.floor(availableDevice / matrixSize));
  const backingPixels = matrixSize * devicePixelsPerCell;
  const cssPixels = backingPixels / dpr;
  return {backingPixels, cssPixels, devicePixelsPerCell, devicePixelRatio: dpr};
}
function drawGrid(cells: Uint8Array, matrixSize: number): RenderGeometry {
  const geometry = chooseRenderGeometry(matrixSize);
  if (gridCanvas.width !== geometry.backingPixels) gridCanvas.width = geometry.backingPixels;
  if (gridCanvas.height !== geometry.backingPixels) gridCanvas.height = geometry.backingPixels;
  gridCanvas.style.width = `${geometry.cssPixels}px`;
  gridCanvas.style.height = `${geometry.cssPixels}px`;
  const context = gridCanvas.getContext('2d', {alpha: false});
  if (!context) return geometry;
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#fff'; context.fillRect(0, 0, geometry.backingPixels, geometry.backingPixels);
  context.fillStyle = '#000';
  const cell = geometry.devicePixelsPerCell;
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    if (cells[row * matrixSize + column]) context.fillRect(column * cell, row * cell, cell, cell);
  }
  senderRenderGeometry.set(matrixSize, geometry);
  return geometry;
}
const drawStatic = (matrixSize: number) => drawGrid(trainingCells(matrixSize), matrixSize);

function waitState(event: string, id: string, timeoutMs = 20000): Promise<unknown> {
  if (pending) throw new Error(`pending state already active: ${pending.event}`);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { pending = null; reject(new Error(`${event} timed out`)); }, timeoutMs);
    pending = {event, id, timer, resolve, reject};
  });
}
function resolvePending(message: any): boolean {
  if (!pending || message.type !== 'state' || message.event !== pending.event || String(message.id || '') !== pending.id) return false;
  clearTimeout(pending.timer);
  const resolve = pending.resolve;
  pending = null;
  resolve(message.value);
  return true;
}
async function senderStaticCalibration(matrixSize: number): Promise<StaticCalibration> {
  const id = `static-${matrixSize}-${Date.now().toString(36)}`;
  const geometry = drawStatic(matrixSize);
  const ready = waitState('tf006v4-static-ready', id);
  send({type: 'command', action: 'tf006v4-static-config', id, matrixSize, renderGeometry: geometry});
  await ready;
  await sleep(STATIC_SETTLE_MS);
  const response = waitState('tf006v4-calibrated', id, 30000);
  send({type: 'command', action: 'tf006v4-calibrate', id, matrixSize});
  const value = await response as StaticCalibration;
  value.renderGeometry = geometry;
  return value;
}
async function renderDynamic(config: DynamicConfig): Promise<{renderedFrames: number; actualHz: number; metrics: DynamicMetrics}> {
  const ready = waitState('tf006v4-dynamic-ready', config.id);
  send({type: 'command', action: 'tf006v4-dynamic-start', id: config.id, config});
  await ready;
  senderRunning = true;
  const started = performance.now();
  let renderedFrames = 0, nextChange = started;
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
  const resultWait = waitState('tf006v4-dynamic-result', config.id);
  send({type: 'command', action: 'tf006v4-dynamic-finish', id: config.id});
  return {renderedFrames, actualHz: renderedFrames / elapsed, metrics: await resultWait as DynamicMetrics};
}
async function runSenderExperiment(): Promise<void> {
  aborted = false;
  const staticCalibrations: StaticCalibration[] = [];
  const dynamicCandidates: DynamicMetrics[] = [];
  try {
    log('TF-006B started: native camera pixels + device-pixel-aligned sender + local mesh calibration.');
    for (const matrixSize of STATIC_MATRICES) {
      if (aborted) break;
      senderStatus.textContent = `STATIC TRAINING ${matrixSize}×${matrixSize}\nDevice-pixel-aligned raster; Receiver sees camera pixels only.`;
      const result = await senderStaticCalibration(matrixSize);
      staticCalibrations.push(result);
      log(`static ${matrixSize}: center ${result.globalCenterErrors}/${result.totalBits} · legacy5 ${result.legacyFivePointErrors} · mesh ${(result.meshBer * 100).toFixed(5)}% · exact ${result.exactCaptures}/3`);
      await sleep(180);
    }
    const exact = staticCalibrations.filter(item => item.qualified).sort((a, b) => b.matrixSize - a.matrixSize);
    const spatialBest = exact[0] || [...staticCalibrations].sort((a, b) => a.meshBer - b.meshBer || b.matrixSize - a.matrixSize)[0] || null;
    if (spatialBest?.qualified && !aborted) {
      log(`largest exact static matrix ${spatialBest.matrixSize}; running 10/20/30 Hz dynamic CRC sweep.`);
      for (const targetHz of DYNAMIC_RATES) {
        if (aborted) break;
        const payloadBytes = payloadCapacityForMatrixV1(spatialBest.matrixSize);
        const config: DynamicConfig = {id: `dyn-${spatialBest.matrixSize}-${targetHz}-${Date.now().toString(36)}`, matrixSize: spatialBest.matrixSize, targetHz, payloadBytes, durationMs: DYNAMIC_MEASURE_MS};
        const rendered = await renderDynamic(config);
        const metrics = rendered.metrics;
        metrics.senderActualHz = rendered.actualHz;
        metrics.grossTargetBytesPerSecond = payloadBytes * targetHz;
        metrics.selectionScore = metrics.uniquePayloadBytesPerSecond * Math.min(1, metrics.validRatio / 0.90);
        dynamicCandidates.push(metrics);
        log(`dynamic ${spatialBest.matrixSize}@${targetHz}: ${formatRate(metrics.uniquePayloadBytesPerSecond)} · valid ${(metrics.validRatio * 100).toFixed(1)}%`);
        drawStatic(spatialBest.matrixSize);
        await sleep(400);
      }
    } else log('No exact mesh-calibrated static matrix; dynamic sweep skipped.');
    const best = dynamicCandidates.reduce<DynamicMetrics | null>((winner, item) => !winner || (item.selectionScore || 0) > (winner.selectionScore || 0) ? item : winner, null);
    const run = {
      schema: 'optilink.tf006.optigrid-v1.physical.v4',
      kind: 'device-pixel-aligned-local-mesh-frontier',
      evidenceClass: 'performance-experiment',
      status: aborted ? 'ABORTED' : spatialBest?.qualified ? 'MESH_FRONTIER_AND_DYNAMIC_COMPLETE' : 'MESH_FRONTIER_COMPLETE_NO_EXACT_MATRIX',
      finishedAt: new Date().toISOString(),
      sender: captureSenderMetadata(), receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, dynamicRatesHz: DYNAMIC_RATES},
      carrier: {
        name: 'OptiGrid v1', modulation: 'monochrome 1-bit cells',
        receiverPipeline: 'native 1080 camera crop -> global homography -> local phase/threshold mesh -> center sample -> CRC',
        senderPipeline: 'matrix-aligned backing raster -> CSS size backing/devicePixelRatio -> physical display',
        calibrationBoundary: 'Receiver locally regenerates public training pattern; no sender payload/cells/raw frame/geometry crosses WebSocket',
      },
      staticCalibrations, spatialBest, candidates: dynamicCandidates, best,
      target: {netGoodputBytesPerSecond: 100000, note: 'v4 remains calibration/performance evidence, not final file Net Goodput'},
      controlPlane: 'WebSocket carries control/telemetry only; training and dynamic frame pixels travel screen→camera optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'tf006v4-finished', status: run.status});
    log(`TF-006B complete · ${run.status}`);
  } catch (error) {
    senderRunning = false;
    send({type: 'command', action: 'tf006v4-finished', status: 'ERROR'});
    log(`TF-006B failed: ${String(error)}`);
  }
}
async function receiverStart(): Promise<void> {
  startButton.disabled = true;
  stopButton.disabled = false;
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  for (let remaining = Math.ceil(PREALIGN_MS / 1000); remaining > 0; remaining -= 1) {
    receiverStatus.textContent = `PREALIGN ${remaining}s\nKeep the complete grid inside the green reticle.\nThen keep the phone fixed.`;
    await sleep(1000);
  }
  latestReceiverMetadata = captureReceiverMetadata();
  send({type: 'state', event: 'tf006v4-receiver-ready', receiver: latestReceiverMetadata});
  receiverStatus.textContent = 'READY · native-pixel mesh frontier running';
}
function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf006v4-${role}`}); log(`coordinator connected as tf006v4-${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (resolvePending(message)) return;
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006v4-receiver-ready') { latestReceiverMetadata = message.receiver as ReceiverMetadata; void runSenderExperiment(); return; }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v4-static-config') {
      const geometry = message.renderGeometry as RenderGeometry | undefined;
      if (geometry) senderRenderGeometry.set(Number(message.matrixSize), geometry);
      send({type: 'state', event: 'tf006v4-static-ready', id: String(message.id), value: true});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v4-calibrate') {
      const id = String(message.id), matrixSize = Number(message.matrixSize);
      void calibrateStatic(matrixSize).then(value => send({type: 'state', event: 'tf006v4-calibrated', id, value}));
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v4-dynamic-start') {
      const config = message.config as DynamicConfig;
      resetDynamic(config);
      send({type: 'state', event: 'tf006v4-dynamic-ready', id: config.id, value: true});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v4-dynamic-finish') {
      const id = String(message.id), value = currentDynamicMetrics();
      currentDynamic = null;
      send({type: 'state', event: 'tf006v4-dynamic-result', id, value});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006v4-finished') {
      stopCamera(); startButton.disabled = false; stopButton.disabled = true;
      receiverStatus.textContent += `\n\nFINISHED · ${String(message.status || '')}`;
    }
  });
}

if (role === 'sender') {
  roleTitle.textContent = 'Sender · waiting for phone';
  roleText.textContent = 'Device-pixel-aligned static optical training first; dynamic payload starts only after exact mesh decode.';
  startButton.disabled = true; stopButton.disabled = true; drawStatic(48);
} else if (role === 'receiver') {
  roleTitle.textContent = 'Receiver · one-click native-pixel mesh frontier';
  roleText.textContent = 'Receiver reads native camera pixels only. Training oracle calibrates local sampling phase/threshold after optical capture.';
  startButton.addEventListener('click', () => { void receiverStart().catch(error => { startButton.disabled = false; receiverStatus.textContent = `camera/calibration error: ${String(error)}`; }); });
  stopButton.addEventListener('click', () => { aborted = true; stopCamera(); send({type: 'command', action: 'tf006v4-abort'}); startButton.disabled = false; stopButton.disabled = true; });
} else {
  roleTitle.textContent = 'Choose sender or receiver URL'; roleText.textContent = 'Use launcher-generated role URLs.'; startButton.disabled = true;
}
connect();
