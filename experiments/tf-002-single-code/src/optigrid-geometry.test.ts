import assert from 'node:assert/strict';
import test from 'node:test';
import {affineFromTriangles, homographyFromUnitSquare, mapHomography, quadArea} from './optigrid-geometry.ts';

function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('homography maps unit square corners to arbitrary quadrilateral', () => {
  const quad = {
    tl: {x: 12, y: 18},
    tr: {x: 122, y: 9},
    br: {x: 136, y: 118},
    bl: {x: 3, y: 131},
  };
  const h = homographyFromUnitSquare(quad);
  assert.ok(h);
  const points = [
    [0, 0, quad.tl],
    [1, 0, quad.tr],
    [1, 1, quad.br],
    [0, 1, quad.bl],
  ] as const;
  for (const [u, v, expected] of points) {
    const mapped = mapHomography(h, u, v);
    close(mapped.x, expected.x);
    close(mapped.y, expected.y);
  }
});

test('homography keeps rectangle center at rectangle center', () => {
  const quad = {
    tl: {x: 20, y: 40},
    tr: {x: 220, y: 40},
    br: {x: 220, y: 140},
    bl: {x: 20, y: 140},
  };
  const h = homographyFromUnitSquare(quad);
  assert.ok(h);
  const center = mapHomography(h, 0.5, 0.5);
  close(center.x, 120);
  close(center.y, 90);
  close(quadArea(quad), 20000);
});

test('affine triangle transform maps all three source vertices', () => {
  const source = [{x: 10, y: 20}, {x: 90, y: 25}, {x: 15, y: 100}] as const;
  const destination = [{x: 0, y: 0}, {x: 200, y: 0}, {x: 0, y: 160}] as const;
  const transform = affineFromTriangles([...source], [...destination]);
  assert.ok(transform);
  for (let i = 0; i < 3; i += 1) {
    const s = source[i];
    const d = destination[i];
    close(transform.a * s.x + transform.c * s.y + transform.e, d.x);
    close(transform.b * s.x + transform.d * s.y + transform.f, d.y);
  }
});
