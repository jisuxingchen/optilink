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
  acquireKnownTrainingLockFiducial,
  countKnownErrors,
  getPhysicalAcquisitionDiagnostics,
  resetPhysicalAcquisitionDiagnostics,
  type PixelLock,
} from '../tiled-training-solver.ts';
import {refineKnownTrainingResidual} from '../tf007h-known-training-refine.ts';
import {projectedTileRegionsSafe,rankOrientationCandidate} from '../tf007h-orientation-quality.ts';
import {locateOrientationFiducials,type FiducialLocatorDiagnostic} from '../tiled-orientation-fiducial.ts';
import type {PixelFrame} from './pixel-frame.ts';

export type OrientationMode = 'native' | 'rotate180' | 'rotateCW' | 'rotateCCW';

export const ORIENTATION_MATRIX = 64;
export const TILE_COUNT = 3;
export const SAMPLE_WIDTH = 1280;
export const SAMPLE_HEIGHT = 720;

export type MarkerCandidate = {
  x: number;
  y: number;
  width: number;
  height: number;
  sampleCount: number;
  fillRatio: number;
};

export type CalibrationStage = {
  lockMs: number;
  refineMs: number;
  errorsMs: number;
  calibrationMs: number;
};

export type StageProfile = {
  preScanMs: number;    // orientation pre-scan (downsampled normalize + macro-marker locator)
  normalizeMs: number;  // full-res rotate+resize
  lockMs: number;       // acquireKnownTrainingLock total (includes full-res macro-marker locator)
  refineMs: number;     // refineKnownTrainingResidual
  errorsMs: number;     // countKnownErrors total
  calibrationMs: number;
  totalMs: number;      // total acquireOrientation
};

export type TileStatus = {
  tile: number;
  acquired: boolean;
  exact: boolean;
  bitErrors: number | null;  // null when not acquired
  reason: 'acquired' | 'not-acquired';
  bits: number;
  score: number;
  contrast: number;
  refined?: boolean;
  beforeRefineErrors?: number;
  lock?: PixelLock | null;  // shared geometry lock, available when acquired
};

export type CalibrationResult = {
  success: boolean;
  matrixSize: number;
  orientationMode: OrientationMode;
  tiles: TileStatus[];
  exactTiles: number;
  totalBitErrors: number | null;  // null when not all 3 tiles acquired
  projectionSafe: boolean | null;
  locatorSupport: 'triplet' | 'outer-pair' | 'none';
  detectedMarkerComponentCount: number;  // number of marker components actually found
  validTripletMarkerCount: number;       // 3 (triplet) / 2 (outer-pair) / 0
  tripletValid: boolean;
  lockMode: 'triplet-seeded' | 'outer-pair-untrusted' | 'fallback-exhaustive';
  markerCandidates: MarkerCandidate[];
  tripletRejectReason: string;
  calibrationMs: number;
  stage: CalibrationStage;
};

export type TransformCandidate = {
  mode: OrientationMode;
  detectedMarkerComponentCount: number;
  validTripletMarkerCount: number;
  tripletValid: boolean;
  tripletSupport: 'triplet' | 'outer-pair' | 'none';
  geometryScore: number;
  tripletRejectReason: string;
};

export type OrientationAcquisition = {
  locked: boolean;
  orientationMode: OrientationMode | null;
  matrixSize: number;
  candidates: CalibrationResult[];
  best: CalibrationResult | null;
  transformCandidates: TransformCandidate[];
  selectedTransform: OrientationMode | null;
  profile: StageProfile;
};

// --- sender-side preamble encoding (deterministic, shared with the PC sender
// and the platform-neutral receive core) ---
export function preambleSequence(matrixSize: number, tile: number): number {
  return (0x54000000 | ((matrixSize & 0xff) << 8) | (tile & 0xff)) >>> 0;
}

export function payloadFor(sequence: number, length: number, tile: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < output.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 31 + tile * 47) & 255;
  }
  return output;
}

export function preambleCells(matrixSize: number, tile: number): Uint8Array {
  const sequence = preambleSequence(matrixSize, tile);
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, sequence, payloadFor(sequence, bytes, tile));
}

