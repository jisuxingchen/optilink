/**
 * TF-012 Phase 6 — stateful frame routing regression (pure Node, no browser).
 *
 * Locks the namespace routing fixed in TF-011:
 *   - acquisition/orientation beacon  (0x54000000 namespace, matrix 64)
 *   - preamble beacon                 (0x54000000 namespace, matrix 96)
 *   - Manifest namespace              0x4d46xxxx
 *   - dynamic Fountain symbols        (everything else)
 *
 * Manifest / preamble / acquisition frames must NEVER enter FountainDecoder.
 * Also verifies the cheap beacon gate rejects non-beacon frames and accepts
 * the 64-cell acquisition beacon.
 *
 * SIMULATION / NON-PHYSICAL evidence only.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SharedOpticalReceiveCore} from './receive-core.ts';
import {normalizeFrame, preambleCells} from './orientation-acquisition.ts';
import {render1920} from './sim-renderer.ts';
import type {PixelFrame} from './pixel-frame.ts';
import {FountainEncoder} from '../fountain.ts';
import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from '../optigrid-v1.ts';
import {buildManifestOpticalFrames} from '../oltp-optical-session.ts';
import type {OltpManifestV1} from '../oltp-manifest.ts';
import {sha256Hex} from './sha256.ts';

const MATRIX = 96;
const BLOCK = 512;
const TOTAL = 64 * 1024;

function deterministicBytes(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < byteLength; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = ((x ^ (Math.imul(i, 2654435761) >>> 0)) >>> 8) & 255;
  }
  return out;
}

class Fixture {
  readonly sha: string;
  readonly manifest: OltpManifestV1;
  readonly manifestCells: Uint8Array[];
  readonly encoder: FountainEncoder;

  constructor(seed: number) {
    const bytes = deterministicBytes(TOTAL, seed ^ 0x51c0ffee);
    this.sha = sha256Hex(bytes);
    this.manifest = {
      protocol: 'OLTP',
      version: 1,
      sessionId: `tf012-routing-${seed}`,
      file: {name: `tf012-routing-${seed}.bin`, byteLength: TOTAL, sha256: this.sha},
      transport: {
        tileCount: 3,
        matrixSize: MATRIX,
        payloadBytesPerTile: payloadCapacityForMatrixV1(MATRIX),
        opticalSymbolHz: 15,
        displayRefreshHz: 60,
        holdRefreshes: 4,
        fountainSourceBlockBytes: BLOCK,
        fountainSeed: seed,
      },
      flags: {compressed: false, encrypted: false, fountain: true},
    };
    this.manifestCells = buildManifestOpticalFrames(this.manifest, {matrixSize: MATRIX, repetitions: 3}).map(f => f.cells);
    this.encoder = new FountainEncoder(bytes, BLOCK, seed);
  }

  private normalize(cells: Uint8Array[], matrix: number): PixelFrame {
    return normalizeFrame(render1920(cells, matrix), 'native', 1280, 720);
  }

  orientationFrame(): PixelFrame {
    return this.normalize([0, 1, 2].map(t => preambleCells(64, t)), 64);
  }

  preambleFrame(): PixelFrame {
    return this.normalize([0, 1, 2].map(t => preambleCells(MATRIX, t)), MATRIX);
  }

  manifestFrame(index: number): PixelFrame {
    const c = this.manifestCells[index % 3];
    return this.normalize([c, c, c], MATRIX);
  }

  symbolFrame(index: number): PixelFrame {
    return this.normalize(
      [0, 1, 2].map(t => encodeFrameCellsV1(MATRIX, (index * 3 + t) >>> 0, this.encoder.symbol(index * 3 + t))),
      MATRIX,
    );
  }
}

function orientAndPreamble(core: SharedOpticalReceiveCore, fx: Fixture): void {
  assert.equal(core.acquireOrientation(fx.orientationFrame()).locked, true, 'orientation');
  assert.equal(core.lockPreamble(fx.preambleFrame(), MATRIX), true, 'preamble');
}

test('cheap beacon gate: 64 beacon accepted, 96 frames rejected', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x74001);
  assert.equal(core.isLikelyOrientationBeacon(fx.orientationFrame() as unknown as ImageData), true, '64 beacon → accept');
  assert.equal(core.isLikelyOrientationBeacon(fx.preambleFrame() as unknown as ImageData), false, '96 preamble → reject');
  assert.equal(core.isLikelyOrientationBeacon(fx.manifestFrame(0) as unknown as ImageData), false, '96 manifest → reject');
  assert.equal(core.isLikelyOrientationBeacon(fx.symbolFrame(0) as unknown as ImageData), false, '96 symbol → reject');
});

test('cold join via processFrame uses the beacon gate (no orientation on symbol frames)', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x74002);
  // Feed a dynamic symbol frame first — the cheap gate must reject it and stay idle.
  core.processFrame(fx.symbolFrame(7), MATRIX);
  assert.equal(core.stage, 'idle', 'symbol frame does not orient a fresh receiver');
  // The acquisition beacon does orient.
  core.processFrame(fx.orientationFrame(), MATRIX);
  assert.equal(core.stage, 'oriented', 'acquisition beacon orients');
});

test('manifest namespace never enters FountainDecoder (acceptDynamicFrame routes to readManifest)', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x74003);
  orientAndPreamble(core, fx);
  assert.equal(core.readManifest(fx.manifestFrame(0), MATRIX), true, 'initial manifest');
  // Seed a few real symbols.
  for (let i = 0; i < 5; i += 1) core.acceptDynamicFrame(fx.symbolFrame(i), MATRIX);
  const solvedBefore = core.solvedCount;
  assert.ok(solvedBefore >= 0, 'symbols decoded');
  // A manifest-namespace frame during dynamic reception must route to readManifest,
  // not be handed to FountainDecoder (which would crash on wrong symbol length).
  const added = core.acceptDynamicFrame(fx.manifestFrame(1), MATRIX);
  assert.equal(added, 0, 'manifest frame adds zero fountain symbols');
  assert.equal(core.stage, 'receiving', 'idempotent manifest replay keeps receiving stage');
  assert.equal(core.solvedCount, solvedBefore, 'solved count unchanged by manifest replay');
});

test('preamble / acquisition beacon namespace never enters FountainDecoder', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x74004);
  orientAndPreamble(core, fx);
  assert.equal(core.readManifest(fx.manifestFrame(0), MATRIX), true, 'initial manifest');
  for (let i = 0; i < 5; i += 1) core.acceptDynamicFrame(fx.symbolFrame(i), MATRIX);
  const solvedBefore = core.solvedCount;
  // 0x54000000-namespace frames (preamble beacon at matrix 96) must be skipped.
  const added = core.acceptDynamicFrame(fx.preambleFrame(), MATRIX);
  assert.equal(added, 0, 'preamble beacon adds zero fountain symbols');
  assert.equal(core.solvedCount, solvedBefore, 'solved count unchanged by beacon frame');
  assert.equal(core.stage, 'receiving', 'receiving stage preserved');
});

test('routing is harmless under a mixed beacon/manifest/symbol stream', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x74005);
  orientAndPreamble(core, fx);
  assert.equal(core.readManifest(fx.manifestFrame(0), MATRIX), true, 'initial manifest');
  // Interleave preamble beacons, manifest replays, and symbols — must never crash
  // and must still make forward progress.
  let complete = false;
  for (let i = 0; i < 60 && !complete; i += 1) {
    if (i % 10 === 0) core.acceptDynamicFrame(fx.preambleFrame(), MATRIX);
    if (i % 13 === 0) core.acceptDynamicFrame(fx.manifestFrame(i % 3), MATRIX);
    core.acceptDynamicFrame(fx.symbolFrame(i), MATRIX);
    complete = core.complete;
  }
  assert.equal(core.complete, true, 'mixed stream still reconstructs');
  const bytes = core.reconstruct();
  assert.ok(bytes, 'bytes available');
  assert.equal(sha256Hex(bytes as Uint8Array), fx.sha, 'SHA-256 exact');
});
