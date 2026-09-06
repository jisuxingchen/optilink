import QRCode from 'qrcode';
import {BrowserQRCodeReader} from '@zxing/browser';

import {affineFromTriangles, homographyFromUnitSquare, mapHomography, type Point, type Quad} from './optigrid-geometry.ts';
import {
  decodeFrameCells,
  encodeFrameCells,
  payloadCapacityForMatrix,
  reservedCellValue,
} from './optigrid.ts';
import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';
import {crc32} from './protocol.ts';

type CarrierId = 'standard-qr' | 'optigrid-v0' | 'optigrid-v1';
type ScenarioName = 'clean' | 'mild' | 'stress';

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
  carrier: CarrierId;
  scenario: Scenario;
  matrixSize?: number;
  payloadBytes: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  cameraHz: number;
  frames: number;
};

type PixelFrame = {
  image: ImageData;
};

type DecodedPixelFrame = {
  sequence: number;
  payload: Uint8Array;
  finderScore: number;
  contrast: number;
};

type CandidateResult = {
  id: string;
  carrier: CarrierId;
  scenario: ScenarioName;
  matrixSize: number | null;
  payloadBytesPerFrame: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  cameraHz: number;
  attemptedFrames: number;
  validFrames: number;
  validRatio: number;
  renderP95Ms: number;
  channelP95Ms: number;
  decodeP95Ms: number;
  senderCapacityHz: number;
  receiverCapacityHz: number;
  projectedEffectiveHz: number;
  theoreticalGrossBytesPerSecond: number;
  projectedPixelSimIngressBytesPerSecond: number;
  averageFinderScore: number;
  averageContrast: number;
  renderErrors: number;
  decodeErrors: number;
  oracleMismatches: number;
};

type GroupRanking = {
  key: string;
  carrier: CarrierId;
  matrixSize: number | null;
  payloadBytesPerFrame: number;
  renderPixels: number;
  cameraPixels: number;
  targetHz: number;
  minValidRatio: number;
  minProjectedIngress: number;
  cleanProjectedIngress: number;
  mildProjectedIngress: number;
  selectionScore: number;
  scenarios: ScenarioName[];
};

type BenchResult = {
  status: 'idle' | 'running' | 'complete' | 'aborted' | 'error';
  suite: 'quick' | 'full';
  startedAt?: string;
  finishedAt?: string;
  isolation: {
    receiverInput: 'ImageData pixels only';
    senderPayloadPassedToReceiver: false;
    senderCellsPassedToReceiver: false;
    benchmarkOracleSeparatedFromReceiver: true;
  };
  rows: CandidateResult[];
  ranking: GroupRanking[];
  selected: GroupRanking[];
  error?: string;
};

const CLEAN: Scenario = {name: 'clean', fillRatio: 0.78, angleDeg: 0, perspective: 0, shear: 0, blurPx: 0, noise: 0};
const MILD: Scenario = {name: 'mild', fillRatio: 0.73, angleDeg: 4, perspective: 0.05, shear: 0.025, blurPx: 0.35, noise: 2};
const STRESS: Scenario = {name: 'stress', fillRatio: 0.68, angleDeg: 8, perspective: 0.10, shear: 0.055, blurPx: 0.75, noise: 5};

const qrReader = new BrowserQRCodeReader(undefined, {delayBetweenScanAttempts: 0, delayBetweenScanSuccess: 0});

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
let benchResult: BenchResult = emptyBenchResult('quick');
publishBenchResult();

function get<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function emptyBenchResult(suite: 'quick' | 'full'): BenchResult {
  return {
    status: 'idle',
    suite,
    isolation: {
      receiverInput: 'ImageData pixels only',
      senderPayloadPassedToReceiver: false,
      senderCellsPassedToReceiver: false,
      benchmarkOracleSeparatedFromReceiver: true,
    },
    rows: [],
    ranking: [],
    selected: [],
  };
}

function publishBenchResult(): void {
  (window as Window & {__carrierBenchResult?: BenchResult}).__carrierBenchResult = benchResult;
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
  let x = (sequence ^ 0x54463035) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    output[i] = (x + i * 31 + (sequence & 0xff)) & 0xff;
  }
  return output;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function qrChecksum(sequence: number, payload: Uint8Array): number {
  const bytes = new Uint8Array(4 + payload.length);
  bytes[0] = (sequence >>> 24) & 0xff;
  bytes[1] = (sequence >>> 16) & 0xff;
  bytes[2] = (sequence >>> 8) & 0xff;
  bytes[3] = sequence & 0xff;
  bytes.set(payload, 4);
  return crc32(bytes);
}

