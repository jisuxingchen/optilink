import {calibrationPayload, encodeFrameCells, payloadCapacityForMatrix, reservedCellValue} from './optigrid.ts';

const ALIGNMENT_MATRIX = 64;
const ALIGNMENT_SECONDS = 8;
const RENDER_PIXELS = 960;
const ALIGNMENT_SEQUENCE = 0x0a11;
const SEARCH_WIDTH = 270;

type Roi = {x: number; y: number; size: number; score: number; contrast: number};

let lockedRoi: Roi | null = null;

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
  let blackSum = 0;
  let whiteSum = 0;
  let blackCount = 0;
  let whiteCount = 0;
  const values = new Float32Array(reservedSamples.length);

  for (let i = 0; i < reservedSamples.length; i += 1) {
    const sample = reservedSamples[i];
    const px = Math.max(0, Math.min(image.width - 1, Math.round((x + (sample.column + 0.5) * size / ALIGNMENT_MATRIX) * sx)));
    const py = Math.max(0, Math.min(image.height - 1, Math.round((y + (sample.row + 0.5) * size / ALIGNMENT_MATRIX) * sy)));
    const value = luma(image.data, image.width, px, py);
    values[i] = value;
    if (sample.expected) {
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
  const threshold = (whiteMean + blackMean) / 2;
  let matches = 0;
  for (let i = 0; i < reservedSamples.length; i += 1) {
    const observed = values[i] < threshold ? 1 : 0;
    if (observed === reservedSamples[i].expected) matches += 1;
  }
  const score = matches / reservedSamples.length;
  return {x, y, size, score, contrast};
}

function objective(roi: Roi): number {
  const positiveContrast = Math.max(0, Math.min(100, roi.contrast));
  return roi.score + positiveContrast / 500;
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

  for (let scale = 0.38; scale <= 0.98; scale += 0.06) {
    const size = minDim * scale;
    for (let cx = 0.30; cx <= 0.70; cx += 0.10) {
      for (let cy = 0.20; cy <= 0.80; cy += 0.10) {
        consider(evaluateRoi(image, sourceWidth, sourceHeight, sourceWidth * cx - size / 2, sourceHeight * cy - size / 2, size));
      }
    }
  }

  if (!best) return null;
  const seed = best as Roi;
  const step = minDim * 0.02;
  for (let ds = -4; ds <= 4; ds += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dy = -4; dy <= 4; dy += 1) {
        const size = seed.size + ds * step;
        consider(evaluateRoi(image, sourceWidth, sourceHeight, seed.x + dx * step, seed.y + dy * step, size));
      }
    }
  }
  return best;
}

function installLockedRoiPatch(video: HTMLVideoElement, roi: Roi): void {
  lockedRoi = roi;
  const proto = CanvasRenderingContext2D.prototype as CanvasRenderingContext2D & {__optiGridOriginalDrawImage?: CanvasRenderingContext2D['drawImage']};
  if (proto.__optiGridOriginalDrawImage) return;
  const original = proto.drawImage;
  proto.__optiGridOriginalDrawImage = original;
  (proto as unknown as {drawImage: (...args: unknown[]) => void}).drawImage = function (...args: unknown[]): void {
    const active = lockedRoi;
    if (active && args.length === 9 && args[0] === video) {
      const [, , , , , dx, dy, dw, dh] = args as [CanvasImageSource, number, number, number, number, number, number, number, number];
      (original as unknown as (...values: unknown[]) => void).call(this, video, active.x, active.y, active.size, active.size, dx, dy, dw, dh);
      return;
    }
    (original as unknown as (...values: unknown[]) => void).apply(this, args);
  };
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
          if (roleText) roleText.textContent = '保持整个 OptiGrid 方阵在画面内即可。系统会自动搜索方阵的中心、大小和取样 ROI；8 秒后自动锁定并开始测试。';
          const started = performance.now();
          let lastSearchAt = -Infinity;
          const update = () => {
            const elapsed = (performance.now() - started) / 1000;
            const remaining = Math.max(0, ALIGNMENT_SECONDS - elapsed);
            if (searchContext && performance.now() - lastSearchAt > 1100 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              lastSearchAt = performance.now();
              latestAutoRoi = findBestRoi(video, searchContext, searchCanvas);
            }
            button.textContent = `Auto aligning… ${Math.ceil(remaining)}s`;
            if (status) {
              const roiText = latestAutoRoi
                ? `auto ROI: score ${(latestAutoRoi.score * 100).toFixed(1)}% · contrast ${latestAutoRoi.contrast.toFixed(1)} · size ${Math.round(latestAutoRoi.size)}px`
                : 'auto ROI: searching…';
              status.textContent = [
                'AUTO ROI PREFLIGHT — benchmark data is not being counted yet',
                '只需让完整 OptiGrid 方阵保持在画面内；无需精确贴合绿色框。',
                roiText,
                `automatic lock/start in ${remaining.toFixed(1)} s`,
                `camera: ${video.videoWidth || 0}×${video.videoHeight || 0}`,
              ].join('\n');
            }
            if (remaining > 0) requestAnimationFrame(update);
          };
          update();
          await new Promise(resolve => setTimeout(resolve, ALIGNMENT_SECONDS * 1000));
          if (searchContext) latestAutoRoi = findBestRoi(video, searchContext, searchCanvas) || latestAutoRoi;
          if (latestAutoRoi) installLockedRoiPatch(video, latestAutoRoi);
          preflightRunning = false;
          button.style.pointerEvents = '';
          button.textContent = 'Start OptiGrid calibration';
          if (status && latestAutoRoi) {
            status.textContent = `AUTO ROI LOCKED · score ${(latestAutoRoi.score * 100).toFixed(1)}% · contrast ${latestAutoRoi.contrast.toFixed(1)} · x ${Math.round(latestAutoRoi.x)} · y ${Math.round(latestAutoRoi.y)} · size ${Math.round(latestAutoRoi.size)}px`;
          }
          allowBenchmarkClick = true;
          button.click();
        } catch (error) {
          preflightRunning = false;
          button.style.pointerEvents = '';
          button.textContent = 'Start OptiGrid calibration';
          if (status) status.textContent = `alignment camera error: ${String(error)}`;
        }
      })();
    }, {capture: true});
  }
}
