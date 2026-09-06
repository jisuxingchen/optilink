import {calibrationPayload, encodeFrameCells, payloadCapacityForMatrix} from './optigrid.ts';

const ALIGNMENT_MATRIX = 64;
const ALIGNMENT_SECONDS = 8;
const RENDER_PIXELS = 960;
const ALIGNMENT_SEQUENCE = 0x0a11;

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

const params = new URLSearchParams(location.search);
const role = params.get('role');

if (role === 'sender') {
  // optigrid-main clears the canvas during module initialization. Draw on the
  // next animation frame so the sender always presents a real alignment target
  // before the receiver starts the timed sweep.
  requestAnimationFrame(() => requestAnimationFrame(drawAlignmentGrid));
}

if (role === 'receiver') {
  const button = document.getElementById('startButton') as HTMLButtonElement | null;
  const video = document.getElementById('camera') as HTMLVideoElement | null;
  const status = document.getElementById('receiverStatus') as HTMLElement | null;
  const roleText = document.getElementById('roleText') as HTMLElement | null;
  if (button && video && navigator.mediaDevices?.getUserMedia) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let previewStream: MediaStream | null = null;
    let allowBenchmarkClick = false;
    let preflightRunning = false;

    // Reuse the preview stream when optigrid-main starts its camera immediately
    // after the countdown. This avoids a second permission prompt / camera jump.
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
          if (roleText) roleText.textContent = '相机已打开。现在移动手机，让电脑上的整个 OptiGrid 方阵尽量贴合中央绿色方框；倒计时结束后测试会自动开始。';
          const started = performance.now();
          const update = () => {
            const remaining = Math.max(0, ALIGNMENT_SECONDS - (performance.now() - started) / 1000);
            button.textContent = `Aligning… ${Math.ceil(remaining)}s`;
            if (status) status.textContent = [
              'ALIGNMENT PREFLIGHT — no benchmark data is being counted yet',
              '把电脑上的整个 OptiGrid 方阵放进绿色正方形取景框。',
              '尽量保持正对、四边平行、方阵边缘接近绿色框。',
              `automatic start in ${remaining.toFixed(1)} s`,
              `camera: ${video.videoWidth || 0}×${video.videoHeight || 0}`,
            ].join('\n');
            if (remaining > 0) requestAnimationFrame(update);
          };
          update();
          await new Promise(resolve => setTimeout(resolve, ALIGNMENT_SECONDS * 1000));
          preflightRunning = false;
          button.style.pointerEvents = '';
          button.textContent = 'Start OptiGrid calibration';
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
