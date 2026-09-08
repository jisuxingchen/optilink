import {decodeManifest, type OltpManifestV1} from './oltp-manifest.ts';
import {OLTP_MANIFEST_SEQUENCE_BASE} from './oltp-optical-session.ts';
import {decodeWithPixelLock, trackReservedLock, type PixelLock} from './tiled-training-solver.ts';

export type ManifestAttemptDiagnostic = {
  attempt: number;
  tile: number;
  tracked: boolean;
  score: number | null;
  contrast: number | null;
  phaseX: number | null;
  phaseY: number | null;
  decoded: boolean;
  sequence: number | null;
  namespaceMatch: boolean;
  manifestParsed: boolean;
};

export type ManifestRecoveryResult = {
  success: boolean;
  attempts: number;
  decodedFrames: number;
  distinctManifests: number;
  recoveredProtocol: string | null;
  recoveredVersion: number | null;
  diagnostics: ManifestAttemptDiagnostic[];
};

export function decodeManifestObservation(
  image: ImageData,
  matrixSize: number,
  locks: PixelLock[],
  attempt: number,
): {locks: PixelLock[]; recovered: OltpManifestV1[]; diagnostics: ManifestAttemptDiagnostic[]} {
  const nextLocks: PixelLock[] = [];
  const recovered: OltpManifestV1[] = [];
  const diagnostics: ManifestAttemptDiagnostic[] = [];

  for (let tile = 0; tile < locks.length; tile += 1) {
    const prior = locks[tile];
    const tracked = trackReservedLock(image, matrixSize, prior);
    const lock = tracked ?? prior;
    nextLocks.push(lock);

    const decoded = decodeWithPixelLock(image, matrixSize, lock);
    const sequence = decoded?.sequence ?? null;
    const namespaceMatch = sequence !== null && ((sequence & 0xffff0000) === OLTP_MANIFEST_SEQUENCE_BASE);
    let manifestParsed = false;
    if (decoded && namespaceMatch) {
      try {
        recovered.push(decodeManifest(decoded.payload));
        manifestParsed = true;
      } catch {
        manifestParsed = false;
      }
    }

    diagnostics.push({
      attempt,
      tile,
      tracked: tracked !== null,
      score: Number.isFinite(lock.score) ? lock.score : null,
      contrast: Number.isFinite(lock.contrast) ? lock.contrast : null,
      phaseX: Number.isFinite(lock.phaseX) ? lock.phaseX : null,
      phaseY: Number.isFinite(lock.phaseY) ? lock.phaseY : null,
      decoded: decoded !== null,
      sequence,
      namespaceMatch,
      manifestParsed,
    });
  }

  return {locks: nextLocks, recovered, diagnostics};
}

export function summarizeManifestRecovery(
  attempts: number,
  manifests: OltpManifestV1[],
  diagnostics: ManifestAttemptDiagnostic[],
): ManifestRecoveryResult {
  const unique = new Map<string, OltpManifestV1>();
  for (const manifest of manifests) unique.set(JSON.stringify(manifest), manifest);
  const values = [...unique.values()];
  return {
    success: values.length === 1,
    attempts,
    decodedFrames: diagnostics.filter(item => item.manifestParsed).length,
    distinctManifests: values.length,
    recoveredProtocol: values[0]?.protocol ?? null,
    recoveredVersion: values[0]?.version ?? null,
    diagnostics,
  };
}