function encodeQrBenchText(sequence: number, payload: Uint8Array): string {
  return `OB1:${(sequence >>> 0).toString(16).padStart(8, '0')}:${base64UrlEncode(payload)}:${qrChecksum(sequence, payload).toString(16).padStart(8, '0')}`;
}

function decodeQrBenchText(text: string): DecodedPixelFrame | null {
  const parts = text.split(':');
  if (parts.length !== 4 || parts[0] !== 'OB1') return null;
  const sequence = Number.parseInt(parts[1], 16) >>> 0;
  const payload = base64UrlDecode(parts[2]);
  const expected = Number.parseInt(parts[3], 16) >>> 0;
  if (!payload || qrChecksum(sequence, payload) !== expected) return null;
  return {sequence, payload, finderScore: 1, contrast: 0};
}

function drawCells(canvas: HTMLCanvasElement, cells: Uint8Array, matrixSize: number, pixels: number): void {
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('sender canvas 2D context unavailable');
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

async function renderCarrier(candidate: Candidate, sequence: number, payload: Uint8Array): Promise<void> {
  if (candidate.carrier === 'standard-qr') {
    senderCanvas.width = candidate.renderPixels;
    senderCanvas.height = candidate.renderPixels;
    await QRCode.toCanvas(senderCanvas, encodeQrBenchText(sequence, payload), {
      width: candidate.renderPixels,
      margin: 2,
      errorCorrectionLevel: 'L',
      color: {dark: '#000000', light: '#ffffff'},
    });
    return;
  }
  const matrixSize = candidate.matrixSize;
  if (!matrixSize) throw new Error('matrixSize required for OptiGrid');
  const cells = candidate.carrier === 'optigrid-v0'
    ? encodeFrameCells(matrixSize, sequence, payload)
    : encodeFrameCellsV1(matrixSize, sequence, payload);
  drawCells(senderCanvas, cells, matrixSize, candidate.renderPixels);
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

function showReceiverPixels(pixelFrame: PixelFrame): void {
  receiverCanvas.width = pixelFrame.image.width;
  receiverCanvas.height = pixelFrame.image.height;
  const context = receiverCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  context.putImageData(pixelFrame.image, 0, 0);
}

function luma(data: Uint8ClampedArray, index: number): number {
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function imageThreshold(image: ImageData): {low: number; high: number; threshold: number} {
  const histogram = new Uint32Array(256);
  let samples = 0;
  const step = image.width * image.height > 600_000 ? 3 : 2;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const index = (y * image.width + x) * 4;
      histogram[Math.max(0, Math.min(255, Math.round(luma(image.data, index))))] += 1;
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
      const index = (y * image.width + x) * 4;
      if (luma(image.data, index) >= threshold) continue;
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

function samplePixel(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  return luma(image.data, (py * image.width + px) * 4);
}

function evaluateReserved(
  image: ImageData,
  quad: Quad,
  matrixSize: number,
  reserved: (row: number, column: number, size: number) => number | null,
  sampleStride = 2,
): {score: number; contrast: number; threshold: number} | null {
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const values: Array<{expected: number; value: number}> = [];
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reserved(row, column, matrixSize);
      if (expected === null) continue;
      if ((row + column) % sampleStride !== 0 && row >= 10 && column >= 10 && row < matrixSize - 10 && column < matrixSize - 10) continue;
      const point = mapHomography(h, (column + 0.5) / matrixSize, (row + 0.5) / matrixSize);
      const value = samplePixel(image, point.x, point.y);
      values.push({expected, value});
      if (expected) { blackSum += value; blackCount += 1; }
      else { whiteSum += value; whiteCount += 1; }
    }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const threshold = (blackMean + whiteMean) / 2;
  const contrast = whiteMean - blackMean;
  let matches = 0;
  for (const item of values) if ((item.value < threshold ? 1 : 0) === item.expected) matches += 1;
  return {score: values.length ? matches / values.length : 0, contrast, threshold};
}

function cloneQuad(quad: Quad): Quad {
  return {tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl}};
}

function refineQuad(
  image: ImageData,
  initial: Quad,
  matrixSize: number,
  reserved: (row: number, column: number, size: number) => number | null,
): {quad: Quad; score: number; contrast: number; threshold: number} | null {
  let measured = evaluateReserved(image, initial, matrixSize, reserved, 3);
  if (!measured) return null;
  let best = {quad: initial, ...measured};
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  const baseStep = Math.max(1, image.width / 120);
  for (const step of [baseStep * 2, baseStep, Math.max(0.75, baseStep / 2)]) {
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) {
        for (const axis of ['x', 'y'] as const) {
          for (const direction of [-1, 1]) {
            const quad = cloneQuad(best.quad);
            quad[corner][axis] += step * direction;
            const candidate = evaluateReserved(image, quad, matrixSize, reserved, 3);
            if (!candidate) continue;
            const objective = candidate.score + Math.max(0, Math.min(100, candidate.contrast)) / 700;
            const bestObjective = best.score + Math.max(0, Math.min(100, best.contrast)) / 700;
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
  const final = evaluateReserved(image, best.quad, matrixSize, reserved, 1);
  return final ? {quad: best.quad, ...final} : best;
}

function sampleCustomCells(
  image: ImageData,
  matrixSize: number,
  variant: 'v0' | 'v1',
): {cells: Uint8Array; score: number; contrast: number} | null {
  const reserved = variant === 'v0' ? reservedCellValue : reservedCellValueV1;
  const initial = findDarkQuad(image, matrixSize);
  if (!initial) return null;
  const aligned = refineQuad(image, initial, matrixSize, reserved);
  if (!aligned || aligned.contrast < 18 || aligned.score < 0.72) return null;
  const h = homographyFromUnitSquare(aligned.quad);
  if (!h) return null;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const point = mapHomography(h, (column + 0.5) / matrixSize, (row + 0.5) / matrixSize);
      cells[row * matrixSize + column] = samplePixel(image, point.x, point.y) < aligned.threshold ? 1 : 0;
    }
  }
  return {cells, score: aligned.score, contrast: aligned.contrast};
}

async function decodePixelOnly(candidate: Candidate, pixelFrame: PixelFrame): Promise<DecodedPixelFrame | null> {
  // IMPORTANT: this function receives no sender canvas, payload, cells or frame object.
  // Its only data-bearing argument is PixelFrame(ImageData), matching the TF-005 validity rule.
  if (candidate.carrier === 'standard-qr') {
    const canvas = document.createElement('canvas');
    canvas.width = pixelFrame.image.width;
    canvas.height = pixelFrame.image.height;
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) return null;
    context.putImageData(pixelFrame.image, 0, 0);
    try {
      const result = qrReader.decodeFromCanvas(canvas);
      return decodeQrBenchText(result.getText());
    } catch {
      return null;
    }
  }

  const matrixSize = candidate.matrixSize;
  if (!matrixSize) return null;
  const sampled = sampleCustomCells(pixelFrame.image, matrixSize, candidate.carrier === 'optigrid-v0' ? 'v0' : 'v1');
  if (!sampled) return null;
  const decoded = candidate.carrier === 'optigrid-v0'
    ? decodeFrameCells(sampled.cells, matrixSize)
    : decodeFrameCellsV1(sampled.cells, matrixSize);
  if (!decoded) return null;
  return {sequence: decoded.sequence, payload: decoded.payload, finderScore: sampled.score, contrast: sampled.contrast};
}

function payloadCapacity(carrier: CarrierId, matrixSize?: number): number {
  if (carrier === 'standard-qr') throw new Error('QR payload is explicit');
  if (!matrixSize) throw new Error('matrixSize required');
  return carrier === 'optigrid-v0' ? payloadCapacityForMatrix(matrixSize) : payloadCapacityForMatrixV1(matrixSize);
}

function customCandidate(carrier: 'optigrid-v0' | 'optigrid-v1', matrixSize: number, renderPixels: number, cameraPixels: number, targetHz: number, scenario: Scenario, frames: number): Candidate {
  return {
    id: `${carrier}-${matrixSize}-${renderPixels}-${cameraPixels}-${targetHz}-${scenario.name}`,
    carrier,
    scenario,
    matrixSize,
    payloadBytes: payloadCapacity(carrier, matrixSize),
    renderPixels,
    cameraPixels,
    targetHz,
    cameraHz: 60,
    frames,
  };
}

function qrCandidate(payloadBytes: number, renderPixels: number, cameraPixels: number, targetHz: number, scenario: Scenario, frames: number): Candidate {
  return {
    id: `standard-qr-${payloadBytes}-${renderPixels}-${cameraPixels}-${targetHz}-${scenario.name}`,
    carrier: 'standard-qr',
    scenario,
    payloadBytes,
    renderPixels,
    cameraPixels,
    targetHz,
    cameraHz: 60,
    frames,
  };
}

function buildPlan(suite: 'quick' | 'full'): Candidate[] {
  const plan: Candidate[] = [];
  if (suite === 'quick') {
    const scenarios = [CLEAN, MILD];
    for (const scenario of scenarios) {
      plan.push(qrCandidate(300, 560, 720, 24, scenario, 6));
      plan.push(qrCandidate(600, 720, 720, 24, scenario, 6));
      plan.push(customCandidate('optigrid-v0', 64, 640, 720, 24, scenario, 6));
      plan.push(customCandidate('optigrid-v0', 96, 960, 960, 24, scenario, 6));
      plan.push(customCandidate('optigrid-v1', 64, 640, 720, 24, scenario, 6));
      plan.push(customCandidate('optigrid-v1', 96, 960, 960, 24, scenario, 6));
    }
    return plan;
  }

  const scenarios = [CLEAN, MILD, STRESS];
  const qrSetups = [
    [200, 480, 540, 24], [300, 560, 720, 24], [450, 640, 720, 30],
    [650, 800, 960, 30], [900, 960, 960, 30], [650, 960, 1080, 60],
  ] as const;
  for (const scenario of scenarios) for (const [payloadBytes, renderPixels, cameraPixels, targetHz] of qrSetups) {
    plan.push(qrCandidate(payloadBytes, renderPixels, cameraPixels, targetHz, scenario, 8));
  }

  for (const carrier of ['optigrid-v0', 'optigrid-v1'] as const) {
    for (const scenario of scenarios) {
      for (const matrixSize of [48, 64, 80, 96, 120, 160]) {
        const renderPixels = Math.max(480, Math.min(1200, matrixSize * (matrixSize >= 120 ? 7 : 9)));
        const cameraPixels = matrixSize >= 120 ? 1080 : matrixSize >= 96 ? 960 : 720;
        for (const targetHz of [24, 30]) plan.push(customCandidate(carrier, matrixSize, renderPixels, cameraPixels, targetHz, scenario, 6));
      }
    }
  }
  return plan;
}

function updateLiveStatus(candidate: Candidate, frameIndex: number, decoded: DecodedPixelFrame | null): void {
  senderStatus.textContent = [
    `carrier: ${candidate.carrier}`,
    `scenario: ${candidate.scenario.name}`,
    `frame: ${frameIndex + 1}/${candidate.frames}`,
    `payload: ${candidate.payloadBytes} B/frame`,
    `render: ${candidate.renderPixels}px · target ${candidate.targetHz} Hz`,
    candidate.matrixSize ? `matrix: ${candidate.matrixSize}×${candidate.matrixSize}` : 'QR: ZXing decode from simulated camera pixels',
  ].join('\n');
  receiverStatus.textContent = [
    'receiver input: ImageData pixels only',
    `camera simulation: ${candidate.cameraPixels}×${candidate.cameraPixels}`,
    `angle ${candidate.scenario.angleDeg}° · perspective ${candidate.scenario.perspective.toFixed(2)} · blur ${candidate.scenario.blurPx}px · noise ${candidate.scenario.noise}`,
    decoded ? `decoded sequence ${decoded.sequence} · finder ${(decoded.finderScore * 100).toFixed(1)}% · contrast ${decoded.contrast.toFixed(1)}` : 'decode: no valid frame',
  ].join('\n');
}

async function runCandidate(candidate: Candidate, candidateIndex: number, totalCandidates: number): Promise<CandidateResult> {
  const renderTimes: number[] = [];
  const channelTimes: number[] = [];
  const decodeTimes: number[] = [];
  let validFrames = 0;
  let renderErrors = 0;
  let decodeErrors = 0;
  let oracleMismatches = 0;
  let finderSum = 0;
  let contrastSum = 0;
  let finderSamples = 0;

  for (let frame = 0; frame < candidate.frames && !abortRequested; frame += 1) {
    const sequence = ((candidateIndex + 1) * 100_000 + frame + 1) >>> 0;
    const sourcePayload = deterministicPayload(sequence, candidate.payloadBytes);
    const renderStarted = performance.now();
    try {
      await renderCarrier(candidate, sequence, sourcePayload);
    } catch {
      renderErrors += 1;
      renderTimes.push(performance.now() - renderStarted);
      continue;
    }
    renderTimes.push(performance.now() - renderStarted);

    const channelStarted = performance.now();
    const pixelFrame = captureOpticalPixels(candidate, sequence);
    channelTimes.push(performance.now() - channelStarted);
    showReceiverPixels(pixelFrame);

    const decodeStarted = performance.now();
    let decoded: DecodedPixelFrame | null = null;
    try {
      decoded = await decodePixelOnly(candidate, pixelFrame);
    } catch {
      decodeErrors += 1;
    }
    decodeTimes.push(performance.now() - decodeStarted);

    if (decoded) {
      finderSum += decoded.finderScore;
      contrastSum += decoded.contrast;
      finderSamples += 1;
      if (decoded.sequence === sequence && equalBytes(decoded.payload, sourcePayload)) validFrames += 1;
      else oracleMismatches += 1;
    }
    updateLiveStatus(candidate, frame, decoded);
    progress.textContent = `${candidateIndex + 1}/${totalCandidates} · ${candidate.id} · frame ${frame + 1}/${candidate.frames}`;
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const attemptedFrames = candidate.frames;
  const validRatio = attemptedFrames ? validFrames / attemptedFrames : 0;
  const renderP95Ms = percentile(renderTimes, 0.95);
  const channelP95Ms = percentile(channelTimes, 0.95);
  const decodeP95Ms = percentile(decodeTimes, 0.95);
  const senderCapacityHz = renderP95Ms > 0 ? 1000 / renderP95Ms : candidate.targetHz;
  const receiverCapacityHz = decodeP95Ms > 0 ? 1000 / decodeP95Ms : candidate.targetHz;
  const projectedEffectiveHz = Math.min(candidate.targetHz, candidate.cameraHz, senderCapacityHz, receiverCapacityHz) * validRatio;
  return {
    id: candidate.id,
    carrier: candidate.carrier,
    scenario: candidate.scenario.name,
    matrixSize: candidate.matrixSize ?? null,
    payloadBytesPerFrame: candidate.payloadBytes,
    renderPixels: candidate.renderPixels,
    cameraPixels: candidate.cameraPixels,
    targetHz: candidate.targetHz,
    cameraHz: candidate.cameraHz,
    attemptedFrames,
    validFrames,
    validRatio,
    renderP95Ms,
    channelP95Ms,
    decodeP95Ms,
    senderCapacityHz,
    receiverCapacityHz,
    projectedEffectiveHz,
    theoreticalGrossBytesPerSecond: candidate.payloadBytes * candidate.targetHz,
    projectedPixelSimIngressBytesPerSecond: candidate.payloadBytes * projectedEffectiveHz,
    averageFinderScore: finderSamples ? finderSum / finderSamples : 0,
    averageContrast: finderSamples ? contrastSum / finderSamples : 0,
    renderErrors,
    decodeErrors,
    oracleMismatches,
  };
}

function groupKey(row: CandidateResult): string {
  return [row.carrier, row.matrixSize ?? 'qr', row.payloadBytesPerFrame, row.renderPixels, row.cameraPixels, row.targetHz].join('|');
}

function rankRows(rows: CandidateResult[]): GroupRanking[] {
  const groups = new Map<string, CandidateResult[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const items = groups.get(key) || [];
    items.push(row);
    groups.set(key, items);
  }
  const ranking: GroupRanking[] = [];
  for (const [key, items] of groups) {
    const first = items[0];
    const minValidRatio = Math.min(...items.map(item => item.validRatio));
    const minProjectedIngress = Math.min(...items.map(item => item.projectedPixelSimIngressBytesPerSecond));
    const cleanProjectedIngress = items.find(item => item.scenario === 'clean')?.projectedPixelSimIngressBytesPerSecond ?? 0;
    const mildProjectedIngress = items.find(item => item.scenario === 'mild')?.projectedPixelSimIngressBytesPerSecond ?? 0;
    ranking.push({
      key,
      carrier: first.carrier,
      matrixSize: first.matrixSize,
      payloadBytesPerFrame: first.payloadBytesPerFrame,
      renderPixels: first.renderPixels,
      cameraPixels: first.cameraPixels,
      targetHz: first.targetHz,
      minValidRatio,
      minProjectedIngress,
      cleanProjectedIngress,
      mildProjectedIngress,
      selectionScore: minProjectedIngress * minValidRatio,
      scenarios: items.map(item => item.scenario),
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
    `<td>${row.carrier}</td>`,
    `<td>${row.scenario}</td>`,
    `<td>${row.matrixSize ? `${row.matrixSize}²` : `${row.payloadBytesPerFrame}B QR`}</td>`,
    `<td>${row.renderPixels}</td>`,
    `<td>${row.cameraPixels}</td>`,
    `<td>${row.targetHz}</td>`,
    `<td>${row.validFrames}/${row.attemptedFrames} (${(row.validRatio * 100).toFixed(0)}%)</td>`,
    `<td>${row.payloadBytesPerFrame}</td>`,
    `<td>${row.decodeP95Ms.toFixed(1)}</td>`,
    `<td>${formatRate(row.projectedPixelSimIngressBytesPerSecond)}</td>`,
    `<td>${row.averageFinderScore ? `${(row.averageFinderScore * 100).toFixed(1)}%` : '-'}</td>`,
  ].join('');
  resultsBody.appendChild(tr);
}

function renderSummary(ranking: GroupRanking[]): void {
  const stable = ranking.filter(item => item.minValidRatio >= 0.95 && item.scenarios.includes('clean') && item.scenarios.includes('mild'));
  const selected = (stable.length ? stable : ranking).slice(0, 3);
  benchResult.selected = selected;
  const lines = [
    'Receiver isolation: ImageData pixels only; no sender payload/cells are passed into decoder.',
    `stable groups (clean+mild >=95%): ${stable.length}/${ranking.length}`,
    '',
    ...selected.map((item, index) => [
      `#${index + 1} ${item.carrier}${item.matrixSize ? ` ${item.matrixSize}×${item.matrixSize}` : ''}`,
      `payload ${item.payloadBytesPerFrame} B/f · render ${item.renderPixels}px · camera ${item.cameraPixels}px · target ${item.targetHz} Hz`,
      `worst valid ${(item.minValidRatio * 100).toFixed(1)}% · worst projected ${formatRate(item.minProjectedIngress)} · clean ${formatRate(item.cleanProjectedIngress)} · mild ${formatRate(item.mildProjectedIngress)}`,
      `100 KB/s margin: ${(item.minProjectedIngress / 100000).toFixed(2)}×`,
    ].join('\n')),
    '',
    'Interpretation: projected ingress is pixel-simulation engineering data, not physical Net Goodput.',
  ];
  summary.textContent = lines.join('\n');
}

async function runSuite(suite: 'quick' | 'full'): Promise<void> {
  if (benchResult.status === 'running') return;
  abortRequested = false;
  resultsBody.textContent = '';
  benchResult = emptyBenchResult(suite);
  benchResult.status = 'running';
  benchResult.startedAt = new Date().toISOString();
  publishBenchResult();
  runButton.disabled = true;
  suiteMode.disabled = true;
  stopButton.disabled = false;
  summary.textContent = 'running automated pixel-isolated sweep…';

  try {
    const plan = buildPlan(suite);
    for (let index = 0; index < plan.length; index += 1) {
      if (abortRequested) break;
      const row = await runCandidate(plan[index], index, plan.length);
      benchResult.rows.push(row);
      appendRow(row);
      publishBenchResult();
    }
    benchResult.ranking = rankRows(benchResult.rows);
    benchResult.status = abortRequested ? 'aborted' : 'complete';
    benchResult.finishedAt = new Date().toISOString();
    renderSummary(benchResult.ranking);
    progress.textContent = `${benchResult.status} · ${benchResult.rows.length} candidates`;
  } catch (error) {
    benchResult.status = 'error';
    benchResult.error = String(error);
    benchResult.finishedAt = new Date().toISOString();
    summary.textContent = `ERROR\n${String(error)}`;
    progress.textContent = 'error';
  } finally {
    publishBenchResult();
    runButton.disabled = false;
    suiteMode.disabled = false;
    stopButton.disabled = true;
  }
}

runButton.addEventListener('click', () => void runSuite(suiteMode.value === 'full' ? 'full' : 'quick'));
stopButton.addEventListener('click', () => { abortRequested = true; });
stopButton.disabled = true;

const params = new URLSearchParams(location.search);
const autorun = params.get('autorun');
if (autorun === 'quick' || autorun === 'full') {
  suiteMode.value = autorun;
  requestAnimationFrame(() => void runSuite(autorun));
}
