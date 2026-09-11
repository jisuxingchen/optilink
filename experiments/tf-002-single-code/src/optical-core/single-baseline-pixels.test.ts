/**
 * TF-012 r4 — Single-Code Baseline RENDERED-PIXEL tests (G6 → G13).
 *
 * These tests exercise the real optical path with no camera and no browser:
 * deterministic frame rasteriser → single-code locator → cell sampling →
 * OptiGrid v1 CRC decode → chunk ingest → reconstruction → SHA-256.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_BASELINE_MATRIX,
  SingleCodeBaselineReceiver,
  buildSingleBaselineTransfer,
  captureSingleBaselineCode,
  locateDarkRegionBounds,
  locateSingleBaselineCodeSeeds,
  renderSingleBaselineFrame,
} from './single-baseline.ts';
import type {PixelFrame} from './pixel-frame.ts';

const transfer = buildSingleBaselineTransfer();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function render(chunkIndex: number, options?: Parameters<typeof renderSingleBaselineFrame>[2]): PixelFrame {
  return renderSingleBaselineFrame(transfer.frames[chunkIndex], SINGLE_BASELINE_MATRIX, options) as PixelFrame;
}

/** Paint dark glyph-like blocks somewhere else on the screen (sender control panel). */
function stampOverlay(frame: PixelFrame, x0: number, y0: number, width: number, height: number): void {
  for (let y = y0; y < Math.min(frame.height, y0 + height); y += 1) {
    for (let x = x0; x < Math.min(frame.width, x0 + width); x += 1) {
      if (((x - x0) % 6) > 3 || ((y - y0) % 8) > 5) continue;
      const offset = (y * frame.width + x) * 4;
      frame.data[offset] = 20; frame.data[offset + 1] = 20; frame.data[offset + 2] = 20;
    }
  }
}

test('G6/G7 a rendered single OptiGrid decodes to its exact payload in every frame rotation', () => {
  for (const rotation of [0, 1, 2, 3]) {
    const frame = render(5, {width: 720, height: 1280, fill: 0.7, rotation});
    const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
    assert.ok(capture.lock, 'rotation ' + rotation + ' must locate the code');
    assert.ok(capture.decoded, 'rotation ' + rotation + ' must CRC-decode');
    assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[5]), 'rotation ' + rotation + ' payload is exact');
    assert.equal(capture.lock.rotation, rotation, 'rotation is identified by the CRC oracle');
    assert.ok(capture.lock.score > 0.95, 'reserved-pattern score is high');
    assert.ok(capture.lock.contrast > 100);
    assert.ok(capture.lock.pixPerCellX > 1, 'at least one camera pixel per cell');
  }
});

test('G6/G7 the locator tolerates display tilt and code size/position variation', () => {
  const cases = [
    {width: 720, height: 1280, fill: 0.7, tiltDeg: 0, centerX: 360, centerY: 640},
    {width: 720, height: 1280, fill: 0.7, tiltDeg: 2, centerX: 360, centerY: 640},
    {width: 960, height: 720, fill: 0.8, tiltDeg: 4, centerX: 480, centerY: 360},
    {width: 720, height: 1280, fill: 0.5, tiltDeg: 0, centerX: 420, centerY: 520},
    {width: 1080, height: 1920, fill: 0.75, tiltDeg: 1.5, centerX: 500, centerY: 900},
  ];
  for (const options of cases) {
    const frame = render(9, options);
    const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
    assert.ok(capture.decoded, 'must decode for ' + JSON.stringify(options));
    assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[9]));
  }
});

test('G6 dark control-panel glyphs elsewhere on the screen do not steal the bounding box', () => {
  const frame = render(3, {width: 720, height: 1280, fill: 0.6, centerY: 700});
  stampOverlay(frame, 20, 20, 220, 90);
  stampOverlay(frame, 400, 30, 300, 60);
  const bounds = locateDarkRegionBounds(frame);
  assert.ok(bounds);
  const spanX = bounds.maxX - bounds.minX + 1;
  const spanY = bounds.maxY - bounds.minY + 1;
  assert.ok(spanX > 400 && spanY > 400 && Math.abs(spanX - spanY) < 12, 'bounding box is the code, not the glyphs');
  const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
  assert.ok(capture.decoded);
  assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[3]));
});

