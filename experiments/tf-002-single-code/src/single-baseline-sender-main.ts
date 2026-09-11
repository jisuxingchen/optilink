/**
 * TF-012 r4 — Single-Code Baseline Sender 单码基线发送端.
 *
 * ONE OptiGrid on screen, one chunk at a time, cycled forever:
 *
 *   Start → chunk 0 → chunk 1 → … → chunk 15 → chunk 0 → …
 *   Stop  → freeze (the current chunk stays on screen)
 *   Start → restarts from chunk 0
 *
 * Stateless: no ACK, no retransmission request, no receiver feedback, no
 * network payload, no knowledge of the receiver. The PO stops it manually.
 *
 * Everything the receiver needs is inside each chunk: fileId, fileName,
 * totalFileBytes, totalChunks, chunkIndex, chunkDataBytes, reconstructionMethod
 * and fileSha256. No Manifest frame, no Preamble dependency, no Fountain symbol,
 * no 3-tile composition, no speed optimisation.
 */
import {
  SINGLE_BASELINE_MATRIX,
  SINGLE_BASELINE_RECONSTRUCTION_METHOD,
  buildSingleBaselineTransfer,
} from './optical-core/single-baseline.ts';

const params = new URLSearchParams(location.search);
const holdMs = Math.min(60000, Math.max(100, Number.parseInt(params.get('holdMs') ?? '1000', 10) || 1000));
const quietCells = Math.max(2, Math.min(6, Number.parseInt(params.get('quiet') ?? '3', 10) || 3));

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const canvas = $<HTMLCanvasElement>('codeCanvas');
const panel = $<HTMLElement>('panel');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
const hideButton = $<HTMLButtonElement>('hideButton');
const broadcastStatus = $<HTMLElement>('broadcastStatus');
const fileNameCell = $<HTMLElement>('fileName');
const fileSizeCell = $<HTMLElement>('fileSize');
const fileShaCell = $<HTMLElement>('fileSha');
const fileIdCell = $<HTMLElement>('fileId');
const totalChunksCell = $<HTMLElement>('totalChunks');
const currentChunkCell = $<HTMLElement>('currentChunk');
const chunkDataCell = $<HTMLElement>('chunkData');
const chunkPayloadCell = $<HTMLElement>('chunkPayload');
const matrixCell = $<HTMLElement>('matrixSize');
const holdTimeCell = $<HTMLElement>('holdTime');
const cycleCountCell = $<HTMLElement>('cycleCount');
const statusTextCell = $<HTMLElement>('statusText');
const diagnosticRow = $<HTMLElement>('diagnosticRow');
const heldChunkRow = $<HTMLElement>('heldChunkRow');
const diagnosticModeCell = $<HTMLElement>('diagnosticMode');
const heldChunkCell = $<HTMLElement>('heldChunk');
const panelTitle = $<HTMLElement>('panelTitle');

const contextMaybe = canvas.getContext('2d', {alpha: false});
if (!contextMaybe) throw new Error('canvas 2D context unavailable');
const context: CanvasRenderingContext2D = contextMaybe;

const transfer = buildSingleBaselineTransfer();
const matrixSize = transfer.matrixSize;
const totalCells = matrixSize + quietCells * 2;

/**
 * Diagnostic mode (?diagnostic=chunk0): hold ONE known chunk indefinitely so the
 * receiver's G7a→G7d locator can be brought up without any cycle timing
 * dependency. The encoding is byte-identical to the cyclic baseline — only the
 * advance-on-timer behaviour is disabled.
 */
function parseHeldChunk(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^(?:chunk)?([0-9]+)$/iu.exec(raw.trim());
  if (!match) return 0;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return 0;
  return Math.min(transfer.totalChunks - 1, Math.max(0, index));
}

const heldChunk = parseHeldChunk(params.get('diagnostic'));
const diagnosticMode = heldChunk !== null;

let cursor = 0;
let cycleCount = 0;
let broadcasting = false;
let timer: number | null = null;
let cellPixels = 10;

