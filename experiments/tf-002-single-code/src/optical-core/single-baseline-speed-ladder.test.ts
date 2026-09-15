/**
 * TF-012 r6 — Single-Code speed ladder: benchmark arithmetic + timing accounting.
 *
 * WHAT THIS FILE PINS
 *
 *  1. The hold-duration ladder exists exactly as specified and nothing silently
 *     clamps the fast end (75/50/33 ms used to collapse onto a 100 ms floor).
 *  2. Theoretical rates are DECLARED arithmetic on the hold timer. They are
 *     reproducible to the digit and are never called goodput or throughput.
 *  3. Exploratory Net Goodput exists ONLY for a complete, SHA-256-exact run.
 *     Every other combination — MISMATCH, 15/16, zero duration, null duration —
 *     returns null. A failure is not a rate.
 *  4. The r4/r5 latency-accounting bug is structurally impossible now: a frame
 *     that arrives AFTER completion is reported as `ignored-complete`, does NOT
 *     advance `cameraFrames`, and is counted in `postCompleteFrames` instead.
 *     That is precisely the population whose ~0 ms cost used to be averaged into
 *     `avgFrameProcessMs` until the real decode samples were evicted.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_BASELINE_CHUNK_DATA_BYTES,
  SINGLE_BASELINE_FILE_BYTES,
  SINGLE_BASELINE_HOLD_MS_LADDER,
  SINGLE_BASELINE_HOLD_MS_MAX,
  SINGLE_BASELINE_HOLD_MS_MIN,
  SINGLE_BASELINE_MATRIX,
  SINGLE_BASELINE_TOTAL_CHUNKS,
  SingleCodeBaselineReceiver,
  buildSingleBaselineTransfer,
  clampSingleBaselineHoldMs,
  renderSingleBaselineFrame,
  singleBaselineBenchmark,
  singleBaselineNetGoodput,
} from './single-baseline.ts';

const transfer = buildSingleBaselineTransfer();

// ---------------------------------------------------------------------------
// 1. Ladder + clamping
// ---------------------------------------------------------------------------

test('speed ladder exposes exactly the specified hold durations', () => {
  assert.deepEqual(
    Array.from(SINGLE_BASELINE_HOLD_MS_LADDER),
    [1500, 1000, 750, 500, 333, 250, 200, 150, 100, 75, 50, 33],
  );
  assert.equal(SINGLE_BASELINE_HOLD_MS_MIN, 33, 'fastest supported hold is 33 ms');
  assert.equal(SINGLE_BASELINE_HOLD_MS_MAX, 60000);
});

test('every ladder value survives the URL clamp unchanged (no 100 ms floor)', () => {
  for (const holdMs of SINGLE_BASELINE_HOLD_MS_LADDER) {
    assert.equal(clampSingleBaselineHoldMs(String(holdMs)), holdMs, 'hold ' + holdMs + ' must not be clamped');
  }
  // The pre-r6 code floored at 100 ms, which silently made 75/50/33 identical.
  assert.notEqual(clampSingleBaselineHoldMs('33'), 100);
  assert.equal(clampSingleBaselineHoldMs('33'), 33);
});

test('clamp honours bounds, rounding and the invalid-input fallback', () => {
  assert.equal(clampSingleBaselineHoldMs('10'), SINGLE_BASELINE_HOLD_MS_MIN, 'too fast clamps up');
  assert.equal(clampSingleBaselineHoldMs('999999'), SINGLE_BASELINE_HOLD_MS_MAX, 'too slow clamps down');
  assert.equal(clampSingleBaselineHoldMs('124.6'), 124, 'a fractional hold truncates to an integer ms value');
  assert.ok(
    ['124.6', '0.5', '33.9', '1500.99'].every((raw) => Number.isInteger(clampSingleBaselineHoldMs(raw))),
    'the clamped hold is always an integer millisecond count',
  );
  assert.equal(clampSingleBaselineHoldMs(''), 1000, 'empty input falls back');
  assert.equal(clampSingleBaselineHoldMs(null), 1000, 'null falls back');
  assert.equal(clampSingleBaselineHoldMs('abc'), 1000, 'garbage falls back');
  assert.equal(clampSingleBaselineHoldMs('0'), 1000, 'zero is not a duration');
  assert.equal(clampSingleBaselineHoldMs('-40'), 1000, 'negative is not a duration');
  assert.equal(clampSingleBaselineHoldMs(undefined, 500), 500, 'fallback is honoured');
  assert.equal(clampSingleBaselineHoldMs('250'), 250, 'Stage B intermediate values pass through');
});

// ---------------------------------------------------------------------------
// 2. Declared theoretical rates
// ---------------------------------------------------------------------------

test('benchmark reports the specified ladder rates (640 B / hold)', () => {
  const expected: Array<[number, number, number, number]> = [
    // holdMs, chunk/s, B/s, KiB/s
    [1500, 0.667, 426.7, 0.417],
    [1000, 1, 640, 0.625],
    [750, 1.333, 853.3, 0.833],
    [500, 2, 1280, 1.25],
    [333, 3.003, 1921.9, 1.877],
    [250, 4, 2560, 2.5],
    [200, 5, 3200, 3.125],
    [150, 6.667, 4266.7, 4.167],
    [100, 10, 6400, 6.25],
    [75, 13.333, 8533.3, 8.333],
    [50, 20, 12800, 12.5],
    [33, 30.303, 19393.9, 18.939],
  ];
  for (const [holdMs, chunksPerSecond, bytesPerSecond, kibPerSecond] of expected) {
    const benchmark = singleBaselineBenchmark(holdMs);
    assert.ok(benchmark, 'benchmark must exist for hold ' + holdMs);
    assert.equal(benchmark!.holdMs, holdMs);
    assert.equal(benchmark!.theoreticalChunksPerSecond, chunksPerSecond, 'chunk/s @' + holdMs);
    assert.equal(benchmark!.theoreticalPayloadBytesPerSecond, bytesPerSecond, 'B/s @' + holdMs);
    assert.equal(benchmark!.theoreticalPayloadKiBPerSecond, kibPerSecond, 'KiB/s @' + holdMs);
  }
});

test('declared rates are exactly chunkDataBytes / hold for every ladder value', () => {
  for (const holdMs of SINGLE_BASELINE_HOLD_MS_LADDER) {
    const benchmark = singleBaselineBenchmark(holdMs);
    assert.ok(benchmark);
    const exactChunks = 1000 / holdMs;
    const exactBytes = (SINGLE_BASELINE_CHUNK_DATA_BYTES * 1000) / holdMs;
    assert.ok(
      Math.abs(benchmark!.theoreticalChunksPerSecond - exactChunks) < 0.0005,
      'chunk/s within rounding tolerance @' + holdMs,
    );
    assert.ok(Math.abs(benchmark!.theoreticalPayloadBytesPerSecond - exactBytes) < 0.05, 'B/s @' + holdMs);
    // Sanity: the theoretical rate must scale exactly with 1/hold.
    assert.ok(
      Math.abs(benchmark!.theoreticalPayloadBytesPerSecond * holdMs - SINGLE_BASELINE_CHUNK_DATA_BYTES * 1000) < 60,
      'payload rate is linear in 1/hold @' + holdMs,
    );
  }
});

test('benchmark never invents a number for an unusable hold duration', () => {
  assert.equal(singleBaselineBenchmark(0), null);
  assert.equal(singleBaselineBenchmark(-100), null);
  assert.equal(singleBaselineBenchmark(Number.NaN), null);
  assert.equal(singleBaselineBenchmark(Number.POSITIVE_INFINITY), null);
  assert.equal(singleBaselineBenchmark(1000, 0), null, 'no payload => no rate');
});

// ---------------------------------------------------------------------------
// 3. Exploratory Net Goodput is gated, never guessed
// ---------------------------------------------------------------------------

test('net goodput uses fileBytes / timeToAllChunksSeconds when 16/16 + MATCH', () => {
  const goodput = singleBaselineNetGoodput(SINGLE_BASELINE_FILE_BYTES, 15500, 16, 16, true);
  assert.ok(goodput);
  assert.equal(goodput!.fileBytes, SINGLE_BASELINE_FILE_BYTES);
  assert.equal(goodput!.timeToAllChunksMs, 15500);
  const expected = (SINGLE_BASELINE_FILE_BYTES * 1000) / 15500;
  assert.ok(Math.abs(goodput!.bytesPerSecond - expected) < 0.001, 'B/s uses the specified formula');
  assert.ok(Math.abs(goodput!.kibPerSecond - expected / 1024) < 0.001, 'KiB/s is B/s / 1024');
});

test('net goodput is null unless the run is complete AND SHA-256 exact', () => {
  // SHA MISMATCH with all chunks present is still not a rate.
  assert.equal(singleBaselineNetGoodput(SINGLE_BASELINE_FILE_BYTES, 15500, 16, 16, false), null);
  // 15/16 unique chunks: incomplete, so no rate.
  assert.equal(singleBaselineNetGoodput(SINGLE_BASELINE_FILE_BYTES, 15500, 15, 16, true), null);
  // Never completed => no duration => no rate.
  assert.equal(singleBaselineNetGoodput(SINGLE_BASELINE_FILE_BYTES, -1, 16, 16, true), null);
  assert.equal(singleBaselineNetGoodput(SINGLE_BASELINE_FILE_BYTES, 0, 16, 16, true), null);
  assert.equal(singleBaselineNetGoodput(0, 15500, 16, 16, true), null);
  assert.equal(singleBaselineNetGoodput(Number.NaN, 15500, 16, 16, true), null);
});

// ---------------------------------------------------------------------------
// 4. Timing accounting: post-completion frames are structurally separate
// ---------------------------------------------------------------------------

/** Render one clean, decodable OptiGrid for the given chunk. */
function renderChunk(index: number): {width: number; height: number; data: Uint8ClampedArray} {
  return renderSingleBaselineFrame(transfer.frames[index], SINGLE_BASELINE_MATRIX, {
    width: 720,
    height: 720,
    fill: 0.72,
  }) as {width: number; height: number; data: Uint8ClampedArray};
}

