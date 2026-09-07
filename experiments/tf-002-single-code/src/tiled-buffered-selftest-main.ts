import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {acquireKnownTrainingLock, countKnownErrors, trackReservedLock, type PixelLock} from './tiled-training-solver.ts';
import {samplePackedCells, sampleSparseFingerprint} from './packed-cell-sampler.ts';
import {StableFingerprintGate} from './stable-fingerprint-gate.ts';
import {decodePackedOptiGridV1} from './deferred-optigrid-decoder.ts';
import {buildTf007fCandidatePlan} from './tf-007f-candidate-plan.ts';
import {binaryCellsFromPacked, type PackedCellObservation} from './packed-cell-buffer.ts';

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 720;
const TILE_COUNT = 3;
const TILE_CENTERS = [330, 960, 1590] as const;
const TILE_RENDER_PIXELS = 540;
const SYMBOLS = 12;
const RELOCK_EVERY_CAPTURES = 6;
const DIAGNOSTIC_MATRICES = [160, 176] as const;

const sender = document.getElementById('sender') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLPreElement;
const senderContext = sender.getContext('2d', {alpha: false})!;
const tileCanvas = document.createElement('canvas');
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = SAMPLE_WIDTH;
sampleCanvas.height = SAMPLE_HEIGHT;
const sampleContext = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true})!;

