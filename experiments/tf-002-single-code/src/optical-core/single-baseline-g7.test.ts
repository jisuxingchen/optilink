/**
 * TF-012 r5 — G7 Single-Code Detection & Decode diagnostics tests.
 *
 * Splits G7 into G7a candidate detection / G7b code bounding box / G7c geometry
 * lock / G7d CRC decode and exercises each sub-stage with MONITOR-CAPTURE-SHAPED
 * fixtures (dark surroundings, screen cast, illumination gradient, dark UI,
 * blur, moiré, sensor noise, perspective, small code), because the r4 physical
 * run failed 5272/5272 frames inside the locator with no explanation.
 *
 * Two groups of assertions:
 *  1. scenes the detector MUST handle end-to-end (CRC-decoded chunk 0);
 *  2. scenes it does NOT yet handle, where the requirement is that the failure is
 *     EXPLAINABLE through the exposed G7a–G7d measurements (never a bare
 *     "locate-failed").
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_BASELINE_MATRIX,
  SingleCodeBaselineReceiver,
  analyzeDarkRegions,
  buildSingleBaselineTransfer,
  captureSingleBaselineCode,
  locateDarkRegionBounds,
  renderSingleBaselineFrame,
} from './single-baseline.ts';
import type {PixelFrame} from './pixel-frame.ts';

const transfer = buildSingleBaselineTransfer();

type Frame = {width: number; height: number; data: Uint8ClampedArray};

let rngState = 0x2545f491;
function rng(): number {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return (rngState & 0xffff) / 0xffff;
}

const render = (options?: Parameters<typeof renderSingleBaselineFrame>[2]): Frame =>
  renderSingleBaselineFrame(transfer.frames[0], SINGLE_BASELINE_MATRIX, options) as Frame;

function each(frame: Frame, fn: (value: number, x: number, y: number) => number): void {
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const value = fn(frame.data[offset], x, y);
      frame.data[offset] = value;
      frame.data[offset + 1] = value;
      frame.data[offset + 2] = value;
      frame.data[offset + 3] = 255;
    }
  }
}

/** Screen/auto-exposure washout: black lifts, white stays. */
function washedOut(frame: Frame, blackLevel: number, whiteLevel: number): Frame {
  each(frame, (value) => blackLevel + (value / 255) * (whiteLevel - blackLevel));
  return frame;
}

/** Dark room / monitor bezel around the bright screen that holds the code. */
function darkSurround(frame: Frame, inset: number, darkLevel: number): Frame {
  each(frame, (value, x, y) => (
    x >= inset && x < frame.width - inset && y >= inset && y < frame.height - inset ? value : darkLevel
  ));
  return frame;
}

/** A large dark rectangle elsewhere on the screen (dark window / dark desk). */
function darkBlock(frame: Frame, x0: number, y0: number, w: number, h: number, level: number): Frame {
  each(frame, (value, x, y) => (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h ? level : value));
  return frame;
}

/** Screen cast (tint) plus a non-uniform illumination gradient. */
function castAndGradient(frame: Frame, cast: [number, number, number], gradient: number): Frame {
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const gain = 0.5 + (x / frame.width - 0.5) * gradient + (y / frame.height - 0.5) * gradient * 0.4;
      frame.data[offset] = Math.max(0, Math.min(255, frame.data[offset] * gain * cast[0]));
      frame.data[offset + 1] = Math.max(0, Math.min(255, frame.data[offset + 1] * gain * cast[1]));
      frame.data[offset + 2] = Math.max(0, Math.min(255, frame.data[offset + 2] * gain * cast[2]));
    }
  }
  return frame;
}

/** 3×3 box blur (lens + rolling-shutter softening). */
function blur(frame: Frame, radius: number): Frame {
  const out = new Uint8ClampedArray(frame.data.length);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= frame.height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= frame.width) continue;
          sum += frame.data[(sy * frame.width + sx) * 4];
          count += 1;
        }
      }
      const value = sum / count;
      const offset = (y * frame.width + x) * 4;
      out[offset] = value; out[offset + 1] = value; out[offset + 2] = value; out[offset + 3] = 255;
    }
  }
  return {width: frame.width, height: frame.height, data: out};
}