test('post-completion frames are counted separately and never touch the active set', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);

  const HOLD_MS = 1000;
  const FIRST_CHUNK = 7; // arbitrary join time: the receiver starts mid-cycle
  const startedAt = 500; // 500 ms of aiming before the first chunk lands

  let clock = startedAt;
  for (let step = 0; step < SINGLE_BASELINE_TOTAL_CHUNKS; step += 1) {
    const chunkIndex = (FIRST_CHUNK + step) % SINGLE_BASELINE_TOTAL_CHUNKS;
    const result = receiver.ingestFrame(renderChunk(chunkIndex), SINGLE_BASELINE_MATRIX, clock);
    assert.equal(result.result, 'stored', 'chunk ' + chunkIndex + ' must be stored');
    clock += HOLD_MS;
  }

  // 16 active frames, all decoded, zero failures.
  assert.equal(receiver.metrics.cameraFrames, SINGLE_BASELINE_TOTAL_CHUNKS);
  assert.equal(receiver.metrics.decodeAttempts, SINGLE_BASELINE_TOTAL_CHUNKS);
  assert.equal(receiver.metrics.decodeSuccess, SINGLE_BASELINE_TOTAL_CHUNKS);
  assert.equal(receiver.metrics.locateFailures, 0);
  assert.equal(receiver.metrics.crcFailures, 0);
  assert.equal(receiver.receivedUniqueCount, SINGLE_BASELINE_TOTAL_CHUNKS);
  assert.deepEqual(receiver.missingIndices(), []);
  assert.equal(receiver.metrics.firstChunkMs, startedAt);
  assert.equal(receiver.metrics.allChunksMs, startedAt + (SINGLE_BASELINE_TOTAL_CHUNKS - 1) * HOLD_MS);

  // The stage is no longer 'receiving' — this is the condition the adapter uses
  // to route a frame out of the active latency aggregate.
  assert.equal(receiver.stage, 'reconstructing');
  assert.equal(receiver.complete, true);

  // A long post-completion tail: cheap, ignored, and counted nowhere else.
  const tail = 250;
  const reusedFrame = renderChunk(0);
  for (let i = 0; i < tail; i += 1) {
    const result = receiver.ingestFrame(reusedFrame, SINGLE_BASELINE_MATRIX, clock + i);
    assert.equal(result.result, 'ignored-complete');
    assert.equal(result.located, false);
    assert.equal(result.decoded, false);
  }

  // This is the structural guarantee: the ignored population cannot inflate
  // cameraFrames / decodeAttempts, so it cannot dilute a decode-latency average.
  assert.equal(receiver.metrics.cameraFrames, SINGLE_BASELINE_TOTAL_CHUNKS, 'ignored frames are not camera frames');
  assert.equal(receiver.metrics.decodeAttempts, SINGLE_BASELINE_TOTAL_CHUNKS, 'ignored frames are not decode attempts');
  assert.equal(receiver.metrics.postCompleteFrames, tail);
  // ...and the completion timestamps are frozen at completion, not at freeze time.
  assert.equal(receiver.metrics.allChunksMs, startedAt + (SINGLE_BASELINE_TOTAL_CHUNKS - 1) * HOLD_MS);
});

