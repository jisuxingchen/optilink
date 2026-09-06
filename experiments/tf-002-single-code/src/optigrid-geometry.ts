export type Point = {x: number; y: number};
export type Quad = {tl: Point; tr: Point; br: Point; bl: Point};
export type Homography = [number, number, number, number, number, number, number, number];
export type Affine = {a: number; b: number; c: number; d: number; e: number; f: number};

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);

  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];
    for (let j = column; j <= n; j += 1) augmented[column][j] /= divisor;

    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = column; j <= n; j += 1) augmented[row][j] -= factor * augmented[column][j];
    }
  }

  return augmented.map(row => row[n]);
}

/**
 * Return a projective transform mapping unit-square coordinates (u,v) to the
 * supplied image quadrilateral: (0,0)=TL, (1,0)=TR, (1,1)=BR, (0,1)=BL.
 */
export function homographyFromUnitSquare(quad: Quad): Homography | null {
  const correspondences: Array<[number, number, Point]> = [
    [0, 0, quad.tl],
    [1, 0, quad.tr],
    [1, 1, quad.br],
    [0, 1, quad.bl],
  ];
  const matrix: number[][] = [];
  const rhs: number[] = [];

  for (const [u, v, point] of correspondences) {
    matrix.push([u, v, 1, 0, 0, 0, -point.x * u, -point.x * v]);
    rhs.push(point.x);
    matrix.push([0, 0, 0, u, v, 1, -point.y * u, -point.y * v]);
    rhs.push(point.y);
  }

  const solved = solveLinearSystem(matrix, rhs);
  if (!solved || solved.some(value => !Number.isFinite(value))) return null;
  return solved as Homography;
}

export function mapHomography(h: Homography, u: number, v: number): Point {
  const [a, b, c, d, e, f, g, k] = h;
  const denominator = g * u + k * v + 1;
  return {
    x: (a * u + b * v + c) / denominator,
    y: (d * u + e * v + f) / denominator,
  };
}

export function quadArea(quad: Quad): number {
  const points = [quad.tl, quad.tr, quad.br, quad.bl];
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function quadInside(quad: Quad, width: number, height: number, minimumArea = 1): boolean {
  const points = [quad.tl, quad.tr, quad.br, quad.bl];
  if (points.some(point => point.x < 0 || point.y < 0 || point.x >= width || point.y >= height)) return false;
  return quadArea(quad) >= minimumArea;
}

/** Solve the affine transform that maps one source triangle to one destination triangle. */
export function affineFromTriangles(source: [Point, Point, Point], destination: [Point, Point, Point]): Affine | null {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denominator) < 1e-9) return null;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const e = (
    d0.x * (s1.x * s2.y - s2.x * s1.y)
    + d1.x * (s2.x * s0.y - s0.x * s2.y)
    + d2.x * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;

  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const f = (
    d0.y * (s1.x * s2.y - s2.x * s1.y)
    + d1.y * (s2.x * s0.y - s0.x * s2.y)
    + d2.y * (s0.x * s1.y - s1.x * s0.y)
  ) / denominator;

  return {a, b, c, d, e, f};
}
