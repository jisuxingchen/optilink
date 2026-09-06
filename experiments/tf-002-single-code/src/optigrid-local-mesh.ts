export type CellLumaSampler = (cellX: number, cellY: number) => number;

export type MeshNode = {
  phaseX: number;
  phaseY: number;
  threshold: number;
  score: number;
  contrast: number;
};

export type LocalMeshCalibration = {
  matrixSize: number;
  border: number;
  gridSize: number;
  nodes: MeshNode[];
  minScore: number;
  averageScore: number;
  minContrast: number;
  averageContrast: number;
  maxAbsPhaseX: number;
  maxAbsPhaseY: number;
};

export type MeshOptions = {
  border?: number;
  gridSize?: number;
  maxPhase?: number;
  coarseStep?: number;
  fineStep?: number;
  patchRadius?: number;
};

type Candidate = MeshNode & {objective: number};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function nodeIndex(gridSize: number, gx: number, gy: number): number {
  return gy * gridSize + gx;
}

function patchCells(matrixSize: number, border: number, centerColumn: number, centerRow: number, radius: number): Array<[number, number]> {
  const start = border;
  const end = matrixSize - border - 1;
  const cells: Array<[number, number]> = [];
  const stride = Math.max(1, Math.floor((radius * 2 + 1) / 9));
  for (let row = Math.max(start, centerRow - radius); row <= Math.min(end, centerRow + radius); row += stride) {
    for (let column = Math.max(start, centerColumn - radius); column <= Math.min(end, centerColumn + radius); column += stride) {
      cells.push([column, row]);
    }
  }
  return cells;
}

function evaluatePatch(
  sampler: CellLumaSampler,
  expected: Uint8Array,
  matrixSize: number,
  cells: Array<[number, number]>,
  phaseX: number,
  phaseY: number,
): Candidate | null {
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  const values: number[] = [];
  for (const [column, row] of cells) {
    const value = sampler(column + 0.5 + phaseX, row + 0.5 + phaseY);
    values.push(value);
    if (expected[row * matrixSize + column]) {
      blackSum += value;
      blackCount += 1;
    } else {
      whiteSum += value;
      whiteCount += 1;
    }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  if (!(contrast > 0)) return null;
  const threshold = (blackMean + whiteMean) / 2;
  let matches = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const [column, row] = cells[index];
    const observed = values[index] < threshold ? 1 : 0;
    if (observed === expected[row * matrixSize + column]) matches += 1;
  }
  const score = matches / cells.length;
  return {
    phaseX,
    phaseY,
    threshold,
    score,
    contrast,
    objective: score * 1000 + Math.min(160, contrast),
  };
}

function phaseRange(maxPhase: number, step: number): number[] {
  const values: number[] = [];
  for (let value = -maxPhase; value <= maxPhase + step * 0.25; value += step) values.push(Number(value.toFixed(4)));
  return values;
}

function calibrateNode(
  sampler: CellLumaSampler,
  expected: Uint8Array,
  matrixSize: number,
  border: number,
  centerColumn: number,
  centerRow: number,
  radius: number,
  maxPhase: number,
  coarseStep: number,
  fineStep: number,
): MeshNode {
  const cells = patchCells(matrixSize, border, centerColumn, centerRow, radius);
  let best: Candidate | null = null;
  const coarse = phaseRange(maxPhase, coarseStep);
  for (const phaseX of coarse) for (const phaseY of coarse) {
    const candidate = evaluatePatch(sampler, expected, matrixSize, cells, phaseX, phaseY);
    if (candidate && (!best || candidate.objective > best.objective)) best = candidate;
  }
  if (!best) return {phaseX: 0, phaseY: 0, threshold: 127.5, score: 0, contrast: 0};
  const fineRadius = coarseStep;
  for (let phaseX = best.phaseX - fineRadius; phaseX <= best.phaseX + fineRadius + fineStep * 0.25; phaseX += fineStep) {
    for (let phaseY = best.phaseY - fineRadius; phaseY <= best.phaseY + fineRadius + fineStep * 0.25; phaseY += fineStep) {
      const candidate = evaluatePatch(
        sampler,
        expected,
        matrixSize,
        cells,
        Number(phaseX.toFixed(4)),
        Number(phaseY.toFixed(4)),
      );
      if (candidate && candidate.objective > best.objective) best = candidate;
    }
  }
  return {phaseX: best.phaseX, phaseY: best.phaseY, threshold: best.threshold, score: best.score, contrast: best.contrast};
}

