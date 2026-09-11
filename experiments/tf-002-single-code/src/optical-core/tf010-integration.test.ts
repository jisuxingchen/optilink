/**
 * TF-010 non-physical Mini Program integration tests.
 *
 * Proves the Mini Program's committed optical-core bundle (the SAME build the
 * phone requires) contains the shared receive pipeline and reconstructs a
 * deterministic 64 KiB payload end-to-end from rendered pixels, with an exact
 * SHA-256 match against the optically-recovered Manifest.
 *
 * Sender-side (encode/render) uses the TF-009 source modules; receiver-side
 * (decode/reconstruct) uses ONLY the Mini Program bundle — no second algorithm.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {FountainEncoder} from '../fountain.ts';
import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from '../optigrid-v1.ts';
import {buildManifestOpticalFrames} from '../oltp-optical-session.ts';
import type {OltpManifestV1} from '../oltp-manifest.ts';

const require = createRequire(import.meta.url);
// The Mini Program bundle (CommonJS) — the exact file the phone loads.
const opticalCore = require('../../../tf-008-wechat-mini-receiver-poc/utils/optical-core.js');

const MATRIX = 96;
const BLOCK_SIZE = 512;
const SEED = 0x74000901;
const TOTAL_BYTES = 64 * 1024;
const W = 1920, H = 1080;
const TILE = 540;
const CENTERS = [330, 960, 1590];
const TOP = 270;

function deterministicBytes(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < byteLength; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = ((x ^ (Math.imul(i, 2654435761) >>> 0)) >>> 8) & 255;
  }
  return out;
}

/** Render 3 tile cell grids (with fiducial markers) onto the 1920x1080 sender canvas, mirroring the real sender geometry. */
function render1920(cellsByTile: Uint8Array[], matrixSize: number): {width: number; height: number; data: Uint8ClampedArray} {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 236; data[i + 1] = 239; data[i + 2] = 241; data[i + 3] = 255; }
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v;
  };
  const cellPx = TILE / matrixSize;
  for (let tile = 0; tile < 3; tile += 1) {
    const cells = cellsByTile[tile];
    const left = CENTERS[tile] - TILE / 2;
    for (let y = TOP - 10; y < TOP + TILE + 10; y += 1) for (let x = left - 10; x < left + TILE + 10; x += 1) set(x, y, 255);
    for (let r = 0; r < matrixSize; r += 1) {
      for (let c = 0; c < matrixSize; c += 1) {
        const v = cells[r * matrixSize + c] ? 0 : 255;
        const x0 = Math.floor(left + c * cellPx);
        const y0 = Math.floor(TOP + r * cellPx);
        const x1 = Math.floor(left + (c + 1) * cellPx);
        const y1 = Math.floor(TOP + (r + 1) * cellPx);
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, v);
      }
    }
    // Fiducial marker: white halo 132x132 + black core 84x84 at y=180 (offset -360 above tile center).
    const mx = CENTERS[tile], my = TOP + TILE / 2 - 360;
    for (let y = my - 66; y < my + 66; y += 1) for (let x = mx - 66; x < mx + 66; x += 1) set(x, y, 255);
    for (let y = my - 42; y < my + 42; y += 1) for (let x = mx - 42; x < mx + 42; x += 1) set(x, y, 0);
  }
  return {width: W, height: H, data};
}

function frameFor(cellsByTile: Uint8Array[], matrixSize: number): {width: number; height: number; data: Uint8ClampedArray} {
  const raw = render1920(cellsByTile, matrixSize);
  return opticalCore.normalizeFrame(raw, 'native', 1280, 720);
}

