import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeManifestRecovery, type ManifestAttemptDiagnostic} from './tf007g-manifest-recovery.ts';
import type {OltpManifestV1} from './oltp-manifest.ts';

const manifest: OltpManifestV1 = {
  protocol: 'OLTP',
  version: 1,
  sessionId: 'tf007g-test',
  file: {name: 'fixture.bin', byteLength: 1024, sha256: '0'.repeat(64)},
  transport: {
    tileCount: 3,
    matrixSize: 160,
    payloadBytesPerTile: 2436,
    opticalSymbolHz: 15,
    displayRefreshHz: 60,
    holdRefreshes: 4,
    fountainSourceBlockBytes: 1024,
    fountainSeed: 20260908,
  },
  flags: {compressed: false, encrypted: false, fountain: true},
};

function diag(attempt: number, tile: number, parsed: boolean): ManifestAttemptDiagnostic {
  return {
    attempt,
    tile,
    tracked: true,
    score: 0.99,
    contrast: 180,
    phaseX: 0.1,
    phaseY: -0.05,
    decoded: parsed,
    sequence: parsed ? 0x4d460001 : null,
    namespaceMatch: parsed,
    manifestParsed: parsed,
  };
}

test('TF-007G accepts repeated identical recovered manifests without weakening exact identity', () => {
  const diagnostics = [diag(1, 0, true), diag(1, 1, true), diag(2, 2, true)];
  const result = summarizeManifestRecovery(2, [manifest, structuredClone(manifest), structuredClone(manifest)], diagnostics);
  assert.equal(result.success, true);
  assert.equal(result.distinctManifests, 1);
  assert.equal(result.decodedFrames, 3);
  assert.equal(result.recoveredProtocol, 'OLTP');
  assert.equal(result.recoveredVersion, 1);
});

test('TF-007G rejects conflicting manifests', () => {
  const other = structuredClone(manifest);
  other.sessionId = 'tf007g-other';
  const result = summarizeManifestRecovery(2, [manifest, other], [diag(1, 0, true), diag(2, 0, true)]);
  assert.equal(result.success, false);
  assert.equal(result.distinctManifests, 2);
});