function payloadFor(sequence: number, length: number, tile: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 31 + tile * 47) & 255;
  }
  return output;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function drawTile(cells: Uint8Array, matrixSize: number): void {
  tileCanvas.width = matrixSize;
  tileCanvas.height = matrixSize;
  const ctx = tileCanvas.getContext('2d', {alpha: false})!;
  const image = ctx.createImageData(matrixSize, matrixSize);
  for (let i = 0; i < cells.length; i += 1) {
    const value = cells[i] ? 0 : 255;
    const offset = i * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function render(cellsByTile: Uint8Array[], matrixSize: number): void {
  senderContext.fillStyle = '#eceff1';
  senderContext.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  senderContext.imageSmoothingEnabled = false;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    drawTile(cellsByTile[tile], matrixSize);
    const left = TILE_CENTERS[tile] - TILE_RENDER_PIXELS / 2;
    const top = FRAME_HEIGHT / 2 - TILE_RENDER_PIXELS / 2;
    senderContext.fillStyle = '#fff';
    senderContext.fillRect(left - 10, top - 10, TILE_RENDER_PIXELS + 20, TILE_RENDER_PIXELS + 20);
    senderContext.drawImage(tileCanvas, left, top, TILE_RENDER_PIXELS, TILE_RENDER_PIXELS);
  }
}

function cameraImage(): ImageData {
  sampleContext.fillStyle = '#eceff1';
  sampleContext.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.drawImage(sender, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  return sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
}

function lane(tile: number) {
  return {x: tile * SAMPLE_WIDTH / TILE_COUNT, y: 0, width: SAMPLE_WIDTH / TILE_COUNT, height: SAMPLE_HEIGHT};
}

function trainingCells(matrixSize: number, tile: number): Uint8Array {
  const sequence = (0x54000000 | ((matrixSize & 0xff) << 8) | tile) >>> 0;
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, sequence, payloadFor(sequence, bytes, tile));
}

function dynamicCells(matrixSize: number, symbol: number, transient = false): Uint8Array[] {
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  return Array.from({length: TILE_COUNT}, (_, tile) => {
    const sequence = transient
      ? (0x70000000 + symbol * 16 + tile) >>> 0
      : (((symbol + 1) * 16 + tile + 1) >>> 0);
    return encodeFrameCellsV1(matrixSize, sequence, payloadFor(sequence, bytes, tile));
  });
}

function concatFingerprints(image: ImageData, matrixSize: number, locks: PixelLock[]): Uint8Array {
  const parts = locks.map(lock => sampleSparseFingerprint(image, matrixSize, lock, 96));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function countCellErrors(actual: Uint8Array, expected: Uint8Array): number {
  let errors = 0;
  const length = Math.min(actual.length, expected.length);
  for (let i = 0; i < length; i += 1) if (actual[i] !== expected[i]) errors += 1;
  return errors + Math.abs(actual.length - expected.length);
}

function packedBitDiagnostic(observation: PackedCellObservation, expected: Uint8Array) {
  const byThreshold = ([1, 2, 3] as const).map(threshold => ({
    threshold,
    errors: countCellErrors(binaryCellsFromPacked(observation, threshold), expected),
  }));
  return {
    byThreshold,
    minimumErrors: Math.min(...byThreshold.map(item => item.errors)),
  };
}

type Capture = {symbol: number; tiles: PackedCellObservation[]};

type MatrixResult = {
  pass: boolean;
  matrixSize: number;
  opticalSymbolHz: 15;
  displayRefreshHz: 60;
  holdRefreshes: 4;
  trainingErrors: number[];
  sparseFrames: number;
  fullSamples: number;
  captures: number;
  transitionCaptures: number;
  relockAttempts: number;
  relockFailures: number;
  decodedTiles: number;
  decodedSymbols: number;
  oracleMismatches: number;
  captureMs: number;
  deferredDecodeMs: number;
  theoreticalGrossBytesPerSecond: number;
  payloadBytesPerTile: number;
  failedTileDiagnostics: Array<{
    symbol: number;
    tile: number;
    minimumErrors: number;
    byThreshold: Array<{threshold: 1 | 2 | 3; errors: number}>;
  }>;
};

async function runMatrix(matrixSize: number): Promise<MatrixResult> {
  const preambles = [trainingCells(matrixSize, 0), trainingCells(matrixSize, 1), trainingCells(matrixSize, 2)];
  render(preambles, matrixSize);
  const trainingImage = cameraImage();
  const locks: PixelLock[] = [];
  const trainingErrors: number[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const lock = acquireKnownTrainingLock(trainingImage, matrixSize, preambles[tile], lane(tile));
    if (!lock) throw new Error(`training lock failed for ${matrixSize} tile ${tile}`);
    const errors = countKnownErrors(trainingImage, matrixSize, preambles[tile], lock).errors;
    locks.push(lock);
    trainingErrors.push(errors);
  }

  const gate = new StableFingerprintGate({requiredStableFrames: 2, maxHammingRatio: 0.08});
  const captures: Capture[] = [];
  let transitionCaptures = 0;
  let sparseFrames = 0;
  let fullSamples = 0;
  let relockAttempts = 0;
  let relockFailures = 0;
  const captureStarted = performance.now();

  for (let symbol = 0; symbol < SYMBOLS; symbol += 1) {
    render(dynamicCells(matrixSize, symbol, true), matrixSize);
    {
      const image = cameraImage();
      sparseFrames += 1;
      const decision = gate.consider(concatFingerprints(image, matrixSize, locks));
      if (decision.capture) transitionCaptures += 1;
    }

    render(dynamicCells(matrixSize, symbol, false), matrixSize);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const image = cameraImage();
      sparseFrames += 1;
      const decision = gate.consider(concatFingerprints(image, matrixSize, locks));
      if (!decision.capture) continue;

      const shouldRelock = captures.length === 0 || captures.length % RELOCK_EVERY_CAPTURES === 0;
      if (shouldRelock) {
        relockAttempts += 1;
        const tracked = locks.map(lock => trackReservedLock(image, matrixSize, lock));
        if (tracked.some(item => !item)) {
          relockFailures += 1;
          continue;
        }
        for (let tile = 0; tile < TILE_COUNT; tile += 1) locks[tile] = tracked[tile]!;
      }

      const tiles = locks.map(lock => samplePackedCells(image, matrixSize, lock));
      if (tiles.some(item => !item)) throw new Error(`packed cell sample failed for ${matrixSize}`);
      captures.push({symbol, tiles: tiles as PackedCellObservation[]});
      fullSamples += 1;
    }
  }
  const captureMs = performance.now() - captureStarted;

  const decodeStarted = performance.now();
  let decodedTiles = 0;
  let decodedSymbols = 0;
  let oracleMismatches = 0;
  const failedTileDiagnostics: MatrixResult['failedTileDiagnostics'] = [];
  for (const capture of captures) {
    const expectedCells = dynamicCells(matrixSize, capture.symbol, false);
    let complete = 0;
    capture.tiles.forEach((observation, tile) => {
      const result = decodePackedOptiGridV1(observation, matrixSize);
      if (!result.decoded) {
        const diagnostic = packedBitDiagnostic(observation, expectedCells[tile]);
        failedTileDiagnostics.push({symbol: capture.symbol, tile, ...diagnostic});
        return;
      }
      decodedTiles += 1;
      const expected = payloadFor(result.decoded.sequence, result.decoded.payload.length, tile);
      if (!sameBytes(result.decoded.payload, expected)) oracleMismatches += 1;
      else complete += 1;
    });
    if (complete === TILE_COUNT) decodedSymbols += 1;
  }
  const deferredDecodeMs = performance.now() - decodeStarted;
  const candidate = buildTf007fCandidatePlan(60).find(item => item.matrixSize === matrixSize && item.actualSymbolHz === 15);
  if (!candidate) throw new Error(`missing TF-007F candidate ${matrixSize}@15`);
  const pass = trainingErrors.every(value => value === 0)
    && captures.length === SYMBOLS
    && transitionCaptures === 0
    && relockFailures === 0
    && decodedTiles === SYMBOLS * TILE_COUNT
    && decodedSymbols === SYMBOLS
    && oracleMismatches === 0;

  return {
    pass,
    matrixSize,
    opticalSymbolHz: 15,
    displayRefreshHz: 60,
    holdRefreshes: 4,
    trainingErrors,
    sparseFrames,
    fullSamples,
    captures: captures.length,
    transitionCaptures,
    relockAttempts,
    relockFailures,
    decodedTiles,
    decodedSymbols,
    oracleMismatches,
    captureMs,
    deferredDecodeMs,
    theoreticalGrossBytesPerSecond: candidate.theoreticalGrossBytesPerSecond,
    payloadBytesPerTile: candidate.payloadBytesPerTile,
    failedTileDiagnostics,
  };
}

async function run() {
  const started = performance.now();
  const frontier: MatrixResult[] = [];
  for (const matrixSize of DIAGNOSTIC_MATRICES) frontier.push(await runMatrix(matrixSize));
  const release160 = frontier.find(item => item.matrixSize === 160)!;
  const frontier176 = frontier.find(item => item.matrixSize === 176)!;
  const frontier176IntegrityPass = frontier176.trainingErrors.every(value => value === 0)
    && frontier176.captures === SYMBOLS
    && frontier176.transitionCaptures === 0
    && frontier176.relockFailures === 0
    && frontier176.oracleMismatches === 0;
  const result = {
    done: true,
    ...release160,
    pass: release160.pass && release160.theoreticalGrossBytesPerSecond > 100000 && frontier176IntegrityPass,
    evidenceClass: 'pixel-domain-buffered-transport-simulation',
    releaseCandidateMatrix: 160,
    releaseCandidateSymbolHz: 15,
    frontier176IntegrityPass,
    frontier,
    totalBenchMs: performance.now() - started,
    note: 'Simulation only. Issue #32 defines 3×160 as the primary low-symbol-rate sweep. Phone-readiness is gated on exact 3×160@15 (>100,000 B/s theoretical gross) with 176 retained as a non-authoritative frontier diagnostic. No physical raw ingress or Net Goodput claim.',
  };
  status.textContent = JSON.stringify(result, null, 2);
  (window as any).__TF007F_BUFFERED_SELFTEST__ = result;
}

run().catch(error => {
  const result = {done: true, pass: false, error: error instanceof Error ? error.stack || error.message : String(error)};
  status.textContent = JSON.stringify(result, null, 2);
  (window as any).__TF007F_BUFFERED_SELFTEST__ = result;
});
