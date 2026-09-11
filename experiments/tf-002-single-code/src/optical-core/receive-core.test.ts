/**
 * TF-009 shared receive-core regression tests (pure Node, no browser).
 *
 * 1. Fountain + OptiGrid + Manifest round-trip reconstructs a deterministic
 *    64 KiB payload with an exact SHA-256 match (proves the shared algorithm
 *    independent of pixels).
 * 2. Static oracle-boundary guard: the shared receive core contains no DOM /
 *    camera / network / wx.* coupling and no sender-internal references.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {FountainDecoder, FountainEncoder} from '../fountain.ts';
import {decodeFrameCellsV1, encodeFrameCellsV1, payloadCapacityForMatrixV1} from '../optigrid-v1.ts';
import {buildManifestOpticalFrames} from '../oltp-optical-session.ts';
import {decodeManifest, type OltpManifestV1} from '../oltp-manifest.ts';

const MATRIX = 96;
const BLOCK_SIZE = 512;
const SEED = 0x74000901;
const TOTAL_BYTES = 64 * 1024;

function deterministicBytes(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < byteLength; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = ((x ^ (Math.imul(i, 2654435761) >>> 0)) >>> 8) & 255;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i += 1) out += view[i].toString(16).padStart(2, '0');
  return out;
}

test('fountain + OptiGrid v1 + OLTP manifest round-trip reconstructs 64 KiB exactly (SHA-256 match)', async () => {
  const source = deterministicBytes(TOTAL_BYTES, 0x51c0ffee);
  const sourceSha = await sha256Hex(source);

  const manifest: OltpManifestV1 = {
    protocol: 'OLTP',
    version: 1,
    sessionId: 'tf009-test',
    file: {name: 'tf009-64k.bin', byteLength: TOTAL_BYTES, sha256: sourceSha},
    transport: {
      tileCount: 3,
      matrixSize: MATRIX,
      payloadBytesPerTile: payloadCapacityForMatrixV1(MATRIX),
      opticalSymbolHz: 15,
      displayRefreshHz: 60,
      holdRefreshes: 4,
      fountainSourceBlockBytes: BLOCK_SIZE,
      fountainSeed: SEED,
    },
    flags: {compressed: false, encrypted: false, fountain: true},
  };

  // Manifest is carried optically: encode → cells → decode → decodeManifest.
  const manifestFrames = buildManifestOpticalFrames(manifest, {matrixSize: MATRIX, repetitions: 3});
  const manifestDecoded = decodeFrameCellsV1(manifestFrames[0].cells, MATRIX);
  assert.ok(manifestDecoded, 'manifest frame decodes');
  const manifestRecovered = decodeManifest(manifestDecoded.payload);
  assert.equal(manifestRecovered.file.sha256, sourceSha);
  assert.equal(manifestRecovered.transport.fountainSourceBlockBytes, BLOCK_SIZE);
  assert.equal(manifestRecovered.transport.fountainSeed, SEED);

  // Dynamic symbols: fountain-encode → cells → decode → fountain-decode.
  const encoder = new FountainEncoder(source, BLOCK_SIZE, SEED);
  const sourceCount = Math.ceil(TOTAL_BYTES / BLOCK_SIZE);
  assert.equal(sourceCount, 128);
  const decoder = new FountainDecoder(sourceCount, BLOCK_SIZE, SEED);
  let frames = 0;
  for (let symbolId = 0; symbolId < sourceCount && !decoder.complete; symbolId += 1) {
    const cells = encodeFrameCellsV1(MATRIX, symbolId >>> 0, encoder.symbol(symbolId));
    const decoded = decodeFrameCellsV1(cells, MATRIX);
    assert.ok(decoded, `symbol ${symbolId} decodes`);
    assert.equal(decoded.sequence >>> 0, symbolId >>> 0);
    decoder.addSymbol(decoded.sequence, decoded.payload);
    frames += 1;
  }
  assert.ok(decoder.complete, 'fountain decoder completes');
  assert.equal(frames, 128);

  const reconstructed = decoder.reconstruct(TOTAL_BYTES);
  assert.equal(reconstructed.length, TOTAL_BYTES);
  assert.equal(await sha256Hex(reconstructed), sourceSha);
});

test('shared receive core is platform-neutral: no DOM / camera / network / wx / sender-internal coupling', () => {
  const src = readFileSync(fileURLToPath(new URL('./receive-core.ts', import.meta.url)), 'utf8');
  const forbidden = [
    'getUserMedia(',
    'document.getElementById',
    'window.addEventListener',
    'new WebSocket(',
    'wx.request(',
    'wx.connectSocket(',
    'XMLHttpRequest',
    'fetch(',
    'navigator.mediaDevices',
    'senderCanvas',
    'contentWindow',
    '__TF009_SENDER__',
    '__TF008_SIM__',
  ];
  for (const token of forbidden) {
    assert.ok(!src.includes(token), `forbidden token present in receive-core.ts: ${token}`);
  }
});
