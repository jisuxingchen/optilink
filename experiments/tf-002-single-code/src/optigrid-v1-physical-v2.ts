import {
  decodeFrameCellsV1,
  encodeFrameCellsV1,
  payloadCapacityForMatrixV1,
  reservedCellValueV1,
} from './optigrid-v1.ts';
import {homographyFromUnitSquare, mapHomography, quadInside, type Quad} from './optigrid-geometry.ts';

const PHYSICAL_HZ = 60;
const RENDER_PIXELS = 960;
const CAMERA_WORK_PIXELS = 960;
const PREALIGN_MS = 6000;
const WARMUP_MS = 1500;
const MEASURE_MS = 7000;
const MIN_LOCK_SCORE = 0.76;
const MIN_TRACK_SCORE = 0.72;
const MIN_CONTRAST = 16;
const SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-0.18, 0], [0.18, 0], [0, -0.18], [0, 0.18],
];
const SWEEP = [
  {matrixSize: 120, targetHz: 20},
  {matrixSize: 120, targetHz: 30},
  {matrixSize: 160, targetHz: 20},
  {matrixSize: 160, targetHz: 30},
  {matrixSize: 240, targetHz: 20},
  {matrixSize: 240, targetHz: 30},
] as const;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const roleValue = new URLSearchParams(location.search).get('role');
const role: 'sender' | 'receiver' | 'both' = roleValue === 'sender' || roleValue === 'receiver' ? roleValue : 'both';
const roleTitle = $<HTMLElement>('roleTitle');
const roleText = $<HTMLElement>('roleText');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
const labStatus = $<HTMLPreElement>('labStatus');
const senderStatus = $<HTMLPreElement>('senderStatus');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const video = $<HTMLVideoElement>('camera');
const gridCanvas = $<HTMLCanvasElement>('gridCanvas');

gridCanvas.width = RENDER_PIXELS;
gridCanvas.height = RENDER_PIXELS;
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = CAMERA_WORK_PIXELS;
sampleCanvas.height = CAMERA_WORK_PIXELS;
const sampleContextMaybe = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContextMaybe) throw new Error('Canvas 2D context unavailable');
const sampleContext: CanvasRenderingContext2D = sampleContextMaybe;

type CandidateConfig = {id: string; matrixSize: number; payloadBytes: number; durationMs: number; targetHz: number};
type GeometryLock = {quad: Quad; threshold: number; score: number; contrast: number};
type CandidateMetrics = {
  id: string;
  matrixSize: number;
  targetHz: number;
  payloadBytesPerFrame: number;
  attempts: number;
  validFrames: number;
  uniqueFrames: number;
  duplicateFrames: number;
  acquisitionRejects: number;
  crcOrHeaderRejects: number;
  payloadMismatchRejects: number;
  acquisitionCount: number;
  reacquisitionCount: number;
  trackedFrames: number;
  elapsedSeconds: number;
  validRatio: number;
  uniqueFramesPerSecond: number;
  uniquePayloadBytesPerSecond: number;
  acquisitionP95Ms: number;
  trackingValidationP95Ms: number;
  fastDecodeP95Ms: number;
  totalDecodeP95Ms: number;
  averageReservedScore: number;
  averageContrast: number;
  currentLock: GeometryLock | null;
};
type ReceiverMetadata = ReturnType<typeof captureReceiverMetadata>;
type Telemetry = {transport: 'optigrid-v1-physical-v2'; metrics: CandidateMetrics | null; timestamp: number};
type Pending = {timer: number; resolve: (value?: CandidateMetrics) => void; reject: (error: Error) => void};

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let activeCandidate: CandidateConfig | null = null;
let candidateStartedAt = 0;
let geometryLock: GeometryLock | null = null;
let scanning = false;
let aborted = false;
let senderRunning = false;
let senderSequence = 1;
let latestReceiverMetadata: ReceiverMetadata | null = null;
let latestTelemetry: Telemetry = {transport: 'optigrid-v1-physical-v2', metrics: null, timestamp: performance.now()};
let pendingConfig: {id: string; pending: Pending} | null = null;
let pendingMeasure: {id: string; pending: Pending} | null = null;
let pendingResult: {id: string; pending: Pending} | null = null;

