import {calibrationPayload, encodeFrameCells, payloadCapacityForMatrix, reservedCellValue} from './optigrid.ts';
import {
  affineFromTriangles,
  homographyFromUnitSquare,
  mapHomography,
  quadArea,
  quadInside,
  type Point,
  type Quad,
} from './optigrid-geometry.ts';

const ALIGNMENT_MATRIX = 64;
const ALIGNMENT_SECONDS = 8;
const RENDER_PIXELS = 960;
const ALIGNMENT_SEQUENCE = 0x0a11;
const SEARCH_WIDTH = 270;
const WARP_MESH = 6;

type Roi = {x: number; y: number; size: number; score: number; contrast: number};
type QuadCandidate = {quad: Quad; score: number; contrast: number};

let lockedQuad: Quad | null = null;

function drawAlignmentGrid(): void {
  const canvas = document.getElementById('gridCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) return;
  const payload = calibrationPayload(ALIGNMENT_SEQUENCE, payloadCapacityForMatrix(ALIGNMENT_MATRIX));
  const cells = encodeFrameCells(ALIGNMENT_MATRIX, ALIGNMENT_SEQUENCE, payload);
  const cell = RENDER_PIXELS / ALIGNMENT_MATRIX;
  canvas.width = RENDER_PIXELS;
  canvas.height = RENDER_PIXELS;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, RENDER_PIXELS, RENDER_PIXELS);
  context.fillStyle = '#000000';
  for (let row = 0; row < ALIGNMENT_MATRIX; row += 1) {
    for (let column = 0; column < ALIGNMENT_MATRIX; column += 1) {
      if (!cells[row * ALIGNMENT_MATRIX + column]) continue;
      context.fillRect(column * cell, row * cell, cell, cell);
    }
  }
}

function buildReservedSamples(): Array<{row: number; column: number; expected: number}> {
  const samples: Array<{row: number; column: number; expected: number}> = [];
  for (let row = 0; row < ALIGNMENT_MATRIX; row += 1) {
    for (let column = 0; column < ALIGNMENT_MATRIX; column += 1) {
      const expected = reservedCellValue(row, column, ALIGNMENT_MATRIX);
      if (expected === null) continue;
      const inPilot = (row < 4 || row >= ALIGNMENT_MATRIX - 4) && (column < 4 || column >= ALIGNMENT_MATRIX - 4);
      if (inPilot || (row + column) % 3 === 0) samples.push({row, column, expected});
    }
  }
  return samples;
}

const reservedSamples = buildReservedSamples();

function luma(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const index = (y * width + x) * 4;
  return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
}