/** Sensor noise plus moiré-like periodic luminance ripple. Deterministic per call. */
function noiseAndMoire(frame: Frame, noiseAmplitude: number, ripple: number): Frame {
  rngState = 0x2545f491;
  each(frame, (value, x, y) => value + ripple * Math.sin(x / 3.1 + y / 4.7) + (rng() * 2 - 1) * noiseAmplitude);
  return frame;
}

/** Depth perspective: vertical trapezoid warp. */
function perspective(frame: Frame, strength: number): Frame {
  const out = new Uint8ClampedArray(frame.data.length);
  const cy = frame.height / 2;
  for (let y = 0; y < frame.height; y += 1) {
    const scale = 1 + ((y - cy) / frame.height) * strength;
    for (let x = 0; x < frame.width; x += 1) {
      const sx = Math.max(0, Math.min(frame.width - 1, Math.round((x - frame.width / 2) / scale + frame.width / 2)));
      const offset = (y * frame.width + x) * 4;
      const value = frame.data[(y * frame.width + sx) * 4];
      out[offset] = value; out[offset + 1] = value; out[offset + 2] = value; out[offset + 3] = 255;
    }
  }
  return {width: frame.width, height: frame.height, data: out};
}

function decodeReport(frame: Frame) {
  const region = analyzeDarkRegions(frame as PixelFrame);
  const capture = captureSingleBaselineCode(frame as PixelFrame, SINGLE_BASELINE_MATRIX);
  return {region: region.diagnostics, capture, diagnostics: capture.diagnostics};
}

// ---------------------------------------------------------------------------
// Group 1 — scenes the detector must handle end-to-end (r4 failed these)
// ---------------------------------------------------------------------------

test('G7a · monitor washout no longer aborts at the region stage (r4 returned null below contrast 60)', () => {
  const frame = washedOut(render({width: 720, height: 1280, fill: 0.7}), 190, 240);
  const {region, capture} = decodeReport(frame);
  assert.ok(region.contrast < 60, 'fixture really is low contrast (' + region.contrast.toFixed(0) + ')');
  assert.equal(region.g7aPass, true, 'G7a must still analyse a low-contrast frame');
  assert.ok(region.darkPixelRatio > 0.05, 'dark modules are still separable');
  assert.ok(capture.decoded, 'G7d must CRC-decode the washed-out frame');
  assert.equal(capture.decoded!.sequence & 0xffff, 0);
});

test('G7a/G7b · dark room or bezel larger than the code no longer steals the geometry', () => {
  const frame = darkSurround(render({width: 720, height: 1280, fill: 0.6}), 60, 18);
  const largest = locateDarkRegionBounds(frame as PixelFrame);
  assert.ok(largest, 'a dark region exists');
  assert.ok(
    largest!.maxX - largest!.minX + 1 > 700 && largest!.maxY - largest!.minY + 1 > 1200,
    'the LARGEST dark region really is the room around the screen, not the code',
  );
  const {region, capture} = decodeReport(frame);
  assert.equal(region.g7aPass, true);
  assert.ok(region.candidateCount >= 2, 'the code is still offered as a candidate');
  assert.equal(capture.diagnostics.g7bPass, true, 'a code-like candidate ranks first');
  assert.ok(capture.decoded, 'G7d must CRC-decode with the room larger than the code');
  assert.equal(capture.diagnostics.stage, 'G7d');
});

test('G7a/G7b · a large dark UI block elsewhere on the screen does not block the code', () => {
  const frame = darkBlock(render({width: 720, height: 1280, fill: 0.55, centerY: 420}), 0, 900, 720, 380, 20);
  const {capture, diagnostics} = decodeReport(frame);
  assert.ok(diagnostics.region!.g7aPass);
  assert.ok(capture.decoded, 'G7d must CRC-decode with a dark block larger than the code present');
  assert.equal(diagnostics.g7dPass, true);
});