test('G7 a blank / low-contrast frame yields no lock and no false chunk', () => {
  const blank = render(0, {width: 720, height: 1280, fill: 0.7});
  for (let i = 0; i < blank.data.length; i += 4) {
    blank.data[i] = 250; blank.data[i + 1] = 250; blank.data[i + 2] = 250;
  }
  assert.equal(locateDarkRegionBounds(blank), null);
  assert.equal(locateSingleBaselineCodeSeeds(blank, SINGLE_BASELINE_MATRIX).length, 0);
  const capture = captureSingleBaselineCode(blank, SINGLE_BASELINE_MATRIX);
  assert.equal(capture.decoded, null);

  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  const result = receiver.ingestFrame(blank, SINGLE_BASELINE_MATRIX, 0);
  assert.equal(result.result, 'locate-failed');
  assert.equal(receiver.receivedUniqueCount, 0);
  assert.equal(receiver.metrics.locateFailures, 1);
});

test('G8/G10 end-to-end from pixels: receiver joins mid-cycle and still reconstructs exactly', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(1000);
  const startIndex = 11; // sender is already broadcasting chunk 11
  let frames = 0;
  for (let cycle = 0; cycle < 4 && !receiver.complete; cycle += 1) {
    for (let step = 0; step < 16 && !receiver.complete; step += 1) {
      const index = (startIndex + step) % 16;
      const frame = render(index, {width: 720, height: 1280, fill: 0.7});
      receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, 1000 + frames * 100);
      frames += 1;
    }
  }
  assert.ok(receiver.complete, 'joined at chunk ' + startIndex + ' and completed without a sender restart');
  assert.equal(receiver.receivedUniqueCount, 16);
  const result = receiver.reconstruct(9999);
  assert.ok(result);
  assert.equal(result.bytes.length, 10240);
  assert.equal(result.match, true);
  assert.equal(result.sha256Hex, transfer.fileSha256Hex);
  assert.equal(receiver.stage, 'complete');
  assert.ok(receiver.metrics.decodeSuccess >= 16);
  assert.ok(receiver.metrics.reservedScore > 0.95);
  assert.ok(receiver.metrics.codeWidthPx > 400);
  assert.ok(receiver.metrics.pixPerCellX > 4);
});

test('G8/G9 duplicates and dropped cycles from pixels never block completion', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  const plan = [3, 3, 3, 7, 7, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 14, 15];
  plan.forEach((index, i) => {
    receiver.ingestFrame(render(index, {width: 720, height: 1280, fill: 0.7}), SINGLE_BASELINE_MATRIX, i * 100);
  });
  assert.ok(receiver.complete);
  // Intentional re-emissions: 3 appears twice extra, 7 once extra, 14 twice extra.
  assert.equal(receiver.metrics.duplicateChunks, 7);
  assert.equal(receiver.metrics.uniqueChunks, 16);
  const result = receiver.reconstruct(5000);
  assert.ok(result && result.match);
});

test('G9 tracking keeps a held frame cheap and still exact', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  receiver.ingestFrame(render(2, {width: 720, height: 1280, fill: 0.7}), SINGLE_BASELINE_MATRIX, 0);
  const first = receiver.metrics.reservedScore;
  assert.equal(receiver.receivedUniqueCount, 1);
  for (let i = 0; i < 5; i += 1) {
    const frame = render(2, {width: 720, height: 1280, fill: 0.7});
    const result = receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, 100 + i * 100);
    assert.equal(result.result, 'duplicate', 'a re-rendered identical frame is a duplicate');
  }
  assert.equal(receiver.metrics.duplicateChunks, 5);
  assert.equal(receiver.metrics.reservedScore, first);
  assert.equal(receiver.metrics.decodeSuccess, 6);
  assert.equal(receiver.metrics.crcFailures, 0);
  assert.equal(receiver.metrics.locateFailures, 0);
});

test('G7 every chunk index survives the full pixel path independently', () => {
  for (let index = 0; index < 16; index += 1) {
    const frame = render(index, {width: 720, height: 1280, fill: 0.72});
    const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
    assert.ok(capture.decoded, 'chunk ' + index + ' decodes from rendered pixels');
    assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[index]));
    assert.equal(capture.decoded.sequence & 0xffff, index, 'OptiGrid sequence carries the chunk index');
  }
});