let attempts = 0;
let validFrames = 0;
let duplicateFrames = 0;
let acquisitionRejects = 0;
let crcOrHeaderRejects = 0;
let payloadMismatchRejects = 0;
let acquisitionCount = 0;
let reacquisitionCount = 0;
let trackedFrames = 0;
let scoreSum = 0;
let contrastSum = 0;
let validationCount = 0;
let sequences = new Set<number>();
let acquisitionTimes: number[] = [];
let trackingTimes: number[] = [];
let fastDecodeTimes: number[] = [];
let totalDecodeTimes: number[] = [];
let lastTelemetryAt = 0;

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
function deterministicPayload(sequence: number, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x46524f4e) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 29 + (sequence & 0xff)) & 0xff;
  }
  return output;
}
function formatRate(value: number): string { return `${(value / 1000).toFixed(1)} KB/s`; }
function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 24000);
}
function send(message: unknown): void { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

function captureReceiverMetadata() {
  const track = cameraStream?.getVideoTracks()[0];
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    cameraSettings: track?.getSettings?.() || null,
    source: 'tf006-optigrid-v1-receiver-page-v2' as const,
    capturedAt: new Date().toISOString(),
  };
}
function captureSenderMetadata() {
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    renderPixels: RENDER_PIXELS,
    capturedAt: new Date().toISOString(),
  };
}

function luma(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}
function sampleLumaBilinear(image: ImageData, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x));
  const py = Math.max(0, Math.min(image.height - 1, y));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const tx = px - x0, ty = py - y0, stride = image.width * 4;
  const o00 = y0 * stride + x0 * 4, o10 = y0 * stride + x1 * 4;
  const o01 = y1 * stride + x0 * 4, o11 = y1 * stride + x1 * 4;
  const top = luma(image.data, o00) * (1 - tx) + luma(image.data, o10) * tx;
  const bottom = luma(image.data, o01) * (1 - tx) + luma(image.data, o11) * tx;
  return top * (1 - ty) + bottom * ty;
}
function captureCameraSquare(): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  const side = Math.min(video.videoWidth, video.videoHeight);
  const sx = (video.videoWidth - side) / 2;
  const sy = (video.videoHeight - side) / 2;
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.drawImage(video, sx, sy, side, side, 0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
  return sampleContext.getImageData(0, 0, CAMERA_WORK_PIXELS, CAMERA_WORK_PIXELS);
}

