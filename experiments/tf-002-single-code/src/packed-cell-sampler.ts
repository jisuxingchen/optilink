import {homographyFromUnitSquare, mapHomography} from './optigrid-geometry.ts';
import {reservedCellValueV1} from './optigrid-v1.ts';
import {sampleLuma, type PixelLock} from './tiled-training-solver.ts';
import {packTwoBitLevels, type PackedCellObservation} from './packed-cell-buffer.ts';

const positionCache = new Map<string, Array<{row: number; column: number}>>();
const AMBIGUOUS_LOW = 0.28;
const AMBIGUOUS_HIGH = 0.72;
const SUBCELL_OFFSET = 0.18;

function fingerprintPositions(matrixSize: number, count: number): Array<{row: number; column: number}> {
  const key = `${matrixSize}:${count}`;
  const cached = positionCache.get(key);
  if (cached) return cached;
  const candidates: Array<{row: number; column: number; rank: number}> = [];
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      if (reservedCellValueV1(row, column, matrixSize) !== null) continue;
      // Deterministic pseudo-random rank so the sparse fingerprint covers the
      // whole payload interior instead of clustering in one corner.
      const rank = (((row + 1) * 2654435761) ^ ((column + 7) * 2246822519) ^ (matrixSize * 3266489917)) >>> 0;
      candidates.push({row, column, rank});
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const result = candidates.slice(0, Math.min(count, candidates.length)).map(({row, column}) => ({row, column}));
  positionCache.set(key, result);
  return result;
}

function normalizedLuma(luma: number, lock: PixelLock): number {
  const span = Math.max(8, lock.contrast);
  const black = lock.threshold - span / 2;
  return Math.max(0, Math.min(1, (luma - black) / span));
}

function robustCellLuma(
  image: ImageData,
  h: NonNullable<ReturnType<typeof homographyFromUnitSquare>>,
  matrixSize: number,
  lock: PixelLock,
  row: number,
  column: number,
): number {
  const center = mapHomography(
    h,
    (column + 0.5 + lock.phaseX) / matrixSize,
    (row + 0.5 + lock.phaseY) / matrixSize,
  );
  const centerLuma = sampleLuma(image, center.x, center.y);
  const normalized = normalizedLuma(centerLuma, lock);

  // Most cells are decisively black or white and stay on the one-sample fast path.
  // At high density (~2 camera pixels/cell), only threshold-adjacent cells pay for
  // four cell-interior taps. Their median suppresses sub-pixel resampling/edge
  // contamination without borrowing any payload oracle or neighbouring-cell value.
  if (normalized <= AMBIGUOUS_LOW || normalized >= AMBIGUOUS_HIGH) return centerLuma;

  const values = [centerLuma];
  for (const [dx, dy] of [
    [-SUBCELL_OFFSET, 0],
    [SUBCELL_OFFSET, 0],
    [0, -SUBCELL_OFFSET],
    [0, SUBCELL_OFFSET],
  ] as const) {
    const point = mapHomography(
      h,
      (column + 0.5 + lock.phaseX + dx) / matrixSize,
      (row + 0.5 + lock.phaseY + dy) / matrixSize,
    );
    values.push(sampleLuma(image, point.x, point.y));
  }
  values.sort((a, b) => a - b);
  return values[2];
}

export function sampleSparseFingerprint(image: ImageData, matrixSize: number, lock: PixelLock, count = 96): Uint8Array {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return new Uint8Array();
  const positions = fingerprintPositions(matrixSize, count);
  const bits = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i += 1) {
    const {row, column} = positions[i];
    const point = mapHomography(h, (column + 0.5 + lock.phaseX) / matrixSize, (row + 0.5 + lock.phaseY) / matrixSize);
    bits[i] = sampleLuma(image, point.x, point.y) < lock.threshold ? 1 : 0;
  }
  return bits;
}

export function quantizeLumaTwoBit(luma: number, lock: PixelLock): 0 | 1 | 2 | 3 {
  const normalized = normalizedLuma(luma, lock);
  return Math.max(0, Math.min(3, Math.round(normalized * 3))) as 0 | 1 | 2 | 3;
}

export function samplePackedCells(image: ImageData, matrixSize: number, lock: PixelLock): PackedCellObservation | null {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return null;
  const levels = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      levels[row * matrixSize + column] = quantizeLumaTwoBit(
        robustCellLuma(image, h, matrixSize, lock, row, column),
        lock,
      );
    }
  }
  return packTwoBitLevels(levels);
}
