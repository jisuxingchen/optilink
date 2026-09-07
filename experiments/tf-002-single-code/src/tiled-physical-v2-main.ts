import {homographyFromUnitSquare, mapHomography, quadInside, type Quad} from './optigrid-geometry.ts';
import {decodeFrameCellsV1, encodeFrameCellsV1, OPTIGRID_V1_BORDER, payloadCapacityForMatrixV1, reservedCellValueV1} from './optigrid-v1.ts';

const PHYSICAL_DISPLAY_HZ = 60;
const TILE_COUNT = 3;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 720;
const TILE_RENDER_PIXELS = 540;
const TILE_CENTERS = [330, 960, 1590] as const;
const TRAINING_MATRIX = 64;
const TRAINING_SETTLE_MS = 1400;
const CANDIDATE_SECONDS = 10;
const MIN_TRACK_SCORE = 0.68;
const MIN_TRACK_CONTRAST = 16;
const CANDIDATES = [
  {matrixSize: 80, targetHz: 30, reference: true},
  {matrixSize: 96, targetHz: 60, reference: false},
  {matrixSize: 112, targetHz: 45, reference: false},
  {matrixSize: 120, targetHz: 45, reference: false},
] as const;

type OrientationMode = 'native' | 'rotate180' | 'rotateCW' | 'rotateCCW';
type CandidateConfig = {
  id: string;
  matrixSize: number;
  targetHz: number;
  durationMs: number;
  payloadBytes: number;
  tileCount: 3;
  reference: boolean;
};
type Lock = {quad: Quad; phaseX: number; phaseY: number; threshold: number; score: number; contrast: number};
type TrainingTile = {tile: number; acquired: boolean; score: number; contrast: number; bitErrors: number; bits: number; lock: Lock | null};
type TrainingResult = {
  success: boolean;
  orientationMode: OrientationMode | null;
  sourceVideo: {width: number; height: number};
  normalizedFrame: {width: number; height: number};
  tiles: TrainingTile[];
  exactTiles: number;
  totalBitErrors: number;
  calibrationMs: number;
};
type TileState = {lock: Lock | null; reacquisitions: number; tracked: number};
type CandidateMetrics = {
  id: string;
  matrixSize: number;
  targetHz: number;
  reference: boolean;
  payloadBytesPerTile: number;
  elapsedSeconds: number;
  cameraFrames: number;
  attemptedTiles: number;
  validTiles: number;
  validTileRatio: number;
  completeFrames: number;
  completeFrameRatio: number;
  uniqueDecodedSymbols: number;
  uniqueSymbolsPerSecond: number;
  rawUniqueOpticalIngressBytesPerSecond: number;
  alignmentRejects: number;
  crcRejects: number;
  payloadMismatchRejects: number;
  transitionFramesIgnored: number;
  reacquisitions: number;
  trackedTiles: number;
  averageReservedScore: number;
  averageContrast: number;
  decodeP95Ms: number;
  averageFrameProcessMs: number;
  processingFramesPerSecond: number;
  cameraVideo: {width: number; height: number};
  normalizedFrame: {width: number; height: number};
};
type Pending = {event: string; id: string; timer: number; resolve: (value: unknown) => void; reject: (error: Error) => void};
type ExpectedSample = {row: number; column: number; expected: number};
type ReceiverMeta = ReturnType<typeof receiverMetadata>;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const roleValue = new URLSearchParams(location.search).get('role');
const role: 'sender' | 'receiver' | 'both' = roleValue === 'sender' || roleValue === 'receiver' ? roleValue : 'both';
const senderCanvas = $<HTMLCanvasElement>('senderCanvas');
const video = $<HTMLVideoElement>('camera');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const labStatus = $<HTMLPreElement>('labStatus');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
const progress = $<HTMLElement>('progress');
const roleTitle = $<HTMLElement>('roleTitle');
const roleText = $<HTMLElement>('roleText');
const receiverView = $<HTMLElement>('receiverView');