const reservedCache = new Map<number, Array<{row: number; column: number; expected: number}>>();
function sparseReservedSamples(matrixSize: number): Array<{row: number; column: number; expected: number}> {
  const cached = reservedCache.get(matrixSize);
  if (cached) return cached;
  const samples: Array<{row: number; column: number; expected: number}> = [];
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    const expected = reservedCellValueV1(row, column, matrixSize);
    if (expected === null) continue;
    const finder = (row < 10 || row >= matrixSize - 10) && (column < 10 || column >= matrixSize - 10);
    if (finder || ((row + column) & 3) === 0) samples.push({row, column, expected});
  }
  reservedCache.set(matrixSize, samples);
  return samples;
}
function objective(lock: GeometryLock): number {
  return lock.score * 1000 + Math.max(0, Math.min(lock.contrast, 120));
}
function evaluateQuad(image: ImageData, matrixSize: number, quad: Quad): GeometryLock | null {
  if (!quadInside(quad, image.width, image.height, image.width * image.height * 0.08)) return null;
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const samples = sparseReservedSamples(matrixSize);
  let blackSum = 0, blackCount = 0, whiteSum = 0, whiteCount = 0;
  for (const sample of samples) {
    const point = mapHomography(h, (sample.column + 0.5) / matrixSize, (sample.row + 0.5) / matrixSize);
    const value = sampleLumaBilinear(image, point.x, point.y);
    if (sample.expected) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const blackMean = blackSum / blackCount;
  const whiteMean = whiteSum / whiteCount;
  const contrast = whiteMean - blackMean;
  if (contrast <= 0) return null;
  const threshold = (blackMean + whiteMean) / 2;
  let matches = 0;
  for (const sample of samples) {
    const point = mapHomography(h, (sample.column + 0.5) / matrixSize, (sample.row + 0.5) / matrixSize);
    const observed = sampleLumaBilinear(image, point.x, point.y) < threshold ? 1 : 0;
    if (observed === sample.expected) matches += 1;
  }
  return {quad, threshold, score: matches / samples.length, contrast};
}
function axisQuad(size: number, scale: number, offsetX: number, offsetY: number): Quad {
  const side = size * scale;
  const left = (size - side) / 2 + size * offsetX;
  const top = (size - side) / 2 + size * offsetY;
  return {tl: {x: left, y: top}, tr: {x: left + side, y: top}, br: {x: left + side, y: top + side}, bl: {x: left, y: top + side}};
}
function cloneQuad(quad: Quad): Quad {
  return {tl: {...quad.tl}, tr: {...quad.tr}, br: {...quad.br}, bl: {...quad.bl}};
}
function refineQuad(image: ImageData, matrixSize: number, initial: GeometryLock): GeometryLock {
  let best = initial;
  const corners: Array<keyof Quad> = ['tl', 'tr', 'br', 'bl'];
  for (const step of [14, 7, 3.5, 1.75, 0.75]) {
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
      for (const corner of corners) for (const axis of ['x', 'y'] as const) for (const direction of [-1, 1]) {
        const quad = cloneQuad(best.quad);
        quad[corner][axis] += step * direction;
        const candidate = evaluateQuad(image, matrixSize, quad);
        if (candidate && objective(candidate) > objective(best) + 0.05) {
          best = candidate;
          improved = true;
        }
      }
      if (!improved) break;
    }
  }
  return best;
}
function acquireGeometry(image: ImageData, matrixSize: number): GeometryLock | null {
  let best: GeometryLock | null = null;
  for (const scale of [0.72, 0.78, 0.84, 0.88, 0.92, 0.96]) for (const offsetX of [-0.06, -0.03, 0, 0.03, 0.06]) for (const offsetY of [-0.06, -0.03, 0, 0.03, 0.06]) {
    const candidate = evaluateQuad(image, matrixSize, axisQuad(image.width, scale, offsetX, offsetY));
    if (candidate && (!best || objective(candidate) > objective(best))) best = candidate;
  }
  if (!best) return null;
  best = refineQuad(image, matrixSize, best);
  if (best.score < MIN_LOCK_SCORE || best.contrast < MIN_CONTRAST) return null;
  return best;
}
function validateGeometry(image: ImageData, matrixSize: number, lock: GeometryLock): GeometryLock | null {
  const current = evaluateQuad(image, matrixSize, lock.quad);
  if (!current || current.score < MIN_TRACK_SCORE || current.contrast < MIN_CONTRAST) return null;
  return current;
}
function decodeWithGeometry(image: ImageData, matrixSize: number, lock: GeometryLock): ReturnType<typeof decodeFrameCellsV1> {
  const h = homographyFromUnitSquare(lock.quad);
  if (!h) return null;
  const cells = new Uint8Array(matrixSize * matrixSize);
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) {
    let blackVotes = 0;
    for (const [dx, dy] of SAMPLE_OFFSETS) {
      const point = mapHomography(h, (column + 0.5 + dx) / matrixSize, (row + 0.5 + dy) / matrixSize);
      if (sampleLumaBilinear(image, point.x, point.y) < lock.threshold) blackVotes += 1;
    }
    cells[row * matrixSize + column] = blackVotes >= 3 ? 1 : 0;
  }
  return decodeFrameCellsV1(cells, matrixSize);
}

