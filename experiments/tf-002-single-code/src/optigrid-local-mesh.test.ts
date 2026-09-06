import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateLocalMesh,
  countMeshBitErrors,
  sampleCellWithMesh,
  type CellLumaSampler,
} from './optigrid-local-mesh.ts';

function makePattern(size: number): Uint8Array {
  const cells = new Uint8Array(size * size);
  let x = 0x12345678;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      cells[row * size + column] = (x >>> 31) & 1;
    }
  }
  return cells;
}

function warpedSampler(cells: Uint8Array, size: number): CellLumaSampler {
  return (cellX, cellY) => {
    const nx = cellX / size;
    const ny = cellY / size;
    // Smooth non-projective displacement that a single global homography cannot remove.
    const phaseX = 0.72 * Math.sin(Math.PI * ny) * (nx - 0.5) * 2;
    const phaseY = -0.68 * Math.sin(Math.PI * nx) * (ny - 0.5) * 2;
    const idealX = cellX - phaseX;
    const idealY = cellY - phaseY;
    const column = Math.max(0, Math.min(size - 1, Math.floor(idealX)));
    const row = Math.max(0, Math.min(size - 1, Math.floor(idealY)));
    return cells[row * size + column] ? 24 : 232;
  };
}

function centerErrors(sampler: CellLumaSampler, expected: Uint8Array, size: number, border: number): number {
  let errors = 0;
  for (let row = border; row < size - border; row += 1) {
    for (let column = border; column < size - border; column += 1) {
      const observed = sampler(column + 0.5, row + 0.5) < 128 ? 1 : 0;
      if (observed !== expected[row * size + column]) errors += 1;
    }
  }
  return errors;
}

test('local mesh calibration corrects smooth non-projective cell displacement', () => {
  const size = 80;
  const border = 10;
  const expected = makePattern(size);
  const sampler = warpedSampler(expected, size);
  const baseline = centerErrors(sampler, expected, size, border);
  assert.ok(baseline > 20, `synthetic channel must contain meaningful global-center errors, got ${baseline}`);

  const mesh = calibrateLocalMesh(sampler, expected, size, {
    border,
    gridSize: 7,
    maxPhase: 0.9,
    coarseStep: 0.2,
    fineStep: 0.05,
    patchRadius: 4,
  });
  const corrected = countMeshBitErrors(sampler, expected, mesh);
  assert.ok(corrected.errors < baseline * 0.25, `mesh should remove most local warp errors: ${baseline} -> ${corrected.errors}`);
  assert.ok(mesh.averageScore > 0.95, `training correlation should remain high, got ${mesh.averageScore}`);
});

test('mesh sampler preserves an undistorted binary grid exactly', () => {
  const size = 64;
  const border = 10;
  const expected = makePattern(size);
  const sampler: CellLumaSampler = (cellX, cellY) => {
    const column = Math.max(0, Math.min(size - 1, Math.floor(cellX)));
    const row = Math.max(0, Math.min(size - 1, Math.floor(cellY)));
    return expected[row * size + column] ? 18 : 238;
  };
  const mesh = calibrateLocalMesh(sampler, expected, size, {border, gridSize: 5, maxPhase: 0.6, patchRadius: 3});
  const measured = countMeshBitErrors(sampler, expected, mesh);
  assert.equal(measured.errors, 0);
  assert.equal(sampleCellWithMesh(sampler, mesh, 22, 31), expected[22 * size + 31]);
});
