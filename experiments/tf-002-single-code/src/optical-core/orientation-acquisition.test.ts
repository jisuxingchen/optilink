import {test} from 'node:test';
import assert from 'node:assert';
import {acquireOrientation,normalizeFrame,ORIENTATION_MATRIX,TILE_COUNT} from './orientation-acquisition.ts';
import type {PixelFrame} from './pixel-frame.ts';

// A 2x3 RGBA frame with a distinct gradient so rotation mapping is verifiable.
function makeFrame(): PixelFrame {
  // width=2, height=3
  // row0: (10,0,0) (20,0,0)
  // row1: (30,0,0) (40,0,0)
  // row2: (50,0,0) (60,0,0)
  const data = new Uint8ClampedArray([
    10,0,0,255, 20,0,0,255,
    30,0,0,255, 40,0,0,255,
    50,0,0,255, 60,0,0,255,
  ]);
  return {width: 2, height: 3, data};
}

test('normalizeFrame native preserves top-left', () => {
  const out = normalizeFrame(makeFrame(), 'native', 2, 3);
  assert.equal(out.data[0], 10);
  assert.equal(out.data[(2*2+1)*4], 60); // bottom-right (x=1,y=2)
});

test('normalizeFrame rotate180 flips', () => {
  const out = normalizeFrame(makeFrame(), 'rotate180', 2, 3);
  assert.equal(out.data[0], 60); // bottom-right -> top-left
  assert.equal(out.data[(2*2+1)*4], 10); // top-left -> bottom-right
});

test('normalizeFrame rotateCW maps portrait to landscape', () => {
  // 2x3 -> rotate CW -> 3x2
  const out = normalizeFrame(makeFrame(), 'rotateCW', 3, 2);
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  // top-left of source (10) -> top-right of output
  assert.equal(out.data[(0*3+2)*4], 10);
  // bottom-left of source (50) -> top-left of output
  assert.equal(out.data[0], 50);
});

test('normalizeFrame rotateCCW maps portrait to landscape', () => {
  const out = normalizeFrame(makeFrame(), 'rotateCCW', 3, 2);
  // top-left of source (10) -> bottom-left of output
  assert.equal(out.data[((2-1)*3+0)*4], 10);
});

test('acquireOrientation returns candidate structure on a blank portrait frame', () => {
  // 64x64 blank frame (portrait): no markers/tiles, so it must NOT lock.
  const blank: PixelFrame = {width: 64, height: 128, data: new Uint8ClampedArray(64*128*4)};
  const result = acquireOrientation(blank);
  assert.equal(result.matrixSize, ORIENTATION_MATRIX);
  // portrait -> two rotation candidates
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map(c => c.orientationMode), ['rotateCW', 'rotateCCW']);
  assert.equal(result.locked, false);
  assert.equal(result.orientationMode, null);
  assert.equal(result.best ? result.best.success : false, false);
});

test('acquireOrientation returns two candidates on a landscape frame', () => {
  const blank: PixelFrame = {width: 128, height: 64, data: new Uint8ClampedArray(128*64*4)};
  const result = acquireOrientation(blank);
  assert.deepEqual(result.candidates.map(c => c.orientationMode), ['native', 'rotate180']);
  assert.equal(result.locked, false);
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
