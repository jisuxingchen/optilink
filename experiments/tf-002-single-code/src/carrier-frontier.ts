import {affineFromTriangles, homographyFromUnitSquare, mapHomography, type Point, type Quad} from './optigrid-geometry.ts';
import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  OPTIGRID_V1_BORDER,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';

type ScenarioName = 'clean' | 'mild' | 'stress';
type SuiteName = 'quick' | 'frontier';

type Scenario = {
  name: ScenarioName;
  fillRatio: number;
  angleDeg: number;
  perspective: number;
  shear: number;
  blurPx: number;
  noise: number;
};

type Candidate = {
  id: string;
  matrixSize: number;
  payloadBytes: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  cameraHz: number;
  scenario: Scenario;
  frames: number;
};

type PixelFrame = {image: ImageData};

type LockPlan = {
  quad: Quad;
  threshold: number;
  score: number;
  contrast: number;
  dataSamplePoints: Float32Array;
  samplesPerCell: number;
  reservedSamplePoints: Float32Array;
  reservedExpected: Uint8Array;
};

type DecoderState = {
  lock: LockPlan | null;
  acquisitions: number;
  reacquisitions: number;
  trackingFrames: number;
};

type DecodeAttempt = {
  sequence: number;
  payload: Uint8Array;
  finderScore: number;
  contrast: number;
  acquisitionMs: number | null;
  trackingValidationMs: number;
  fastDecodeMs: number;
  reacquired: boolean;
};

type CandidateResult = {
  id: string;
  carrier: 'optigrid-v1';
  scenario: ScenarioName;
  matrixSize: number;
  payloadBytesPerFrame: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  cameraHz: number;
  attemptedFrames: number;
  validFrames: number;
  validRatio: number;
  acquisitionCount: number;
  reacquisitionCount: number;
  trackedFrames: number;
  acquisitionP95Ms: number;
  trackingValidationP95Ms: number;
  fastDecodeP95Ms: number;
  sustainedDecodeP95Ms: number;
  senderRenderP95Ms: number;
  channelP95Ms: number;
  sustainedReceiverCapacityHz: number;
  senderCapacityHz: number;
  projectedEffectiveHz: number;
  theoreticalGrossBytesPerSecond: number;
  projectedPixelSimIngressBytesPerSecond: number;
  estimatedOneMiBSeconds: number | null;
  estimatedOneMiBGoodputBytesPerSecond: number;
  averageFinderScore: number;
  averageContrast: number;
  oracleMismatches: number;
  decodeFailures: number;
};

type RankingRow = {
  key: string;
  matrixSize: number;
  payloadBytesPerFrame: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  minValidRatio: number;
  worstProjectedIngress: number;
  worstEstimatedOneMiBGoodput: number;
  worstFastDecodeP95Ms: number;
  worstSustainedDecodeP95Ms: number;
  maxReacquisitions: number;
  scenarios: ScenarioName[];
  selectionScore: number;
};

type FrontierResult = {
  status: 'idle' | 'running' | 'complete' | 'aborted' | 'error';
  suite: SuiteName;
  startedAt?: string;
  finishedAt?: string;
  isolation: {
    receiverInput: 'ImageData pixels only';
    senderPayloadPassedToReceiver: false;
    senderCellsPassedToReceiver: false;
    senderFrameObjectsPassedToReceiver: false;
    geometryStateDerivedFromReceiverPixelsOnly: true;
    benchmarkOracleSeparatedFromReceiver: true;
  };
  pipeline: 'acquisition -> tracking -> fast decode';
  sampling: 'subpixel bilinear 5-point majority';
  rows: CandidateResult[];
  ranking: RankingRow[];
  selected: RankingRow[];
  stableAtOrAbove100KBps: RankingRow[];
  error?: string;
};

const CLEAN: Scenario = {name: 'clean', fillRatio: 0.78, angleDeg: 0, perspective: 0, shear: 0, blurPx: 0, noise: 0};
const MILD: Scenario = {name: 'mild', fillRatio: 0.73, angleDeg: 4, perspective: 0.05, shear: 0.025, blurPx: 0.35, noise: 2};
const STRESS: Scenario = {name: 'stress', fillRatio: 0.68, angleDeg: 8, perspective: 0.10, shear: 0.055, blurPx: 0.75, noise: 5};
const ONE_MIB = 1024 * 1024;
const TARGET_BYTES_PER_SECOND = 100_000;
const DATA_SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-0.18, 0],
  [0.18, 0],
  [0, -0.18],
  [0, 0.18],
];

const senderCanvas = get<HTMLCanvasElement>('senderCanvas');
const receiverCanvas = get<HTMLCanvasElement>('receiverCanvas');
const senderStatus = get<HTMLPreElement>('senderStatus');
const receiverStatus = get<HTMLPreElement>('receiverStatus');
const summary = get<HTMLPreElement>('summary');
const resultsBody = get<HTMLTableSectionElement>('resultsBody');
const runButton = get<HTMLButtonElement>('runSuite');
const stopButton = get<HTMLButtonElement>('stopSuite');
const suiteMode = get<HTMLSelectElement>('suiteMode');
const progress = get<HTMLElement>('progress');