senderCanvas.width = FRAME_WIDTH;
senderCanvas.height = FRAME_HEIGHT;
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = SAMPLE_WIDTH;
sampleCanvas.height = SAMPLE_HEIGHT;
const sampleContextMaybe = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContextMaybe) throw new Error('sample canvas unavailable');
const sampleContext: CanvasRenderingContext2D = sampleContextMaybe;
const tileCanvas = document.createElement('canvas');

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let scanning = false;
let orientationMode: OrientationMode | null = null;
let trainingLocks: Lock[] | null = null;
let latestTraining: TrainingResult | null = null;
let activeCandidate: CandidateConfig | null = null;
let candidateStartedAt = 0;
let states: TileState[] = [];
let cameraFrames = 0;
let validTiles = 0;
let completeFrames = 0;
let alignmentRejects = 0;
let crcRejects = 0;
let payloadMismatchRejects = 0;
let transitionFramesIgnored = 0;
let scoreSum = 0;
let contrastSum = 0;
let scoreSamples = 0;
let processTimes: number[] = [];
let seen: Array<Set<number>> = [];
let senderRunning = false;
let senderFrameHandle = 0;
let senderSymbolBase = 1;
let aborted = false;
let pending: Pending | null = null;
let latestReceiverMeta: ReceiverMeta | null = null;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 26000);
}
function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
const formatRate = (value: number) => `${(value / 1000).toFixed(2)} KB/s`;
function payloadFor(sequence: number, length: number, tile: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 31 + tile * 47) & 255;
  }
  return output;
}
const trainingSequence = (tile: number) => (0x54463720 + tile) >>> 0;
function trainingCells(tile: number): Uint8Array {
  const bytes = payloadCapacityForMatrixV1(TRAINING_MATRIX);
  const sequence = trainingSequence(tile);
  return encodeFrameCellsV1(TRAINING_MATRIX, sequence, payloadFor(sequence, bytes, tile));
}
function receiverMetadata() {
  const track = cameraStream?.getVideoTracks()[0];
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    cameraSettings: track?.getSettings?.() || null,
    screenOrientation: screen.orientation?.type || 'unknown',
    normalizedOrientation: orientationMode,
    normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT},
    capturedAt: new Date().toISOString(),
    source: 'tf007-tiled-physical-receiver-v2' as const,
  };
}
function senderMetadata() {
  const rect = senderCanvas.getBoundingClientRect();
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_DISPLAY_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    canvasBacking: {width: senderCanvas.width, height: senderCanvas.height},
    canvasCss: {width: rect.width, height: rect.height},
    tileRenderPixels: TILE_RENDER_PIXELS,
    capturedAt: new Date().toISOString(),
  };
}
function luma(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}
function sampleLuma(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x));
  const py = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const tx = px - x0, ty = py - y0, stride = image.width * 4;
  const a = luma(image.data, y0 * stride + x0 * 4), b = luma(image.data, y0 * stride + x1 * 4);
  const c = luma(image.data, y1 * stride + x0 * 4), d = luma(image.data, y1 * stride + x1 * 4);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