export function calibrateLocalMesh(
  sampler: CellLumaSampler,
  expected: Uint8Array,
  matrixSize: number,
  options: MeshOptions = {},
): LocalMeshCalibration {
  if (expected.length !== matrixSize * matrixSize) throw new Error('expected cell matrix size mismatch');
  const border = options.border ?? 10;
  const gridSize = options.gridSize ?? (matrixSize <= 100 ? 7 : 9);
  const inner = matrixSize - border * 2;
  if (inner < 8) throw new Error('matrix interior too small for mesh calibration');
  const maxPhase = options.maxPhase ?? (matrixSize <= 80 ? 0.8 : matrixSize <= 120 ? 1.0 : 1.3);
  const coarseStep = options.coarseStep ?? 0.2;
  const fineStep = options.fineStep ?? 0.05;
  const patchRadius = options.patchRadius ?? Math.max(3, Math.min(10, Math.round(inner / (gridSize * 2))));
  const nodes: MeshNode[] = [];

  for (let gy = 0; gy < gridSize; gy += 1) {
    const fy = gridSize === 1 ? 0.5 : gy / (gridSize - 1);
    const centerRow = Math.round(border + fy * (inner - 1));
    for (let gx = 0; gx < gridSize; gx += 1) {
      const fx = gridSize === 1 ? 0.5 : gx / (gridSize - 1);
      const centerColumn = Math.round(border + fx * (inner - 1));
      nodes.push(calibrateNode(
        sampler,
        expected,
        matrixSize,
        border,
        centerColumn,
        centerRow,
        patchRadius,
        maxPhase,
        coarseStep,
        fineStep,
      ));
    }
  }

  const sumScore = nodes.reduce((sum, node) => sum + node.score, 0);
  const sumContrast = nodes.reduce((sum, node) => sum + node.contrast, 0);
  return {
    matrixSize,
    border,
    gridSize,
    nodes,
    minScore: Math.min(...nodes.map(node => node.score)),
    averageScore: sumScore / nodes.length,
    minContrast: Math.min(...nodes.map(node => node.contrast)),
    averageContrast: sumContrast / nodes.length,
    maxAbsPhaseX: Math.max(...nodes.map(node => Math.abs(node.phaseX))),
    maxAbsPhaseY: Math.max(...nodes.map(node => Math.abs(node.phaseY))),
  };
}

export function interpolateMesh(mesh: LocalMeshCalibration, column: number, row: number): MeshNode {
  const inner = mesh.matrixSize - mesh.border * 2;
  const x = clamp((column - mesh.border) / Math.max(1, inner - 1), 0, 1) * (mesh.gridSize - 1);
  const y = clamp((row - mesh.border) / Math.max(1, inner - 1), 0, 1) * (mesh.gridSize - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(mesh.gridSize - 1, x0 + 1);
  const y1 = Math.min(mesh.gridSize - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = mesh.nodes[nodeIndex(mesh.gridSize, x0, y0)];
  const b = mesh.nodes[nodeIndex(mesh.gridSize, x1, y0)];
  const c = mesh.nodes[nodeIndex(mesh.gridSize, x0, y1)];
  const d = mesh.nodes[nodeIndex(mesh.gridSize, x1, y1)];
  const blend = (key: keyof Pick<MeshNode, 'phaseX' | 'phaseY' | 'threshold' | 'score' | 'contrast'>) => {
    const top = a[key] * (1 - tx) + b[key] * tx;
    const bottom = c[key] * (1 - tx) + d[key] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return {
    phaseX: blend('phaseX'),
    phaseY: blend('phaseY'),
    threshold: blend('threshold'),
    score: blend('score'),
    contrast: blend('contrast'),
  };
}

export function sampleCellWithMesh(
  sampler: CellLumaSampler,
  mesh: LocalMeshCalibration,
  row: number,
  column: number,
): number {
  const local = interpolateMesh(mesh, column, row);
  const value = sampler(column + 0.5 + local.phaseX, row + 0.5 + local.phaseY);
  return value < local.threshold ? 1 : 0;
}

export function countMeshBitErrors(
  sampler: CellLumaSampler,
  expected: Uint8Array,
  mesh: LocalMeshCalibration,
): {errors: number; bits: number; tileErrors: number[]} {
  const grid = mesh.gridSize;
  const tileErrors = new Array<number>(grid * grid).fill(0);
  let errors = 0;
  let bits = 0;
  const inner = mesh.matrixSize - mesh.border * 2;
  for (let row = mesh.border; row < mesh.matrixSize - mesh.border; row += 1) {
    for (let column = mesh.border; column < mesh.matrixSize - mesh.border; column += 1) {
      const observed = sampleCellWithMesh(sampler, mesh, row, column);
      if (observed !== expected[row * mesh.matrixSize + column]) {
        errors += 1;
        const gx = Math.round(clamp((column - mesh.border) / Math.max(1, inner - 1), 0, 1) * (grid - 1));
        const gy = Math.round(clamp((row - mesh.border) / Math.max(1, inner - 1), 0, 1) * (grid - 1));
        tileErrors[nodeIndex(grid, gx, gy)] += 1;
      }
      bits += 1;
    }
  }
  return {errors, bits, tileErrors};
}