test('a full cyclic ingest reconstructs byte-exact and yields a non-null goodput', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);

  const HOLD_MS = 333; // r6 ladder: 3 chunk/s theoretical
  const FIRST_CHUNK = 11;
  let clock = 0;

  // Two full cycles so duplicates are exercised, then stop as soon as complete.
  for (let step = 0; step < SINGLE_BASELINE_TOTAL_CHUNKS * 2 && !receiver.complete; step += 1) {
    const chunkIndex = (FIRST_CHUNK + step) % SINGLE_BASELINE_TOTAL_CHUNKS;
    const frame = renderChunk(chunkIndex);
    // A camera delivers several frames per displayed chunk; only the first of
    // each window decodes to a new index, the rest are duplicates.
    const framesPerChunk = 3;
    for (let frameIndex = 0; frameIndex < framesPerChunk; frameIndex += 1) {
      receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, clock);
      clock += Math.floor(HOLD_MS / framesPerChunk);
      if (receiver.complete) break;
    }
  }

  assert.equal(receiver.complete, true);
  assert.equal(receiver.receivedUniqueCount, SINGLE_BASELINE_TOTAL_CHUNKS);
  assert.deepEqual(receiver.missingIndices(), []);
  assert.ok(receiver.metrics.duplicateChunks > 0, 'the duplicate path really ran');
  assert.equal(receiver.metrics.locateFailures, 0);
  assert.equal(receiver.metrics.crcFailures, 0);

  const reconstruction = receiver.reconstruct();
  assert.ok(reconstruction);
  assert.equal(reconstruction!.bytes.length, SINGLE_BASELINE_FILE_BYTES);
  assert.equal(reconstruction!.match, true, 'SHA-256 MATCH');
  assert.equal(reconstruction!.sha256Hex, transfer.fileSha256Hex);

  const goodput = singleBaselineNetGoodput(
    reconstruction!.bytes.length,
    receiver.metrics.allChunksMs,
    receiver.receivedUniqueCount,
    receiver.totalChunks,
    reconstruction!.match,
  );
  assert.ok(goodput, 'a complete SHA-exact run must produce a goodput number');
  assert.ok(goodput!.bytesPerSecond > 0);
  assert.ok(
    Math.abs(goodput!.bytesPerSecond - (SINGLE_BASELINE_FILE_BYTES * 1000) / receiver.metrics.allChunksMs) < 0.001,
  );
});
