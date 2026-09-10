/**
 * TF-007H 64x64 orientation acquisition, extracted into a platform-neutral core.
 *
 * This module is the shared "optical acquisition core" consumed by BOTH the
 * browser Receiver and the WeChat Mini Program Receiver. It depends only on the
 * `PixelFrame` shape ({width, height, data: Uint8Array|Uint8ClampedArray}) and
 * the existing TF-007H modules — it has no DOM / `document` / `canvas` /
 * `crypto` / `performance` dependency.
 *
 * It is NOT a copy of the TF-007H algorithm: it imports the exact same
 * `acquireKnownTrainingLock` / `countKnownErrors` / `refineKnownTrainingResidual`
 * / `rankOrientationCandidate` / `projectedTileRegionsSafe` functions the
 * browser `tiled-physical-v5-main.ts` uses. Only the frame normalization
 * (rotate + resize) is re-expressed here because the browser version delegates
 * to `canvas.drawImage`, which the Mini Program does not have.
 *
 * TF-007H trust rule (unchanged): only a fiducial triplet with
 * `support === 'triplet'` may seed macro-triplet acquisition and the
 * projection-safety heuristic. `outer-pair` is untrusted. This module does not
 * regress that rule — it is enforced inside the imported modules.
 */
import {encodeFrameCellsV1,payloadCapacityForMatrixV1} from '../optigrid-v1.ts';
import {
  acquireKnownTrainingLock,
  countKnownErrors,
  getPhysicalAcquisitionDiagnostics,
  resetPhysicalAcquisitionDiagnostics,
  type PixelLock,
} from '../tiled-training-solver.ts';
import {refineKnownTrainingResidual} from '../tf007h-known-training-refine.ts';
import {projectedTileRegionsSafe,rankOrientationCandidate} from '../tf007h-orientation-quality.ts';
import type {PixelFrame} from './pixel-frame.ts';

export type OrientationMode = 'native' | 'rotate180' | 'rotateCW' | 'rotateCCW';

export const ORIENTATION_MATRIX = 64;
export const TILE_COUNT = 3;
export const SAMPLE_WIDTH = 1280;
export const SAMPLE_HEIGHT = 720;

export type TileStatus = {
  tile: number;
  acquired: boolean;
  exact: boolean;
  bitErrors: number;
  bits: number;
  score: number;
  contrast: number;
  refined?: boolean;
  beforeRefineErrors?: number;
};

export type CalibrationResult = {
  success: boolean;
  matrixSize: number;
  orientationMode: OrientationMode;
  tiles: TileStatus[];
  exactTiles: number;
  totalBitErrors: number;
  projectionSafe: boolean | null;
  locatorSupport: 'triplet' | 'outer-pair' | 'none';
  calibrationMs: number;
};

export type OrientationAcquisition = {
  locked: boolean;
  orientationMode: OrientationMode | null;
  matrixSize: number;
  candidates: CalibrationResult[];
  best: CalibrationResult | null;
};

// --- sender-side preamble encoding (deterministic, shared with the PC sender) ---
function preambleSequence(matrixSize: number, tile: number): number {
  return (0x54000000 | ((matrixSize & 0xff) << 8) | (tile & 0xff)) >>> 0;
}

function payloadFor(sequence: number, length: number, tile: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < output.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 31 + tile * 47) & 255;
  }
  return output;
}

function preambleCells(matrixSize: number, tile: number): Uint8Array {
  const sequence = preambleSequence(matrixSize, tile);
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, sequence, payloadFor(sequence, bytes, tile));
}

function lane(tile: number): {x: number; y: number; width: number; height: number} {
  return {x: tile * SAMPLE_WIDTH / TILE_COUNT, y: 0, width: SAMPLE_WIDTH / TILE_COUNT, height: SAMPLE_HEIGHT};
}

// The existing modules are typed against the DOM `ImageData` type, but only use
// its structural `{width, height, data}` shape. A single well-documented cast at
// the boundary (matching the existing test convention) keeps this core DOM-free
// without touching TF-007H source.
function asImageData(frame: PixelFrame): ImageData {
  return frame as unknown as ImageData;
}

/**
 * Rotate + resize a raw camera frame into the canonical 1280x720 landscape
 * buffer the solver expects, using bilinear sampling (equivalent to the
 * browser's `drawImage` with `imageSmoothingEnabled`).
 *
 * Modes (inverse mapping, normalized coords):
 *   native     : sx = ox,               sy = oy
 *   rotate180  : sx = 1 - ox,           sy = 1 - oy
 *   rotateCW   : sx = oy,               sy = 1 - ox
 *   rotateCCW  : sx = 1 - oy,           sy = ox
 */
export function normalizeFrame(
  frame: PixelFrame,
  mode: OrientationMode,
  tw: number = SAMPLE_WIDTH,
  th: number = SAMPLE_HEIGHT,
): PixelFrame {
  const src = frame.data;
  const sw = frame.width;
  const sh = frame.height;
  const out = new Uint8ClampedArray(tw * th * 4);
  const sw1 = sw - 1, sh1 = sh - 1, tw1 = tw - 1, th1 = th - 1;

  for (let oy = 0; oy < th; oy++) {
    const oyNorm = oy / th1;
    for (let ox = 0; ox < tw; ox++) {
      const oxNorm = ox / tw1;
      let sxNorm: number, syNorm: number;
      if (mode === 'native') { sxNorm = oxNorm; syNorm = oyNorm; }
      else if (mode === 'rotate180') { sxNorm = 1 - oxNorm; syNorm = 1 - oyNorm; }
      else if (mode === 'rotateCW') { sxNorm = oyNorm; syNorm = 1 - oxNorm; }
      else { sxNorm = 1 - oyNorm; syNorm = oxNorm; } // rotateCCW

      const sx = sxNorm * sw1;
      const sy = syNorm * sh1;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const x1 = Math.min(x0 + 1, sw1), y1 = Math.min(y0 + 1, sh1);

      const o = (oy * tw + ox) * 4;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bottom * fy;
      }
      out[o + 3] = 255;
    }
  }

  return {width: tw, height: th, data: out};
}