export function lane(tile: number): {x: number; y: number; width: number; height: number} {
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
  const fw = frame.width;   // full-frame width
  const fh = frame.height;  // full-frame height

  // Letterbox-aware source region: when the raw frame is portrait (taller than
  // wide) and we are NOT rotating 90°, the 16:9 optical content is a central
  // horizontal strip (the sender is landscape). Crop that strip so markers/tiles
  // keep their true aspect ratio instead of being vertically squashed.
  let sx0 = 0, sy0 = 0, sW = fw, sH = fh;
  if ((mode === 'native' || mode === 'rotate180') && fh > fw) {
    sW = fw;
    sH = Math.round(fw * 9 / 16);
    sy0 = Math.round((fh - sH) / 2);
  }

  const out = new Uint8ClampedArray(tw * th * 4);
  const sW1 = sW - 1, sH1 = sH - 1, tw1 = tw - 1, th1 = th - 1;
  const fw1 = fw - 1, fh1 = fh - 1;

  for (let oy = 0; oy < th; oy++) {
    const oyNorm = oy / th1;
    for (let ox = 0; ox < tw; ox++) {
      const oxNorm = ox / tw1;
      let sxNorm: number, syNorm: number;
      if (mode === 'native') { sxNorm = oxNorm; syNorm = oyNorm; }
      else if (mode === 'rotate180') { sxNorm = 1 - oxNorm; syNorm = 1 - oyNorm; }
      else if (mode === 'rotateCW') { sxNorm = oyNorm; syNorm = 1 - oxNorm; }
      else { sxNorm = 1 - oyNorm; syNorm = oxNorm; } // rotateCCW

      const sx = sx0 + sxNorm * sW1;
      const sy = sy0 + syNorm * sH1;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const x1 = Math.min(x0 + 1, fw1), y1 = Math.min(y0 + 1, fh1);

      const o = (oy * tw + ox) * 4;
      const i00 = (y0 * fw + x0) * 4;
      const i10 = (y0 * fw + x1) * 4;
      const i01 = (y1 * fw + x0) * 4;
      const i11 = (y1 * fw + x1) * 4;

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

function fiducialScore(fid: FiducialLocatorDiagnostic | null | undefined): number {
  const t = fid && fid.triplet;
  if (!t) return -Infinity;
  if (t.support === 'triplet') return 1e6 - t.score;
  return 5e5 - t.score; // outer-pair
}

function tripletRejectReason(fid: FiducialLocatorDiagnostic | null | undefined): string {
  if (!fid) return 'no-fiducial';
  const t = fid.triplet;
  if (!t) {
    const n = typeof fid.conservativeComponentCount === 'number' ? fid.conservativeComponentCount : fid.componentCount;
    if (n < 3) return 'insufficient-markers (' + n + ' detected)';
    return 'geometry-mismatch (' + fid.componentCount + ' components, no valid triplet)';
  }
  if (t.support === 'outer-pair') return 'outer-pair (only 2 markers observed)';
  return 'triplet-ok';
}

function calibrationFromImage(image: PixelFrame, matrixSize: number, mode: OrientationMode, fiducialOnly: boolean = false): CalibrationResult {
  const started = Date.now();
  const imageData = asImageData(image);
  type Tile = {
    tile: number; acquired: boolean; exact: boolean; bitErrors: number; bits: number; score: number; contrast: number;
    lock: PixelLock | null; refined?: boolean; beforeRefineErrors?: number;
  };
  const tiles: Tile[] = [];
  let lockMs = 0, errorsMs = 0, refineMs = 0;

  const lockAcquire = fiducialOnly ? acquireKnownTrainingLockFiducial : acquireKnownTrainingLock;
  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const cells = preambleCells(matrixSize, tile);
    const tLock = Date.now();
    const lock = lockAcquire(imageData, matrixSize, cells, lane(tile));
    lockMs += Date.now() - tLock;
    if (!lock) {
      tiles.push({tile, acquired: false, exact: false, bitErrors: Number.MAX_SAFE_INTEGER, bits: 0, score: 0, contrast: 0, lock: null});
      continue;
    }
    const tErr = Date.now();
    const error = countKnownErrors(imageData, matrixSize, cells, lock);
    errorsMs += Date.now() - tErr;
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
      const tR = Date.now();
      const refined = refineKnownTrainingResidual(imageData, matrixSize, cells, residual.lock);
      refineMs += Date.now() - tR;
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
  const totalBitErrors = acquired === TILE_COUNT ? tiles.reduce((s, t) => s + t.bitErrors, 0) : null;
  const diagnostic = getPhysicalAcquisitionDiagnostics().slice(-1)[0] || null;
  const fid = diagnostic?.fiducial || null;
  const projectionSafe = projectedTileRegionsSafe(fid, image.width, image.height);
  const locatorSupport: CalibrationResult['locatorSupport'] = fid?.triplet?.support ?? 'none';
  const lockMode: CalibrationResult['lockMode'] = locatorSupport === 'triplet'
    ? 'triplet-seeded'
    : locatorSupport === 'outer-pair'
      ? 'outer-pair-untrusted'
      : 'fallback-exhaustive';
  const calibrationMs = Date.now() - started;

  return {
    success: exactTiles === TILE_COUNT && totalBitErrors === 0,
    matrixSize,
    orientationMode: mode,
    tiles: tiles.map(t => ({
      tile: t.tile,
      acquired: t.acquired,
      exact: t.exact,
      bitErrors: t.acquired ? t.bitErrors : null,
      reason: t.acquired ? 'acquired' : 'not-acquired',
      bits: t.bits,
      score: t.score,
      contrast: t.contrast,
      refined: t.refined,
      beforeRefineErrors: t.beforeRefineErrors,
      lock: t.lock ?? null,
    })),
    exactTiles,
    totalBitErrors,
    projectionSafe,
    locatorSupport,
    detectedMarkerComponentCount: fid?.componentCount ?? 0,
    validTripletMarkerCount: fid?.triplet?.observedMarkerCount ?? 0,
    tripletValid: fid?.triplet?.support === 'triplet',
    lockMode,
    markerCandidates: (fid?.components ?? []).map(c => ({
      x: c.x, y: c.y, width: c.width, height: c.height, sampleCount: c.sampleCount, fillRatio: c.fillRatio,
    })),
    tripletRejectReason: tripletRejectReason(fid),
    calibrationMs,
    stage: {lockMs, refineMs, errorsMs, calibrationMs},
  };
}

function rankCalibration(result: CalibrationResult): number {
  const acquired = result.tiles.filter(t => t.acquired).length;
  const scoreSum = result.tiles.reduce((s, t) => s + t.score, 0);
  return rankOrientationCandidate({
    success: result.success,
    acquiredTiles: acquired,
    exactTiles: result.exactTiles,
    totalBitErrors: result.totalBitErrors === null ? Number.MAX_SAFE_INTEGER : result.totalBitErrors,
    scoreSum,
    projectionSafe: result.projectionSafe,
  });
}

function orientationCandidates(_frame: PixelFrame): OrientationMode[] {
  // Evaluate ALL transforms; the pre-scan picks by valid-triplet geometry.
  // The physical sensor is portrait, so "none" (letterbox crop) is often the
  // correct transform, not a 90-degree rotation.
  return ['native', 'rotate180', 'rotateCW', 'rotateCCW'];
}

const PRE_SCAN_W = 320;
const PRE_SCAN_H = 180;

/**
 * Run the full TF-007H 64x64 orientation acquisition on a single raw camera
 * frame. Uses a cheap downsampled fiducial pre-scan to pick the likely
 * orientation, then runs full-res acquisition on the winner (with a fallback to
 * the other orientation if the winner does not lock). This preserves the
 * "find the locking orientation" outcome while avoiding full-res work on both
 * orientations when one is clearly correct.
 */
export function acquireOrientation(frame: PixelFrame, candidates?: OrientationMode[], options?: {fiducialOnly?: boolean}): OrientationAcquisition {
  const t0 = Date.now();
  const modes = candidates ?? orientationCandidates(frame);

  // Phase 1: cheap pre-scan on downsampled frames for EVERY transform, recording
  // per-transform geometry diagnostics and ranking by valid-triplet evidence.
  const preScan0 = Date.now();
  const transformCandidates: TransformCandidate[] = [];
  for (const mode of modes) {
    const small = normalizeFrame(frame, mode, PRE_SCAN_W, PRE_SCAN_H);
    const fid = locateOrientationFiducials(asImageData(small));
    transformCandidates.push({
      mode,
      detectedMarkerComponentCount: fid.componentCount,
      validTripletMarkerCount: fid.triplet ? fid.triplet.observedMarkerCount : 0,
      tripletValid: fid.triplet?.support === 'triplet',
      tripletSupport: fid.triplet?.support ?? 'none',
      geometryScore: fiducialScore(fid),
      tripletRejectReason: tripletRejectReason(fid),
    });
  }
  const preScanMs = Date.now() - preScan0;

  // Rank transforms: valid 3-marker triplet > outer-pair > nothing.
  const ranked = transformCandidates.slice().sort((a, b) => b.geometryScore - a.geometryScore);

  // Phase 2: full-res acquisition on the best transform (+ one fallback only if
  // the winner does not lock and the runner-up has at least outer-pair evidence).
  resetPhysicalAcquisitionDiagnostics();
  const results: CalibrationResult[] = [];
  let normalizeMs = 0, lockMs = 0, refineMs = 0, errorsMs = 0, calibrationMs = 0;

  const runCalibration = (mode: OrientationMode): CalibrationResult => {
    const n0 = Date.now();
    const normalized = normalizeFrame(frame, mode, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    normalizeMs += Date.now() - n0;
    const r = calibrationFromImage(normalized, ORIENTATION_MATRIX, mode, Boolean(options?.fiducialOnly));
    lockMs += r.stage.lockMs; refineMs += r.stage.refineMs; errorsMs += r.stage.errorsMs; calibrationMs += r.stage.calibrationMs;
    results.push(r);
    return r;
  };

  let best: CalibrationResult = runCalibration(ranked[0].mode);
  if (!best.success && ranked.length > 1 && ranked[1].geometryScore > -Infinity) {
    const second = runCalibration(ranked[1].mode);
    if (rankCalibration(second) > rankCalibration(best)) best = second;
  }

  return {
    locked: best.success,
    orientationMode: best.success ? best.orientationMode : null,
    matrixSize: ORIENTATION_MATRIX,
    candidates: results,
    best,
    transformCandidates,
    selectedTransform: ranked[0].mode,
    profile: {preScanMs, normalizeMs, lockMs, refineMs, errorsMs, calibrationMs, totalMs: Date.now() - t0},
  };
}