function orientationCandidates(): OrientationMode[] {
  return video.videoWidth < video.videoHeight ? ['rotateCW', 'rotateCCW'] : ['native', 'rotate180'];
}
function captureNormalized(mode: OrientationMode): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  sampleCanvas.width = SAMPLE_WIDTH;
  sampleCanvas.height = SAMPLE_HEIGHT;
  sampleContext.setTransform(1, 0, 0, 1, 0, 0);
  sampleContext.fillStyle = '#eceff1';
  sampleContext.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.save();
  if (mode === 'native') {
    sampleContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  } else if (mode === 'rotate180') {
    sampleContext.translate(SAMPLE_WIDTH, SAMPLE_HEIGHT);
    sampleContext.rotate(Math.PI);
    sampleContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  } else if (mode === 'rotateCW') {
    sampleContext.translate(SAMPLE_WIDTH, 0);
    sampleContext.rotate(Math.PI / 2);
    sampleContext.drawImage(video, 0, 0, SAMPLE_HEIGHT, SAMPLE_WIDTH);
  } else {
    sampleContext.translate(0, SAMPLE_HEIGHT);
    sampleContext.rotate(-Math.PI / 2);
    sampleContext.drawImage(video, 0, 0, SAMPLE_HEIGHT, SAMPLE_WIDTH);
  }
  sampleContext.restore();
  return sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
}
function cloneQuad(q: Quad): Quad {
  return {tl: {...q.tl}, tr: {...q.tr}, br: {...q.br}, bl: {...q.bl}};
}
function cloneLock(lock: Lock): Lock {
  return {...lock, quad: cloneQuad(lock.quad)};
}
function laneRect(tile: number, width: number, height: number) {
  const laneWidth = width / TILE_COUNT;
  return {x: tile * laneWidth, y: 0, width: laneWidth, height};
}
function axisQuad(rect: {x: number; y: number; width: number; height: number}, scale: number, offsetX: number, offsetY: number): Quad {
  const side = Math.min(rect.width, rect.height) * scale;
  const cx = rect.x + rect.width / 2 + rect.width * offsetX;
  const cy = rect.y + rect.height / 2 + rect.height * offsetY;
  const left = cx - side / 2, top = cy - side / 2;
  return {tl: {x: left, y: top}, tr: {x: left + side, y: top}, br: {x: left + side, y: top + side}, bl: {x: left, y: top + side}};
}
function expectedSamples(matrixSize: number, cells: Uint8Array, fine: boolean): ExpectedSample[] {
  const target = fine ? 30 : 16;
  const stride = Math.max(1, Math.floor(matrixSize / target));
  const samples: ExpectedSample[] = [];
  for (let row = 0; row < matrixSize; row += stride) {
    for (let column = 0; column < matrixSize; column += stride) samples.push({row, column, expected: cells[row * matrixSize + column]});
  }
  return samples;
}
function evaluateKnown(image: ImageData, matrixSize: number, quad: Quad, cells: Uint8Array, phaseX: number, phaseY: number, fine: boolean): Lock | null {
  if (!quadInside(quad, image.width, image.height, image.width * image.height * 0.008)) return null;
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const samples = expectedSamples(matrixSize, cells, fine);
  const measured = new Float64Array(samples.length);
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const p = mapHomography(h, (s.column + 0.5 + phaseX) / matrixSize, (s.row + 0.5 + phaseY) / matrixSize);
    const value = sampleLuma(image, p.x, p.y);
    measured[i] = value;
    if (s.expected) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const black = blackSum / blackCount, white = whiteSum / whiteCount, contrast = white - black;
  if (!(contrast > 0)) return null;
  const threshold = (black + white) / 2;
  let matches = 0;
  for (let i = 0; i < samples.length; i += 1) if ((measured[i] < threshold ? 1 : 0) === samples[i].expected) matches += 1;
  return {quad, phaseX, phaseY, threshold, score: matches / samples.length, contrast};
}
const objective = (lock: Lock) => lock.score * 1000 + Math.min(160, Math.max(0, lock.contrast));
function refineKnown(image: ImageData, matrixSize: number, cells: Uint8Array, initial: Lock): Lock {
  let best = initial;
  for (const step of [8, 4, 2, 1]) {
    for (const corner of ['tl', 'tr', 'br', 'bl'] as const) {
      for (const axis of ['x', 'y'] as const) {
        for (const direction of [-1, 1]) {
          const quad = cloneQuad(best.quad);
          quad[corner][axis] += step * direction;
          const candidate = evaluateKnown(image, matrixSize, quad, cells, best.phaseX, best.phaseY, true);
          if (candidate && objective(candidate) > objective(best)) best = candidate;
        }
      }
    }
  }
  let phaseBest = best;
  for (const phaseX of [-0.3, -0.15, 0, 0.15, 0.3]) {
    for (const phaseY of [-0.3, -0.15, 0, 0.15, 0.3]) {
      const candidate = evaluateKnown(image, matrixSize, best.quad, cells, phaseX, phaseY, true);
      if (candidate && objective(candidate) > objective(phaseBest)) phaseBest = candidate;
    }
  }
  return phaseBest;
}
function acquireTrainingTile(image: ImageData, tile: number): Lock | null {
  const cells = trainingCells(tile);
  const rect = laneRect(tile, image.width, image.height);
  let best: Lock | null = null;
  for (const scale of [0.52, 0.62, 0.72, 0.82, 0.92]) {
    for (const offsetX of [-0.12, -0.06, 0, 0.06, 0.12]) {
      for (const offsetY of [-0.20, -0.10, 0, 0.10, 0.20]) {
        const candidate = evaluateKnown(image, TRAINING_MATRIX, axisQuad(rect, scale, offsetX, offsetY), cells, 0, 0, false);
        if (candidate && (!best || objective(candidate) > objective(best))) best = candidate;
      }
    }
  }
  if (!best || best.score < 0.56 || best.contrast < 10) return null;
  return refineKnown(image, TRAINING_MATRIX, cells, best);
}
function countTrainingErrors(image: ImageData, tile: number, lock: Lock): {errors: number; bits: number} {
  const expected = trainingCells(tile);
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return {errors: Number.MAX_SAFE_INTEGER, bits: 0};
  let errors = 0, bits = 0;
  for (let row = OPTIGRID_V1_BORDER; row < TRAINING_MATRIX - OPTIGRID_V1_BORDER; row += 1) {
    for (let column = OPTIGRID_V1_BORDER; column < TRAINING_MATRIX - OPTIGRID_V1_BORDER; column += 1) {
      const p = mapHomography(h, (column + 0.5 + lock.phaseX) / TRAINING_MATRIX, (row + 0.5 + lock.phaseY) / TRAINING_MATRIX);
      const observed = sampleLuma(image, p.x, p.y) < lock.threshold ? 1 : 0;
      if (observed !== expected[row * TRAINING_MATRIX + column]) errors += 1;
      bits += 1;
    }
  }
  return {errors, bits};
}
function calibrateMode(mode: OrientationMode): TrainingResult {
  const started = performance.now();
  const image = captureNormalized(mode);
  const tiles: TrainingTile[] = [];
  if (!image) return {success: false, orientationMode: mode, sourceVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0}, normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT}, tiles, exactTiles: 0, totalBitErrors: Number.MAX_SAFE_INTEGER, calibrationMs: performance.now() - started};
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const lock = acquireTrainingTile(image, tile);
    if (!lock) {
      tiles.push({tile, acquired: false, score: 0, contrast: 0, bitErrors: Number.MAX_SAFE_INTEGER, bits: 0, lock: null});
      continue;
    }
    const errors = countTrainingErrors(image, tile, lock);
    tiles.push({tile, acquired: true, score: lock.score, contrast: lock.contrast, bitErrors: errors.errors, bits: errors.bits, lock});
  }
  const acquired = tiles.filter(item => item.acquired).length;
  const exactTiles = tiles.filter(item => item.acquired && item.bitErrors === 0).length;
  const totalBitErrors = acquired === TILE_COUNT ? tiles.reduce((sum, item) => sum + item.bitErrors, 0) : Number.MAX_SAFE_INTEGER;
  return {success: acquired === TILE_COUNT, orientationMode: mode, sourceVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0}, normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT}, tiles, exactTiles, totalBitErrors, calibrationMs: performance.now() - started};
}
function trainingRank(result: TrainingResult): number {
  const acquired = result.tiles.filter(item => item.acquired).length;
  const finiteErrors = Number.isFinite(result.totalBitErrors) ? result.totalBitErrors : 1e9;
  const score = result.tiles.reduce((sum, item) => sum + item.score, 0);
  return acquired * 1e9 - finiteErrors * 1e5 + result.exactTiles * 1e6 + score * 1e4;
}
async function calibrateTraining(): Promise<TrainingResult> {
  let best: TrainingResult | null = null;
  for (const mode of orientationCandidates()) {
    const result = calibrateMode(mode);
    log(`orientation ${mode}: locks ${result.tiles.filter(item => item.acquired).length}/3 · exact ${result.exactTiles}/3 · errors ${Number.isFinite(result.totalBitErrors) ? result.totalBitErrors : 'n/a'}`);
    if (!best || trainingRank(result) > trainingRank(best)) best = result;
    await sleep(30);
  }
  if (!best) throw new Error('no training orientation result');
  orientationMode = best.orientationMode;
  trainingLocks = best.success ? best.tiles.map(item => item.lock ? cloneLock(item.lock) : null).filter((item): item is Lock => Boolean(item)) : null;
  latestTraining = best;
  latestReceiverMeta = receiverMetadata();
  receiverStatus.textContent = [
    `TRAINING orientation ${best.orientationMode || 'n/a'} · source ${best.sourceVideo.width}×${best.sourceVideo.height} → ${SAMPLE_WIDTH}×${SAMPLE_HEIGHT}`,
    `tile locks ${best.tiles.filter(item => item.acquired).length}/3 · exact ${best.exactTiles}/3 · total errors ${Number.isFinite(best.totalBitErrors) ? best.totalBitErrors : 'n/a'}`,
    ...best.tiles.map(item => `T${item.tile + 1}: ${item.acquired ? `score ${(item.score * 100).toFixed(1)}% · contrast ${item.contrast.toFixed(1)} · errors ${item.bitErrors}/${item.bits}` : 'NO LOCK'}`),
  ].join('\n');
  return best;
}

