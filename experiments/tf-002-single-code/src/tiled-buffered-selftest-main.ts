import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {acquireKnownTrainingLock, countKnownErrors, trackReservedLock, type PixelLock} from './tiled-training-solver.ts';
import {samplePackedCells, sampleSparseFingerprint} from './packed-cell-sampler.ts';
import {StableFingerprintGate} from './stable-fingerprint-gate.ts';
import {decodePackedOptiGridV1} from './deferred-optigrid-decoder.ts';
import {buildTf007fCandidatePlan} from './tf-007f-candidate-plan.ts';
import type {PackedCellObservation} from './packed-cell-buffer.ts';

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 720;
const TILE_COUNT = 3;
const TILE_CENTERS = [330, 960, 1590] as const;
const TILE_RENDER_PIXELS = 540;
const MATRIX = 176;
const SYMBOLS = 12;
const RELOCK_EVERY_CAPTURES = 6;

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

function render(cellsByTile: Uint8Array[]): void {
  senderContext.fillStyle = '#eceff1';
  senderContext.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  senderContext.imageSmoothingEnabled = false;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    drawTile(cellsByTile[tile], MATRIX);
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

function trainingCells(tile: number): Uint8Array {
  const sequence = (0x54000000 | ((MATRIX & 0xff) << 8) | tile) >>> 0;
  const bytes = payloadCapacityForMatrixV1(MATRIX);
  return encodeFrameCellsV1(MATRIX, sequence, payloadFor(sequence, bytes, tile));
}

function dynamicCells(symbol: number, transient = false): Uint8Array[] {
  const bytes = payloadCapacityForMatrixV1(MATRIX);
  return Array.from({length: TILE_COUNT}, (_, tile) => {
    const sequence = transient
      ? (0x70000000 + symbol * 16 + tile) >>> 0
      : (((symbol + 1) * 16 + tile + 1) >>> 0);
    return encodeFrameCellsV1(MATRIX, sequence, payloadFor(sequence, bytes, tile));
  });
}

function concatFingerprints(image: ImageData, locks: PixelLock[]): Uint8Array {
  const parts = locks.map(lock => sampleSparseFingerprint(image, MATRIX, lock, 96));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

type Capture = {tiles: PackedCellObservation[]};

async function run() {
  const started = performance.now();
  const preambles = [trainingCells(0), trainingCells(1), trainingCells(2)];
  render(preambles);
  const trainingImage = cameraImage();
  const locks: PixelLock[] = [];
  const trainingErrors: number[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const lock = acquireKnownTrainingLock(trainingImage, MATRIX, preambles[tile], lane(tile));
    if (!lock) throw new Error(`training lock failed for tile ${tile}`);
    const errors = countKnownErrors(trainingImage, MATRIX, preambles[tile], lock).errors;
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
    render(dynamicCells(symbol, true));
    {
      const image = cameraImage();
      sparseFrames += 1;
      const decision = gate.consider(concatFingerprints(image, locks));
      if (decision.capture) transitionCaptures += 1;
    }

    render(dynamicCells(symbol, false));
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const image = cameraImage();
      sparseFrames += 1;
      const decision = gate.consider(concatFingerprints(image, locks));
      if (!decision.capture) continue;

      const shouldRelock = captures.length === 0 || captures.length % RELOCK_EVERY_CAPTURES === 0;
      if (shouldRelock) {
        relockAttempts += 1;
        const tracked = locks.map(lock => trackReservedLock(image, MATRIX, lock));
        if (tracked.some(item => !item)) {
          relockFailures += 1;
          continue;
        }
        for (let tile = 0; tile < TILE_COUNT; tile += 1) locks[tile] = tracked[tile]!;
      }

      const tiles = locks.map(lock => samplePackedCells(image, MATRIX, lock));
      if (tiles.some(item => !item)) throw new Error('packed cell sample failed');
      captures.push({tiles: tiles as PackedCellObservation[]});
      fullSamples += 1;
    }
  }
  const captureMs = performance.now() - captureStarted;

  const decodeStarted = performance.now();
  let decodedTiles = 0;
  let decodedSymbols = 0;
  let oracleMismatches = 0;
  for (const capture of captures) {
    let complete = 0;
    capture.tiles.forEach((observation, tile) => {
      const result = decodePackedOptiGridV1(observation, MATRIX);
      if (!result.decoded) return;
      decodedTiles += 1;
      const expected = payloadFor(result.decoded.sequence, result.decoded.payload.length, tile);
      if (!sameBytes(result.decoded.payload, expected)) oracleMismatches += 1;
      else complete += 1;
    });
    if (complete === TILE_COUNT) decodedSymbols += 1;
  }
  const deferredDecodeMs = performance.now() - decodeStarted;
  const plan = buildTf007fCandidatePlan(60);
  const candidate176 = plan.find(item => item.matrixSize === 176 && item.actualSymbolHz === 15)!;
  const result = {
    done: true,
    pass: trainingErrors.every(value => value === 0)
      && captures.length === SYMBOLS
      && transitionCaptures === 0
      && relockFailures === 0
      && decodedTiles === SYMBOLS * TILE_COUNT
      && decodedSymbols === SYMBOLS
      && oracleMismatches === 0,
    evidenceClass: 'pixel-domain-buffered-transport-simulation',
    matrixSize: MATRIX,
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
    totalBenchMs: performance.now() - started,
    theoreticalGrossBytesPerSecond: candidate176.theoreticalGrossBytesPerSecond,
    payloadBytesPerTile: candidate176.payloadBytesPerTile,
    note: 'Simulation only; no physical raw ingress or Net Goodput claim.',
  };
  status.textContent = JSON.stringify(result, null, 2);
  (window as any).__TF007F_BUFFERED_SELFTEST__ = result;
}

run().catch(error => {
  const result = {done: true, pass: false, error: error instanceof Error ? error.stack || error.message : String(error)};
  status.textContent = JSON.stringify(result, null, 2);
  (window as any).__TF007F_BUFFERED_SELFTEST__ = result;
});