function calibrationFromImage(image: PixelFrame, matrixSize: number, mode: OrientationMode): CalibrationResult {
  const started = Date.now();
  const imageData = asImageData(image);
  type Tile = TileStatus & {lock: PixelLock | null};
  const tiles: Tile[] = [];

  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const cells = preambleCells(matrixSize, tile);
    const lock = acquireKnownTrainingLock(imageData, matrixSize, cells, lane(tile));
    if (!lock) {
      tiles.push({tile, acquired: false, exact: false, bitErrors: Number.MAX_SAFE_INTEGER, bits: 0, score: 0, contrast: 0, lock: null});
      continue;
    }
    const error = countKnownErrors(imageData, matrixSize, cells, lock);
    tiles.push({tile, acquired: true, exact: error.errors === 0, bitErrors: error.errors, bits: error.bits, score: error.score, contrast: error.contrast, lock});
  }

  let exactTiles = tiles.filter(t => t.acquired && t.bitErrors === 0).length;
  let acquired = tiles.filter(t => t.acquired).length;

  // Same constrained residual refine as the browser orientation stage: only
  // when exactly one tile is off by a small number of bits.
  if (matrixSize === ORIENTATION_MATRIX && acquired === TILE_COUNT && exactTiles === TILE_COUNT - 1) {
    const residual = tiles.find(tile => tile.acquired && tile.lock && tile.bitErrors > 0 && tile.bitErrors <= 64);
    if (residual && residual.lock) {
      const cells = preambleCells(matrixSize, residual.tile);
      const refined = refineKnownTrainingResidual(imageData, matrixSize, cells, residual.lock);
      const error = countKnownErrors(imageData, matrixSize, cells, refined.lock);
      residual.beforeRefineErrors = refined.beforeErrors;
      residual.refined = refined.improved;
      residual.lock = refined.lock;
      residual.bitErrors = error.errors;
      residual.bits = error.bits;
      residual.score = error.score;
      residual.contrast = error.contrast;
      residual.exact = error.errors === 0;
      exactTiles = tiles.filter(t => t.acquired && t.bitErrors === 0).length;
    }
  }

  acquired = tiles.filter(t => t.acquired).length;
  const totalBitErrors = acquired === TILE_COUNT
    ? tiles.reduce((s, t) => s + t.bitErrors, 0)
    : Number.MAX_SAFE_INTEGER;
  const diagnostic = getPhysicalAcquisitionDiagnostics().slice(-1)[0] || null;
  const projectionSafe = projectedTileRegionsSafe(diagnostic?.fiducial || null, image.width, image.height);
  const locatorSupport: CalibrationResult['locatorSupport'] = diagnostic?.fiducial?.triplet?.support ?? 'none';

  return {
    success: exactTiles === TILE_COUNT && totalBitErrors === 0,
    matrixSize,
    orientationMode: mode,
    tiles: tiles.map(({lock: _lock, ...rest}) => rest),
    exactTiles,
    totalBitErrors,
    projectionSafe,
    locatorSupport,
    calibrationMs: Date.now() - started,
  };
}

function rankCalibration(result: CalibrationResult): number {
  const acquired = result.tiles.filter(t => t.acquired).length;
  const scoreSum = result.tiles.reduce((s, t) => s + t.score, 0);
  return rankOrientationCandidate({
    success: result.success,
    acquiredTiles: acquired,
    exactTiles: result.exactTiles,
    totalBitErrors: result.totalBitErrors,
    scoreSum,
    projectionSafe: result.projectionSafe,
  });
}

function orientationCandidates(frame: PixelFrame): OrientationMode[] {
  return frame.width < frame.height ? ['rotateCW', 'rotateCCW'] : ['native', 'rotate180'];
}

/**
 * Run the full TF-007H 64x64 orientation acquisition on a single raw camera
 * frame. Tries the applicable orientation candidates, ranks them with the same
 * scoring the browser uses, and returns the best (plus per-candidate detail).
 */
export function acquireOrientation(frame: PixelFrame, candidates?: OrientationMode[]): OrientationAcquisition {
  resetPhysicalAcquisitionDiagnostics();
  const modes = candidates ?? orientationCandidates(frame);
  const results: CalibrationResult[] = [];
  let best: CalibrationResult | null = null;

  for (const mode of modes) {
    const normalized = normalizeFrame(frame, mode);
    const result = calibrationFromImage(normalized, ORIENTATION_MATRIX, mode);
    results.push(result);
    if (!best || rankCalibration(result) > rankCalibration(best)) best = result;
  }

  return {
    locked: best ? best.success : false,
    orientationMode: best && best.success ? best.orientationMode : null,
    matrixSize: ORIENTATION_MATRIX,
    candidates: results,
    best,
  };
}