let abortRequested = false;
let frontierResult = emptyResult('quick');
publishResult();

function get<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function emptyResult(suite: SuiteName): FrontierResult {
  return {
    status: 'idle',
    suite,
    isolation: {
      receiverInput: 'ImageData pixels only',
      senderPayloadPassedToReceiver: false,
      senderCellsPassedToReceiver: false,
      senderFrameObjectsPassedToReceiver: false,
      geometryStateDerivedFromReceiverPixelsOnly: true,
      benchmarkOracleSeparatedFromReceiver: true,
    },
    pipeline: 'acquisition -> tracking -> fast decode',
    sampling: 'subpixel bilinear 5-point majority',
    rows: [],
    ranking: [],
    selected: [],
    stableAtOrAbove100KBps: [],
  };
}

function publishResult(): void {
  (window as Window & {__carrierFrontierResult?: FrontierResult}).__carrierFrontierResult = frontierResult;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function deterministicPayload(sequence: number, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x46524f4e) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    output[i] = (x + i * 29 + (sequence & 0xff)) & 0xff;
  }
  return output;
}

function luma(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

function sampleLumaBilinear(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x));
  const py = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = px - x0;
  const ty = py - y0;
  const stride = image.width * 4;
  const o00 = y0 * stride + x0 * 4;
  const o10 = y0 * stride + x1 * 4;
  const o01 = y1 * stride + x0 * 4;
  const o11 = y1 * stride + x1 * 4;
  const top = luma(image.data, o00) * (1 - tx) + luma(image.data, o10) * tx;
  const bottom = luma(image.data, o01) * (1 - tx) + luma(image.data, o11) * tx;
  return top * (1 - ty) + bottom * ty;
}

function drawCells(canvas: HTMLCanvasElement, cells: Uint8Array, matrixSize: number, pixels: number): void {
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('sender canvas 2D context unavailable');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = '#000000';
  const cell = pixels / matrixSize;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      if (cells[row * matrixSize + column]) context.fillRect(column * cell, row * cell, cell + 0.02, cell + 0.02);
    }
  }
}

function renderCarrier(candidate: Candidate, sequence: number, payload: Uint8Array): void {
  const cells = encodeFrameCellsV1(candidate.matrixSize, sequence, payload);
  drawCells(senderCanvas, cells, candidate.matrixSize, candidate.renderPixels);
}

function makeCameraQuad(size: number, scenario: Scenario): Quad {
  const cx = size * 0.5;
  const cy = size * 0.5;
  const base = size * scenario.fillRatio;
  const half = base / 2;
  const angle = scenario.angleDeg * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const topScale = 1 - scenario.perspective;
  const bottomScale = 1 + scenario.perspective;
  const topShift = scenario.shear * base;
  const bottomShift = -scenario.shear * base;
  const rotate = (x: number, y: number): Point => ({x: cx + x * cos - y * sin, y: cy + x * sin + y * cos});
  return {
    tl: rotate(-half * topScale + topShift, -half),
    tr: rotate(half * topScale + topShift, -half),
    br: rotate(half * bottomScale + bottomShift, half),
    bl: rotate(-half * bottomScale + bottomShift, half),
  };
}

function drawTriangle(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  source: [Point, Point, Point],
  destination: [Point, Point, Point],
): void {
  const affine = affineFromTriangles(source, destination);
  if (!affine) return;
  context.save();
  context.beginPath();
  context.moveTo(destination[0].x, destination[0].y);
  context.lineTo(destination[1].x, destination[1].y);
  context.lineTo(destination[2].x, destination[2].y);
  context.closePath();
  context.clip();
  context.setTransform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
  context.drawImage(sourceCanvas, 0, 0);
  context.restore();
}

function projectCanvas(sourceCanvas: HTMLCanvasElement, destination: HTMLCanvasElement, quad: Quad, mesh = 8): void {
  const context = destination.getContext('2d', {alpha: false});
  if (!context) throw new Error('channel canvas context unavailable');
  const h = homographyFromUnitSquare(quad);
  if (!h) throw new Error('invalid channel homography');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, destination.width, destination.height);
  context.imageSmoothingEnabled = true;

  for (let row = 0; row < mesh; row += 1) {
    for (let column = 0; column < mesh; column += 1) {
      const u0 = column / mesh;
      const u1 = (column + 1) / mesh;
      const v0 = row / mesh;
      const v1 = (row + 1) / mesh;
      const s00 = {x: u0 * sourceCanvas.width, y: v0 * sourceCanvas.height};
      const s10 = {x: u1 * sourceCanvas.width, y: v0 * sourceCanvas.height};
      const s11 = {x: u1 * sourceCanvas.width, y: v1 * sourceCanvas.height};
      const s01 = {x: u0 * sourceCanvas.width, y: v1 * sourceCanvas.height};
      const d00 = mapHomography(h, u0, v0);
      const d10 = mapHomography(h, u1, v0);
      const d11 = mapHomography(h, u1, v1);
      const d01 = mapHomography(h, u0, v1);
      drawTriangle(context, sourceCanvas, [s00, s10, s11], [d00, d10, d11]);
      drawTriangle(context, sourceCanvas, [s00, s11, s01], [d00, d11, d01]);
    }
  }
}