function candidateScore(values: Float32Array): {score: number; contrast: number} | null {
  let blackSum = 0;
  let whiteSum = 0;
  let blackCount = 0;
  let whiteCount = 0;
  for (let i = 0; i < reservedSamples.length; i += 1) {
    if (reservedSamples[i].expected) {
      blackSum += values[i];
      blackCount += 1;
    } else {
      whiteSum += values[i];
      whiteCount += 1;
    }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  const threshold = (whiteMean + blackMean) / 2;
  let matches = 0;
  for (let i = 0; i < reservedSamples.length; i += 1) {
    const observed = values[i] < threshold ? 1 : 0;
    if (observed === reservedSamples[i].expected) matches += 1;
  }
  return {score: matches / reservedSamples.length, contrast};
}

function evaluateRoi(
  image: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  size: number,
): Roi | null {
  if (size <= 0 || x < 0 || y < 0 || x + size > sourceWidth || y + size > sourceHeight) return null;
  const sx = image.width / sourceWidth;
  const sy = image.height / sourceHeight;
  const values = new Float32Array(reservedSamples.length);
  for (let i = 0; i < reservedSamples.length; i += 1) {
    const sample = reservedSamples[i];
    const px = Math.max(0, Math.min(image.width - 1, Math.round((x + (sample.column + 0.5) * size / ALIGNMENT_MATRIX) * sx)));
    const py = Math.max(0, Math.min(image.height - 1, Math.round((y + (sample.row + 0.5) * size / ALIGNMENT_MATRIX) * sy)));
    values[i] = luma(image.data, image.width, px, py);
  }
  const measured = candidateScore(values);
  return measured ? {x, y, size, ...measured} : null;
}

function evaluateQuad(
  image: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  quad: Quad,
): QuadCandidate | null {
  if (!quadInside(quad, sourceWidth, sourceHeight, Math.min(sourceWidth, sourceHeight) ** 2 * 0.04)) return null;
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const sx = image.width / sourceWidth;
  const sy = image.height / sourceHeight;
  const values = new Float32Array(reservedSamples.length);
  for (let i = 0; i < reservedSamples.length; i += 1) {
    const sample = reservedSamples[i];
    const source = mapHomography(h, (sample.column + 0.5) / ALIGNMENT_MATRIX, (sample.row + 0.5) / ALIGNMENT_MATRIX);
    const px = Math.max(0, Math.min(image.width - 1, Math.round(source.x * sx)));
    const py = Math.max(0, Math.min(image.height - 1, Math.round(source.y * sy)));
    values[i] = luma(image.data, image.width, px, py);
  }
  const measured = candidateScore(values);
  return measured ? {quad, ...measured} : null;
}

function objective(candidate: {score: number; contrast: number}): number {
  const positiveContrast = Math.max(0, Math.min(120, candidate.contrast));
  return candidate.score + positiveContrast / 700;
}

function findBestRoi(video: HTMLVideoElement, context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): Roi | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  canvas.width = SEARCH_WIDTH;
  canvas.height = Math.max(1, Math.round(SEARCH_WIDTH * sourceHeight / sourceWidth));
  context.imageSmoothingEnabled = true;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const minDim = Math.min(sourceWidth, sourceHeight);
  let best: Roi | null = null;

  const consider = (candidate: Roi | null) => {
    if (!candidate) return;
    if (!best || objective(candidate) > objective(best)) best = candidate;
  };

  for (let scale = 0.34; scale <= 0.98; scale += 0.05) {
    const size = minDim * scale;
    for (let cx = 0.20; cx <= 0.80; cx += 0.08) {
      for (let cy = 0.14; cy <= 0.86; cy += 0.08) {
        consider(evaluateRoi(image, sourceWidth, sourceHeight, sourceWidth * cx - size / 2, sourceHeight * cy - size / 2, size));
      }
    }
  }

  if (!best) return null;
  const seed = best as Roi;
  const step = minDim * 0.015;
  for (let ds = -5; ds <= 5; ds += 1) {
    for (let dx = -5; dx <= 5; dx += 1) {
      for (let dy = -5; dy <= 5; dy += 1) {
        const size = seed.size + ds * step;
        consider(evaluateRoi(image, sourceWidth, sourceHeight, seed.x + dx * step, seed.y + dy * step, size));
      }
    }
  }
  return best;
}

function makeSeedQuad(roi: Roi, angleDegrees: number, topScale: number, bottomScale: number, shear: number): Quad {
  const cx = roi.x + roi.size / 2;
  const cy = roi.y + roi.size / 2;
  const angle = angleDegrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const point = (localX: number, localY: number): Point => ({
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  });
  const half = roi.size / 2;
  const topShift = shear * roi.size;
  const bottomShift = -shear * roi.size;
  return {
    tl: point(-half * topScale + topShift, -half),
    tr: point(half * topScale + topShift, -half),
    br: point(half * bottomScale + bottomShift, half),
    bl: point(-half * bottomScale + bottomShift, half),
  };
}

function cloneQuad(quad: Quad): Quad {
  return {
    tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl},
  };
}

function refineQuad(
  image: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  initial: QuadCandidate,
  seedSize: number,
): QuadCandidate {
  let best = initial;
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  for (const scale of [0.045, 0.022, 0.011, 0.005]) {
    const step = seedSize * scale;
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) {
        for (const axis of ['x', 'y'] as const) {
          for (const direction of [-1, 1]) {
            const quad = cloneQuad(best.quad);
            quad[corner][axis] += step * direction;
            const candidate = evaluateQuad(image, sourceWidth, sourceHeight, quad);
            if (candidate && objective(candidate) > objective(best)) {
              best = candidate;
              improved = true;
            }
          }
        }
      }
      if (!improved) break;
    }
  }
  return best;
}

