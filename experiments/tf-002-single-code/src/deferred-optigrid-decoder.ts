import {decodeFrameCellsV1, type OptiGridV1DecodedFrame} from './optigrid-v1.ts';
import {binaryCellsFromPacked, type PackedCellObservation} from './packed-cell-buffer.ts';

export type DeferredDecodeResult = {
  decoded: OptiGridV1DecodedFrame | null;
  thresholdLevel: 1 | 2 | 3 | null;
  attempts: number;
};

/**
 * Deferred decoder for cached cell observations. It retries only a tiny set of
 * quantized thresholds; geometry/tracking is deliberately not re-run here.
 */
export function decodePackedOptiGridV1(observation: PackedCellObservation, matrixSize: number): DeferredDecodeResult {
  const thresholds = [2, 1, 3] as const;
  let attempts = 0;
  for (const thresholdLevel of thresholds) {
    attempts += 1;
    const decoded = decodeFrameCellsV1(binaryCellsFromPacked(observation, thresholdLevel), matrixSize);
    if (decoded) return {decoded, thresholdLevel, attempts};
  }
  return {decoded: null, thresholdLevel: null, attempts};
}