function addDeterministicNoise(image: ImageData, amount: number, seed: number): void {
  if (amount <= 0) return;
  let x = (seed ^ 0x91e10da5) >>> 0;
  for (let i = 0; i < image.data.length; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const delta = (((x >>> 8) & 0xffff) / 65535 * 2 - 1) * amount;
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + delta));
    image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + delta));
    image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + delta));
  }
}

function captureOpticalPixels(candidate: Candidate, sequence: number): PixelFrame {
  const camera = document.createElement('canvas');
  camera.width = candidate.cameraPixels;
  camera.height = candidate.cameraPixels;
  const projected = document.createElement('canvas');
  projected.width = camera.width;
  projected.height = camera.height;
  projectCanvas(senderCanvas, projected, makeCameraQuad(camera.width, candidate.scenario));

  const context = camera.getContext('2d', {alpha: false, willReadFrequently: true});
  if (!context) throw new Error('camera simulation context unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, camera.width, camera.height);
  context.imageSmoothingEnabled = true;
  context.filter = candidate.scenario.blurPx > 0 ? `blur(${candidate.scenario.blurPx}px)` : 'none';
  context.drawImage(projected, 0, 0);
  context.filter = 'none';
  const image = context.getImageData(0, 0, camera.width, camera.height);
  addDeterministicNoise(image, candidate.scenario.noise, sequence);
  return {image};
}

function showReceiverPixels(frame: PixelFrame): void {
  receiverCanvas.width = frame.image.width;
  receiverCanvas.height = frame.image.height;
  const context = receiverCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  context.putImageData(frame.image, 0, 0);
}

function imageThreshold(image: ImageData): {low: number; high: number; threshold: number} {
  const histogram = new Uint32Array(256);
  let samples = 0;
  const step = image.width * image.height > 600_000 ? 3 : 2;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      histogram[Math.max(0, Math.min(255, Math.round(luma(image.data, offset))))] += 1;
      samples += 1;
    }
  }
  const percentileValue = (fraction: number): number => {
    const target = samples * fraction;
    let cumulative = 0;
    for (let value = 0; value < 256; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return 255;
  };
  const low = percentileValue(0.08);
  const high = percentileValue(0.92);
  return {low, high, threshold: (low + high) / 2};
}

function findDarkQuad(image: ImageData, matrixSize: number): Quad | null {
  const {low, high, threshold} = imageThreshold(image);
  if (high - low < 30) return null;
  let tlScore = Infinity;
  let trScore = -Infinity;
  let brScore = -Infinity;
  let blScore = Infinity;
  let tl: Point | null = null;
  let tr: Point | null = null;
  let br: Point | null = null;
  let bl: Point | null = null;
  const step = image.width > 800 ? 2 : 1;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      if (luma(image.data, offset) >= threshold) continue;
      const sum = x + y;
      const diff = x - y;
      if (sum < tlScore) { tlScore = sum; tl = {x, y}; }
      if (diff > trScore) { trScore = diff; tr = {x, y}; }
      if (sum > brScore) { brScore = sum; br = {x, y}; }
      if (diff < blScore) { blScore = diff; bl = {x, y}; }
    }
  }
  if (!tl || !tr || !br || !bl) return null;
  const center = {
    x: (tl.x + tr.x + br.x + bl.x) / 4,
    y: (tl.y + tr.y + br.y + bl.y) / 4,
  };
  const expansion = matrixSize / Math.max(1, matrixSize - 1);
  const expand = (point: Point): Point => ({
    x: center.x + (point.x - center.x) * expansion,
    y: center.y + (point.y - center.y) * expansion,
  });
  return {tl: expand(tl), tr: expand(tr), br: expand(br), bl: expand(bl)};
}

type ReservedSample = {row: number; column: number; expected: 0 | 1};
const reservedSampleCache = new Map<string, ReservedSample[]>();

