/**
 * TF-011 broadcast / resume / session robustness tests (pure Node, no browser).
 *
 * Exercises the shared receive core against rendered-pixel frames under
 * deterministic imperfections: late join, Manifest replay, frame drop,
 * duplicate frames, checkpoint/destroy/restore, session switching, and
 * invalid/stale Manifest rejection. Every case must end with an exact
 * SHA-256 match.
 *
 * SIMULATION / NON-PHYSICAL evidence only.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SharedOpticalReceiveCore, sessionKey} from './receive-core.ts';
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
// Late join misses degree-1 symbols and must recover them via repair symbols
// (~2x symbol count), so keep generous headroom in the broadcast stream.
const MAX_SYM_FRAMES = 160;

function deterministicBytes(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < byteLength; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = ((x ^ (Math.imul(i, 2654435761) >>> 0)) >>> 8) & 255;
  }
  return out;
}

class SessionFixture {
  readonly name: string;
  readonly sha: string;
  readonly manifest: OltpManifestV1;
  readonly manifestCells: Uint8Array[];
  readonly encoder: FountainEncoder;

  constructor(name: string, seed: number) {
    this.name = name;
    const bytes = deterministicBytes(TOTAL, seed ^ 0x51c0ffee);
    this.sha = sha256Hex(bytes);
    this.manifest = {
      protocol: 'OLTP',
      version: 1,
      sessionId: `tf011-${name}-${seed}`,
      file: {name: `tf011-${name}.bin`, byteLength: TOTAL, sha256: this.sha},
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

  frame(kind: 'manifest' | 'symbols', index: number): PixelFrame {
    let cells: Uint8Array[];
    if (kind === 'manifest') {
      const c = this.manifestCells[index % 3];
      cells = [c, c, c];
    } else {
      cells = [0, 1, 2].map(t => encodeFrameCellsV1(MATRIX, (index * 3 + t) >>> 0, this.encoder.symbol(index * 3 + t)));
    }
    return normalizeFrame(render1920(cells, MATRIX), 'native', 1280, 720);
  }
}

function orientAndPreamble(core: SharedOpticalReceiveCore): void {
  const orientCells = [0, 1, 2].map(t => preambleCells(64, t));
  const orient = core.acquireOrientation(normalizeFrame(render1920(orientCells, 64), 'native', 1280, 720));
  assert.equal(orient.locked, true, 'orientation locks');
  const preCells = [0, 1, 2].map(t => preambleCells(MATRIX, t));
  assert.equal(core.lockPreamble(normalizeFrame(render1920(preCells, MATRIX), 'native', 1280, 720), MATRIX), true, 'preamble locks');
}

function* broadcast(replayEvery: number, maxSymFrames: number): Generator<{kind: 'manifest' | 'symbols'; index: number}> {
  let sym = 0;
  while (sym < maxSymFrames) {
    for (let rep = 0; rep < 3; rep += 1) yield {kind: 'manifest', index: rep};
    for (let i = 0; i < replayEvery && sym < maxSymFrames; i += 1) {
      yield {kind: 'symbols', index: sym};
      sym += 1;
    }
  }
}

type DriveOptions = {
  joinAt?: number;
  dropEvery?: number;
  dupEvery?: number;
  maxFrames?: number;
};

function drive(core: SharedOpticalReceiveCore, fixture: SessionFixture, options: DriveOptions = {}) {
  const {joinAt = 0, dropEvery = 0, dupEvery = 0, maxFrames = 0} = options;
  const stats = {rendered: 0, captured: 0, dropped: 0, duplicated: 0};
  for (const desc of broadcast(REPLAY, MAX_SYM_FRAMES)) {
    stats.rendered += 1;
    if (stats.rendered <= joinAt) { stats.dropped += 1; continue; }
    if (dropEvery && stats.rendered % dropEvery === 0) { stats.dropped += 1; continue; }
    const frame = fixture.frame(desc.kind, desc.index);
    stats.captured += 1;
    if (desc.kind === 'manifest') core.readManifest(frame, MATRIX);
    else core.acceptDynamicFrame(frame, MATRIX);
    if (dupEvery && stats.rendered % dupEvery === 0) {
      stats.duplicated += 1;
      stats.captured += 1;
      if (desc.kind === 'manifest') core.readManifest(frame, MATRIX);
      else core.acceptDynamicFrame(frame, MATRIX);
    }
    if (core.complete) break;
    if (maxFrames && stats.rendered >= maxFrames) break;
  }
  return stats;
}

function assertReconstructed(core: SharedOpticalReceiveCore, fixture: SessionFixture): void {
  assert.equal(core.complete, true, 'decoder completes');
  const bytes = core.reconstruct();
  assert.ok(bytes, 'reconstruction available');
  assert.equal(bytes.length, TOTAL);
  assert.equal(sha256Hex(bytes), fixture.sha, 'SHA-256 exact');
}

test('A: receiver starts at frame 0 → exact SHA', () => {
  const fixture = new SessionFixture('A', 0x1001);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  drive(core, fixture);
  assertReconstructed(core, fixture);
});

test('B: late join (~30%) → replayed Manifest → exact SHA', () => {
  const fixture = new SessionFixture('B', 0x2002);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  const stats = drive(core, fixture, {joinAt: 17});
  assert.ok(stats.dropped >= 17, 'frames skipped before join');
  assert.ok(core.stats.rejectedFrames > 0, 'pre-manifest symbols rejected');
  assertReconstructed(core, fixture);
});

test('C: 20% deterministic visual-frame drop → exact SHA', () => {
  const fixture = new SessionFixture('C', 0x3003);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  const stats = drive(core, fixture, {dropEvery: 5});
  assert.ok(stats.dropped > 0, 'frames dropped');
  assertReconstructed(core, fixture);
});

test('D: ~30% duplicate visual frames → no corruption, exact SHA', () => {
  const fixture = new SessionFixture('D', 0x4004);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  const stats = drive(core, fixture, {dupEvery: 3});
  assert.ok(stats.duplicated > 0, 'frames duplicated');
  assert.ok(core.stats.duplicateSymbols > 0, 'duplicate symbols counted');
  assertReconstructed(core, fixture);
});

test('E: receive ~50% → checkpoint → destroy → restore → exact SHA', () => {
  const fixture = new SessionFixture('E', 0x5005);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  drive(core, fixture, {maxFrames: 25});
  assert.equal(core.complete, false, 'not yet complete at checkpoint');

  const checkpoint = core.exportCheckpoint();
  assert.ok(checkpoint, 'checkpoint exported');
  assert.equal(checkpoint.sessionKey, sessionKey(fixture.manifest));
  assert.ok(checkpoint.solvedBlocks.length > 0, 'solved blocks persisted');
  const json = JSON.stringify(checkpoint);
  const restored = JSON.parse(json) as typeof checkpoint;

  // Destroy: fresh instance restores from the serialized checkpoint.
  const core2 = new SharedOpticalReceiveCore();
  assert.equal(core2.restoreCheckpoint(restored), true, 'checkpoint restored');
  assert.equal(core2.solvedCount, checkpoint.solvedCount, 'progress restored');
  drive(core2, fixture, {joinAt: 25});
  assertReconstructed(core2, fixture);
});

test('F: session A partial → session B → no cross-session contamination', () => {
  const fixtureA = new SessionFixture('A', 0x6006);
  const fixtureB = new SessionFixture('B', 0x7007);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);

  // Partially collect A.
  drive(core, fixtureA, {maxFrames: 20});
  assert.equal(core.complete, false, 'A incomplete');
  const keyA = sessionKey(fixtureA.manifest);
  assert.equal(core.activeSessionKey, keyA);

  // Manifest B appears (new session) → switch; A checkpoint preserved.
  core.readManifest(fixtureB.frame('manifest', 0), MATRIX);
  assert.equal(core.activeSessionKey, sessionKey(fixtureB.manifest), 'switched to B');
  assert.ok(core.previousCheckpoints.has(keyA), 'A checkpoint preserved');
  assert.notEqual(core.previousCheckpoints.get(keyA)!.sessionKey, sessionKey(fixtureB.manifest), 'A checkpoint is A, not B');

  // Drive B symbols to completion. B symbols only enter B decoder.
  let frames = 0;
  while (!core.complete && frames < 300) {
    core.acceptDynamicFrame(fixtureB.frame('symbols', frames), MATRIX);
    frames += 1;
  }
  assert.equal(core.complete, true, 'B completes');
  const bytes = core.reconstruct();
  assert.ok(bytes, 'B reconstruction available');
  assert.equal(sha256Hex(bytes), fixtureB.sha, 'B SHA exact, not A');
  assert.notEqual(fixtureB.sha, fixtureA.sha);
});

test('G: repeated Manifest bursts do not reset progress → exact SHA', () => {
  const fixture = new SessionFixture('G', 0x8008);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  core.readManifest(fixture.frame('manifest', 0), MATRIX);
  const key = core.activeSessionKey;
  // Drive some symbols.
  for (let i = 0; i < 8; i += 1) core.acceptDynamicFrame(fixture.frame('symbols', i), MATRIX);
  const solvedBefore = core.solvedCount;
  assert.ok(solvedBefore > 0, 'progress made');
  // Replayed manifest (same session) must not reset.
  core.readManifest(fixture.frame('manifest', 1), MATRIX);
  assert.equal(core.activeSessionKey, key, 'same session key');
  assert.equal(core.solvedCount, solvedBefore, 'progress not reset by replay');
  drive(core, fixture, {joinAt: 8});
  assertReconstructed(core, fixture);
});

test('H: invalid / stale Manifest rejected; current valid session preserved', () => {
  const fixture = new SessionFixture('H', 0x9009);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  core.readManifest(fixture.frame('manifest', 0), MATRIX);
  const key = core.activeSessionKey;
  core.acceptDynamicFrame(fixture.frame('symbols', 0), MATRIX);
  const solvedBefore = core.solvedCount;
  assert.ok(key, 'session key present');

  // Corrupted manifest frame: scramble the cells → invalid → rejected.
  const corrupt = render1920([0, 1, 2].map(() => encodeFrameCellsV1(MATRIX, 0x4d460000, deterministicBytes(payloadCapacityForMatrixV1(MATRIX), 0xdead))), MATRIX);
  core.readManifest(normalizeFrame(corrupt, 'native', 1280, 720), MATRIX);
  assert.equal(core.activeSessionKey, key, 'session preserved after invalid manifest');
  assert.equal(core.solvedCount, solvedBefore, 'progress preserved');

  // Valid but different session (stale A while on H) triggers a switch, not silent replace.
  const stale = new SessionFixture('stale', 0xa0a0);
  core.readManifest(stale.frame('manifest', 0), MATRIX);
  assert.equal(core.activeSessionKey, sessionKey(stale.manifest), 'explicit session switch to new valid session');
  assert.ok(core.previousCheckpoints.has(key), 'H checkpoint preserved on switch');
});

// ---- COLD LATE JOIN (receiver may join at any time) ----

type BeaconKind = 'orientation' | 'preamble' | 'manifest' | 'symbols';

function* beaconBroadcast(replayEvery: number, maxSymFrames: number): Generator<{kind: BeaconKind; index: number}> {
  let sym = 0;
  while (sym < maxSymFrames) {
    yield {kind: 'orientation', index: 0};
    yield {kind: 'preamble', index: 0};
    for (let rep = 0; rep < 3; rep += 1) yield {kind: 'manifest', index: rep};
    for (let i = 0; i < replayEvery && sym < maxSymFrames; i += 1) {
      yield {kind: 'symbols', index: sym};
      sym += 1;
    }
  }
}

function beaconFrame(fixture: SessionFixture, kind: BeaconKind, index: number): PixelFrame {
  if (kind === 'orientation') return normalizeFrame(render1920([0, 1, 2].map(t => preambleCells(64, t)), 64), 'native', 1280, 720);
  if (kind === 'preamble') return normalizeFrame(render1920([0, 1, 2].map(t => preambleCells(MATRIX, t)), MATRIX), 'native', 1280, 720);
  return fixture.frame(kind, index);
}

function coldJoin(fixture: SessionFixture, replayEvery: number, startOffset: number): {complete: boolean; renderedFrames: number; reconstructedSha: string | null} {
  // Completely fresh receiver — no orientation, no PixelLocks, no Manifest, no decoder, no checkpoint.
  const core = new SharedOpticalReceiveCore();
  const schedule = [...beaconBroadcast(replayEvery, MAX_SYM_FRAMES)];
  let rendered = 0;
  for (let i = startOffset; i < schedule.length; i += 1) {
    rendered += 1;
    core.processFrame(beaconFrame(fixture, schedule[i].kind, schedule[i].index), MATRIX);
    if (core.complete) {
      const bytes = core.reconstruct();
      return {complete: true, renderedFrames: rendered, reconstructedSha: bytes ? sha256Hex(bytes) : null};
    }
  }
  return {complete: false, renderedFrames: rendered, reconstructedSha: null};
}

test('COLD late join matrix: fresh receiver at any join point → exact SHA', () => {
  const fixture = new SessionFixture('cold', 0xc0c0);
  const replayEvery = 16;
  const cycleLen = 5 + replayEvery; // orientation + preamble + 3 manifest + N symbols
  const joinPoints: Array<[string, number]> = [
    ['A-beacon', 0],
    ['B-after-beacon', 1],
    ['C-mid-dynamic', 5 + Math.floor(replayEvery / 2)],
    ['D-before-manifest-replay', cycleLen - 1],
    ['E-worst-case', 3],
  ];
  for (const [label, offset] of joinPoints) {
    const r = coldJoin(fixture, replayEvery, offset);
    assert.equal(r.complete, true, `${label} cold join completes`);
    assert.equal(r.reconstructedSha, fixture.sha, `${label} exact SHA`);
  }
});

test('replay interval comparison 16/32/64 (cold join, worst-case point)', () => {
  const fixture = new SessionFixture('replay', 0xd0d0);
  for (const replayEvery of [16, 32, 64]) {
    const r = coldJoin(fixture, replayEvery, 3);
    assert.equal(r.complete, true, `replayEvery=${replayEvery} completes`);
    assert.equal(r.reconstructedSha, fixture.sha, `replayEvery=${replayEvery} exact SHA`);
    console.log(`[tf011-replay] replayEvery=${replayEvery} renderedFramesUntilReconstruct=${r.renderedFrames}`);
  }
});

test('repair-heavy checkpoint: unsolved equations discarded safely → exact SHA', () => {
  const fixture = new SessionFixture('repair', 0xbaba);
  const core = new SharedOpticalReceiveCore();
  orientAndPreamble(core);
  core.readManifest(fixture.frame('manifest', 0), MATRIX); // establish session before symbols
  // Miss degree-1 symbols 0..47; collect through the repair phase (ids >= 128).
  for (let i = 16; i < 50; i += 1) core.acceptDynamicFrame(fixture.frame('symbols', i), MATRIX);
  assert.ok(core.solvedCount > 0, 'progress made');
  assert.equal(core.complete, false, 'not complete at checkpoint');

  const cp = core.exportCheckpoint();
  assert.ok(cp && cp.solvedBlocks.length > 0, 'checkpoint exported');
  const restored = JSON.parse(JSON.stringify(cp)) as typeof cp;

  const core2 = new SharedOpticalReceiveCore();
  assert.equal(core2.restoreCheckpoint(restored), true, 'restore');
  for (let i = 50; i < 240 && !core2.complete; i += 1) core2.acceptDynamicFrame(fixture.frame('symbols', i), MATRIX);
  assert.equal(core2.complete, true, 'resume completes');
  const bytes = core2.reconstruct();
  assert.ok(bytes, 'resume reconstruction available');
  assert.equal(sha256Hex(bytes), fixture.sha, 'exact SHA after repair-heavy resume');
});