test('bundle exposes SharedOpticalReceiveCore and sha256Hex', () => {
  assert.equal(typeof opticalCore.SharedOpticalReceiveCore, 'function');
  assert.equal(typeof opticalCore.sha256Hex, 'function');
  assert.equal(typeof opticalCore.acquireOrientation, 'function');
  assert.equal(opticalCore.sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('non-physical 64 KiB reconstruction: orientation → Manifest → dynamic → SHA-256 match (bundle core)', () => {
  const source = deterministicBytes(TOTAL_BYTES, 0x51c0ffee);
  const sourceSha = opticalCore.sha256Hex(source);

  const manifest: OltpManifestV1 = {
    protocol: 'OLTP',
    version: 1,
    sessionId: 'tf010-test',
    file: {name: 'tf010-64k.bin', byteLength: TOTAL_BYTES, sha256: sourceSha},
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

  const manifestFrames = buildManifestOpticalFrames(manifest, {matrixSize: MATRIX, repetitions: 3});
  const encoder = new FountainEncoder(source, BLOCK_SIZE, SEED);
  const core = new opticalCore.SharedOpticalReceiveCore();

  // Stage 1: orientation (64x64 preamble cells from the shared bundle).
  const orientationCells = [0, 1, 2].map((tile) => opticalCore.preambleCells(64, tile));
  const orientation = core.acquireOrientation(frameFor(orientationCells, 64));
  assert.equal(orientation.locked, true, 'orientation locks');
  assert.equal(orientation.best.locatorSupport, 'triplet');

  // Stage 2: data preamble (96x96).
  const preambleCells96 = [0, 1, 2].map((tile) => opticalCore.preambleCells(MATRIX, tile));
  assert.equal(core.lockPreamble(frameFor(preambleCells96, MATRIX), MATRIX), true, 'preamble locks');

  // Stage 3: optical Manifest.
  let recovered = false;
  for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
    const cells = manifestFrames[attempt].cells;
    recovered = core.readManifest(frameFor([cells, cells, cells], MATRIX), MATRIX);
  }
  assert.equal(recovered, true, 'manifest recovered');
  assert.equal(core.manifest.file.byteLength, TOTAL_BYTES);
  assert.equal(core.manifest.file.sha256, sourceSha);

  // Stage 4: dynamic symbols.
  let frames = 0;
  while (!core.complete && frames < 256) {
    const cells = [0, 1, 2].map((t) => encodeFrameCellsV1(MATRIX, (frames * 3 + t) >>> 0, encoder.symbol(frames * 3 + t)));
    core.acceptDynamicFrame(frameFor(cells, MATRIX), MATRIX);
    frames += 1;
  }
  assert.equal(core.complete, true, 'decoder completes');

  // Stage 5: reconstruction + SHA-256.
  const bytes = core.reconstruct();
  assert.equal(bytes.length, TOTAL_BYTES);
  assert.equal(opticalCore.sha256Hex(bytes), sourceSha);
});

test('Mini Program adapter: no duplicated decode, no network payload API, benchmark kept separate', () => {
  const indexJs = readFileSync(fileURLToPath(new URL('../../../tf-008-wechat-mini-receiver-poc/pages/index/index.js', import.meta.url)), 'utf8');
  // H: no duplicated optical decode implementation — only the bundle is required.
  for (const forbidden of ['decodeWithPixelLock', 'decodeFrameCellsV1', 'FountainDecoder', 'acquireKnownTrainingLock', 'trackReservedLock']) {
    assert.ok(!indexJs.includes(forbidden), 'index.js must not re-implement ' + forbidden);
  }
  // G: no network payload API.
  for (const forbidden of ['wx.request', 'wx.connectSocket', 'wx.uploadFile', 'wx.downloadFile', 'wx.cloud', 'wx.requestPayment']) {
    assert.ok(!indexJs.includes(forbidden), 'index.js must not use ' + forbidden);
  }
  // E/F: benchmark remains a separate diagnostic mode; receive routes to its own handler.
  assert.ok(indexJs.includes("mode: 'receive'"), 'default mode is receive');
  assert.ok(indexJs.includes('processBenchmarkFrame'), 'benchmark handler still exists');
  assert.ok(indexJs.includes("this.data.mode === 'receive'"), 'receive routing is explicit');
  assert.ok(!indexJs.includes('processReceiveFrame(buffer, width, height) {\n    this.processBenchmarkFrame'), 'receive handler never falls back to benchmark');
});
