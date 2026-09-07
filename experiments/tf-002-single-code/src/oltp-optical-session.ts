import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {encodeManifest, type OltpManifestV1} from './oltp-manifest.ts';

export const OLTP_MANIFEST_SEQUENCE_BASE = 0x4d460000; // 'MF' namespace

export type ManifestOpticalFrame = {
  repetition: number;
  matrixSize: number;
  sequence: number;
  payload: Uint8Array;
  cells: Uint8Array;
};

export function manifestSequence(repetition: number): number {
  if (!Number.isInteger(repetition) || repetition < 0 || repetition > 0xffff) throw new Error('manifest repetition out of range');
  return (OLTP_MANIFEST_SEQUENCE_BASE | repetition) >>> 0;
}

export function buildManifestOpticalFrames(manifest: OltpManifestV1, options: {matrixSize?: number; repetitions?: number} = {}): ManifestOpticalFrame[] {
  const matrixSize = options.matrixSize ?? 96;
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be positive');
  const payload = encodeManifest(manifest);
  const capacity = payloadCapacityForMatrixV1(matrixSize);
  if (payload.length > capacity) throw new Error(`OLTP manifest ${payload.length} B exceeds ${matrixSize} OptiGrid payload capacity ${capacity} B`);
  return Array.from({length: repetitions}, (_, repetition) => {
    const sequence = manifestSequence(repetition);
    return {
      repetition,
      matrixSize,
      sequence,
      payload: payload.slice(),
      cells: encodeFrameCellsV1(matrixSize, sequence, payload),
    };
  });
}