test('G7c · the geometry lock reaches the code through blur and moiré plus sensor noise', () => {
  const blurred = blur(render({width: 720, height: 1280, fill: 0.7}), 2);
  const noisy = noiseAndMoire(washedOut(render({width: 720, height: 1280, fill: 0.7}), 30, 235), 14, 20);
  for (const [label, frame] of [['blur', blurred], ['moire+noise', noisy]] as Array<[string, Frame]>) {
    const {capture, diagnostics} = decodeReport(frame);
    assert.ok(capture.decoded, label + ' must decode');
    assert.ok(diagnostics.refinementBestScore > 0.9, label + ' refinement score ' + diagnostics.refinementBestScore.toFixed(3));
    assert.equal(diagnostics.g7dPass, true, label + ' G7d pass');
  }
});

test('G7a→G7d · a realistic monitor scene (bezel + cast + gradient + blur + noise + moiré) decodes', () => {
  const frame = noiseAndMoire(
    blur(castAndGradient(darkSurround(washedOut(render({width: 720, height: 1280, fill: 0.62}), 55, 235), 45, 22), [0.9, 0.95, 1.04], 0.15), 1),
    8,
    10,
  );
  const {capture, diagnostics} = decodeReport(frame);
  assert.ok(diagnostics.region!.g7aPass, 'G7a pass');
  assert.ok(diagnostics.g7bPass, 'G7b pass');
  assert.ok(diagnostics.g7cPass, 'G7c pass');
  assert.ok(capture.decoded, 'G7d CRC pass');
  assert.equal(capture.decoded!.sequence & 0xffff, 0, 'decoded chunkIndex = 0');
  assert.ok(diagnostics.refinementBestPixPerCell > 3, 'plausible pixels per cell');
  assert.ok(diagnostics.refinementBestContrast > 50, 'strong reserved contrast');
});

// ---------------------------------------------------------------------------
// Group 2 — scenes that still fail, where the failure MUST be explainable
// ---------------------------------------------------------------------------

test('G7c · strong lateral gradient whose bright region is a strip reports a wrong-region signature, not silence', () => {
  const frame = castAndGradient(washedOut(render({width: 720, height: 1280, fill: 0.68}), 40, 235), [0.82, 0.92, 1.06], 0.45);
  const {capture, diagnostics} = decodeReport(frame);
  assert.equal(diagnostics.region!.g7aPass, true, 'G7a still analyses the frame');
  assert.equal(capture.decoded, null);
  // The exposed signature distinguishes "wrong region" (huge quad, ~zero reserved contrast)
  // from "right region, wrong geometry" (plausible px/cell, high contrast).
  assert.equal(diagnostics.stage, 'G7c');
  assert.match(diagnostics.stageReason, /^crc-fail:/u);
  assert.ok(diagnostics.refinementBestPixPerCell > 8, 'the quad is far too large → wrong region');
  assert.ok(diagnostics.refinementBestContrast < 20, 'reserved contrast is ~0 → not the code');
  assert.ok(diagnostics.refinementBestScore > 0, 'the best FAILED score is reported, not hidden');
});

test('G7c · real depth perspective is reported with a near-miss score', () => {
  const frame = perspective(render({width: 720, height: 1280, fill: 0.62}), 0.12);
  const {capture, diagnostics} = decodeReport(frame);
  assert.equal(capture.decoded, null);
  assert.equal(diagnostics.stage, 'G7c');
  assert.ok(diagnostics.g7bPass, 'the bounding box is still code-like');
  assert.ok(diagnostics.refinementBestScore > 0.6 && diagnostics.refinementBestScore < 0.99, 'near miss is visible');
  assert.ok(diagnostics.refinementBestPixPerCell > 3 && diagnostics.refinementBestPixPerCell < 8, 'sane px/cell');
  assert.ok(diagnostics.refinementBestContrast > 50, 'high reserved contrast → right region, wrong geometry');
});

