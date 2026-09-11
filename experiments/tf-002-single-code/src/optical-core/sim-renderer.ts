/**
 * Deterministic test-fixture renderer: rasterizes three OptiGrid tile cell grids
 * (plus fiducial markers) onto the 1920x1080 sender canvas, mirroring the real
 * sender geometry (tile 540px at centers [330,960,1590], y=270; markers at
 * y=180). Used by non-physical integration tests so they exercise rendered
 * pixels without a browser.
 */

export const RENDER_W = 1920;
export const RENDER_H = 1080;
export const RENDER_TILE = 540;
export const RENDER_CENTERS = [330, 960, 1590];
export const RENDER_TOP = 270;

export function render1920(
  cellsByTile: Uint8Array[],
  matrixSize: number,
): {width: number; height: number; data: Uint8ClampedArray} {
  const data = new Uint8ClampedArray(RENDER_W * RENDER_H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 236; data[i + 1] = 239; data[i + 2] = 241; data[i + 3] = 255; }
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= RENDER_W || y >= RENDER_H) return;
    const o = (y * RENDER_W + x) * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v;
  };
  const cellPx = RENDER_TILE / matrixSize;
  for (let tile = 0; tile < 3; tile += 1) {
    const cells = cellsByTile[tile];
    const left = RENDER_CENTERS[tile] - RENDER_TILE / 2;
    for (let y = RENDER_TOP - 10; y < RENDER_TOP + RENDER_TILE + 10; y += 1) for (let x = left - 10; x < left + RENDER_TILE + 10; x += 1) set(x, y, 255);
    for (let r = 0; r < matrixSize; r += 1) {
      for (let c = 0; c < matrixSize; c += 1) {
        const v = cells[r * matrixSize + c] ? 0 : 255;
        const x0 = Math.floor(left + c * cellPx);
        const y0 = Math.floor(RENDER_TOP + r * cellPx);
        const x1 = Math.floor(left + (c + 1) * cellPx);
        const y1 = Math.floor(RENDER_TOP + (r + 1) * cellPx);
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, v);
      }
    }
    const mx = RENDER_CENTERS[tile];
    const my = RENDER_TOP + RENDER_TILE / 2 - 360;
    for (let y = my - 66; y < my + 66; y += 1) for (let x = mx - 66; x < mx + 66; x += 1) set(x, y, 255);
    for (let y = my - 42; y < my + 42; y += 1) for (let x = mx - 42; x < mx + 42; x += 1) set(x, y, 0);
  }
  return {width: RENDER_W, height: RENDER_H, data};
}