function findBestQuad(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  roi: Roi,
): QuadCandidate | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  canvas.width = SEARCH_WIDTH;
  canvas.height = Math.max(1, Math.round(SEARCH_WIDTH * sourceHeight / sourceWidth));
  context.imageSmoothingEnabled = true;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let best: QuadCandidate | null = null;

  const consider = (quad: Quad) => {
    const candidate = evaluateQuad(image, sourceWidth, sourceHeight, quad);
    if (candidate && (!best || objective(candidate) > objective(best))) best = candidate;
  };

  for (const angle of [-14, -9, -4, 0, 4, 9, 14]) {
    for (const topScale of [0.82, 0.94, 1.06, 1.18]) {
      for (const bottomScale of [0.82, 0.94, 1.06, 1.18]) {
        for (const shear of [-0.10, -0.04, 0, 0.04, 0.10]) {
          consider(makeSeedQuad(roi, angle, topScale, bottomScale, shear));
        }
      }
    }
  }

  if (!best) return null;
  return refineQuad(image, sourceWidth, sourceHeight, best, roi.size);
}

function drawTriangle(
  context: CanvasRenderingContext2D,
  original: CanvasRenderingContext2D['drawImage'],
  video: HTMLVideoElement,
  source: [Point, Point, Point],
  destination: [Point, Point, Point],
): void {
  const affine = affineFromTriangles(source, destination);
  if (!affine) return;
  context.save();
  context.beginPath();
  context.moveTo(destination[0].x, destination[0].y);
  context.lineTo(destination[1].x, destination[1].y);
  context.lineTo(destination[2].x, destination[2].y);
  context.closePath();
  context.clip();
  context.setTransform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
  (original as unknown as (source: CanvasImageSource, dx: number, dy: number) => void).call(context, video, 0, 0);
  context.restore();
}

function installLockedQuadPatch(video: HTMLVideoElement, quad: Quad): void {
  lockedQuad = quad;
  const proto = CanvasRenderingContext2D.prototype as CanvasRenderingContext2D & {__optiGridOriginalDrawImage?: CanvasRenderingContext2D['drawImage']};
  if (proto.__optiGridOriginalDrawImage) return;
  const original = proto.drawImage;
  proto.__optiGridOriginalDrawImage = original;
  (proto as unknown as {drawImage: (this: CanvasRenderingContext2D, ...args: unknown[]) => void}).drawImage = function (...args: unknown[]): void {
    const active = lockedQuad;
    if (active && args.length === 9 && args[0] === video) {
      const [, , , , , dxRaw, dyRaw, dwRaw, dhRaw] = args;
      const dx = Number(dxRaw);
      const dy = Number(dyRaw);
      const dw = Number(dwRaw);
      const dh = Number(dhRaw);
      const h = homographyFromUnitSquare(active);
      if (!h) {
        (original as unknown as (...values: unknown[]) => void).apply(this, args);
        return;
      }
      this.save();
      this.setTransform(1, 0, 0, 1, 0, 0);
      this.fillStyle = '#ffffff';
      this.fillRect(dx, dy, dw, dh);
      this.imageSmoothingEnabled = true;
      this.restore();

      for (let row = 0; row < WARP_MESH; row += 1) {
        for (let column = 0; column < WARP_MESH; column += 1) {
          const u0 = column / WARP_MESH;
          const u1 = (column + 1) / WARP_MESH;
          const v0 = row / WARP_MESH;
          const v1 = (row + 1) / WARP_MESH;
          const s00 = mapHomography(h, u0, v0);
          const s10 = mapHomography(h, u1, v0);
          const s11 = mapHomography(h, u1, v1);
          const s01 = mapHomography(h, u0, v1);
          const d00 = {x: dx + u0 * dw, y: dy + v0 * dh};
          const d10 = {x: dx + u1 * dw, y: dy + v0 * dh};
          const d11 = {x: dx + u1 * dw, y: dy + v1 * dh};
          const d01 = {x: dx + u0 * dw, y: dy + v1 * dh};
          drawTriangle(this, original, video, [s00, s10, s11], [d00, d10, d11]);
          drawTriangle(this, original, video, [s00, s11, s01], [d00, d11, d01]);
        }
      }
      return;
    }
    (original as unknown as (...values: unknown[]) => void).apply(this, args);
  };
}

function quadText(candidate: QuadCandidate): string {
  const q = candidate.quad;
  return [
    `projective score ${(candidate.score * 100).toFixed(1)}% · contrast ${candidate.contrast.toFixed(1)} · area ${Math.round(quadArea(q))} px²`,
    `TL ${Math.round(q.tl.x)},${Math.round(q.tl.y)} · TR ${Math.round(q.tr.x)},${Math.round(q.tr.y)}`,
    `BL ${Math.round(q.bl.x)},${Math.round(q.bl.y)} · BR ${Math.round(q.br.x)},${Math.round(q.br.y)}`,
  ].join('\n');
}

