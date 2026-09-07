export const TF007_FIDUCIAL_MARGIN_PX = 28;
export const TF007_FIDUCIAL_RING_PX = 18;
export const TF007_TILE_TO_CENTER_SPACING = 540 / 630;

export type FiducialComponent = {
  x: number;
  y: number;
  width: number;
  height: number;
  sampleCount: number;
  fillRatio: number;
};

export type FiducialPoint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FiducialLocatorDiagnostic = {
  method: 'macro-dark-triplet-v1';
  width: number;
  height: number;
  sampleStep: number;
  luma: {p02: number; p10: number; p50: number; p85: number; p98: number; dynamicRange: number; darkThreshold: number};
  componentCount: number;
  components: FiducialComponent[];
  triplet: null | {
    points: FiducialPoint[];
    spacing: number;
    spacingError: number;
    ySpread: number;
    sizeSpread: number;
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
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function componentCenter(component: FiducialComponent): {x: number; y: number} {
  return {x: component.x + component.width / 2, y: component.y + component.height / 2};
}

function componentSide(component: FiducialComponent): number {
  return (component.width + component.height) / 2;
}

function detectDarkComponents(image: ImageData, darkThreshold: number, step: number): FiducialComponent[] {
  const cols = Math.max(1, Math.floor(image.width / step));
  const rows = Math.max(1, Math.floor(image.height / step));
  const active = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (sampleLuma(image, (col + 0.5) * step, (row + 0.5) * step) < darkThreshold) active[row * cols + col] = 1;
    }
  }

  // One-cell dilation makes the locator tolerant of display/camera blur and resampling gaps.
  const dilated = new Uint8Array(active.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const rr = row + dy, cc = col + dx;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && active[rr * cols + cc]) { hit = true; break; }
        }
      }
      if (hit) dilated[row * cols + col] = 1;
    }
  }

  const seen = new Uint8Array(dilated.length);
  const components: FiducialComponent[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const start = row * cols + col;
      if (!dilated[start] || seen[start]) continue;
      seen[start] = 1;
      const queue = [start];
      let minCol = col, maxCol = col, minRow = row, maxRow = row, count = 0;
      for (let qi = 0; qi < queue.length; qi += 1) {
        const index = queue[qi], rr = Math.floor(index / cols), cc = index % cols;
        count += 1;
        minCol = Math.min(minCol, cc); maxCol = Math.max(maxCol, cc);
        minRow = Math.min(minRow, rr); maxRow = Math.max(maxRow, rr);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nr = rr + dy, nc = cc + dx;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const ni = nr * cols + nc;
            if (dilated[ni] && !seen[ni]) { seen[ni] = 1; queue.push(ni); }
          }
        }
      }
      const width = (maxCol - minCol + 1) * step;
      const height = (maxRow - minRow + 1) * step;
      const side = Math.max(width, height);
      const aspect = width / Math.max(1, height);
      const boxSamples = Math.max(1, (maxCol - minCol + 1) * (maxRow - minRow + 1));
      const fillRatio = count / boxSamples;
      if (count < 14 || aspect < 0.45 || aspect > 2.2) continue;
      if (side < image.height * 0.055 || side > image.height * 0.72) continue;
      if (fillRatio < 0.025 || fillRatio > 0.88) continue;
      components.push({x: minCol * step, y: minRow * step, width, height, sampleCount: count, fillRatio});
    }
  }
  return components.sort((a, b) => (b.sampleCount * componentSide(b)) - (a.sampleCount * componentSide(a)));
}

function chooseTriplet(image: ImageData, components: FiducialComponent[]): FiducialLocatorDiagnostic['triplet'] {
  const pool = components.slice(0, 18);
  let best: FiducialLocatorDiagnostic['triplet'] = null;
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      for (let k = j + 1; k < pool.length; k += 1) {
        const items = [pool[i], pool[j], pool[k]].sort((a, b) => componentCenter(a).x - componentCenter(b).x);
        const centers = items.map(componentCenter);
        const d1 = centers[1].x - centers[0].x, d2 = centers[2].x - centers[1].x;
        const spacing = (d1 + d2) / 2;
        if (d1 < image.width * 0.07 || d2 < image.width * 0.07 || spacing > image.width * 0.44) continue;
        const spacingError = Math.abs(d1 - d2) / Math.max(1, spacing);
        const ySpread = (Math.max(...centers.map(p => p.y)) - Math.min(...centers.map(p => p.y))) / Math.max(1, spacing);
        const sides = items.map(componentSide), meanSide = sides.reduce((a, b) => a + b, 0) / 3;
        const sizeSpread = (Math.max(...sides) - Math.min(...sides)) / Math.max(1, meanSide);
        if (spacingError > 0.36 || ySpread > 0.42 || sizeSpread > 0.62) continue;
        const sideRatio = meanSide / Math.max(1, spacing);
        const geometryPenalty = Math.min(1.5, Math.abs(sideRatio - 0.9) * 1.8);
        const score = spacingError * 6 + ySpread * 4 + sizeSpread * 2.5 + geometryPenalty;
        if (!best || score < best.score) {
          best = {
            points: items.map((item, index) => ({...componentCenter(item), width: item.width, height: item.height, index})).map(({index: _index, ...point}) => point),
            spacing,
            spacingError,
            ySpread,
            sizeSpread,
            estimatedTileSide: spacing * TF007_TILE_TO_CENTER_SPACING,
            score,
          };
        }
      }
    }
  }
  return best;
}

export function locateOrientationFiducials(image: ImageData): FiducialLocatorDiagnostic {
  const step = Math.max(3, Math.floor(image.width / 360));
  const values: number[] = [];
  for (let y = step / 2; y < image.height; y += step * 2) {
    for (let x = step / 2; x < image.width; x += step * 2) values.push(sampleLuma(image, x, y));
  }
  values.sort((a, b) => a - b);
  const p02 = quantile(values, 0.02), p10 = quantile(values, 0.10), p50 = quantile(values, 0.50), p85 = quantile(values, 0.85), p98 = quantile(values, 0.98);
  const dynamicRange = p98 - p02;
  const darkThreshold = Math.min(p50 - 4, p02 + Math.max(22, Math.min(82, dynamicRange * 0.30)));
  const components = detectDarkComponents(image, darkThreshold, step);
  const triplet = chooseTriplet(image, components);
  return {
    method: 'macro-dark-triplet-v1', width: image.width, height: image.height, sampleStep: step,
    luma: {p02, p10, p50, p85, p98, dynamicRange, darkThreshold},
    componentCount: components.length,
    components: components.slice(0, 10),
    triplet,
  };
}