type ReservedSample = {row: number; column: number; expected: 0 | 1};
const reservedCache = new Map<number, ReservedSample[]>();
function reservedSamples(matrixSize: number): ReservedSample[] {
  const cached = reservedCache.get(matrixSize);
  if (cached) return cached;
  const samples: ReservedSample[] = [];
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reservedCellValueV1(row, column, matrixSize);
      if (expected === null) continue;
      const finder = (row < 9 || row >= matrixSize - 9) && (column < 9 || column >= matrixSize - 9);
      if (!finder && ((row * 7 + column * 11) % 5 !== 0)) continue;
      samples.push({row, column, expected: expected as 0 | 1});
    }
  }
  reservedCache.set(matrixSize, samples);
  return samples;
}
function evaluateReserved(image: ImageData, matrixSize: number, lock: Lock): Lock | null {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return null;
  const samples = reservedSamples(matrixSize);
  const measured = new Float64Array(samples.length);
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const p = mapHomography(h, (s.column + 0.5 + lock.phaseX) / matrixSize, (s.row + 0.5 + lock.phaseY) / matrixSize);
    const value = sampleLuma(image, p.x, p.y);
    measured[i] = value;
    if (s.expected) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const black = blackSum / blackCount, white = whiteSum / whiteCount, contrast = white - black;
  const threshold = (black + white) / 2;
  let matches = 0;
  for (let i = 0; i < samples.length; i += 1) if ((measured[i] < threshold ? 1 : 0) === samples[i].expected) matches += 1;
  return {...lock, threshold, score: matches / samples.length, contrast};
}
function refineReserved(image: ImageData, matrixSize: number, initial: Lock): Lock | null {
  let best = evaluateReserved(image, matrixSize, initial);
  if (!best) return null;
  for (const step of [2, 1]) {
    for (const corner of ['tl', 'tr', 'br', 'bl'] as const) {
      for (const axis of ['x', 'y'] as const) {
        for (const direction of [-1, 1]) {
          const candidateLock = cloneLock(best);
          candidateLock.quad[corner][axis] += step * direction;
          const candidate = evaluateReserved(image, matrixSize, candidateLock);
          if (candidate && objective(candidate) > objective(best)) best = candidate;
        }
      }
    }
  }
  return best;
}
function decodeTile(image: ImageData, matrixSize: number, lock: Lock) {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return null;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = OPTIGRID_V1_BORDER; row < matrixSize - OPTIGRID_V1_BORDER; row += 1) {
    for (let column = OPTIGRID_V1_BORDER; column < matrixSize - OPTIGRID_V1_BORDER; column += 1) {
      const p = mapHomography(h, (column + 0.5 + lock.phaseX) / matrixSize, (row + 0.5 + lock.phaseY) / matrixSize);
      cells[row * matrixSize + column] = sampleLuma(image, p.x, p.y) < lock.threshold ? 1 : 0;
    }
  }
  return decodeFrameCellsV1(cells, matrixSize);
}
function resetCandidate(config: CandidateConfig | null): void {
  activeCandidate = config;
  candidateStartedAt = performance.now();
  states = Array.from({length: TILE_COUNT}, (_, index) => ({lock: trainingLocks?.[index] ? cloneLock(trainingLocks[index]) : null, reacquisitions: 0, tracked: 0}));
  cameraFrames = validTiles = completeFrames = alignmentRejects = crcRejects = payloadMismatchRejects = transitionFramesIgnored = scoreSum = contrastSum = scoreSamples = 0;
  processTimes = [];
  seen = Array.from({length: TILE_COUNT}, () => new Set<number>());
  updateStatus();
}
function currentMetrics(): CandidateMetrics | null {
  const config = activeCandidate;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - candidateStartedAt) / 1000);
  const unique = seen.reduce((sum, set) => sum + set.size, 0);
  const averageFrameProcessMs = processTimes.length ? processTimes.reduce((sum, value) => sum + value, 0) / processTimes.length : 0;
  return {
    id: config.id, matrixSize: config.matrixSize, targetHz: config.targetHz, reference: config.reference, payloadBytesPerTile: config.payloadBytes,
    elapsedSeconds, cameraFrames, attemptedTiles: cameraFrames * TILE_COUNT, validTiles, validTileRatio: cameraFrames ? validTiles / (cameraFrames * TILE_COUNT) : 0,
    completeFrames, completeFrameRatio: cameraFrames ? completeFrames / cameraFrames : 0, uniqueDecodedSymbols: unique, uniqueSymbolsPerSecond: unique / elapsedSeconds,
    rawUniqueOpticalIngressBytesPerSecond: unique * config.payloadBytes / elapsedSeconds, alignmentRejects, crcRejects, payloadMismatchRejects, transitionFramesIgnored,
    reacquisitions: states.reduce((sum, state) => sum + state.reacquisitions, 0), trackedTiles: states.reduce((sum, state) => sum + state.tracked, 0),
    averageReservedScore: scoreSamples ? scoreSum / scoreSamples : 0, averageContrast: scoreSamples ? contrastSum / scoreSamples : 0,
    decodeP95Ms: percentile(processTimes, 0.95), averageFrameProcessMs, processingFramesPerSecond: cameraFrames / elapsedSeconds,
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0}, normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT},
  };
}
function updateStatus(): void {
  const metrics = currentMetrics();
  if (!metrics) { receiverStatus.textContent = latestTraining ? 'training locked · waiting for dynamic candidate' : 'camera ready · waiting for training'; return; }
  receiverStatus.textContent = [
    `${metrics.reference ? 'REFERENCE' : 'CANDIDATE'} 3×${metrics.matrixSize} @ ${metrics.targetHz} Hz · ${metrics.payloadBytesPerTile} B/tile`,
    `camera/process ${metrics.processingFramesPerSecond.toFixed(1)} fps · process avg ${metrics.averageFrameProcessMs.toFixed(1)} ms · p95 ${metrics.decodeP95Ms.toFixed(1)} ms`,
    `valid tiles ${metrics.validTiles}/${metrics.attemptedTiles} · ${(metrics.validTileRatio * 100).toFixed(1)}% · complete ${(metrics.completeFrameRatio * 100).toFixed(1)}%`,
    `unique symbols ${metrics.uniqueDecodedSymbols} · ${metrics.uniqueSymbolsPerSecond.toFixed(1)}/s`,
    `RAW optical ingress ${formatRate(metrics.rawUniqueOpticalIngressBytesPerSecond)}`,
    `rejects align ${metrics.alignmentRejects} · CRC ${metrics.crcRejects} · payload ${metrics.payloadMismatchRejects} · transition ${metrics.transitionFramesIgnored}`,
    `reserved ${(metrics.averageReservedScore * 100).toFixed(1)}% · contrast ${metrics.averageContrast.toFixed(1)} · reacquire ${metrics.reacquisitions}`,
    `orientation ${orientationMode || 'n/a'} · video ${metrics.cameraVideo.width}×${metrics.cameraVideo.height} → ${SAMPLE_WIDTH}×${SAMPLE_HEIGHT}`,
  ].join('\n');
  send({type: 'telemetry', telemetry: {transport: 'tf007-tiled-physical-v2', metrics, timestamp: performance.now()}});
}
function processFrame(): void {
  const config = activeCandidate;
  if (!scanning || !config || !orientationMode || !trainingLocks) return;
  const image = captureNormalized(orientationMode);
  if (!image) return;
  const started = performance.now();
  cameraFrames += 1;
  let frameValid = 0;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const state = states[tile];
    let lock = state.lock;
    if (!lock) {
      lock = cloneLock(trainingLocks[tile]);
      state.lock = lock;
    }
    let tracked = evaluateReserved(image, config.matrixSize, lock);
    if (!tracked || tracked.score < MIN_TRACK_SCORE || tracked.contrast < MIN_TRACK_CONTRAST) {
      const refined = refineReserved(image, config.matrixSize, lock);
      if (!refined || refined.score < MIN_TRACK_SCORE || refined.contrast < MIN_TRACK_CONTRAST) {
        alignmentRejects += 1;
        state.reacquisitions += 1;
        continue;
      }
      tracked = refined;
      state.reacquisitions += 1;
    }
    state.lock = tracked;
    state.tracked += 1;
    scoreSum += tracked.score;
    contrastSum += tracked.contrast;
    scoreSamples += 1;
    const decoded = decodeTile(image, config.matrixSize, tracked);
    if (!decoded) { crcRejects += 1; continue; }
    if (decoded.sequence >= trainingSequence(0) && decoded.sequence <= trainingSequence(2)) { transitionFramesIgnored += 1; continue; }
    const expected = payloadFor(decoded.sequence, decoded.payload.length, tile);
    if (!sameBytes(decoded.payload, expected)) { payloadMismatchRejects += 1; continue; }
    validTiles += 1;
    frameValid += 1;
    seen[tile].add(decoded.sequence);
  }
  if (frameValid === TILE_COUNT) completeFrames += 1;
  processTimes.push(performance.now() - started);
  if (processTimes.length > 1200) processTimes.shift();
  if (cameraFrames % 3 === 0) updateStatus();
}
function scheduleVideoLoop(): void {
  const source = video as HTMLVideoElement & {requestVideoFrameCallback?: (callback: () => void) => number};
  const tick = () => {
    if (!scanning) return;
    processFrame();
    if (source.requestVideoFrameCallback) source.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (source.requestVideoFrameCallback) source.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}
async function startCamera(): Promise<void> {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60, max: 60}}});
  video.srcObject = cameraStream;
  await video.play();
  scanning = true;
  scheduleVideoLoop();
}
function stopCamera(): void {
  scanning = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}