function reservedSamples(matrixSize: number, stride: number): ReservedSample[] {
  const key = `${matrixSize}:${stride}`;
  const cached = reservedSampleCache.get(key);
  if (cached) return cached;
  const samples: ReservedSample[] = [];
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reservedCellValueV1(row, column, matrixSize);
      if (expected === null) continue;
      const inFinder = (row < 9 || row >= matrixSize - 9) && (column < 9 || column >= matrixSize - 9);
      if (!inFinder && ((row * 7 + column * 11) % stride !== 0)) continue;
      samples.push({row, column, expected: expected as 0 | 1});
    }
  }
  reservedSampleCache.set(key, samples);
  return samples;
}

function evaluateQuad(image: ImageData, quad: Quad, matrixSize: number, stride = 7): {score: number; contrast: number; threshold: number} | null {
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const samples = reservedSamples(matrixSize, stride);
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  const measured = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const point = mapHomography(h, (sample.column + 0.5) / matrixSize, (sample.row + 0.5) / matrixSize);
    const value = sampleLumaBilinear(image, point.x, point.y);
    measured[i] = value;
    if (sample.expected) { blackSum += value; blackCount += 1; }
    else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const threshold = (blackMean + whiteMean) / 2;
  const contrast = whiteMean - blackMean;
  let matches = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if ((measured[i] < threshold ? 1 : 0) === samples[i].expected) matches += 1;
  }
  return {score: samples.length ? matches / samples.length : 0, contrast, threshold};
}

function cloneQuad(quad: Quad): Quad {
  return {tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl}};
}

function refineQuad(image: ImageData, initial: Quad, matrixSize: number): {quad: Quad; score: number; contrast: number; threshold: number} | null {
  const first = evaluateQuad(image, initial, matrixSize, 9);
  if (!first) return null;
  let best = {quad: initial, ...first};
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  const baseStep = Math.max(1.5, image.width / 180);
  const steps = [baseStep * 2, baseStep, baseStep / 2, baseStep / 4, 0.5, 0.25]
    .filter((step, index, values) => index === values.findIndex(value => Math.abs(value - step) < 0.01));
  for (const step of steps) {
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) {
        for (const axis of ['x', 'y'] as const) {
          for (const direction of [-1, 1]) {
            const quad = cloneQuad(best.quad);
            quad[corner][axis] += step * direction;
            const candidate = evaluateQuad(image, quad, matrixSize, 9);
            if (!candidate) continue;
            const objective = candidate.score + Math.max(0, Math.min(120, candidate.contrast)) / 900;
            const bestObjective = best.score + Math.max(0, Math.min(120, best.contrast)) / 900;
            if (objective > bestObjective) {
              best = {quad, ...candidate};
              improved = true;
            }
          }
        }
      }
      if (!improved) break;
    }
  }
  const final = evaluateQuad(image, best.quad, matrixSize, 3);
  return final ? {quad: best.quad, ...final} : best;
}

function buildLockPlan(image: ImageData, quad: Quad, matrixSize: number, threshold: number, score: number, contrast: number): LockPlan | null {
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const inner = matrixSize - OPTIGRID_V1_BORDER * 2;
  const samplesPerCell = DATA_SAMPLE_OFFSETS.length;
  const dataSamplePoints = new Float32Array(inner * inner * samplesPerCell * 2);
  let pointIndex = 0;
  for (let row = OPTIGRID_V1_BORDER; row < matrixSize - OPTIGRID_V1_BORDER; row += 1) {
    for (let column = OPTIGRID_V1_BORDER; column < matrixSize - OPTIGRID_V1_BORDER; column += 1) {
      for (const [dx, dy] of DATA_SAMPLE_OFFSETS) {
        const point = mapHomography(h, (column + 0.5 + dx) / matrixSize, (row + 0.5 + dy) / matrixSize);
        dataSamplePoints[pointIndex] = point.x;
        dataSamplePoints[pointIndex + 1] = point.y;
        pointIndex += 2;
      }
    }
  }

  const samples = reservedSamples(matrixSize, 3);
  const reservedSamplePoints = new Float32Array(samples.length * 2);
  const reservedExpected = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const point = mapHomography(h, (sample.column + 0.5) / matrixSize, (sample.row + 0.5) / matrixSize);
    reservedSamplePoints[i * 2] = point.x;
    reservedSamplePoints[i * 2 + 1] = point.y;
    reservedExpected[i] = sample.expected;
  }
  return {quad, threshold, score, contrast, dataSamplePoints, samplesPerCell, reservedSamplePoints, reservedExpected};
}

function acquireLock(image: ImageData, matrixSize: number): LockPlan | null {
  const initial = findDarkQuad(image, matrixSize);
  if (!initial) return null;
  const refined = refineQuad(image, initial, matrixSize);
  if (!refined || refined.contrast < 18 || refined.score < 0.72) return null;
  return buildLockPlan(image, refined.quad, matrixSize, refined.threshold, refined.score, refined.contrast);
}

