/**
 * TF-012 r3 — preamble-miss cold-join robustness (pure Node, no browser).
 *
 * Reproduces the physical failure: orientation succeeds, but the immediate
 * 96-preamble frame is MISSED (camera callback + processing latency). The
 * receiver then sees Manifest / dynamic / beacon frames while still waiting for
 * a preamble, and must survive them (cheap gate + namespace verification) until
 * the NEXT broadcast-cycle preamble arrives, then lock preamble → Manifest →
 * dynamic → exact SHA. No sender restart.
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
const REPLAY = 16;
const MAX_SYM_FRAMES = 220;

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
      sessionId: `tf012r3-${seed}`,
      file: {name: `tf012r3-${seed}.bin`, byteLength: TOTAL, sha256: this.sha},
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

  orientFrame(): PixelFrame {
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

type Step = {kind: 'orientation' | 'preamble' | 'manifest' | 'symbols'; index: number};

function broadcastCycle(replayEvery: number, symStart: number): Step[] {
  const out: Step[] = [];
  out.push({kind: 'orientation', index: 0});
  out.push({kind: 'preamble', index: 0});
  for (let rep = 0; rep < 3; rep += 1) out.push({kind: 'manifest', index: rep});
  for (let i = 0; i < replayEvery; i += 1) out.push({kind: 'symbols', index: symStart + i});
  return out;
}

function frameFor(fx: Fixture, step: Step): PixelFrame {
  if (step.kind === 'orientation') return fx.orientFrame();
  if (step.kind === 'preamble') return fx.preambleFrame();
  if (step.kind === 'manifest') return fx.manifestFrame(step.index);
  return fx.symbolFrame(step.index);
}

// Drive the shared greedy entry point (same path as the Mini Program adapter)
// through a full broadcast stream from the given starting symbol index until
// completion, then assert exact SHA.
function driveToComplete(fx: Fixture, core: SharedOpticalReceiveCore, symStart: number): void {
  const cycle = broadcastCycle(REPLAY, symStart);
  for (const step of cycle) {
    core.processFrame(frameFor(fx, step), MATRIX);
    if (core.complete) break;
  }
  let sym = symStart + REPLAY;
  while (!core.complete && sym < MAX_SYM_FRAMES) {
    core.processFrame(fx.symbolFrame(sym), MATRIX);
    sym += 1;
  }
}

function assertReconstructed(fx: Fixture, core: SharedOpticalReceiveCore, label: string): void {
  assert.equal(core.complete, true, `${label}: decoder completes`);
  const bytes = core.reconstruct();
  assert.ok(bytes, `${label}: bytes available`);
  assert.equal(bytes.length, TOTAL, `${label}: size`);
  assert.equal(sha256Hex(bytes as Uint8Array), fx.sha, `${label}: SHA exact`);
}

test('cheap preamble gate discriminates 96-preamble from other 96-frames', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71001);
  assert.equal(core.acquireOrientation(fx.orientFrame()).locked, true, 'orientation locks');
  assert.equal(core.isLikelyPreamble(fx.preambleFrame() as unknown as ImageData, MATRIX), true, '96 preamble accepted');
  assert.equal(core.isLikelyPreamble(fx.manifestFrame(0) as unknown as ImageData, MATRIX), false, '96 manifest rejected');
  assert.equal(core.isLikelyPreamble(fx.symbolFrame(3) as unknown as ImageData, MATRIX), false, '96 symbol rejected');
  assert.equal(core.isLikelyPreamble(fx.orientFrame() as unknown as ImageData, MATRIX), false, '64 beacon rejected');
});

test('A: orientation → immediate preamble → manifest → exact SHA', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71002);
  core.processFrame(fx.orientFrame(), MATRIX);
  assert.equal(core.stage, 'oriented', 'A: oriented');
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'A: preamble locked');
  assert.equal(core.eventCounts.preambleSuccess, 1, 'A: preamble success');
  driveToComplete(fx, core, 0);
  assertReconstructed(fx, core, 'A');
});

test('B: orientation → miss immediate preamble → manifest/dynamic → next-cycle preamble → SHA', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71003);
  core.processFrame(fx.orientFrame(), MATRIX);
  assert.equal(core.stage, 'oriented', 'B: oriented');
  // The immediate preamble is missed; the receiver sees a Manifest frame and
  // dynamic frames while still seeking the preamble. All must be rejected cheaply.
  core.processFrame(fx.manifestFrame(0), MATRIX);
  core.processFrame(fx.symbolFrame(1), MATRIX);
  core.processFrame(fx.symbolFrame(2), MATRIX);
  assert.equal(core.stage, 'oriented', 'B: still seeking preamble (not corrupt)');
  assert.equal(core.eventCounts.preambleRejectedOrSkipped, 3, 'B: rejected/skipped counted');
  // Next broadcast cycle's preamble arrives.
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'B: preamble locked on next cycle');
  driveToComplete(fx, core, REPLAY);
  assertReconstructed(fx, core, 'B');
});

test('C: orientation → miss several frames → next-cycle preamble → SHA', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71004);
  core.processFrame(fx.orientFrame(), MATRIX);
  // Miss the whole first preamble block: a full cycle of non-preamble frames.
  for (let i = 0; i < 20; i += 1) core.processFrame(fx.symbolFrame(i), MATRIX);
  core.processFrame(fx.manifestFrame(2), MATRIX);
  assert.equal(core.stage, 'oriented', 'C: still seeking preamble');
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'C: preamble locked');
  driveToComplete(fx, core, REPLAY);
  assertReconstructed(fx, core, 'C');
});

test('D: orientation → arbitrary dynamic frames before next preamble → SHA', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71005);
  core.processFrame(fx.orientFrame(), MATRIX);
  for (let i = 0; i < 47; i += 1) core.processFrame(fx.symbolFrame(i), MATRIX);
  assert.equal(core.stage, 'oriented', 'D: still seeking preamble');
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'D: preamble locked');
  driveToComplete(fx, core, 48);
  assertReconstructed(fx, core, 'D');
});

test('E: orientation → repeated acquisition beacon before preamble → SHA', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71006);
  core.processFrame(fx.orientFrame(), MATRIX);
  assert.equal(core.stage, 'oriented', 'E: oriented');
  // Repeated 64-cell acquisition beacons arrive while seeking the 96 preamble.
  for (let i = 0; i < 5; i += 1) core.processFrame(fx.orientFrame(), MATRIX);
  assert.equal(core.stage, 'oriented', 'E: still seeking preamble (beacons rejected)');
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'E: preamble locked');
  driveToComplete(fx, core, 0);
  assertReconstructed(fx, core, 'E');
});

test('preamble stage survives non-Manifest frames without corrupting geometry', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71007);
  core.processFrame(fx.orientFrame(), MATRIX);
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'preamble locked');
  // Dynamic symbols + beacon arrive at PREAMBLE stage — must not advance or throw.
  for (let i = 0; i < 10; i += 1) core.processFrame(fx.symbolFrame(i), MATRIX);
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.stage, 'preamble', 'still preamble, geometry not corrupted');
  // The real Manifest then decodes.
  core.processFrame(fx.manifestFrame(0), MATRIX);
  assert.equal(core.stage, 'receiving', 'manifest read after surviving noise frames');
  driveToComplete(fx, core, REPLAY);
  assertReconstructed(fx, core, 'geometry-preserved');
});

test('stage transition log records ORIENTATION → PREAMBLE → MANIFEST', () => {
  const core = new SharedOpticalReceiveCore();
  const fx = new Fixture(0x71008);
  core.processFrame(fx.orientFrame(), MATRIX);
  assert.equal(core.lastStageTransition, 'ORIENTATION');
  core.processFrame(fx.preambleFrame(), MATRIX);
  assert.equal(core.lastStageTransition, 'PREAMBLE');
  core.processFrame(fx.manifestFrame(0), MATRIX);
  assert.equal(core.lastStageTransition, 'MANIFEST');
  assert.ok(core.lastStageTransitionAt > 0, 'transition timestamp set');
});
