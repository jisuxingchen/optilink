export const TF007_FIDUCIAL_MARKER_PX = 84;
export const TF007_FIDUCIAL_OFFSET_Y_PX = -360;
export const TF007_TILE_TO_CENTER_SPACING = 540 / 630;
export const TF007_MARKER_TO_CENTER_SPACING = 84 / 630;
export const TF007_MARKER_OFFSET_TO_SPACING = -360 / 630;

export type FiducialComponent = {
  x: number;
  y: number;
  width: number;
  height: number;
  sampleCount: number;
  fillRatio: number;
};

export type FiducialPoint = {x: number; y: number; width: number; height: number};

export type FiducialLocatorDiagnostic = {
  method: 'macro-marker-triplet-v2';
  width: number;
  height: number;
  sampleStep: number;
  luma: {p02: number; p10: number; p50: number; p85: number; p98: number; dynamicRange: number; darkThreshold: number};
  componentCount: number;
  components: FiducialComponent[];
  triplet: null | {
    markers: FiducialPoint[];
    points: FiducialPoint[];
    spacing: number;
    spacingError: number;
    ySpread: number;
    sizeSpread: number;
    markerSideRatio: number;
    estimatedTileSide: number;
    score: number;
  };
};

function sampleLuma(image: ImageData, x: number, y: number): number {
  const xx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const yy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (yy * image.width + xx) * 4;
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}
function quantile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))];
}
function center(component: FiducialComponent): {x: number; y: number} {
  return {x: component.x + component.width / 2, y: component.y + component.height / 2};
}
function side(component: FiducialComponent): number { return (component.width + component.height) / 2; }

function detectMarkerComponents(image: ImageData, darkThreshold: number, step: number): FiducialComponent[] {
  const cols = Math.max(1, Math.floor(image.width / step));
  const rows = Math.max(1, Math.floor(image.height / step));
  const active = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    if (sampleLuma(image, (col + 0.5) * step, (row + 0.5) * step) < darkThreshold) active[row * cols + col] = 1;
  }
  const dilated = new Uint8Array(active.length);
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const rr = row + dy, cc = col + dx;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && active[rr * cols + cc]) { hit = true; break; }
    }
    if (hit) dilated[row * cols + col] = 1;
  }
  const seen = new Uint8Array(dilated.length), components: FiducialComponent[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const start = row * cols + col;
    if (!dilated[start] || seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    let minC = col, maxC = col, minR = row, maxR = row, count = 0;
    for (let qi = 0; qi < queue.length; qi += 1) {
      const index = queue[qi], rr = Math.floor(index / cols), cc = index % cols;
      count += 1; minC = Math.min(minC, cc); maxC = Math.max(maxC, cc); minR = Math.min(minR, rr); maxR = Math.max(maxR, rr);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nr = rr + dy, nc = cc + dx;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (dilated[ni] && !seen[ni]) { seen[ni] = 1; queue.push(ni); }
      }
    }
    const width = (maxC - minC + 1) * step, height = (maxR - minR + 1) * step;
    const componentSide = Math.max(width, height), aspect = width / Math.max(1, height);
    const boxSamples = Math.max(1, (maxC - minC + 1) * (maxR - minR + 1));
    const fillRatio = count / boxSamples;
    if (count < 10 || aspect < 0.62 || aspect > 1.62) continue;
    if (componentSide < image.height * 0.014 || componentSide > image.height * 0.19) continue;
    if (fillRatio < 0.30) continue;
    components.push({x: minC * step, y: minR * step, width, height, sampleCount: count, fillRatio});
  }
  return components.sort((a, b) => b.sampleCount - a.sampleCount);
}

function chooseTriplet(image: ImageData, components: FiducialComponent[]): FiducialLocatorDiagnostic['triplet'] {
  const pool = components.slice(0, 24);
  let best: FiducialLocatorDiagnostic['triplet'] = null;
  for (let i = 0; i < pool.length; i += 1) for (let j = i + 1; j < pool.length; j += 1) for (let k = j + 1; k < pool.length; k += 1) {
    const items = [pool[i], pool[j], pool[k]].sort((a, b) => center(a).x - center(b).x);
    const markers = items.map(center), d1 = markers[1].x - markers[0].x, d2 = markers[2].x - markers[1].x, spacing = (d1 + d2) / 2;
    if (d1 < image.width * 0.06 || d2 < image.width * 0.06 || spacing > image.width * 0.44) continue;
    const spacingError = Math.abs(d1 - d2) / Math.max(1, spacing);
    const ySpread = (Math.max(...markers.map(p => p.y)) - Math.min(...markers.map(p => p.y))) / Math.max(1, spacing);
    const sides = items.map(side), meanSide = sides.reduce((a, b) => a + b, 0) / 3;
    const sizeSpread = (Math.max(...sides) - Math.min(...sides)) / Math.max(1, meanSide);
    const markerSideRatio = meanSide / Math.max(1, spacing);
    if (spacingError > 0.34 || ySpread > 0.35 || sizeSpread > 0.52) continue;
    const ratioPenalty = Math.abs(markerSideRatio - TF007_MARKER_TO_CENTER_SPACING) * 15;
    const meanY = markers.reduce((sum, p) => sum + p.y, 0) / 3;
    const lowerHalfPenalty = Math.max(0, meanY / image.height - 0.54) * 5;
    const score = spacingError * 7 + ySpread * 5 + sizeSpread * 3 + ratioPenalty + lowerHalfPenalty;
    if (!best || score < best.score) {
      const projectedOffset = -TF007_MARKER_OFFSET_TO_SPACING * spacing;
      const estimatedTileSide = spacing * TF007_TILE_TO_CENTER_SPACING;
      best = {
        markers: items.map((item, n) => ({x: markers[n].x, y: markers[n].y, width: item.width, height: item.height})),
        points: markers.map(p => ({x: p.x, y: p.y + projectedOffset, width: estimatedTileSide, height: estimatedTileSide})),
        spacing, spacingError, ySpread, sizeSpread, markerSideRatio, estimatedTileSide, score,
      };
    }
  }
  return best;
}

export function locateOrientationFiducials(image: ImageData): FiducialLocatorDiagnostic {
  const step = Math.max(2, Math.floor(image.width / 480));
  const values: number[] = [];
  for (let y = step / 2; y < image.height; y += step * 2) for (let x = step / 2; x < image.width; x += step * 2) values.push(sampleLuma(image, x, y));
  values.sort((a, b) => a - b);
  const p02 = quantile(values, 0.02), p10 = quantile(values, 0.10), p50 = quantile(values, 0.50), p85 = quantile(values, 0.85), p98 = quantile(values, 0.98);
  const dynamicRange = p98 - p02;
  const darkThreshold = Math.min(p50 - 5, p02 + Math.max(18, Math.min(74, dynamicRange * 0.28)));
  const components = detectMarkerComponents(image, darkThreshold, step);
  return {method: 'macro-marker-triplet-v2', width: image.width, height: image.height, sampleStep: step,
    luma: {p02, p10, p50, p85, p98, dynamicRange, darkThreshold}, componentCount: components.length,
    components: components.slice(0, 14), triplet: chooseTriplet(image, components)};
}