function drawTile(cells: Uint8Array, matrixSize: number): void {
  tileCanvas.width = matrixSize;
  tileCanvas.height = matrixSize;
  const ctx = tileCanvas.getContext('2d', {alpha: false});
  if (!ctx) throw new Error('tile canvas unavailable');
  const image = ctx.createImageData(matrixSize, matrixSize);
  for (let i = 0; i < cells.length; i += 1) {
    const value = cells[i] ? 0 : 255, offset = i * 4;
    image.data[offset] = value; image.data[offset + 1] = value; image.data[offset + 2] = value; image.data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}
function clearSender(): void {
  const ctx = senderCanvas.getContext('2d', {alpha: false});
  if (!ctx) return;
  ctx.fillStyle = '#eceff1';
  ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
}
function renderCellsForTiles(matrixSize: number, cellsByTile: Uint8Array[]): void {
  const ctx = senderCanvas.getContext('2d', {alpha: false});
  if (!ctx) throw new Error('sender canvas unavailable');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#eceff1';
  ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  ctx.imageSmoothingEnabled = false;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    drawTile(cellsByTile[tile], matrixSize);
    const left = TILE_CENTERS[tile] - TILE_RENDER_PIXELS / 2;
    const top = FRAME_HEIGHT / 2 - TILE_RENDER_PIXELS / 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(left - 10, top - 10, TILE_RENDER_PIXELS + 20, TILE_RENDER_PIXELS + 20);
    ctx.drawImage(tileCanvas, left, top, TILE_RENDER_PIXELS, TILE_RENDER_PIXELS);
  }
}
function renderTraining(): void {
  renderCellsForTiles(TRAINING_MATRIX, [trainingCells(0), trainingCells(1), trainingCells(2)]);
}
function renderDynamic(config: CandidateConfig, symbol: number): void {
  const cells: Uint8Array[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const sequence = ((senderSymbolBase + symbol) * 16 + tile + 1) >>> 0;
    cells.push(encodeFrameCellsV1(config.matrixSize, sequence, payloadFor(sequence, config.payloadBytes, tile)));
  }
  renderCellsForTiles(config.matrixSize, cells);
}
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
async function senderTrainingCalibration(): Promise<TrainingResult> {
  const id = `tf007v2-training-${Date.now().toString(36)}`;
  renderTraining();
  send({type: 'command', action: 'tf007v2-training-visible', id});
  await sleep(TRAINING_SETTLE_MS);
  const response = waitState('tf007v2-training-result', id, 30000);
  send({type: 'command', action: 'tf007v2-calibrate-training', id});
  return await response as TrainingResult;
}
async function configureReceiver(config: CandidateConfig): Promise<void> {
  const ready = waitState('tf007v2-candidate-ready', config.id);
  send({type: 'command', action: 'tf007v2-candidate-config', id: config.id, config});
  await ready;
}
async function collectReceiverResult(config: CandidateConfig): Promise<CandidateMetrics> {
  const result = waitState('tf007v2-candidate-result', config.id);
  send({type: 'command', action: 'tf007v2-candidate-finish', id: config.id});
  return await result as CandidateMetrics;
}
async function renderCandidate(config: CandidateConfig): Promise<{renderedSymbols: number; actualSymbolHz: number}> {
  await configureReceiver(config);
  await sleep(400);
  senderRunning = true;
  let renderedSymbols = 0, lastSymbol = -1;
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const frame = (now: number) => {
      if (!senderRunning || aborted) return resolve();
      const elapsed = now - started;
      if (elapsed >= config.durationMs) return resolve();
      const symbol = Math.floor(elapsed * config.targetHz / 1000);
      if (symbol !== lastSymbol) {
        try { renderDynamic(config, symbol); renderedSymbols += 1; lastSymbol = symbol; }
        catch (error) { senderRunning = false; reject(error); return; }
      }
      senderFrameHandle = requestAnimationFrame(frame);
    };
    senderFrameHandle = requestAnimationFrame(frame);
  });
  senderRunning = false;
  cancelAnimationFrame(senderFrameHandle);
  senderSymbolBase += Math.max(100, renderedSymbols + 20);
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  return {renderedSymbols, actualSymbolHz: renderedSymbols / elapsedSeconds};
}
async function runPhysicalCalibration(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  const results: Array<CandidateMetrics & {senderRenderedSymbols: number; senderActualSymbolHz: number; theoreticalGrossBytesPerSecond: number}> = [];
  try {
    log('TF-007 physical v2 started: auto-orientation + optical training lock + dynamic tiled sweep.');
    const training = await senderTrainingCalibration();
    log(`training: orientation ${training.orientationMode || 'n/a'} · locks ${training.tiles.filter(item => item.acquired).length}/3 · exact ${training.exactTiles}/3 · errors ${Number.isFinite(training.totalBitErrors) ? training.totalBitErrors : 'n/a'}`);
    if (!training.success || aborted) {
      const status = aborted ? 'ABORTED' : 'TRAINING_LOCK_FAILED';
      const run = {
        schema: 'optilink.tf007.tiled.physical.v2', kind: 'tf007-tiled-physical-calibration', issueNumber: 27, evidenceClass: 'physical-carrier-calibration', status,
        startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(), sender: senderMetadata(), receiver: latestReceiverMeta, training,
        displayBaseline: {physicalRefreshHz: PHYSICAL_DISPLAY_HZ}, carrier: {name: 'OptiGrid v1 tiled monochrome', tileCount: 3, layout: 'three horizontal independent tiles', trainingMatrix: TRAINING_MATRIX, integrity: 'per-tile CRC32 + deterministic optical payload oracle'},
        candidates: results, best: null, target: {rawCarrierIngressBytesPerSecond: 100000}, controlPlane: 'WebSocket carries commands/telemetry only; training and candidate bits remain screen→camera optical',
        note: 'Training acquisition failed before dynamic throughput measurement; this is not a carrier speed verdict.',
      };
      send({type: 'lab-result', run}); send({type: 'command', action: 'tf007v2-finished', status}); clearSender(); return;
    }
    for (const candidate of CANDIDATES) {
      if (aborted) break;
      const payloadBytes = payloadCapacityForMatrixV1(candidate.matrixSize);
      const config: CandidateConfig = {id: `tf007v2-${candidate.matrixSize}-${candidate.targetHz}-${Date.now().toString(36)}`, matrixSize: candidate.matrixSize, targetHz: candidate.targetHz, durationMs: CANDIDATE_SECONDS * 1000, payloadBytes, tileCount: 3, reference: candidate.reference};
      log(`${candidate.reference ? 'reference' : 'testing'} 3×${candidate.matrixSize} @ ${candidate.targetHz} Hz · gross ${formatRate(payloadBytes * TILE_COUNT * candidate.targetHz)}`);
      const sender = await renderCandidate(config);
      const receiver = await collectReceiverResult(config);
      results.push({...receiver, senderRenderedSymbols: sender.renderedSymbols, senderActualSymbolHz: sender.actualSymbolHz, theoreticalGrossBytesPerSecond: payloadBytes * TILE_COUNT * candidate.targetHz});
      log(`3×${candidate.matrixSize}@${candidate.targetHz}: raw ${formatRate(receiver.rawUniqueOpticalIngressBytesPerSecond)} · valid ${(receiver.validTileRatio * 100).toFixed(1)}% · process ${receiver.processingFramesPerSecond.toFixed(1)} fps`);
      await sleep(350);
    }
    const highCapacity = results.filter(row => !row.reference);
    const best = highCapacity.reduce<(typeof results)[number] | null>((winner, row) => !winner || row.rawUniqueOpticalIngressBytesPerSecond > winner.rawUniqueOpticalIngressBytesPerSecond ? row : winner, null);
    const reference = results.find(row => row.reference) || null;
    const status = aborted ? 'ABORTED'
      : reference && reference.validTileRatio < 0.25 ? 'FUNCTIONAL_REFERENCE_FAILED'
      : best && best.rawUniqueOpticalIngressBytesPerSecond >= 100000 ? 'PASS_RAW_100KBPS'
      : 'BELOW_100KBPS';
    const run = {
      schema: 'optilink.tf007.tiled.physical.v2', kind: 'tf007-tiled-physical-calibration', issueNumber: 27, evidenceClass: 'physical-carrier-calibration', status,
      startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(), sender: senderMetadata(), receiver: latestReceiverMeta, training,
      displayBaseline: {physicalRefreshHz: PHYSICAL_DISPLAY_HZ}, carrier: {name: 'OptiGrid v1 tiled monochrome', tileCount: 3, layout: 'three horizontal independent tiles', trainingMatrix: TRAINING_MATRIX, tileRenderPixels: TILE_RENDER_PIXELS, integrity: 'per-tile CRC32 + deterministic optical payload oracle'},
      candidates: results, reference, best, target: {rawCarrierIngressBytesPerSecond: 100000}, controlPlane: 'WebSocket carries commands/telemetry only; training and candidate bits remain screen→camera optical',
      note: 'Raw carrier calibration only. File-level Net Goodput still requires Fountain + reconstructed file SHA-256.',
    };
    send({type: 'lab-result', run}); send({type: 'command', action: 'tf007v2-finished', status}); clearSender();
    log(best ? `physical v2 ${status} · best ${best.matrixSize}@${best.targetHz} · ${formatRate(best.rawUniqueOpticalIngressBytesPerSecond)}` : `physical v2 ${status}`);
  } catch (error) {
    clearSender(); senderRunning = false; send({type: 'command', action: 'tf007v2-finished', status: 'ERROR'}); log(`physical v2 failed: ${String(error)}`);
  }
}
function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf007v2-tiled-${role}`}); log(`coordinator connected as ${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (resolvePending(message)) return;
    if (role === 'sender' && message.type === 'state' && message.event === 'tf007v2-receiver-ready') {
      latestReceiverMeta = message.receiver as ReceiverMeta; void runPhysicalCalibration(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v2-training-visible') {
      latestReceiverMeta = receiverMetadata(); send({type: 'state', event: 'tf007v2-training-visible-ready', id: String(message.id || ''), value: latestReceiverMeta}); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v2-calibrate-training') {
      const id = String(message.id || '');
      void calibrateTraining().then(value => send({type: 'state', event: 'tf007v2-training-result', id, value})).catch(error => send({type: 'state', event: 'tf007v2-training-result', id, value: {success: false, error: String(error)}}));
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v2-candidate-config') {
      const config = message.config as CandidateConfig; resetCandidate(config); latestReceiverMeta = receiverMetadata(); send({type: 'state', event: 'tf007v2-candidate-ready', id: String(message.id || ''), value: latestReceiverMeta}); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v2-candidate-finish') {
      const id = String(message.id || ''), metrics = currentMetrics(); send({type: 'state', event: 'tf007v2-candidate-result', id, value: metrics}); resetCandidate(null); return;
    }
    if (message.type === 'command' && message.action === 'tiled-physical-stop') {
      aborted = true; senderRunning = false; cancelAnimationFrame(senderFrameHandle); if (role === 'receiver') stopCamera(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v2-finished') {
      stopCamera(); startButton.disabled = false; stopButton.disabled = true; progress.textContent = String(message.status || 'finished'); log(`physical v2 finished: ${message.status}`); return;
    }
    if (message.type === 'server' && message.event === 'result-saved') log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
  });
}
async function receiverStart(): Promise<void> {
  orientationMode = null; trainingLocks = null; latestTraining = null; resetCandidate(null); progress.textContent = 'starting camera';
  await startCamera(); latestReceiverMeta = receiverMetadata(); startButton.disabled = true; stopButton.disabled = false; progress.textContent = 'training';
  send({type: 'state', event: 'tf007v2-receiver-ready', receiver: latestReceiverMeta});
  log('Camera started. Orientation will be normalized automatically; keep the complete desktop sender area inside the reticle.');
}
function userStop(): void {
  aborted = true; send({type: 'command', action: 'tiled-physical-stop'}); if (role === 'receiver') stopCamera(); senderRunning = false; cancelAnimationFrame(senderFrameHandle);
  startButton.disabled = false; stopButton.disabled = true; progress.textContent = 'stopped'; log('stopped by user');
}
startButton.addEventListener('click', () => { if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`)); });
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  document.body.classList.add('sender-mode'); senderCanvas.parentElement!.hidden = false; roleTitle.textContent = 'TF-007 tiled sender v2'; roleText.textContent = '手机 Start 后自动完成方向识别、训练锁定和动态 sweep；电脑端无需点击。';
} else if (role === 'receiver') {
  document.body.classList.add('receiver-mode'); senderCanvas.parentElement!.hidden = true; roleTitle.textContent = 'TF-007 phone receiver v2'; roleText.textContent = '完整电脑发射区域保持在取景框内即可；相机方向自动处理，只点一次 Start。';
} else {
  document.body.classList.add('both-mode'); senderCanvas.parentElement!.hidden = true; receiverView.hidden = false; startButton.disabled = true; roleTitle.textContent = 'Open role-specific TF-007 v2 URLs';
}
clearSender();
connect();