function validateLock(image: ImageData, lock: LockPlan): {score: number; contrast: number; threshold: number} | null {
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  const measured = new Float64Array(lock.reservedExpected.length);
  for (let i = 0; i < lock.reservedExpected.length; i += 1) {
    const value = sampleLumaBilinear(image, lock.reservedSamplePoints[i * 2], lock.reservedSamplePoints[i * 2 + 1]);
    measured[i] = value;
    if (lock.reservedExpected[i]) { blackSum += value; blackCount += 1; }
    else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const threshold = (blackMean + whiteMean) / 2;
  const contrast = whiteMean - blackMean;
  let matches = 0;
  for (let i = 0; i < lock.reservedExpected.length; i += 1) {
    if ((measured[i] < threshold ? 1 : 0) === lock.reservedExpected[i]) matches += 1;
  }
  return {
    score: lock.reservedExpected.length ? matches / lock.reservedExpected.length : 0,
    contrast,
    threshold,
  };
}

function sampleLockedDataCells(image: ImageData, lock: LockPlan, matrixSize: number, threshold: number): Uint8Array {
  const cells = new Uint8Array(matrixSize * matrixSize);
  let pointIndex = 0;
  const majority = Math.floor(lock.samplesPerCell / 2) + 1;
  for (let row = OPTIGRID_V1_BORDER; row < matrixSize - OPTIGRID_V1_BORDER; row += 1) {
    const rowOffset = row * matrixSize;
    for (let column = OPTIGRID_V1_BORDER; column < matrixSize - OPTIGRID_V1_BORDER; column += 1) {
      let darkVotes = 0;
      for (let sample = 0; sample < lock.samplesPerCell; sample += 1) {
        const value = sampleLumaBilinear(image, lock.dataSamplePoints[pointIndex], lock.dataSamplePoints[pointIndex + 1]);
        if (value < threshold) darkVotes += 1;
        pointIndex += 2;
      }
      cells[rowOffset + column] = darkVotes >= majority ? 1 : 0;
    }
  }
  return cells;
}

function decodeTrackedPixelOnly(image: ImageData, matrixSize: number, state: DecoderState): DecodeAttempt | null {
  // Receiver-side data boundary: this function receives ImageData + known carrier configuration only.
  // It never receives sender payload bytes, sender cells, sequence metadata, or sender frame objects.
  let acquisitionMs: number | null = null;
  let reacquired = false;
  let validation: {score: number; contrast: number; threshold: number} | null = null;
  const trackingValidationStarted = performance.now();
  if (state.lock) validation = validateLock(image, state.lock);
  const trackingValidationMs = performance.now() - trackingValidationStarted;

  if (!state.lock || !validation || validation.score < 0.70 || validation.contrast < 16) {
    const hadLock = Boolean(state.lock);
    const acquisitionStarted = performance.now();
    const nextLock = acquireLock(image, matrixSize);
    acquisitionMs = performance.now() - acquisitionStarted;
    if (!nextLock) {
      state.lock = null;
      return null;
    }
    state.lock = nextLock;
    state.acquisitions += 1;
    if (hadLock) {
      state.reacquisitions += 1;
      reacquired = true;
    }
    validation = {score: nextLock.score, contrast: nextLock.contrast, threshold: nextLock.threshold};
  } else {
    state.trackingFrames += 1;
    state.lock.threshold = validation.threshold;
    state.lock.score = validation.score;
    state.lock.contrast = validation.contrast;
  }

  const lock = state.lock;
  if (!lock || !validation) return null;
  const fastStarted = performance.now();
  const cells = sampleLockedDataCells(image, lock, matrixSize, validation.threshold);
  const decoded = decodeFrameCellsV1(cells, matrixSize);
  const fastDecodeMs = performance.now() - fastStarted;
  if (!decoded) return null;
  return {
    sequence: decoded.sequence,
    payload: decoded.payload,
    finderScore: validation.score,
    contrast: validation.contrast,
    acquisitionMs,
    trackingValidationMs,
    fastDecodeMs,
    reacquired,
  };
}

function candidate(matrixSize: number, renderPixels: number, targetHz: number, scenario: Scenario, frames: number): Candidate {
  return {
    id: `optigrid-v1-track-${matrixSize}-${renderPixels}-1080-${targetHz}-${scenario.name}`,
    matrixSize,
    payloadBytes: payloadCapacityForMatrixV1(matrixSize),
    renderPixels,
    cameraPixels: 1080,
    targetHz,
    cameraHz: 60,
    scenario,
    frames,
  };
}

function buildPlan(suite: SuiteName): Candidate[] {
  const plan: Candidate[] = [];
  const scenarios = [CLEAN, MILD, STRESS];
  if (suite === 'quick') {
    for (const scenario of scenarios) {
      for (const matrixSize of [120, 160, 200]) {
        for (const targetHz of [24, 60]) plan.push(candidate(matrixSize, 960, targetHz, scenario, 8));
      }
    }
    return plan;
  }

  for (const scenario of scenarios) {
    for (const matrixSize of [120, 140, 160, 180, 200, 220, 240]) {
      for (const renderPixels of [720, 960]) {
        for (const targetHz of [24, 30, 45, 60]) {
          plan.push(candidate(matrixSize, renderPixels, targetHz, scenario, 6));
        }
      }
    }
  }
  return plan;
}

function updateLiveStatus(candidateConfig: Candidate, frame: number, attempt: DecodeAttempt | null, state: DecoderState): void {
  senderStatus.textContent = [
    'carrier: OptiGrid v1',
    `matrix: ${candidateConfig.matrixSize}×${candidateConfig.matrixSize}`,
    `payload: ${candidateConfig.payloadBytes} B/frame`,
    `render: ${candidateConfig.renderPixels}px`,
    `target visual rate: ${candidateConfig.targetHz} Hz`,
    `frame: ${frame + 1}/${candidateConfig.frames}`,
  ].join('\n');

  receiverStatus.textContent = [
    'receiver input: ImageData pixels only',
    'sampler: subpixel bilinear 5-point majority',
    `camera simulation: ${candidateConfig.cameraPixels}×${candidateConfig.cameraPixels}`,
    `scenario: ${candidateConfig.scenario.name} · angle ${candidateConfig.scenario.angleDeg}° · perspective ${candidateConfig.scenario.perspective.toFixed(2)} · blur ${candidateConfig.scenario.blurPx}px`,
    `lock: ${state.lock ? 'LOCKED' : 'SEARCHING'} · acquisitions ${state.acquisitions} · reacquisitions ${state.reacquisitions} · tracked ${state.trackingFrames}`,
    attempt ? `decoded seq ${attempt.sequence} · finder ${(attempt.finderScore * 100).toFixed(1)}% · contrast ${attempt.contrast.toFixed(1)} · fast ${attempt.fastDecodeMs.toFixed(2)} ms` : 'decode: no valid frame',
  ].join('\n');
}

async function runCandidate(candidateConfig: Candidate, candidateIndex: number, totalCandidates: number): Promise<CandidateResult> {
  const renderTimes: number[] = [];
  const channelTimes: number[] = [];
  const acquisitionTimes: number[] = [];
  const trackingValidationTimes: number[] = [];
  const fastDecodeTimes: number[] = [];
  const state: DecoderState = {lock: null, acquisitions: 0, reacquisitions: 0, trackingFrames: 0};
  let validFrames = 0;
  let oracleMismatches = 0;
  let decodeFailures = 0;
  let finderSum = 0;
  let contrastSum = 0;
  let finderSamples = 0;

  for (let frame = 0; frame < candidateConfig.frames && !abortRequested; frame += 1) {
    const sequence = ((candidateIndex + 1) * 100_000 + frame + 1) >>> 0;
    const sourcePayload = deterministicPayload(sequence, candidateConfig.payloadBytes);

    const renderStarted = performance.now();
    renderCarrier(candidateConfig, sequence, sourcePayload);
    renderTimes.push(performance.now() - renderStarted);

    const channelStarted = performance.now();
    const pixelFrame = captureOpticalPixels(candidateConfig, sequence);
    channelTimes.push(performance.now() - channelStarted);
    showReceiverPixels(pixelFrame);

    let decoded: DecodeAttempt | null = null;
    try {
      decoded = decodeTrackedPixelOnly(pixelFrame.image, candidateConfig.matrixSize, state);
    } catch {
      decoded = null;
    }

    if (decoded) {
      if (decoded.acquisitionMs !== null) acquisitionTimes.push(decoded.acquisitionMs);
      trackingValidationTimes.push(decoded.trackingValidationMs);
      fastDecodeTimes.push(decoded.fastDecodeMs);
      finderSum += decoded.finderScore;
      contrastSum += decoded.contrast;
      finderSamples += 1;
      if (decoded.sequence === sequence && equalBytes(decoded.payload, sourcePayload)) validFrames += 1;
      else oracleMismatches += 1;
    } else {
      decodeFailures += 1;
    }

    updateLiveStatus(candidateConfig, frame, decoded, state);
    progress.textContent = `${candidateIndex + 1}/${totalCandidates} · ${candidateConfig.id} · frame ${frame + 1}/${candidateConfig.frames}`;
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const attemptedFrames = candidateConfig.frames;
  const validRatio = attemptedFrames ? validFrames / attemptedFrames : 0;
  const acquisitionP95Ms = percentile(acquisitionTimes, 0.95);
  const trackingValidationP95Ms = percentile(trackingValidationTimes, 0.95);
  const fastDecodeP95Ms = percentile(fastDecodeTimes, 0.95);
  // Sustained capacity must include both the tracking guard and the actual data-cell decode.
  // Acquisition is a startup/recovery cost and is accounted for separately in the 1 MiB estimate.
  const sustainedDecodeP95Ms = trackingValidationP95Ms + fastDecodeP95Ms;
  const senderRenderP95Ms = percentile(renderTimes, 0.95);
  const channelP95Ms = percentile(channelTimes, 0.95);
  const sustainedReceiverCapacityHz = sustainedDecodeP95Ms > 0 ? 1000 / sustainedDecodeP95Ms : 0;
  const senderCapacityHz = senderRenderP95Ms > 0 ? 1000 / senderRenderP95Ms : candidateConfig.targetHz;
  const projectedEffectiveHz = Math.min(candidateConfig.targetHz, candidateConfig.cameraHz, senderCapacityHz, sustainedReceiverCapacityHz) * validRatio;
  const projectedPixelSimIngressBytesPerSecond = candidateConfig.payloadBytes * projectedEffectiveHz;
  const startupSeconds = acquisitionP95Ms / 1000;
  const estimatedOneMiBSeconds = projectedPixelSimIngressBytesPerSecond > 0 ? startupSeconds + ONE_MIB / projectedPixelSimIngressBytesPerSecond : null;
  const estimatedOneMiBGoodputBytesPerSecond = estimatedOneMiBSeconds ? ONE_MIB / estimatedOneMiBSeconds : 0;

  return {
    id: candidateConfig.id,
    carrier: 'optigrid-v1',
    scenario: candidateConfig.scenario.name,
    matrixSize: candidateConfig.matrixSize,
    payloadBytesPerFrame: candidateConfig.payloadBytes,
    renderPixels: candidateConfig.renderPixels,
    cameraPixels: candidateConfig.cameraPixels,
    targetHz: candidateConfig.targetHz,
    cameraHz: candidateConfig.cameraHz,
    attemptedFrames,
    validFrames,
    validRatio,
    acquisitionCount: state.acquisitions,
    reacquisitionCount: state.reacquisitions,
    trackedFrames: state.trackingFrames,
    acquisitionP95Ms,
    trackingValidationP95Ms,
    fastDecodeP95Ms,
    sustainedDecodeP95Ms,
    senderRenderP95Ms,
    channelP95Ms,
    sustainedReceiverCapacityHz,
    senderCapacityHz,
    projectedEffectiveHz,
    theoreticalGrossBytesPerSecond: candidateConfig.payloadBytes * candidateConfig.targetHz,
    projectedPixelSimIngressBytesPerSecond,
    estimatedOneMiBSeconds,
    estimatedOneMiBGoodputBytesPerSecond,
    averageFinderScore: finderSamples ? finderSum / finderSamples : 0,
    averageContrast: finderSamples ? contrastSum / finderSamples : 0,
    oracleMismatches,
    decodeFailures,
  };
}

function groupKey(row: CandidateResult): string {
  return [row.matrixSize, row.payloadBytesPerFrame, row.renderPixels, row.cameraPixels, row.targetHz].join('|');
}

function rankRows(rows: CandidateResult[]): RankingRow[] {
  const groups = new Map<string, CandidateResult[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const items = groups.get(key) || [];
    items.push(row);
    groups.set(key, items);
  }

  const ranking: RankingRow[] = [];
  for (const [key, items] of groups) {
    const first = items[0];
    const minValidRatio = Math.min(...items.map(item => item.validRatio));
    const worstProjectedIngress = Math.min(...items.map(item => item.projectedPixelSimIngressBytesPerSecond));
    const worstEstimatedOneMiBGoodput = Math.min(...items.map(item => item.estimatedOneMiBGoodputBytesPerSecond));
    const worstFastDecodeP95Ms = Math.max(...items.map(item => item.fastDecodeP95Ms));
    const worstSustainedDecodeP95Ms = Math.max(...items.map(item => item.sustainedDecodeP95Ms));
    const maxReacquisitions = Math.max(...items.map(item => item.reacquisitionCount));
    const scenarios = items.map(item => item.scenario);
    ranking.push({
      key,
      matrixSize: first.matrixSize,
      payloadBytesPerFrame: first.payloadBytesPerFrame,
      renderPixels: first.renderPixels,
      cameraPixels: first.cameraPixels,
      targetHz: first.targetHz,
      minValidRatio,
      worstProjectedIngress,
      worstEstimatedOneMiBGoodput,
      worstFastDecodeP95Ms,
      worstSustainedDecodeP95Ms,
      maxReacquisitions,
      scenarios,
      selectionScore: worstEstimatedOneMiBGoodput * minValidRatio,
    });
  }
  return ranking.sort((a, b) => b.selectionScore - a.selectionScore);
}

function formatRate(value: number): string {
  return `${(value / 1000).toFixed(1)} KB/s`;
}

function appendRow(row: CandidateResult): void {
  const tr = document.createElement('tr');
  tr.innerHTML = [
    `<td>${row.matrixSize}²</td>`,
    `<td>${row.scenario}</td>`,
    `<td>${row.renderPixels}px</td>`,
    `<td>${row.targetHz}</td>`,
    `<td>${row.validFrames}/${row.attemptedFrames} (${(row.validRatio * 100).toFixed(0)}%)</td>`,
    `<td>${row.payloadBytesPerFrame}</td>`,
    `<td>${row.acquisitionP95Ms.toFixed(1)} ms</td>`,
    `<td>${row.sustainedDecodeP95Ms.toFixed(2)} ms</td>`,
    `<td>${row.sustainedReceiverCapacityHz.toFixed(1)}</td>`,
    `<td>${formatRate(row.projectedPixelSimIngressBytesPerSecond)}</td>`,
    `<td>${row.reacquisitionCount}</td>`,
  ].join('');
  resultsBody.appendChild(tr);
}

function renderSummary(ranking: RankingRow[]): void {
  const stable = ranking.filter(item => item.minValidRatio >= 0.95 && item.scenarios.includes('clean') && item.scenarios.includes('mild') && item.scenarios.includes('stress'));
  const stableAtOrAbove100 = stable.filter(item => item.worstEstimatedOneMiBGoodput >= TARGET_BYTES_PER_SECOND);
  frontierResult.stableAtOrAbove100KBps = stableAtOrAbove100;
  frontierResult.selected = (stable.length ? stable : ranking).slice(0, 5);

  const top = frontierResult.selected;
  const lines = [
    'Receiver isolation: pixel ImageData only; tracking state is derived from receiver pixels only.',
    'Sampler: subpixel bilinear 5-point majority; acquisition refines geometry to 0.25 px.',
    `stable groups across clean+mild+stress (>=95%): ${stable.length}/${ranking.length}`,
    `stable simulated 1 MiB >=100 KB/s groups: ${stableAtOrAbove100.length}`,
    '',
    ...top.map((item, index) => [
      `#${index + 1} OptiGrid v1 ${item.matrixSize}×${item.matrixSize} · render ${item.renderPixels}px · target ${item.targetHz} Hz`,
      `payload ${item.payloadBytesPerFrame} B/f · worst valid ${(item.minValidRatio * 100).toFixed(1)}% · worst tracked p95 ${item.worstSustainedDecodeP95Ms.toFixed(2)} ms`,
      `worst sustained ingress ${formatRate(item.worstProjectedIngress)} · estimated 1 MiB goodput ${formatRate(item.worstEstimatedOneMiBGoodput)} · max reacq ${item.maxReacquisitions}`,
      `100 KB/s margin ${(item.worstEstimatedOneMiBGoodput / TARGET_BYTES_PER_SECOND).toFixed(2)}×`,
    ].join('\n')),
    '',
    stableAtOrAbove100.length
      ? 'Decision signal: pixel-domain feasibility for >=100 KB/s exists. Only the top 1–2 robust candidates should advance to physical camera validation.'
      : 'Decision signal: no robust >=100 KB/s pixel-domain point yet. Continue receiver/carrier optimization before another phone test.',
    'Boundary: these are engineering simulation projections, not physical Net Goodput or acceptance evidence.',
  ];
  summary.textContent = lines.join('\n');
}

async function runSuite(suite: SuiteName): Promise<void> {
  if (frontierResult.status === 'running') return;
  abortRequested = false;
  runButton.disabled = true;
  resultsBody.textContent = '';
  frontierResult = emptyResult(suite);
  frontierResult.status = 'running';
  frontierResult.startedAt = new Date().toISOString();
  publishResult();

  try {
    const plan = buildPlan(suite);
    for (let i = 0; i < plan.length; i += 1) {
      if (abortRequested) break;
      const row = await runCandidate(plan[i], i, plan.length);
      frontierResult.rows.push(row);
      appendRow(row);
      publishResult();
    }
    frontierResult.ranking = rankRows(frontierResult.rows);
    renderSummary(frontierResult.ranking);
    frontierResult.status = abortRequested ? 'aborted' : 'complete';
    frontierResult.finishedAt = new Date().toISOString();
    progress.textContent = abortRequested ? 'aborted' : `complete · ${frontierResult.rows.length} rows`;
  } catch (error) {
    frontierResult.status = 'error';
    frontierResult.error = error instanceof Error ? error.message : String(error);
    frontierResult.finishedAt = new Date().toISOString();
    progress.textContent = `error · ${frontierResult.error}`;
  } finally {
    runButton.disabled = false;
    publishResult();
  }
}

runButton.addEventListener('click', () => void runSuite(suiteMode.value === 'frontier' ? 'frontier' : 'quick'));
stopButton.addEventListener('click', () => { abortRequested = true; });

const autorun = new URLSearchParams(location.search).get('autorun');
if (autorun === 'quick' || autorun === 'frontier') {
  suiteMode.value = autorun;
  setTimeout(() => void runSuite(autorun), 0);
}