function clearMeasurements(preserveGeometry: boolean): void {
  attempts = validFrames = duplicateFrames = acquisitionRejects = crcOrHeaderRejects = payloadMismatchRejects = 0;
  acquisitionCount = reacquisitionCount = trackedFrames = 0;
  scoreSum = contrastSum = validationCount = 0;
  sequences = new Set<number>();
  acquisitionTimes = []; trackingTimes = []; fastDecodeTimes = []; totalDecodeTimes = [];
  candidateStartedAt = performance.now();
  if (!preserveGeometry) geometryLock = null;
}
function setCandidate(config: CandidateConfig | null): void {
  activeCandidate = config;
  clearMeasurements(true);
  publishTelemetry(true);
}
function currentMetrics(): CandidateMetrics | null {
  const config = activeCandidate;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - candidateStartedAt) / 1000);
  return {
    id: config.id, matrixSize: config.matrixSize, targetHz: config.targetHz, payloadBytesPerFrame: config.payloadBytes,
    attempts, validFrames, uniqueFrames: sequences.size, duplicateFrames, acquisitionRejects, crcOrHeaderRejects, payloadMismatchRejects,
    acquisitionCount, reacquisitionCount, trackedFrames, elapsedSeconds,
    validRatio: attempts ? validFrames / attempts : 0,
    uniqueFramesPerSecond: sequences.size / elapsedSeconds,
    uniquePayloadBytesPerSecond: sequences.size * config.payloadBytes / elapsedSeconds,
    acquisitionP95Ms: percentile(acquisitionTimes, 0.95), trackingValidationP95Ms: percentile(trackingTimes, 0.95),
    fastDecodeP95Ms: percentile(fastDecodeTimes, 0.95), totalDecodeP95Ms: percentile(totalDecodeTimes, 0.95),
    averageReservedScore: validationCount ? scoreSum / validationCount : 0,
    averageContrast: validationCount ? contrastSum / validationCount : 0,
    currentLock: geometryLock,
  };
}
function publishTelemetry(force = false): void {
  const metrics = currentMetrics();
  latestTelemetry = {transport: 'optigrid-v1-physical-v2', metrics, timestamp: performance.now()};
  if (metrics) receiverStatus.textContent = [
    `candidate: ${metrics.matrixSize}×${metrics.matrixSize} @ ${metrics.targetHz} Hz · ${metrics.payloadBytesPerFrame} B/frame`,
    `unique: ${metrics.uniqueFrames} · ${metrics.uniqueFramesPerSecond.toFixed(2)}/s · raw ingress ${formatRate(metrics.uniquePayloadBytesPerSecond)}`,
    `valid: ${metrics.validFrames}/${metrics.attempts} (${(metrics.validRatio * 100).toFixed(1)}%) · duplicates ${metrics.duplicateFrames}`,
    `rejects: acquisition ${metrics.acquisitionRejects} · CRC/header ${metrics.crcOrHeaderRejects} · payload ${metrics.payloadMismatchRejects}`,
    `lock: acquisitions ${metrics.acquisitionCount} · reacq ${metrics.reacquisitionCount} · tracked ${metrics.trackedFrames}`,
    `p95: acquire ${metrics.acquisitionP95Ms.toFixed(1)} ms · track ${metrics.trackingValidationP95Ms.toFixed(1)} ms · fast ${metrics.fastDecodeP95Ms.toFixed(1)} ms · total ${metrics.totalDecodeP95Ms.toFixed(1)} ms`,
    `pilot ${(metrics.averageReservedScore * 100).toFixed(1)}% · contrast ${metrics.averageContrast.toFixed(1)}`,
  ].join('\n');
  const now = performance.now();
  if (force || now - lastTelemetryAt > 350) { lastTelemetryAt = now; send({type: 'telemetry', telemetry: latestTelemetry}); }
}

async function scanCurrentCameraFrame(): Promise<void> {
  const config = activeCandidate;
  if (!scanning || !config) return;
  const totalStarted = performance.now();
  const image = captureCameraSquare();
  if (!image) return;
  attempts += 1;
  const hadLock = Boolean(geometryLock);
  let validation: GeometryLock | null = null;
  if (geometryLock) {
    const started = performance.now();
    validation = validateGeometry(image, config.matrixSize, geometryLock);
    trackingTimes.push(performance.now() - started);
  }
  if (!validation) {
    const started = performance.now();
    const acquired = acquireGeometry(image, config.matrixSize);
    acquisitionTimes.push(performance.now() - started);
    if (!acquired) {
      geometryLock = null;
      acquisitionRejects += 1;
      totalDecodeTimes.push(performance.now() - totalStarted);
      publishTelemetry();
      return;
    }
    geometryLock = acquired;
    acquisitionCount += 1;
    if (hadLock) reacquisitionCount += 1;
    validation = acquired;
  } else {
    geometryLock = validation;
    trackedFrames += 1;
  }
  scoreSum += validation.score; contrastSum += validation.contrast; validationCount += 1;
  const fastStarted = performance.now();
  const decoded = decodeWithGeometry(image, config.matrixSize, validation);
  fastDecodeTimes.push(performance.now() - fastStarted);
  if (!decoded) crcOrHeaderRejects += 1;
  else if (!sameBytes(decoded.payload, deterministicPayload(decoded.sequence, decoded.payload.length))) payloadMismatchRejects += 1;
  else {
    validFrames += 1;
    if (sequences.has(decoded.sequence)) duplicateFrames += 1; else sequences.add(decoded.sequence);
  }
  totalDecodeTimes.push(performance.now() - totalStarted);
  publishTelemetry();
}
function scheduleCameraLoop(): void {
  if (!scanning) return;
  const withCallback = video as HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number};
  if (typeof withCallback.requestVideoFrameCallback === 'function') withCallback.requestVideoFrameCallback(() => { void scanCurrentCameraFrame().finally(scheduleCameraLoop); });
  else requestAnimationFrame(() => { void scanCurrentCameraFrame().finally(scheduleCameraLoop); });
}
async function startCamera(): Promise<void> {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}}});
  video.srcObject = cameraStream;
  await video.play();
  scanning = true;
  scheduleCameraLoop();
}
function stopCamera(): void {
  scanning = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}

