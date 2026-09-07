import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {decodeManifest, encodeManifest, type OltpManifestV1} from './oltp-manifest.ts';
import {buildManifestOpticalFrames, manifestSequence} from './oltp-optical-session.ts';

const manifest: OltpManifestV1 = {
  protocol: 'OLTP', version: 1, sessionId: 'session-bootstrap',
  file: {name: '10MiB.bin', byteLength: 10 * 1024 * 1024, sha256: 'a'.repeat(64)},
  transport: {
    tileCount: 3, matrixSize: 176, payloadBytesPerTile: 3028,
    opticalSymbolHz: 15, displayRefreshHz: 60, holdRefreshes: 4,
    fountainSourceBlockBytes: 1024, fountainSeed: 42,
  },
  flags: {compressed: false, encrypted: false, fountain: true},
};

test('manifest fits conservative 96×96 bootstrap carrier', () => {
  const bytes = encodeManifest(manifest);
  assert.ok(bytes.length <= payloadCapacityForMatrixV1(96), `${bytes.length} > ${payloadCapacityForMatrixV1(96)}`);
});

test('repeated manifest frames survive OptiGrid encode/decode and recover identical session metadata', () => {
  const frames = buildManifestOpticalFrames(manifest, {matrixSize: 96, repetitions: 3});
  assert.equal(frames.length, 3);
  for (let i = 0; i < frames.length; i += 1) {
    assert.equal(frames[i].sequence, manifestSequence(i));
    const decoded = decodeFrameCellsV1(frames[i].cells, 96);
    assert.ok(decoded);
    assert.equal(decoded.sequence, manifestSequence(i));
    assert.deepEqual(decodeManifest(decoded.payload), manifest);
  }
});
