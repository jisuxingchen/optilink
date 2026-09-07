import {encodeFrameCellsV1, payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {acquireKnownTrainingLock, countKnownErrors, decodeWithPixelLock, trackReservedLock, type PixelLock} from './tiled-training-solver.ts';

const PHYSICAL_DISPLAY_HZ = 60;
const TILE_COUNT = 3;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 720;
const TILE_RENDER_PIXELS = 540;
const TILE_CENTERS = [330, 960, 1590] as const;
const ORIENTATION_TRAINING_MATRIX = 64;
const TRAINING_SETTLE_MS = 1200;
const PREAMBLE_SETTLE_MS = 850;
const CANDIDATE_SECONDS = 10;
const CANDIDATES = [
  {matrixSize: 80, targetHz: 30, reference: true},
  {matrixSize: 96, targetHz: 60, reference: false},
  {matrixSize: 112, targetHz: 45, reference: false},
  {matrixSize: 120, targetHz: 45, reference: false},
] as const;

type OrientationMode = 'native' | 'rotate180' | 'rotateCW' | 'rotateCCW';
type CandidateConfig = {
  id: string;
  matrixSize: number;
  targetHz: number;
  durationMs: number;
  payloadBytes: number;
  tileCount: 3;
  reference: boolean;
};
type CalibrationTile = {tile: number; acquired: boolean; score: number; contrast: number; bitErrors: number; bits: number; lock: PixelLock | null};
type CalibrationResult = {
  success: boolean;
  matrixSize: number;
  orientationMode: OrientationMode | null;
  sourceVideo: {width: number; height: number};
  normalizedFrame: {width: number; height: number};
  tiles: CalibrationTile[];
  exactTiles: number;
  totalBitErrors: number;
  calibrationMs: number;
};
type TileState = {lock: PixelLock | null; tracked: number};
type CandidateMetrics = {
  id: string;
  matrixSize: number;
  targetHz: number;
  reference: boolean;
  payloadBytesPerTile: number;
  elapsedSeconds: number;
  cameraFrames: number;
  attemptedTiles: number;
  validTiles: number;
  validTileRatio: number;
  completeFrames: number;
  completeFrameRatio: number;
  uniqueDecodedSymbols: number;
  uniqueSymbolsPerSecond: number;
  rawUniqueOpticalIngressBytesPerSecond: number;
  alignmentRejects: number;
  crcRejects: number;
  payloadMismatchRejects: number;
  transitionFramesIgnored: number;
  trackedTiles: number;
  averageReservedScore: number;
  averageContrast: number;
  decodeP95Ms: number;
  averageFrameProcessMs: number;
  processingFramesPerSecond: number;
  cameraVideo: {width: number; height: number};
  normalizedFrame: {width: number; height: number};
  preamble: CalibrationResult | null;
};
type Pending = {event: string; id: string; timer: number; resolve: (value: unknown) => void; reject: (error: Error) => void};
type ReceiverMeta = ReturnType<typeof receiverMetadata>;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const roleValue = new URLSearchParams(location.search).get('role');
const role: 'sender' | 'receiver' | 'both' = roleValue === 'sender' || roleValue === 'receiver' ? roleValue : 'both';
const senderCanvas = $<HTMLCanvasElement>('senderCanvas');
const video = $<HTMLVideoElement>('camera');
const receiverStatus = $<HTMLPreElement>('receiverStatus');
const labStatus = $<HTMLPreElement>('labStatus');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
const progress = $<HTMLElement>('progress');
const roleTitle = $<HTMLElement>('roleTitle');
const roleText = $<HTMLElement>('roleText');
const receiverView = $<HTMLElement>('receiverView');

senderCanvas.width = FRAME_WIDTH;
senderCanvas.height = FRAME_HEIGHT;
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = SAMPLE_WIDTH;
sampleCanvas.height = SAMPLE_HEIGHT;
const sampleContext = sampleCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
if (!sampleContext) throw new Error('sample canvas unavailable');
const tileCanvas = document.createElement('canvas');

let socket: WebSocket | null = null;
let cameraStream: MediaStream | null = null;
let scanning = false;
let orientationMode: OrientationMode | null = null;
let initialTraining: CalibrationResult | null = null;
let preparedPreamble: CalibrationResult | null = null;
let preparedLocks: PixelLock[] | null = null;
let activeCandidate: CandidateConfig | null = null;
let candidateStartedAt = 0;
let states: TileState[] = [];
let cameraFrames = 0;
let validTiles = 0;
let completeFrames = 0;
let alignmentRejects = 0;
let crcRejects = 0;
let payloadMismatchRejects = 0;
let transitionFramesIgnored = 0;
let scoreSum = 0;
let contrastSum = 0;
let scoreSamples = 0;
let processTimes: number[] = [];
let seen: Array<Set<number>> = [];
let senderRunning = false;
let senderFrameHandle = 0;
let senderSymbolBase = 1;
let aborted = false;
let pending: Pending | null = null;
let latestReceiverMeta: ReceiverMeta | null = null;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function log(message: string): void {
  labStatus.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent || ''}`.slice(0, 26000);
}
function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
const formatRate = (value: number) => `${(value / 1000).toFixed(2)} KB/s`;
function payloadFor(sequence: number, length: number, tile: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x71d2c3a5 ^ (tile * 0x9e3779b9)) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    output[i] = (x + i * 31 + tile * 47) & 255;
  }
  return output;
}
function preambleSequence(matrixSize: number, tile: number): number {
  return (0x54000000 | ((matrixSize & 0xff) << 8) | (tile & 0xff)) >>> 0;
}
function preambleCells(matrixSize: number, tile: number): Uint8Array {
  const sequence = preambleSequence(matrixSize, tile);
  const bytes = payloadCapacityForMatrixV1(matrixSize);
  return encodeFrameCellsV1(matrixSize, sequence, payloadFor(sequence, bytes, tile));
}
function isPreambleSequence(matrixSize: number, sequence: number): boolean {
  return sequence >= preambleSequence(matrixSize, 0) && sequence <= preambleSequence(matrixSize, 2);
}
function receiverMetadata() {
  const track = cameraStream?.getVideoTracks()[0];
  return {
    configuredDevice: 'moto razr 40 ultra',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    cameraSettings: track?.getSettings?.() || null,
    screenOrientation: screen.orientation?.type || 'unknown',
    normalizedOrientation: orientationMode,
    normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT},
    capturedAt: new Date().toISOString(),
    source: 'tf007-tiled-physical-receiver-v3' as const,
  };
}
function senderMetadata() {
  const rect = senderCanvas.getBoundingClientRect();
  return {
    userAgent: navigator.userAgent,
    screen: {width: screen.width, height: screen.height, devicePixelRatio},
    physicalDisplayRefreshHz: PHYSICAL_DISPLAY_HZ,
    physicalDisplayRefreshSource: 'owner-confirmed',
    canvasBacking: {width: senderCanvas.width, height: senderCanvas.height},
    canvasCss: {width: rect.width, height: rect.height},
    tileRenderPixels: TILE_RENDER_PIXELS,
    capturedAt: new Date().toISOString(),
  };
}
function orientationCandidates(): OrientationMode[] {
  return video.videoWidth < video.videoHeight ? ['rotateCW', 'rotateCCW'] : ['native', 'rotate180'];
}
function captureNormalized(mode: OrientationMode): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  sampleCanvas.width = SAMPLE_WIDTH;
  sampleCanvas.height = SAMPLE_HEIGHT;
  sampleContext.setTransform(1, 0, 0, 1, 0, 0);
  sampleContext.fillStyle = '#eceff1';
  sampleContext.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  sampleContext.imageSmoothingEnabled = true;
  sampleContext.save();
  if (mode === 'native') sampleContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  else if (mode === 'rotate180') {
    sampleContext.translate(SAMPLE_WIDTH, SAMPLE_HEIGHT); sampleContext.rotate(Math.PI); sampleContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  } else if (mode === 'rotateCW') {
    sampleContext.translate(SAMPLE_WIDTH, 0); sampleContext.rotate(Math.PI / 2); sampleContext.drawImage(video, 0, 0, SAMPLE_HEIGHT, SAMPLE_WIDTH);
  } else {
    sampleContext.translate(0, SAMPLE_HEIGHT); sampleContext.rotate(-Math.PI / 2); sampleContext.drawImage(video, 0, 0, SAMPLE_HEIGHT, SAMPLE_WIDTH);
  }
  sampleContext.restore();
  return sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
}
function lane(tile: number) {
  return {x: tile * SAMPLE_WIDTH / TILE_COUNT, y: 0, width: SAMPLE_WIDTH / TILE_COUNT, height: SAMPLE_HEIGHT};
}
function calibrationFromImage(image: ImageData, matrixSize: number, mode: OrientationMode): CalibrationResult {
  const started = performance.now();
  const tiles: CalibrationTile[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const cells = preambleCells(matrixSize, tile);
    const lock = acquireKnownTrainingLock(image, matrixSize, cells, lane(tile));
    if (!lock) {
      tiles.push({tile, acquired: false, score: 0, contrast: 0, bitErrors: Number.MAX_SAFE_INTEGER, bits: 0, lock: null});
      continue;
    }
    const error = countKnownErrors(image, matrixSize, cells, lock);
    tiles.push({tile, acquired: true, score: lock.score, contrast: lock.contrast, bitErrors: error.errors, bits: error.bits, lock});
  }
  const exactTiles = tiles.filter(item => item.acquired && item.bitErrors === 0).length;
  const acquired = tiles.filter(item => item.acquired).length;
  const totalBitErrors = acquired === TILE_COUNT ? tiles.reduce((sum, item) => sum + item.bitErrors, 0) : Number.MAX_SAFE_INTEGER;
  return {
    success: exactTiles === TILE_COUNT && totalBitErrors === 0,
    matrixSize,
    orientationMode: mode,
    sourceVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT},
    tiles,
    exactTiles,
    totalBitErrors,
    calibrationMs: performance.now() - started,
  };
}
function calibrationRank(result: CalibrationResult): number {
  const acquired = result.tiles.filter(item => item.acquired).length;
  const errors = Number.isFinite(result.totalBitErrors) ? result.totalBitErrors : 1e9;
  const score = result.tiles.reduce((sum, item) => sum + item.score, 0);
  return acquired * 1e9 + result.exactTiles * 1e7 - errors * 1e5 + score * 1e4;
}
async function calibrateInitialOrientation(): Promise<CalibrationResult> {
  let best: CalibrationResult | null = null;
  for (const mode of orientationCandidates()) {
    const image = captureNormalized(mode);
    if (!image) continue;
    const result = calibrationFromImage(image, ORIENTATION_TRAINING_MATRIX, mode);
    log(`orientation ${mode}: exact ${result.exactTiles}/3 · errors ${Number.isFinite(result.totalBitErrors) ? result.totalBitErrors : 'n/a'}`);
    if (!best || calibrationRank(result) > calibrationRank(best)) best = result;
    await sleep(25);
  }
  if (!best) throw new Error('no orientation calibration frame');
  orientationMode = best.orientationMode;
  initialTraining = best;
  latestReceiverMeta = receiverMetadata();
  receiverStatus.textContent = [
    `ORIENTATION PREAMBLE ${best.matrixSize} · ${best.orientationMode || 'n/a'}`,
    `exact ${best.exactTiles}/3 · errors ${Number.isFinite(best.totalBitErrors) ? best.totalBitErrors : 'n/a'}`,
    ...best.tiles.map(item => `T${item.tile + 1}: ${item.acquired ? `score ${(item.score * 100).toFixed(1)}% · contrast ${item.contrast.toFixed(1)} · errors ${item.bitErrors}/${item.bits}` : 'NO LOCK'}`),
  ].join('\n');
  return best;
}
async function calibrateCandidatePreamble(matrixSize: number): Promise<CalibrationResult> {
  if (!orientationMode) throw new Error('orientation not calibrated');
  const image = captureNormalized(orientationMode);
  if (!image) throw new Error('candidate preamble frame unavailable');
  const result = calibrationFromImage(image, matrixSize, orientationMode);
  preparedPreamble = result;
  preparedLocks = result.success ? result.tiles.map(item => item.lock!).filter(Boolean) : null;
  latestReceiverMeta = receiverMetadata();
  receiverStatus.textContent = [
    `DENSITY PREAMBLE ${matrixSize}×${matrixSize}`,
    `exact ${result.exactTiles}/3 · errors ${Number.isFinite(result.totalBitErrors) ? result.totalBitErrors : 'n/a'} · ${result.success ? 'LOCKED' : 'FAILED'}`,
    ...result.tiles.map(item => `T${item.tile + 1}: ${item.acquired ? `score ${(item.score * 100).toFixed(1)}% · contrast ${item.contrast.toFixed(1)} · errors ${item.bitErrors}/${item.bits}` : 'NO LOCK'}`),
  ].join('\n');
  return result;
}
function resetCandidate(config: CandidateConfig | null): void {
  activeCandidate = config;
  candidateStartedAt = performance.now();
  states = Array.from({length: TILE_COUNT}, (_, tile) => ({lock: preparedLocks?.[tile] ? {...preparedLocks[tile], quad: {tl: {...preparedLocks[tile].quad.tl}, tr: {...preparedLocks[tile].quad.tr}, br: {...preparedLocks[tile].quad.br}, bl: {...preparedLocks[tile].quad.bl}}} : null, tracked: 0}));
  cameraFrames = validTiles = completeFrames = alignmentRejects = crcRejects = payloadMismatchRejects = transitionFramesIgnored = scoreSum = contrastSum = scoreSamples = 0;
  processTimes = [];
  seen = Array.from({length: TILE_COUNT}, () => new Set<number>());
  updateStatus();
}
function currentMetrics(): CandidateMetrics | null {
  const config = activeCandidate;
  if (!config) return null;
  const elapsedSeconds = Math.max(0.001, (performance.now() - candidateStartedAt) / 1000);
  const unique = seen.reduce((sum, set) => sum + set.size, 0);
  const avgProcess = processTimes.length ? processTimes.reduce((sum, value) => sum + value, 0) / processTimes.length : 0;
  return {
    id: config.id, matrixSize: config.matrixSize, targetHz: config.targetHz, reference: config.reference, payloadBytesPerTile: config.payloadBytes,
    elapsedSeconds, cameraFrames, attemptedTiles: cameraFrames * TILE_COUNT, validTiles, validTileRatio: cameraFrames ? validTiles / (cameraFrames * TILE_COUNT) : 0,
    completeFrames, completeFrameRatio: cameraFrames ? completeFrames / cameraFrames : 0, uniqueDecodedSymbols: unique, uniqueSymbolsPerSecond: unique / elapsedSeconds,
    rawUniqueOpticalIngressBytesPerSecond: unique * config.payloadBytes / elapsedSeconds, alignmentRejects, crcRejects, payloadMismatchRejects, transitionFramesIgnored,
    trackedTiles: states.reduce((sum, state) => sum + state.tracked, 0), averageReservedScore: scoreSamples ? scoreSum / scoreSamples : 0,
    averageContrast: scoreSamples ? contrastSum / scoreSamples : 0, decodeP95Ms: percentile(processTimes, 0.95), averageFrameProcessMs: avgProcess,
    processingFramesPerSecond: cameraFrames / elapsedSeconds, cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0},
    normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT}, preamble: preparedPreamble,
  };
}
function updateStatus(): void {
  const metrics = currentMetrics();
  if (!metrics) {
    receiverStatus.textContent = preparedPreamble?.success ? `density ${preparedPreamble.matrixSize} locked · waiting for dynamic candidate` : initialTraining?.success ? 'orientation locked · waiting for density preamble' : 'camera ready · waiting for training';
    return;
  }
  receiverStatus.textContent = [
    `${metrics.reference ? 'REFERENCE' : 'CANDIDATE'} 3×${metrics.matrixSize} @ ${metrics.targetHz} Hz · ${metrics.payloadBytesPerTile} B/tile`,
    `preamble ${metrics.preamble?.success ? 'exact' : 'not exact'} · camera/process ${metrics.processingFramesPerSecond.toFixed(1)} fps · avg ${metrics.averageFrameProcessMs.toFixed(1)} ms · p95 ${metrics.decodeP95Ms.toFixed(1)} ms`,
    `valid tiles ${metrics.validTiles}/${metrics.attemptedTiles} · ${(metrics.validTileRatio * 100).toFixed(1)}% · complete ${(metrics.completeFrameRatio * 100).toFixed(1)}%`,
    `unique ${metrics.uniqueDecodedSymbols} · ${metrics.uniqueSymbolsPerSecond.toFixed(1)}/s · RAW ${formatRate(metrics.rawUniqueOpticalIngressBytesPerSecond)}`,
    `rejects align ${metrics.alignmentRejects} · CRC ${metrics.crcRejects} · payload ${metrics.payloadMismatchRejects} · transition ${metrics.transitionFramesIgnored}`,
    `reserved ${(metrics.averageReservedScore * 100).toFixed(1)}% · contrast ${metrics.averageContrast.toFixed(1)} · orientation ${orientationMode || 'n/a'}`,
  ].join('\n');
  send({type: 'telemetry', telemetry: {transport: 'tf007-tiled-physical-v3', metrics, timestamp: performance.now()}});
}
function processFrame(): void {
  const config = activeCandidate;
  if (!scanning || !config || !orientationMode || !preparedLocks) return;
  const image = captureNormalized(orientationMode);
  if (!image) return;
  const started = performance.now();
  cameraFrames += 1;
  let frameValid = 0;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const state = states[tile];
    const baseLock = state.lock || preparedLocks[tile];
    const tracked = trackReservedLock(image, config.matrixSize, baseLock);
    if (!tracked) { alignmentRejects += 1; continue; }
    state.lock = tracked;
    state.tracked += 1;
    scoreSum += tracked.score; contrastSum += tracked.contrast; scoreSamples += 1;
    const decoded = decodeWithPixelLock(image, config.matrixSize, tracked);
    if (!decoded) { crcRejects += 1; continue; }
    if (isPreambleSequence(config.matrixSize, decoded.sequence)) { transitionFramesIgnored += 1; continue; }
    const expected = payloadFor(decoded.sequence, decoded.payload.length, tile);
    if (!sameBytes(decoded.payload, expected)) { payloadMismatchRejects += 1; continue; }
    validTiles += 1; frameValid += 1; seen[tile].add(decoded.sequence);
  }
  if (frameValid === TILE_COUNT) completeFrames += 1;
  processTimes.push(performance.now() - started);
  if (processTimes.length > 1200) processTimes.shift();
  if (cameraFrames % 3 === 0) updateStatus();
}
function scheduleVideoLoop(): void {
  const source = video as HTMLVideoElement & {requestVideoFrameCallback?: (callback: () => void) => number};
  const tick = () => {
    if (!scanning) return;
    processFrame();
    if (source.requestVideoFrameCallback) source.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (source.requestVideoFrameCallback) source.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}
async function startCamera(): Promise<void> {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60, max: 60}}});
  video.srcObject = cameraStream;
  await video.play();
  scanning = true;
  scheduleVideoLoop();
}
function stopCamera(): void {
  scanning = false;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
}
function drawTile(cells: Uint8Array, matrixSize: number): void {
  tileCanvas.width = matrixSize; tileCanvas.height = matrixSize;
  const ctx = tileCanvas.getContext('2d', {alpha: false});
  if (!ctx) throw new Error('tile canvas unavailable');
  const image = ctx.createImageData(matrixSize, matrixSize);
  for (let i = 0; i < cells.length; i += 1) {
    const value = cells[i] ? 0 : 255, offset = i * 4;
    image.data[offset] = value; image.data[offset + 1] = value; image.data[offset + 2] = value; image.data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}
function clearSender(): void {
  const ctx = senderCanvas.getContext('2d', {alpha: false});
  if (!ctx) return;
  ctx.fillStyle = '#eceff1'; ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
}
function renderCellsForTiles(matrixSize: number, cellsByTile: Uint8Array[]): void {
  const ctx = senderCanvas.getContext('2d', {alpha: false});
  if (!ctx) throw new Error('sender canvas unavailable');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#eceff1'; ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT); ctx.imageSmoothingEnabled = false;
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    drawTile(cellsByTile[tile], matrixSize);
    const left = TILE_CENTERS[tile] - TILE_RENDER_PIXELS / 2, top = FRAME_HEIGHT / 2 - TILE_RENDER_PIXELS / 2;
    ctx.fillStyle = '#fff'; ctx.fillRect(left - 10, top - 10, TILE_RENDER_PIXELS + 20, TILE_RENDER_PIXELS + 20);
    ctx.drawImage(tileCanvas, left, top, TILE_RENDER_PIXELS, TILE_RENDER_PIXELS);
  }
}
function renderPreamble(matrixSize: number): void {
  renderCellsForTiles(matrixSize, [preambleCells(matrixSize, 0), preambleCells(matrixSize, 1), preambleCells(matrixSize, 2)]);
}
function renderDynamic(config: CandidateConfig, symbol: number): void {
  const cells: Uint8Array[] = [];
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const sequence = ((senderSymbolBase + symbol) * 16 + tile + 1) >>> 0;
    cells.push(encodeFrameCellsV1(config.matrixSize, sequence, payloadFor(sequence, config.payloadBytes, tile)));
  }
  renderCellsForTiles(config.matrixSize, cells);
}
function waitState(event: string, id: string, timeoutMs = 30000): Promise<unknown> {
  if (pending) throw new Error(`pending state already active: ${pending.event}`);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { pending = null; reject(new Error(`${event} timed out`)); }, timeoutMs);
    pending = {event, id, timer, resolve, reject};
  });
}
function resolvePending(message: any): boolean {
  if (!pending || message.type !== 'state' || message.event !== pending.event || String(message.id || '') !== pending.id) return false;
  clearTimeout(pending.timer); const resolve = pending.resolve; pending = null; resolve(message.value); return true;
}
async function senderCalibration(matrixSize: number, kind: 'orientation' | 'density'): Promise<CalibrationResult> {
  const id = `tf007v3-${kind}-${matrixSize}-${Date.now().toString(36)}`;
  renderPreamble(matrixSize);
  send({type: 'command', action: 'tf007v3-preamble-visible', id, matrixSize, kind});
  await sleep(kind === 'orientation' ? TRAINING_SETTLE_MS : PREAMBLE_SETTLE_MS);
  const response = waitState('tf007v3-calibration-result', id, 45000);
  send({type: 'command', action: 'tf007v3-calibrate', id, matrixSize, kind});
  return await response as CalibrationResult;
}
async function configureReceiver(config: CandidateConfig): Promise<void> {
  const ready = waitState('tf007v3-candidate-ready', config.id);
  send({type: 'command', action: 'tf007v3-candidate-config', id: config.id, config});
  await ready;
}
async function collectReceiverResult(config: CandidateConfig): Promise<CandidateMetrics> {
  const result = waitState('tf007v3-candidate-result', config.id);
  send({type: 'command', action: 'tf007v3-candidate-finish', id: config.id});
  return await result as CandidateMetrics;
}
async function renderCandidate(config: CandidateConfig): Promise<{renderedSymbols: number; actualSymbolHz: number}> {
  await configureReceiver(config);
  await sleep(250);
  senderRunning = true;
  let renderedSymbols = 0, lastSymbol = -1;
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const frame = (now: number) => {
      if (!senderRunning || aborted) return resolve();
      const elapsed = now - started;
      if (elapsed >= config.durationMs) return resolve();
      const symbol = Math.floor(elapsed * config.targetHz / 1000);
      if (symbol !== lastSymbol) {
        try { renderDynamic(config, symbol); renderedSymbols += 1; lastSymbol = symbol; }
        catch (error) { senderRunning = false; reject(error); return; }
      }
      senderFrameHandle = requestAnimationFrame(frame);
    };
    senderFrameHandle = requestAnimationFrame(frame);
  });
  senderRunning = false; cancelAnimationFrame(senderFrameHandle);
  senderSymbolBase += Math.max(100, renderedSymbols + 20);
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  return {renderedSymbols, actualSymbolHz: renderedSymbols / elapsedSeconds};
}
function failedMetrics(config: CandidateConfig, preamble: CalibrationResult): CandidateMetrics {
  return {
    id: config.id, matrixSize: config.matrixSize, targetHz: config.targetHz, reference: config.reference, payloadBytesPerTile: config.payloadBytes,
    elapsedSeconds: 0, cameraFrames: 0, attemptedTiles: 0, validTiles: 0, validTileRatio: 0, completeFrames: 0, completeFrameRatio: 0,
    uniqueDecodedSymbols: 0, uniqueSymbolsPerSecond: 0, rawUniqueOpticalIngressBytesPerSecond: 0, alignmentRejects: 0, crcRejects: 0,
    payloadMismatchRejects: 0, transitionFramesIgnored: 0, trackedTiles: 0, averageReservedScore: 0, averageContrast: 0,
    decodeP95Ms: 0, averageFrameProcessMs: 0, processingFramesPerSecond: 0,
    cameraVideo: {width: video.videoWidth || 0, height: video.videoHeight || 0}, normalizedFrame: {width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT}, preamble,
  };
}
async function runPhysicalCalibration(): Promise<void> {
  if (senderRunning) return;
  aborted = false;
  const results: Array<CandidateMetrics & {senderRenderedSymbols: number; senderActualSymbolHz: number; theoreticalGrossBytesPerSecond: number}> = [];
  try {
    log('TF-007 physical v3 started: orientation preamble + same-density preamble before every candidate.');
    const training = await senderCalibration(ORIENTATION_TRAINING_MATRIX, 'orientation');
    log(`orientation training: ${training.orientationMode || 'n/a'} · exact ${training.exactTiles}/3 · errors ${Number.isFinite(training.totalBitErrors) ? training.totalBitErrors : 'n/a'}`);
    if (!training.success || aborted) {
      const status = aborted ? 'ABORTED' : 'TRAINING_LOCK_FAILED';
      const run = {schema: 'optilink.tf007.tiled.physical.v3', kind: 'tf007-tiled-physical-calibration', issueNumber: 27, evidenceClass: 'physical-carrier-calibration', status,
        startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(), sender: senderMetadata(), receiver: latestReceiverMeta, training,
        displayBaseline: {physicalRefreshHz: PHYSICAL_DISPLAY_HZ}, carrier: {name: 'OptiGrid v1 tiled monochrome', tileCount: 3, layout: 'three horizontal independent tiles', calibration: 'same-density optical preamble'},
        candidates: results, best: null, target: {rawCarrierIngressBytesPerSecond: 100000}, controlPlane: 'WebSocket carries commands/telemetry only; all preamble and candidate bits remain screen→camera optical',
        note: 'Orientation training failed before throughput measurement; not a carrier speed verdict.'};
      send({type: 'lab-result', run}); send({type: 'command', action: 'tf007v3-finished', status}); clearSender(); return;
    }
    for (const candidate of CANDIDATES) {
      if (aborted) break;
      const payloadBytes = payloadCapacityForMatrixV1(candidate.matrixSize);
      const config: CandidateConfig = {id: `tf007v3-${candidate.matrixSize}-${candidate.targetHz}-${Date.now().toString(36)}`, matrixSize: candidate.matrixSize, targetHz: candidate.targetHz,
        durationMs: CANDIDATE_SECONDS * 1000, payloadBytes, tileCount: 3, reference: candidate.reference};
      const preamble = await senderCalibration(candidate.matrixSize, 'density');
      log(`preamble ${candidate.matrixSize}: exact ${preamble.exactTiles}/3 · errors ${Number.isFinite(preamble.totalBitErrors) ? preamble.totalBitErrors : 'n/a'}`);
      if (!preamble.success) {
        const receiver = failedMetrics(config, preamble);
        results.push({...receiver, senderRenderedSymbols: 0, senderActualSymbolHz: 0, theoreticalGrossBytesPerSecond: payloadBytes * TILE_COUNT * candidate.targetHz});
        continue;
      }
      log(`${candidate.reference ? 'reference' : 'testing'} 3×${candidate.matrixSize} @ ${candidate.targetHz} Hz · gross ${formatRate(payloadBytes * TILE_COUNT * candidate.targetHz)}`);
      const sender = await renderCandidate(config);
      const receiver = await collectReceiverResult(config);
      results.push({...receiver, senderRenderedSymbols: sender.renderedSymbols, senderActualSymbolHz: sender.actualSymbolHz, theoreticalGrossBytesPerSecond: payloadBytes * TILE_COUNT * candidate.targetHz});
      log(`3×${candidate.matrixSize}@${candidate.targetHz}: raw ${formatRate(receiver.rawUniqueOpticalIngressBytesPerSecond)} · valid ${(receiver.validTileRatio * 100).toFixed(1)}% · process ${receiver.processingFramesPerSecond.toFixed(1)} fps`);
      await sleep(250);
    }
    const highCapacity = results.filter(row => !row.reference && row.preamble?.success);
    const best = highCapacity.reduce<(typeof results)[number] | null>((winner, row) => !winner || row.rawUniqueOpticalIngressBytesPerSecond > winner.rawUniqueOpticalIngressBytesPerSecond ? row : winner, null);
    const reference = results.find(row => row.reference) || null;
    const anyPreambleFailure = results.some(row => !row.preamble?.success);
    const status = aborted ? 'ABORTED'
      : reference && !reference.preamble?.success ? 'FUNCTIONAL_REFERENCE_PREAMBLE_FAILED'
      : reference && reference.validTileRatio < 0.25 ? 'FUNCTIONAL_REFERENCE_FAILED'
      : best && best.rawUniqueOpticalIngressBytesPerSecond >= 100000 ? 'PASS_RAW_100KBPS'
      : anyPreambleFailure ? 'DENSITY_PREAMBLE_PARTIAL_FAILURE'
      : 'BELOW_100KBPS';
    const run = {schema: 'optilink.tf007.tiled.physical.v3', kind: 'tf007-tiled-physical-calibration', issueNumber: 27, evidenceClass: 'physical-carrier-calibration', status,
      startedBy: 'receiver-one-click', finishedAt: new Date().toISOString(), sender: senderMetadata(), receiver: latestReceiverMeta, training,
      displayBaseline: {physicalRefreshHz: PHYSICAL_DISPLAY_HZ}, carrier: {name: 'OptiGrid v1 tiled monochrome', tileCount: 3, layout: 'three horizontal independent tiles', calibration: 'same-density optical preamble before each dynamic candidate', tileRenderPixels: TILE_RENDER_PIXELS},
      candidates: results, reference, best, target: {rawCarrierIngressBytesPerSecond: 100000}, controlPlane: 'WebSocket carries commands/telemetry only; all preamble and candidate bits remain screen→camera optical',
      note: 'Raw carrier calibration only. File-level Net Goodput still requires Fountain + reconstructed file SHA-256.'};
    send({type: 'lab-result', run}); send({type: 'command', action: 'tf007v3-finished', status}); clearSender();
    log(best ? `physical v3 ${status} · best ${best.matrixSize}@${best.targetHz} · ${formatRate(best.rawUniqueOpticalIngressBytesPerSecond)}` : `physical v3 ${status}`);
  } catch (error) {
    clearSender(); senderRunning = false; send({type: 'command', action: 'tf007v3-finished', status: 'ERROR'}); log(`physical v3 failed: ${String(error)}`);
  }
}
function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/lab`);
  socket.addEventListener('open', () => { send({type: 'hello', role: `tf007v3-tiled-${role}`}); log(`coordinator connected as ${role}`); });
  socket.addEventListener('close', () => { log('coordinator disconnected; reconnecting…'); setTimeout(connect, 1500); });
  socket.addEventListener('message', event => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (resolvePending(message)) return;
    if (role === 'sender' && message.type === 'state' && message.event === 'tf007v3-receiver-ready') {
      latestReceiverMeta = message.receiver as ReceiverMeta; void runPhysicalCalibration(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v3-preamble-visible') {
      latestReceiverMeta = receiverMetadata(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v3-calibrate') {
      const id = String(message.id || ''), matrixSize = Number(message.matrixSize), kind = String(message.kind || 'density');
      const task = kind === 'orientation' ? calibrateInitialOrientation() : calibrateCandidatePreamble(matrixSize);
      void task.then(value => send({type: 'state', event: 'tf007v3-calibration-result', id, value})).catch(error => send({type: 'state', event: 'tf007v3-calibration-result', id, value: {success: false, matrixSize, error: String(error)}}));
      return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v3-candidate-config') {
      const config = message.config as CandidateConfig;
      if (!preparedPreamble?.success || preparedPreamble.matrixSize !== config.matrixSize || !preparedLocks) {
        send({type: 'state', event: 'tf007v3-candidate-ready', id: String(message.id || ''), value: {error: 'matching exact density preamble required'}}); return;
      }
      resetCandidate(config); latestReceiverMeta = receiverMetadata(); send({type: 'state', event: 'tf007v3-candidate-ready', id: String(message.id || ''), value: latestReceiverMeta}); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v3-candidate-finish') {
      const id = String(message.id || ''), metrics = currentMetrics(); send({type: 'state', event: 'tf007v3-candidate-result', id, value: metrics}); resetCandidate(null); return;
    }
    if (message.type === 'command' && message.action === 'tiled-physical-stop') {
      aborted = true; senderRunning = false; cancelAnimationFrame(senderFrameHandle); if (role === 'receiver') stopCamera(); return;
    }
    if (role === 'receiver' && message.type === 'command' && message.action === 'tf007v3-finished') {
      stopCamera(); startButton.disabled = false; stopButton.disabled = true; progress.textContent = String(message.status || 'finished'); log(`physical v3 finished: ${message.status}`); return;
    }
    if (message.type === 'server' && message.event === 'result-saved') log(`result saved${message.publish?.published ? ` and posted to Issue #${message.publish.issueNumber}` : ''}`);
  });
}
async function receiverStart(): Promise<void> {
  orientationMode = null; initialTraining = null; preparedPreamble = null; preparedLocks = null; resetCandidate(null); progress.textContent = 'starting camera';
  await startCamera(); latestReceiverMeta = receiverMetadata(); startButton.disabled = true; stopButton.disabled = false; progress.textContent = 'training';
  send({type: 'state', event: 'tf007v3-receiver-ready', receiver: latestReceiverMeta});
  log('Camera started. v3 will calibrate orientation once, then recalibrate geometry/phase/threshold at every target density before dynamic symbols.');
}
function userStop(): void {
  aborted = true; send({type: 'command', action: 'tiled-physical-stop'}); if (role === 'receiver') stopCamera(); senderRunning = false; cancelAnimationFrame(senderFrameHandle);
  startButton.disabled = false; stopButton.disabled = true; progress.textContent = 'stopped'; log('stopped by user');
}
startButton.addEventListener('click', () => { if (role === 'receiver') void receiverStart().catch(error => log(`camera error: ${String(error)}`)); });
stopButton.addEventListener('click', userStop);

if (role === 'sender') {
  document.body.classList.add('sender-mode'); senderCanvas.parentElement!.hidden = false; roleTitle.textContent = 'TF-007 tiled sender v3';
  roleText.textContent = '手机 Start 后自动完成方向训练、每密度光学 preamble、动态 sweep；电脑端无需点击。';
} else if (role === 'receiver') {
  document.body.classList.add('receiver-mode'); senderCanvas.parentElement!.hidden = true; roleTitle.textContent = 'TF-007 phone receiver v3';
  roleText.textContent = '保持完整电脑发射区域在取景框内，只点一次 Start。每个密度都会先用同密度光学 preamble 重新校准。';
} else {
  document.body.classList.add('both-mode'); senderCanvas.parentElement!.hidden = true; receiverView.hidden = false; startButton.disabled = true; roleTitle.textContent = 'Open role-specific TF-007 v3 URLs';
}
clearSender();
connect();