test('G6/G13 physical capability metrics are recorded from pixels', () => {
  const frame = render(0, {width: 720, height: 1280, fill: 0.75});
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, 250);
  const metrics = receiver.metrics;
  assert.equal(metrics.cameraFrames, 1);
  assert.equal(metrics.cameraWidth, 720);
  assert.equal(metrics.cameraHeight, 1280);
  assert.equal(metrics.decodeAttempts, 1);
  assert.equal(metrics.decodeSuccess, 1);
  assert.equal(metrics.crcFailures, 0);
  assert.equal(metrics.uniqueChunks, 1);
  assert.equal(metrics.firstChunkMs, 250);
  assert.ok(metrics.codeWidthPx > 500 && metrics.codeWidthPx < 560, 'observed code width in camera pixels');
  assert.ok(Math.abs(metrics.pixPerCellX - metrics.codeWidthPx / 96) < 1e-6);
  assert.ok(metrics.pixPerCellY > 5);
  assert.ok(metrics.contrast > 100);
  assert.ok(metrics.threshold > 60 && metrics.threshold < 200);
  assert.equal(metrics.postCompleteFrames, 0);
});

/**
 * Deterministic stand-in for a real camera: 3x3 box blur (lens/rolling-shutter
 * softening) plus bounded per-pixel sensor noise. Same seed → same frame.
 */
function degradeCamera(frame: PixelFrame, noiseAmplitude: number, blurRadius = 1): PixelFrame {
  const {width, height} = frame;
  const source = frame.data;
  const blurred = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let dy = -blurRadius; dy <= blurRadius; dy += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -blurRadius; dx <= blurRadius; dx += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const offset = (sy * width + sx) * 4;
          sumR += source[offset]; sumG += source[offset + 1]; sumB += source[offset + 2];
          count += 1;
        }
      }
      const offset = (y * width + x) * 4;
      blurred[offset] = sumR / count;
      blurred[offset + 1] = sumG / count;
      blurred[offset + 2] = sumB / count;
      blurred[offset + 3] = 255;
    }
  }
  let state = 0x2545f491;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  for (let i = 0; i < blurred.length; i += 4) {
    const noise = (((next() & 0xffff) / 0xffff) * 2 - 1) * noiseAmplitude;
    blurred[i] = blurred[i] + noise;
    blurred[i + 1] = blurred[i + 1] + noise;
    blurred[i + 2] = blurred[i + 2] + noise;
  }
  return {width, height, data: blurred};
}

test('G6/G7 blurred + noisy camera-like frames still decode exactly', () => {
  for (const noise of [0, 12, 25]) {
    const frame = degradeCamera(render(6, {width: 720, height: 1280, fill: 0.7}), noise);
    const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
    assert.ok(capture.decoded, 'blur+noise ' + noise + ' must decode');
    assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[6]));
  }
});

test('G6/G7 rotation, tilt and camera degradation combined still decode exactly', () => {
  for (const rotation of [0, 1, 2, 3]) {
    const frame = degradeCamera(render(12, {width: 720, height: 1280, fill: 0.68, rotation, tiltDeg: 1.5}), 12);
    const capture = captureSingleBaselineCode(frame, SINGLE_BASELINE_MATRIX);
    assert.ok(capture.decoded, 'rotation ' + rotation + ' + tilt + noise must decode');
    assert.ok(bytesEqual(capture.decoded.payload, transfer.payloads[12]));
  }
});

test('G8/G10 a degraded-pixel broadcast still reconstructs 10240 bytes with SHA MATCH', () => {
  const receiver = new SingleCodeBaselineReceiver();
  receiver.begin(0);
  let ticks = 0;
  for (let cycle = 0; cycle < 3 && !receiver.complete; cycle += 1) {
    for (let index = 0; index < 16 && !receiver.complete; index += 1) {
      const frame = degradeCamera(render(index, {width: 720, height: 1280, fill: 0.7, tiltDeg: 1}), 12);
      receiver.ingestFrame(frame, SINGLE_BASELINE_MATRIX, ticks * 100);
      ticks += 1;
      // Re-broadcast the same chunk (simulates a slow cyclic sender).
      receiver.ingestFrame(degradeCamera(render(index, {width: 720, height: 1280, fill: 0.7, tiltDeg: 1}), 12), SINGLE_BASELINE_MATRIX, ticks * 100);
      ticks += 1;
    }
  }
  assert.ok(receiver.complete, 'completes from degraded pixels');
  const result = receiver.reconstruct(ticks * 100);
  assert.ok(result);
  assert.equal(result.bytes.length, 10240);
  assert.equal(result.match, true);
  assert.equal(result.sha256Hex, transfer.fileSha256Hex);
});