function drawGrid(cells: Uint8Array, matrixSize: number): void {
  const context = gridCanvas.getContext('2d', {alpha: false});
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#fff'; context.fillRect(0, 0, RENDER_PIXELS, RENDER_PIXELS);
  context.fillStyle = '#000';
  const cell = RENDER_PIXELS / matrixSize;
  for (let row = 0; row < matrixSize; row += 1) for (let column = 0; column < matrixSize; column += 1) if (cells[row * matrixSize + column]) context.fillRect(column * cell, row * cell, cell, cell);
}
function drawStatic(matrixSize: number, sequence = 0): void {
  const payloadBytes = payloadCapacityForMatrixV1(matrixSize);
  drawGrid(encodeFrameCellsV1(matrixSize, sequence, deterministicPayload(sequence, payloadBytes)), matrixSize);
}
function makePending(timeoutMessage: string): Pending {
  let resolveFn: (value?: CandidateMetrics) => void = () => undefined;
  let rejectFn: (error: Error) => void = () => undefined;
  const timer = window.setTimeout(() => rejectFn(new Error(timeoutMessage)), 8000);
  const promise = new Promise<CandidateMetrics | undefined>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  (promise as Promise<CandidateMetrics | undefined> & {pending?: Pending}).pending = {timer, resolve: resolveFn, reject: rejectFn};
  return (promise as Promise<CandidateMetrics | undefined> & {pending: Pending}).pending;
}
function waitFor(kind: 'config' | 'measure' | 'result', id: string): Promise<CandidateMetrics | undefined> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`TF-006 ${kind} acknowledgement timed out`)), 8000);
    const pending: Pending = {timer, resolve, reject};
    if (kind === 'config') pendingConfig = {id, pending};
    else if (kind === 'measure') pendingMeasure = {id, pending};
    else pendingResult = {id, pending};
  });
}
async function configureReceiver(config: CandidateConfig): Promise<void> {
  const ack = waitFor('config', config.id);
  send({type: 'command', action: 'tf006-config', config});
  await ack;
}
async function startMeasurement(config: CandidateConfig): Promise<void> {
  const ack = waitFor('measure', config.id);
  send({type: 'command', action: 'tf006-measurement-start', candidateId: config.id});
  await ack;
}
async function collectResult(config: CandidateConfig): Promise<CandidateMetrics> {
  const ack = waitFor('result', config.id);
  send({type: 'command', action: 'tf006-candidate-finish', candidateId: config.id});
  const value = await ack;
  if (!value) throw new Error('TF-006 receiver metrics missing');
  return value;
}
async function renderCandidate(config: CandidateConfig): Promise<{renderedFrames: number; actualHz: number}> {
  drawStatic(config.matrixSize, 0);
  await configureReceiver(config);
  await sleep(WARMUP_MS);
  await startMeasurement(config);
  senderRunning = true;
  let renderedFrames = 0;
  const started = performance.now();
  let nextChange = started;
  await new Promise<void>(resolve => {
    const tick = () => {
      if (!senderRunning || aborted || performance.now() - started >= config.durationMs) { resolve(); return; }
      const now = performance.now();
      if (now + 0.2 >= nextChange) {
        const sequence = senderSequence++ >>> 0;
        drawGrid(encodeFrameCellsV1(config.matrixSize, sequence, deterministicPayload(sequence, config.payloadBytes)), config.matrixSize);
        renderedFrames += 1;
        nextChange += 1000 / config.targetHz;
        if (nextChange < now - 100) nextChange = now + 1000 / config.targetHz;
      }
      const elapsed = Math.max(0.001, (now - started) / 1000);
      senderStatus.textContent = [
        `TF-006 v2 · projective · ${config.matrixSize}×${config.matrixSize} @ ${config.targetHz} Hz`,
        `payload ${config.payloadBytes} B/frame · physical display ${PHYSICAL_HZ} Hz`,
        `actual code changes ${(renderedFrames / elapsed).toFixed(2)}/s · gross ${formatRate(config.payloadBytes * config.targetHz)}`,
        `receiver raw ingress ${formatRate(latestTelemetry.metrics?.uniquePayloadBytesPerSecond || 0)}`,
      ].join('\n');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  senderRunning = false;
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return {renderedFrames, actualHz: renderedFrames / elapsed};
}

async function runPhysicalGate(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  const senderMetadata = captureSenderMetadata();
  const results: Array<CandidateMetrics & {renderedFrames: number; senderActualHz: number; grossTargetBytesPerSecond: number; selectionScore: number}> = [];
  try {
    log('TF-006 v2 started: projective geometry + temporal sweep. Payload remains optical.');
    await sleep(PREALIGN_MS);
    for (const spec of SWEEP) {
      if (aborted) break;
      const payloadBytes = payloadCapacityForMatrixV1(spec.matrixSize);
      const config: CandidateConfig = {id: `tf006v2-${spec.matrixSize}-${spec.targetHz}-${Date.now().toString(36)}`, matrixSize: spec.matrixSize, payloadBytes, durationMs: MEASURE_MS, targetHz: spec.targetHz};
      log(`testing ${spec.matrixSize}×${spec.matrixSize} @ ${spec.targetHz} Hz · gross ${formatRate(payloadBytes * spec.targetHz)}`);
      const sender = await renderCandidate(config);
      const receiver = await collectResult(config);
      const stability = Math.min(1, receiver.validRatio / 0.70);
      const selectionScore = receiver.uniquePayloadBytesPerSecond * stability;
      results.push({...receiver, renderedFrames: sender.renderedFrames, senderActualHz: sender.actualHz, grossTargetBytesPerSecond: payloadBytes * spec.targetHz, selectionScore});
      log(`${spec.matrixSize}²@${spec.targetHz}: ${formatRate(receiver.uniquePayloadBytesPerSecond)} · valid ${(receiver.validRatio * 100).toFixed(1)}% · pilot ${(receiver.averageReservedScore * 100).toFixed(1)}%`);
      await sleep(300);
    }
    const best = results.reduce<(typeof results)[number] | null>((winner, candidate) => !winner || candidate.selectionScore > winner.selectionScore ? candidate : winner, null);
    const run = {
      schema: 'optilink.tf006.optigrid-v1.physical.v2',
      kind: 'optigrid-v1-physical-calibration', evidenceClass: 'performance-experiment',
      status: aborted ? 'ABORTED' : best ? 'PHYSICAL_GATE_COMPLETE' : 'NO_VALID_CANDIDATE', startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(),
      sender: senderMetadata, receiver: latestReceiverMetadata,
      displayBaseline: {physicalRefreshHz: PHYSICAL_HZ, targetOpticalVisualUpdateHz: 'per-candidate 20/30'},
      carrier: {name: 'OptiGrid v1', modulation: 'monochrome 1-bit cells', renderPixels: RENDER_PIXELS, receiverPipeline: 'axis seed -> four-corner projective refinement -> tracked homography -> subpixel bilinear 5-point fast decode', integrity: 'per-frame CRC32 + deterministic receiver-side payload oracle'},
      candidates: results, best,
      target: {netGoodputBytesPerSecond: 100000, note: 'short physical gate measures raw unique optical ingress, not final file Net Goodput'},
      controlPlane: 'WebSocket carries candidate configuration and telemetry only; frame payload bytes remain screen→camera optical',
    };
    send({type: 'lab-result', run});
    send({type: 'command', action: 'tf006-finished', status: run.status});
    log(best ? `TF-006 v2 complete · selected ${best.matrixSize}² @ ${best.targetHz} Hz · ${formatRate(best.uniquePayloadBytesPerSecond)}.` : 'TF-006 v2 completed without a valid candidate.');
  } catch (error) {
    senderRunning = false;
    send({type: 'command', action: 'tf006-finished', status: 'ERROR'});
    log(`TF-006 v2 failed: ${String(error)}`);
  }
}

function resolvePending(slot: {id: string; pending: Pending} | null, id: string, value?: CandidateMetrics): boolean {
  if (!slot || slot.id !== id) return false;
  clearTimeout(slot.pending.timer); slot.pending.resolve(value); return true;
}
function connect(): void {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${wsProtocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf006-${role}`}); log(`coordinator connected as tf006-${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (role === 'sender' && message.type === 'telemetry' && message.telemetry?.transport === 'optigrid-v1-physical-v2') { latestTelemetry = message.telemetry as Telemetry; return; }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-receiver-ready') { latestReceiverMetadata = message.receiver as ReceiverMetadata; drawStatic(120, 0); void runPhysicalGate(); return; }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-config') {
      const config = message.config as CandidateConfig;
      setCandidate(config);
      latestReceiverMetadata = captureReceiverMetadata();
      send({type: 'state', event: 'tf006-config-ready', candidateId: config.id, receiver: latestReceiverMetadata});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-measurement-start') {
      const id = String(message.candidateId || '');
      if (activeCandidate?.id === id) clearMeasurements(true);
      send({type: 'state', event: 'tf006-measurement-ready', candidateId: id});
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-candidate-finish') {
      const id = String(message.candidateId || '');
      const metrics = currentMetrics();
      if (metrics && metrics.id === id) send({type: 'state', event: 'tf006-candidate-result', candidateId: id, metrics});
      return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-config-ready') {
      const id = String(message.candidateId || ''); if (resolvePending(pendingConfig, id)) pendingConfig = null; latestReceiverMetadata = message.receiver as ReceiverMetadata; return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-measurement-ready') {
      const id = String(message.candidateId || ''); if (resolvePending(pendingMeasure, id)) pendingMeasure = null; return;
    }
    if (role === 'sender' && message.type === 'state' && message.event === 'tf006-candidate-result') {
      const id = String(message.candidateId || ''); if (resolvePending(pendingResult, id, message.metrics as CandidateMetrics)) pendingResult = null; return;
    }
    if (message.type === 'command' && message.action === 'tf006-stop') { aborted = true; senderRunning = false; return; }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf006-finished') {
      stopCamera(); startButton.disabled = false; stopButton.disabled = true; log(`TF-006 finished: ${message.status}`); return;
    }
    if (message.type === 'server' && message.event === 'result-saved') log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
  });
}

async function receiverStart(): Promise<void> {
  await startCamera();
  latestReceiverMetadata = captureReceiverMetadata();
  startButton.disabled = true; stopButton.disabled = false;
  send({type: 'state', event: 'tf006-receiver-ready', receiver: latestReceiverMetadata});
  log('Camera started. Align during preflight; projective acquisition and the 20/30 Hz sweep are automatic.');
}
function userStop(): void {
  aborted = true; senderRunning = false; send({type: 'command', action: 'tf006-stop'});
  if (role === 'receiver') stopCamera();
  startButton.disabled = false; stopButton.disabled = true; log('stopped by user');
}
startButton.addEventListener('click', () => { if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`)); });
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  roleTitle.textContent = 'TF-006 sender ready'; roleText.textContent = '手机点击 Start 后自动运行 projective + 20/30 Hz sweep。';
  startButton.hidden = true; stopButton.hidden = true; drawStatic(120, 0);
} else if (role === 'receiver') {
  roleTitle.textContent = 'TF-006 receiver ready'; roleText.textContent = '完整方阵放入绿色框，只点一次 Start；之后保持手机固定。';
} else {
  roleTitle.textContent = 'Use role-specific URLs'; roleText.textContent = '电脑 sender，手机 receiver。'; startButton.disabled = true;
}
connect();
