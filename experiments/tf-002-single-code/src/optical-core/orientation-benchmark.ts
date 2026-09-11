/**
 * NON-PHYSICAL synthetic benchmark for the TF-007H orientation acquisition core.
 * Generates a plausible 1280x720 sender frame (3 tiles + 3 macro markers), wraps
 * it as a portrait 720x1280 "camera" frame (simulating the physical sensor), and
 * times acquireOrientation. Results are synthetic desktop timings only — they do
 * NOT represent the phone.
 *
 * Run: node src/optical-core/orientation-benchmark.ts
 */
import {acquireOrientation, normalizeFrame, ORIENTATION_MATRIX, SAMPLE_WIDTH, SAMPLE_HEIGHT, TILE_COUNT} from './orientation-acquisition.ts';
import type {PixelFrame} from './pixel-frame.ts';
import {encodeFrameCellsV1,payloadCapacityForMatrixV1} from '../optigrid-v1.ts';

function preambleCells(matrixSize: number, tile: number): Uint8Array {
  const sequence = (0x54000000 | ((matrixSize & 0xff) << 8) | (tile & 0xff)) >>> 0;
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  const payload = new Uint8Array(bytes);
  for (let i = 0; i < payload.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    payload[i] = (x + i * 31 + tile * 47) & 255;
  }
  return encodeFrameCellsV1(matrixSize, sequence, payload);
}

function renderLandscape(): PixelFrame {
  const w = SAMPLE_WIDTH, h = SAMPLE_HEIGHT;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 236; data[i + 1] = 239; data[i + 2] = 241; data[i + 3] = 255; }
  const laneW = w / TILE_COUNT;
  const tileSize = 384; // 64 cells * 6px
  const cellPx = tileSize / ORIENTATION_MATRIX;
  const markerOffsetY = -240, core = 56, halo = 88;
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v;
  };
  for (let tile = 0; tile < TILE_COUNT; tile++) {
    const cx = tile * laneW + laneW / 2;
    const cy = h / 2;
    const cells = preambleCells(ORIENTATION_MATRIX, tile);
    const left = Math.round(cx - tileSize / 2);
    const top = Math.round(cy - tileSize / 2);
    for (let row = 0; row < ORIENTATION_MATRIX; row++) {
      for (let col = 0; col < ORIENTATION_MATRIX; col++) {
        const v = cells[row * ORIENTATION_MATRIX + col] ? 0 : 255;
        const x0 = left + Math.round(col * cellPx);
        const y0 = top + Math.round(row * cellPx);
        for (let y = y0; y < y0 + Math.ceil(cellPx); y++)
          for (let x = x0; x < x0 + Math.ceil(cellPx); x++) set(x, y, v);
      }
    }
    const my = cy + markerOffsetY;
    for (let y = Math.round(my - halo / 2); y < Math.round(my + halo / 2); y++)
      for (let x = Math.round(cx - halo / 2); x < Math.round(cx + halo / 2); x++) set(x, y, 255);
    for (let y = Math.round(my - core / 2); y < Math.round(my + core / 2); y++)
      for (let x = Math.round(cx - core / 2); x < Math.round(cx + core / 2); x++) set(x, y, 0);
  }
  return {width: w, height: h, data};
}

function toPortrait(landscape: PixelFrame): PixelFrame {
  return normalizeFrame(landscape, 'rotateCW', landscape.height, landscape.width);
}

const landscape = renderLandscape();
const portrait = toPortrait(landscape);

const N = 10;
const totals: number[] = [];
let sample: ReturnType<typeof acquireOrientation> | null = null;

for (let i = 0; i < N; i++) {
  const r = acquireOrientation(portrait);
  totals.push(r.profile.totalMs);
  if (i === 0) sample = r;
}

totals.sort((a, b) => a - b);
const avg = totals.reduce((a, b) => a + b, 0) / N;
console.log('[synthetic benchmark — NON-PHYSICAL]');
if (sample) {
  console.log('selectedTransform=' + sample.selectedTransform
    + ' locked=' + sample.locked
    + ' mode=' + sample.orientationMode
    + ' support=' + (sample.best?.locatorSupport ?? 'none')
    + ' tripletValid=' + (sample.best?.tripletValid ?? false)
    + ' detectedComponents=' + (sample.best?.detectedMarkerComponentCount ?? 0)
    + ' validTripletMarkers=' + (sample.best?.validTripletMarkerCount ?? 0)
    + ' lockMode=' + (sample.best?.lockMode ?? 'n/a')
    + ' reject=' + (sample.best?.tripletRejectReason ?? 'n/a'));
  console.log('transformCandidates=' + JSON.stringify(sample.transformCandidates.map(tc => ({mode: tc.mode, tripletValid: tc.tripletValid, support: tc.tripletSupport, score: tc.geometryScore, components: tc.detectedMarkerComponentCount}))));
  console.log('profile: ' + JSON.stringify(sample.profile));
}
console.log('acquireOrientation total: avg=' + avg.toFixed(1)
  + 'ms p50=' + totals[Math.floor(N * 0.5)]
  + 'ms p95=' + totals[Math.floor(N * 0.95)] + 'ms over ' + N + ' runs');
