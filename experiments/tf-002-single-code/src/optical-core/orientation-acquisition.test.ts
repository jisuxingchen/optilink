import {test} from 'node:test';
import assert from 'node:assert';
import {acquireOrientation,normalizeFrame,ORIENTATION_MATRIX,TILE_COUNT} from './orientation-acquisition.ts';
import type {PixelFrame} from './pixel-frame.ts';

// Landscape 4x2 frame — no letterbox crop for native/rotate180.
function makeLandscape(): PixelFrame {
  const data = new Uint8ClampedArray([
    10,0,0,255, 20,0,0,255, 30,0,0,255, 40,0,0,255,
    50,0,0,255, 60,0,0,255, 70,0,0,255, 80,0,0,255,
  ]);
  return {width: 4, height: 2, data};
}

// Portrait 2x4 frame for rotateCW/rotateCCW.
function makePortrait(): PixelFrame {
  const data = new Uint8ClampedArray([
    10,0,0,255, 20,0,0,255,
    30,0,0,255, 40,0,0,255,
    50,0,0,255, 60,0,0,255,
    70,0,0,255, 80,0,0,255,
  ]);
  return {width: 2, height: 4, data};
}

// Portrait frame with three horizontal black markers (matches physical evidence:
// raw marker centers at x≈124/340/558, y≈533).
function renderHorizontalMarkers(): PixelFrame {
  const w = 720, h = 1280;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  const marker = (cx: number, cy: number, size: number) => {
    for (let y = Math.round(cy - size / 2); y < Math.round(cy + size / 2); y++) {
      for (let x = Math.round(cx - size / 2); x < Math.round(cx + size / 2); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4;
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
      }
    }
  };
  marker(340, 533, 32);
  marker(558, 531, 32);
  marker(124, 535, 32);
  return {width: w, height: h, data};
}

test('normalizeFrame native preserves top-left (landscape, no crop)', () => {
  const out = normalizeFrame(makeLandscape(), 'native', 4, 2);
  assert.equal(out.data[0], 10);
  assert.equal(out.data[(1*4+3)*4], 80); // bottom-right (x=3,y=1)
});

test('normalizeFrame rotate180 flips (landscape)', () => {
  const out = normalizeFrame(makeLandscape(), 'rotate180', 4, 2);
  assert.equal(out.data[0], 80);
  assert.equal(out.data[(1*4+3)*4], 10);
});

test('normalizeFrame native letterbox-crops portrait (center kept, letterbox dropped)', () => {
  const w = 100, h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  const set = (x: number, y: number, v: number) => { const o = (y * w + x) * 4; data[o] = v; data[o + 1] = v; data[o + 2] = v; };
  for (let y = 95; y < 105; y++) for (let x = 45; x < 55; x++) set(x, y, 0); // black block near center
  const out = normalizeFrame({width: w, height: h, data}, 'native', 100, 56);
  assert.ok(out.data[(28*100+50)*4] < 128, 'center block mapped into output');
  assert.equal(out.data[0], 255, 'letterbox top dropped (output top stays white)');
});

test('normalizeFrame rotateCW maps portrait to landscape', () => {
  const out = normalizeFrame(makePortrait(), 'rotateCW', 4, 2);
  assert.equal(out.width, 4);
  assert.equal(out.height, 2);
  assert.equal(out.data[(0*4+3)*4], 10); // top-left of source -> top-right
  assert.equal(out.data[0], 70);          // bottom-left of source -> top-left
});

test('normalizeFrame rotateCCW maps portrait to landscape', () => {
  const out = normalizeFrame(makePortrait(), 'rotateCCW', 4, 2);
  assert.equal(out.data[((2-1)*4+0)*4], 10); // top-left of source -> bottom-left
});

test('acquireOrientation evaluates all 4 transforms', () => {
  const blank: PixelFrame = {width: 64, height: 128, data: new Uint8ClampedArray(64*128*4)};
  const result = acquireOrientation(blank);
  assert.equal(result.matrixSize, ORIENTATION_MATRIX);
  assert.equal(result.transformCandidates.length, 4);
  assert.deepEqual(result.transformCandidates.map(tc => tc.mode), ['native', 'rotate180', 'rotateCW', 'rotateCCW']);
  assert.equal(result.locked, false);
  assert.equal(result.orientationMode, null);
  assert.equal(result.candidates.length, 1, 'no fallback when no transform has marker evidence');
  assert.equal(result.selectedTransform, 'native', 'first-ranked when all transforms score -Infinity');
});

test('transform selector picks native for horizontal markers in portrait frame', () => {
  const result = acquireOrientation(renderHorizontalMarkers());
  assert.equal(result.selectedTransform, 'native');
  const native = result.transformCandidates.find(tc => tc.mode === 'native');
  assert.ok(native, 'native candidate present');
  assert.ok(native!.detectedMarkerComponentCount >= 3, '3 marker components detected: ' + native!.detectedMarkerComponentCount);
  assert.equal(native!.tripletValid, true, 'native forms a valid triplet');
});

test('rotateCW rejects vertical markers (geometry mismatch)', () => {
  const result = acquireOrientation(renderHorizontalMarkers());
  const cw = result.transformCandidates.find(tc => tc.mode === 'rotateCW');
  assert.ok(cw, 'rotateCW candidate present');
  assert.notEqual(cw!.tripletValid, true, 'rotateCW must not form a valid triplet on horizontal markers');
});

test('no transform yields triplet -> no false lock', () => {
  const blank: PixelFrame = {width: 64, height: 128, data: new Uint8ClampedArray(64*128*4)};
  const result = acquireOrientation(blank);
  assert.equal(result.locked, false);
  assert.equal(result.best!.tripletValid, false);
});

test('tile count constant is 3', () => {
  assert.equal(TILE_COUNT, 3);
});

test('not-acquired tiles serialize bitErrors null with reason not-acquired', () => {
  const blank: PixelFrame = {width: 64, height: 128, data: new Uint8ClampedArray(64*128*4)};
  const result = acquireOrientation(blank);
  assert.equal(result.locked, false);
  assert.ok(result.best, 'best candidate exists');
  for (const tile of result.best!.tiles) {
    assert.equal(tile.acquired, false);
    assert.equal(tile.bitErrors, null, 'not-acquired bitErrors must be null, not sentinel');
    assert.equal(tile.reason, 'not-acquired');
  }
  assert.equal(result.best!.totalBitErrors, null, 'totalBitErrors null when not all acquired');
  assert.ok(result.profile && typeof result.profile.totalMs === 'number', 'profile present');
});