test('G7c · too few camera pixels per cell is reported as a physical limit', () => {
  const {capture, diagnostics} = decodeReport(render({width: 720, height: 1280, fill: 0.28}));
  assert.equal(capture.decoded, null);
  assert.ok(diagnostics.refinementBestPixPerCell < 3, 'px/cell exposes the physical limit (get closer)');
  assert.equal(diagnostics.region!.g7aPass, true);
});

test('G7a · a severe global-illumination gradient is reported as a wrong-region limit', () => {
  // Known limit of the current GLOBAL threshold: at a ~50% brightness ramp across
  // the frame combined with moiré, one screen edge becomes as dark as the code's
  // black modules, so no code-like region exists. Measured boundary: the same
  // scene with a 0.3 ramp decodes; a 0.25 ramp plus moiré does not. The
  // requirement here is only that the failure is measurable and attributable.
  const frame = noiseAndMoire(
    castAndGradient(darkSurround(washedOut(render({width: 720, height: 1280, fill: 0.62}), 55, 235), 45, 22), [0.9, 0.95, 1.04], 0.25),
    8,
    10,
  );
  const {capture, diagnostics} = decodeReport(frame);
  assert.equal(capture.decoded, null);
  assert.equal(diagnostics.region!.g7aPass, true, 'G7a still produces candidates');
  assert.equal(diagnostics.stage, 'G7c', 'G7c/G7d are still attempted and measured');
  assert.ok(diagnostics.refinementBestPixPerCell > 8, 'wrong-region signature: quad far too large');
  assert.ok(diagnostics.refinementBestContrast < 20, 'wrong-region signature: reserved contrast ~0');
  assert.ok(diagnostics.refinementBestScore > 0, 'best FAILED score is exposed');
});

// ---------------------------------------------------------------------------
// Receiver wiring
// ---------------------------------------------------------------------------

test('receiver exposes cumulative G7a→G7d sub-stage counters and the last reason', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  // A blank frame stops at G7a with an explicit reason.
  const blank = render({width: 720, height: 1280, fill: 0.7});
  for (let i = 0; i < blank.data.length; i += 4) {
    blank.data[i] = 250; blank.data[i + 1] = 250; blank.data[i + 2] = 250;
  }
  receiver.ingestFrame(blank, SINGLE_BASELINE_MATRIX, 0);
  const metrics = receiver.metrics;
  assert.equal(metrics.locateFailures, 1);
  assert.equal(metrics.crcFailures, 0, 'a locator failure must NOT be counted as a CRC failure');
  assert.equal(metrics.g7FramesAnalysed, 1);
  assert.equal(metrics.g7aPassCount, 0);
  assert.equal(metrics.locatorStage, 'G7a');
  assert.notEqual(metrics.locatorStageReason, '', 'the exact reason is exposed');
  assert.ok(metrics.regionLumaMin >= 0 && metrics.regionLumaMax >= 0);
  assert.equal(metrics.regionCandidateCount, 0);

  // A real chunk-0 frame walks the full G7 chain and increments every counter.
  receiver.begin(0);
  const frame = darkSurround(render({width: 720, height: 1280, fill: 0.6}), 60, 18);
  const result = receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, 10);
  assert.equal(result.result, 'stored');
  assert.equal(receiver.metrics.g7FramesAnalysed, 1);
  assert.equal(receiver.metrics.g7aPassCount, 1);
  assert.equal(receiver.metrics.g7bPassCount, 1);
  assert.equal(receiver.metrics.g7cPassCount, 1);
  assert.equal(receiver.metrics.g7dPassCount, 1);
  assert.equal(receiver.metrics.locatorStage, 'G7d');
  assert.equal(receiver.metrics.decodedChunkIndex, 0);
  assert.equal(receiver.metrics.crcSuccess, 1);
  assert.equal(receiver.metrics.regionCandidateCount >= 2, true);
  assert.ok(receiver.metrics.regionLumaMax - receiver.metrics.regionLumaMin > 100, 'G7a luma span is measured');
  assert.ok(receiver.metrics.regionDarkPixelRatio > 0);
  assert.ok(receiver.metrics.regionLocalVariationRatio > 0);
});