const params = new URLSearchParams(location.search);
const role = params.get('role');

if (role === 'sender') {
  requestAnimationFrame(() => requestAnimationFrame(drawAlignmentGrid));
}

if (role === 'receiver') {
  const button = document.getElementById('startButton') as HTMLButtonElement | null;
  const video = document.getElementById('camera') as HTMLVideoElement | null;
  const status = document.getElementById('receiverStatus') as HTMLElement | null;
  const roleText = document.getElementById('roleText') as HTMLElement | null;
  if (button && video && navigator.mediaDevices?.getUserMedia) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const searchCanvas = document.createElement('canvas');
    const searchContext = searchCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
    let previewStream: MediaStream | null = null;
    let allowBenchmarkClick = false;
    let preflightRunning = false;
    let latestAutoRoi: Roi | null = null;

    (navigator.mediaDevices as MediaDevices & {getUserMedia: typeof navigator.mediaDevices.getUserMedia}).getUserMedia = async constraints => {
      if (previewStream && previewStream.getVideoTracks().some(track => track.readyState === 'live')) return previewStream;
      return originalGetUserMedia(constraints);
    };

    button.addEventListener('click', event => {
      if (allowBenchmarkClick) {
        allowBenchmarkClick = false;
        return;
      }
      if (preflightRunning) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      preflightRunning = true;
      button.style.pointerEvents = 'none';
      void (async () => {
        try {
          previewStream = await originalGetUserMedia({
            audio: false,
            video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}},
          });
          video.srcObject = previewStream;
          await video.play();
          if (roleText) roleText.textContent = '保持整个 OptiGrid 方阵在画面内并尽量正对即可。系统先找粗 ROI，再自动优化四个角点并做透视校正；无需贴合绿色框。';
          const started = performance.now();
          let lastSearchAt = -Infinity;
          const update = () => {
            const remaining = Math.max(0, ALIGNMENT_SECONDS - (performance.now() - started) / 1000);
            if (searchContext && performance.now() - lastSearchAt > 1000 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              lastSearchAt = performance.now();
              latestAutoRoi = findBestRoi(video, searchContext, searchCanvas);
            }
            button.textContent = `Projective aligning… ${Math.ceil(remaining)}s`;
            if (status) {
              const roiText = latestAutoRoi
                ? `coarse ROI: score ${(latestAutoRoi.score * 100).toFixed(1)}% · contrast ${latestAutoRoi.contrast.toFixed(1)} · size ${Math.round(latestAutoRoi.size)}px`
                : 'coarse ROI: searching…';
              status.textContent = [
                'PROJECTIVE PREFLIGHT — benchmark data is not being counted yet',
                '只需让完整 OptiGrid 方阵保持在画面内；系统会自动求四角和透视变换。',
                roiText,
                `projective lock/start in ${remaining.toFixed(1)} s`,
                `camera: ${video.videoWidth || 0}×${video.videoHeight || 0}`,
              ].join('\n');
            }
            if (remaining > 0) requestAnimationFrame(update);
          };
          update();
          await new Promise(resolve => setTimeout(resolve, ALIGNMENT_SECONDS * 1000));
          if (searchContext) latestAutoRoi = findBestRoi(video, searchContext, searchCanvas) || latestAutoRoi;
          const projective = searchContext && latestAutoRoi
            ? findBestQuad(video, searchContext, searchCanvas, latestAutoRoi)
            : null;
          if (projective) installLockedQuadPatch(video, projective.quad);
          preflightRunning = false;
          button.style.pointerEvents = '';
          button.textContent = 'Start OptiGrid calibration';
          if (status) {
            status.textContent = projective
              ? `PROJECTIVE QUAD LOCKED\n${quadText(projective)}\nmesh warp ${WARP_MESH}×${WARP_MESH}`
              : 'PROJECTIVE LOCK FAILED · benchmark will fall back to the original central ROI';
          }
          allowBenchmarkClick = true;
          button.click();
        } catch (error) {
          preflightRunning = false;
          button.style.pointerEvents = '';
          button.textContent = 'Start OptiGrid calibration';
          if (status) status.textContent = `projective alignment camera error: ${String(error)}`;
        }
      })();
    }, {capture: true});
  }
}