function layout(): void {
  const stage = Math.min(window.innerWidth, window.innerHeight) * 0.98;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  cellPixels = Math.max(2, Math.floor((stage * dpr) / totalCells));
  const pixels = cellPixels * totalCells;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${Math.round(pixels / dpr)}px`;
  canvas.style.height = `${Math.round(pixels / dpr)}px`;
}

/** Draw exactly ONE OptiGrid: white quiet zone, 1:1 module pixels, no scaling blur. */
function drawChunk(chunkIndex: number): void {
  const cells = transfer.frames[chunkIndex];
  const pixels = canvas.width;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixels, pixels);
  const origin = quietCells * cellPixels;
  for (let row = 0; row < matrixSize; row += 1) {
    let runStart = -1;
    for (let column = 0; column <= matrixSize; column += 1) {
      const black = column < matrixSize && cells[row * matrixSize + column] === 1;
      if (black && runStart < 0) runStart = column;
      if (!black && runStart >= 0) {
        context.fillStyle = '#000000';
        context.fillRect(origin + runStart * cellPixels, origin + row * cellPixels, (column - runStart) * cellPixels, cellPixels);
        runStart = -1;
      }
    }
  }
}

function updateReadout(): void {
  const current = diagnosticMode ? (heldChunk as number) : cursor % transfer.totalChunks;
  currentChunkCell.textContent = `${current} / ${transfer.totalChunks - 1}`;
  cycleCountCell.textContent = String(cycleCount);
  const label = diagnosticMode
    ? (broadcasting ? 'Holding / 固定中' : 'Stopped / 已停止')
    : (broadcasting ? 'Broadcasting / 广播中' : 'Stopped / 已停止');
  statusTextCell.textContent = label;
  broadcastStatus.textContent = label;
  broadcastStatus.className = broadcasting ? 'live' : 'stopped';
}

function renderCurrent(): void {
  drawChunk(diagnosticMode ? (heldChunk as number) : cursor % transfer.totalChunks);
  updateReadout();
}

function stopBroadcast(): void {
  broadcasting = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  updateReadout();
}

/**
 * One broadcast step: advance the cycle cursor, then show that chunk.
 * Start already shows chunk 0, so the visible sequence is 0,1,…,15,0,1,…
 * (a full cycle lasts exactly totalChunks × holdMs).
 */
function step(): void {
  cursor += 1;
  if (cursor >= transfer.totalChunks) {
    cursor = 0;
    cycleCount += 1;
  }
  renderCurrent();
}

function startBroadcast(): void {
  stopBroadcast();
  cycleCount = 0;
  broadcasting = true;
  startButton.disabled = true;
  stopButton.disabled = false;
  if (diagnosticMode) {
    // Static diagnostic mode: ONE known chunk, held indefinitely, no timer.
    cursor = heldChunk as number;
    renderCurrent();
    return;
  }
  cursor = 0;
  renderCurrent();
  timer = window.setInterval(step, holdMs);
}

function stopAndFreeze(): void {
  stopBroadcast();
  startButton.disabled = false;
  stopButton.disabled = true;
}

startButton.addEventListener('click', startBroadcast);
stopButton.addEventListener('click', stopAndFreeze);
hideButton.addEventListener('click', () => {
  panel.classList.toggle('hidden');
  hideButton.textContent = panel.classList.contains('hidden') ? 'Show / 显示' : 'Hide / 隐藏';
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'h' || event.key === 'H') {
    panel.classList.toggle('hidden');
    hideButton.textContent = panel.classList.contains('hidden') ? 'Show / 显示' : 'Hide / 隐藏';
  }
});
window.addEventListener('resize', () => {
  layout();
  renderCurrent();
});

fileNameCell.textContent = transfer.fileName;
fileSizeCell.textContent = `${transfer.totalFileBytes} bytes`;
fileShaCell.textContent = transfer.fileSha256Hex;
fileIdCell.textContent = `0x${transfer.fileId.toString(16).padStart(8, '0')}`;
totalChunksCell.textContent = String(transfer.totalChunks);
chunkDataCell.textContent = `${transfer.chunkDataBytes} bytes`;
chunkPayloadCell.textContent = `${transfer.payloadBytes} / ${transfer.optigridCapacityBytes} bytes`;
matrixCell.textContent = `${matrixSize} × ${matrixSize}`;
holdTimeCell.textContent = diagnosticMode ? 'static (diagnostic)' : `${holdMs} ms`;
if (diagnosticMode) {
  diagnosticRow.hidden = false;
  heldChunkRow.hidden = false;
  diagnosticModeCell.textContent = 'Static hold / 静态固定';
  heldChunkCell.textContent = String(heldChunk);
  panelTitle.textContent = 'TF-012 Single-Code Baseline · Diagnostic 诊断模式';
}
updateReadout();

layout();
renderCurrent();

// Harness / diagnostic surface (read-only intent): the PO can verify the exact
// transfer identity and force a chunk for physical debugging.
(window as unknown as Record<string, unknown>).__SINGLE_BASELINE_SENDER__ = {
  payload: {
    protocol: 'SB',
    fileName: transfer.fileName,
    totalFileBytes: transfer.totalFileBytes,
    totalChunks: transfer.totalChunks,
    chunkDataBytes: transfer.chunkDataBytes,
    payloadBytes: transfer.payloadBytes,
    matrixSize,
    fileId: transfer.fileId,
    fileSha256: transfer.fileSha256Hex,
    reconstructionMethod: SINGLE_BASELINE_RECONSTRUCTION_METHOD,
    holdMs,
    quietCells,
    diagnosticMode,
    heldChunk: diagnosticMode ? heldChunk : null,
  },
  state: () => ({broadcasting, cursor: diagnosticMode ? (heldChunk as number) : cursor, cycleCount, holdMs, diagnosticMode}),
  start: startBroadcast,
  stop: stopAndFreeze,
  showChunk: (index: number) => {
    cursor = ((index % transfer.totalChunks) + transfer.totalChunks) % transfer.totalChunks;
    renderCurrent();
  },
};
