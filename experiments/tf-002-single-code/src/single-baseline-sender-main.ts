/**
 * TF-012 r6 — Single-Code Baseline Sender 单码基线发送端 (speed ladder).
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
 *
 * r6 adds NOTHING to the protocol. The only new degree of freedom is `holdMs`
 * (how long one chunk stays on screen), so the stable speed limit of the CURRENT
 * architecture can be characterised before anything is optimised:
 *
 *   single-baseline.html?holdMs=100
 *
 * The readout prints three deliberately separate numbers: the declared hold
 * time, the THEORETICAL chunk rate and the THEORETICAL gross file-payload rate.
 * The last two are arithmetic on the hold timer — they are NOT measurements, NOT
 * Net Goodput and NOT optical throughput. Only a complete SHA-256-exact phone run
 * may produce a goodput number, and that number comes from the receiver.
 */
import {
  SINGLE_BASELINE_MATRIX,
  SINGLE_BASELINE_RECONSTRUCTION_METHOD,
  SINGLE_BASELINE_HOLD_MS_LADDER,
  SINGLE_BASELINE_HOLD_MS_PRESETS,
  SINGLE_BASELINE_STAGE_B_LADDER,
  buildSingleBaselineTransfer,
  clampSingleBaselineHoldMs,
  singleBaselineBenchmark,
} from './optical-core/single-baseline.ts';

const params = new URLSearchParams(location.search);
// Speed ladder: 1500 … 33 ms. Values outside the ladder are still honoured
// (Stage B needs 125/100/90/80), only the hard bounds are clamped.
// r9: mutable — the visible dropdown owns it after load, and the URL stays the
// entry point (?holdMs=75) and is kept in sync when the dropdown changes.
let holdMs = clampSingleBaselineHoldMs(params.get('holdMs'), 1000);
const quietCells = Math.max(2, Math.min(6, Number.parseInt(params.get('quiet') ?? '3', 10) || 3));
let benchmark = singleBaselineBenchmark(holdMs);

/** 750 ms is only ever re-tested to decide whether the Stage A run was an outlier. */
const OUTLIER_HOLD_MS = 750;
const STAGE_B_VALUES: readonly number[] = SINGLE_BASELINE_STAGE_B_LADDER;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const canvas = $<HTMLCanvasElement>('codeCanvas');
const panel = $<HTMLElement>('panel');
const stageBox = $<HTMLElement>('stage');
const statusBar = $<HTMLElement>('statusbar');
const startButton = $<HTMLButtonElement>('startButton');
const stopButton = $<HTMLButtonElement>('stopButton');
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
const chunkRateCell = $<HTMLElement>('chunkRate');
const payloadRateCell = $<HTMLElement>('payloadRate');
const ladderCell = $<HTMLElement>('ladder');
const stageBCell = $<HTMLElement>('stageB');
const cycleCountCell = $<HTMLElement>('cycleCount');
const statusTextCell = $<HTMLElement>('statusText');
const diagnosticRow = $<HTMLElement>('diagnosticRow');
const heldChunkRow = $<HTMLElement>('heldChunkRow');
const diagnosticModeCell = $<HTMLElement>('diagnosticMode');
const heldChunkCell = $<HTMLElement>('heldChunk');
const panelTitle = $<HTMLElement>('panelTitle');
const holdMsSelect = $<HTMLSelectElement>('holdMsSelect');
const holdApplyNote = $<HTMLElement>('holdApplyNote');
const renderSizeCell = $<HTMLElement>('renderSize');
const fullscreenButton = $<HTMLButtonElement>('fullscreenButton');
const detailsButton = $<HTMLButtonElement>('detailsButton');
const detailsBox = $<HTMLElement>('details');
const hintBox = $<HTMLElement>('hint');
const pill = $<HTMLElement>('pill');
const pillStatus = $<HTMLElement>('pillStatus');
const pillHold = $<HTMLElement>('pillHold');
const pillStopButton = $<HTMLButtonElement>('pillStop');
const pillShowButton = $<HTMLButtonElement>('pillShow');

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

// ---------------------------------------------------------------------------
// r11 carrier layout — nothing on this page may overlap the OptiGrid
// ---------------------------------------------------------------------------
//
// MEASURED PROBLEM (r8 / r9 / r10): every control was a fixed overlay, so at common
// window sizes the panel or the help text covered part of the code (r8: 3.9-15.8 %,
// r9: 5.3-21.2 % of the canvas area) and the PO's screenshot showed the bottom-right
// help text sitting on the carrier. A covered carrier cannot be decoded reliably.
//
// r11 removes the overlay approach entirely: the page is a two-column flex layout,
// the sidebar is outside the stage, and the control strip is a normal flow element
// in a band BELOW the carrier that the carrier is sized to leave free. Nothing is
// `position:fixed` / `absolute` over the canvas any more, so the overlap is 0 by
// construction in every state and at every viewport.

/** The band the control strip occupies below the carrier, in CSS px. */
const STATUS_BAR_PX = 30;
/** The compact strip's own height; it must fit inside STATUS_BAR_PX. */
const PILL_HEIGHT_PX = 24;

let opticalFullscreen = false;
/** Defensive: true when the reserved band can hold the strip without touching the code. */
let pillFits = true;

function layout(): void {
  const box = stageBox.getBoundingClientRect();
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // The carrier is sized from the STAGE box with the reserved strip band subtracted,
  // so it can never grow into that band. The stage's own size does not depend on the
  // canvas (it is a fixed-height flex column with overflow hidden), so this cannot
  // feed back into itself.
  const available = Math.min(box.width, Math.max(0, box.height - STATUS_BAR_PX)) * 0.98;
  cellPixels = Math.max(2, Math.floor((available * dpr) / totalCells));
  const pixels = cellPixels * totalCells;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${Math.round(pixels / dpr)}px`;
  canvas.style.height = `${Math.round(pixels / dpr)}px`;
  pillFits = statusBar.getBoundingClientRect().height >= PILL_HEIGHT_PX;
  updateRenderSize();
}

/**
 * r10 display-side readout. This reports the SENDER's own render geometry only —
 * it is not, and must never be presented as, the camera-observed code size.
 */
function updateRenderSize(): void {
  const cssSize = Math.round(canvas.width / Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
  const innerCells = matrixSize;
  const innerCss = Math.round((canvas.width / totalCells) * innerCells / Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
  renderSizeCell.innerHTML = 'Rendered code size / 码显示尺寸 <b>' + canvas.width + '×' + canvas.width
    + '</b> canvas device px · <b>' + cssSize + '×' + cssSize + '</b> CSS px (incl. quiet zone) · '
    + 'OptiGrid core <b>' + innerCss + '×' + innerCss + '</b> CSS px · <b>' + cellPixels
    + '</b> device px/cell — display side only, NOT the camera-observed size';
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
  pillStatus.textContent = label;
  pillHold.textContent = diagnosticMode ? 'diagnostic' : `${holdMs} ms`;
}

function renderCurrent(): void {
  drawChunk(diagnosticMode ? (heldChunk as number) : cursor % transfer.totalChunks);
  updateReadout();
}

// ---------------------------------------------------------------------------
// r11 visibility policy — what is on screen per state
// ---------------------------------------------------------------------------
//
//   stopped      → sidebar visible (controls + readout + help), strip hidden
//   broadcasting → sidebar STILL visible (it is outside the carrier, so it is not
//                  an obstruction and the PO keeps the live readout); the help text
//                  disappears because it is non-essential; the strip below the
//                  carrier shows the state and Stop
//   fullscreen   → sidebar hidden so the carrier owns the whole width; the help is
//                  gone with it; the strip keeps ONLY the out-of-carrier Stop and
//                  Exit controls — every word of explanatory text is hidden
//
// In no state is any of this drawn over the carrier: the sidebar is a separate
// column and the strip is in the reserved band below the canvas.

/** Apply the one visibility policy. Called from start/stop and the fullscreen toggle. */
function applyOverlayVisibility(): void {
  panel.classList.toggle('hidden', opticalFullscreen);
  // Non-essential explanatory text disappears as soon as the code is on screen.
  hintBox.classList.toggle('hidden', broadcasting || opticalFullscreen);
  // The strip is needed whenever the code is on screen (Stop) or when the sidebar is
  // gone (Exit). When idle and not fullscreen the sidebar already has both buttons.
  pill.classList.toggle('hidden', !pillFits || !(broadcasting || opticalFullscreen));
  pillStopButton.disabled = !broadcasting;
  pillShowButton.classList.toggle('hidden', !opticalFullscreen);
  pillStatus.classList.toggle('hidden', opticalFullscreen);
  pillHold.classList.toggle('hidden', opticalFullscreen);
}

/** Optical Fullscreen / 光学全屏: sidebar and help gone, only the OptiGrid plus an
 *  out-of-carrier Stop / Exit strip. The carrier is re-measured because the sidebar
 *  releases its column — it can only grow, never shrink. */
function toggleOpticalFullscreen(force?: boolean): void {
  opticalFullscreen = force === undefined ? !opticalFullscreen : force;
  fullscreenButton.textContent = opticalFullscreen
    ? 'Exit Fullscreen / 退出全屏'
    : 'Optical Fullscreen / 光学全屏';
  applyOverlayVisibility();
  layout();
  renderCurrent();
}

function stopBroadcast(): void {
  broadcasting = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  startButton.disabled = false;
  stopButton.disabled = true;
  applyOverlayVisibility();
  updateReadout();
}

// ---------------------------------------------------------------------------
// r9 hold-time selector
// ---------------------------------------------------------------------------
//
// The hold time is the ONLY degree of freedom in this benchmark, so it must be
// visibly selectable rather than a URL-only value that a PO has to type.
//
// SAFETY: changing the hold time NEVER retimes a running broadcast. If the sender
// is broadcasting the change stops it first and tells the PO to press Start again,
// so a measurement can never span two different hold times and a cycle is never
// retimed halfway through. Nothing about the encoding, the chunk layout or the
// broadcast semantics changes — only the interval of the existing timer.

/**
 * The three numbers a PO must be able to read at a glance, always together and
 * always labelled as DECLARED arithmetic: the current hold time, the theoretical
 * chunk rate and the theoretical gross file-payload rate. None of them is a
 * measurement, none is Net Goodput and none is optical throughput.
 */
function renderHoldReadout(): void {
  holdTimeCell.textContent = diagnosticMode ? 'static (diagnostic)' : `${holdMs} ms`;
  chunkRateCell.textContent = diagnosticMode
    ? 'n/a (static hold)'
    : benchmark
      ? `${benchmark.theoreticalChunksPerSecond} chunk/s`
      : '—';
  payloadRateCell.textContent = diagnosticMode
    ? 'n/a (static hold)'
    : benchmark
      ? `${benchmark.theoreticalPayloadBytesPerSecond} B/s · ${benchmark.theoreticalPayloadKiBPerSecond} KiB/s`
      : '—';
}

/** Populate the dropdown: Stage B first, then the 750 ms outlier check, then the rest. */
function fillHoldMsSelect(): void {  const stageB = new Set<number>(STAGE_B_VALUES);
  const groups: Array<{label: string; values: number[]}> = [
    {label: 'Stage B recommended / 阶段B推荐', values: STAGE_B_VALUES.slice()},
    {label: 'Outlier check / 异常复检', values: [OUTLIER_HOLD_MS]},
    {
      label: 'Other ladder values / 其他阶梯值',
      values: SINGLE_BASELINE_HOLD_MS_PRESETS.filter(
        (value) => !stageB.has(value) && value !== OUTLIER_HOLD_MS,
      ),
    },
  ];
  holdMsSelect.textContent = '';
  for (const group of groups) {
    if (!group.values.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const value of group.values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} ms`;
      optgroup.appendChild(option);
    }
    holdMsSelect.appendChild(optgroup);
  }
}

/** Keep ?holdMs= meaningful after a dropdown change (convenience only). */
function syncHoldMsUrl(value: number): void {
  try {
    const url = new URL(location.href);
    url.searchParams.set('holdMs', String(value));
    window.history.replaceState(null, '', url.toString());
  } catch (err) {
    // URL sync is a convenience; the applied hold time is what matters.
  }
}

function setHoldNote(text: string, warn: boolean): void {
  holdApplyNote.textContent = text;
  holdApplyNote.className = warn ? 'holdnote warn' : 'holdnote';
}

/**
 * Apply a new hold time. Called from the dropdown, the harness and ?holdMs=.
 * Returns the value actually applied (clamped).
 */
function applyHoldMs(next: number): number {
  const applied = clampSingleBaselineHoldMs(next, holdMs);
  const wasBroadcasting = broadcasting;
  if (wasBroadcasting) {
    // Never retime a running broadcast mid-cycle.
    stopBroadcast();
  }
  holdMs = applied;
  benchmark = singleBaselineBenchmark(holdMs);
  holdMsSelect.value = String(holdMs);
  syncHoldMsUrl(holdMs);
  renderHoldReadout();
  setHoldNote(
    wasBroadcasting
      ? `Stopped and applied ${holdMs} ms — press Start again / 已停止并应用，请重新 Start`
      : 'Applied on the next Start / 下一次 Start 生效',
    wasBroadcasting,
  );
  renderCurrent();
  return holdMs;
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
  // r11: the code is on screen now, so the non-essential help text disappears. The
  // sidebar itself stays — it is a separate column and cannot cover the carrier.
  applyOverlayVisibility();
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

/** Stop button: freeze the current chunk on screen (the button state lives in stopBroadcast). */
function stopAndFreeze(): void {
  stopBroadcast();
}

startButton.addEventListener('click', startBroadcast);
stopButton.addEventListener('click', stopAndFreeze);
fullscreenButton.addEventListener('click', () => toggleOpticalFullscreen());
detailsButton.addEventListener('click', () => {
  detailsBox.classList.toggle('hidden');
  detailsButton.textContent = detailsBox.classList.contains('hidden') ? 'Details / 详情' : 'Hide details / 收起详情';
});
pillStopButton.addEventListener('click', stopAndFreeze);
pillShowButton.addEventListener('click', () => {
  // In optical fullscreen this button is the visible way out; the sidebar button is
  // hidden by definition in that mode.
  if (opticalFullscreen) toggleOpticalFullscreen(false);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') {
    toggleOpticalFullscreen();
  } else if (event.key === 's' || event.key === 'S') {
    // Pair for every toggle: this is the guaranteed control path even when the
    // viewport is too small for the strip.
    if (broadcasting) {
      stopAndFreeze();
    } else {
      startBroadcast();
    }
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
ladderCell.textContent = SINGLE_BASELINE_HOLD_MS_LADDER.join(' / ') + ' ms';
stageBCell.textContent = SINGLE_BASELINE_STAGE_B_LADDER.join(' / ') + ' ms';
renderHoldReadout();
if (diagnosticMode) {
  diagnosticRow.hidden = false;
  heldChunkRow.hidden = false;
  diagnosticModeCell.textContent = 'Static hold / 静态固定';
  heldChunkCell.textContent = String(heldChunk);
  panelTitle.textContent = 'TF-012 Single-Code Baseline · Diagnostic 诊断模式';
  setHoldNote('Static diagnostic hold — holdMs is ignored / 静态诊断模式，忽略 holdMs', false);
}
fillHoldMsSelect();
holdMsSelect.value = String(holdMs);
holdMsSelect.addEventListener('change', () => {
  applyHoldMs(Number.parseInt(holdMsSelect.value, 10));
});
applyOverlayVisibility();
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
    quietCells,
    diagnosticMode,
    heldChunk: diagnosticMode ? heldChunk : null,
    holdMs: holdMs,
    benchmark: diagnosticMode ? null : benchmark,
    // r9: the dropdown is the single source of truth for the declared hold time,
    // and it always offers the Stage B operating window plus the 750 ms outlier
    // check, independent of which value the URL asked for.
    stageBLadder: SINGLE_BASELINE_STAGE_B_LADDER.slice(),
    outlierHoldMs: OUTLIER_HOLD_MS,
    selectableHoldMs: Array.from(holdMsSelect.options).map((option) => Number.parseInt(option.value, 10)),
  },
  state: () => ({
    broadcasting,
    cursor: diagnosticMode ? (heldChunk as number) : cursor,
    cycleCount,
    holdMs,
    diagnosticMode,
    benchmark: diagnosticMode ? null : benchmark,
    stageBLadder: SINGLE_BASELINE_STAGE_B_LADDER.slice(),
    selectValue: holdMsSelect.value,
    applyNote: holdApplyNote.textContent,
    urlHoldMs: new URLSearchParams(location.search).get('holdMs'),
    // r11: visibility policy + display-side geometry, so a test can prove the
    // carrier is neither unexpectedly resized nor touched by any UI element.
    panelHidden: panel.classList.contains('hidden'),
    hintHidden: hintBox.classList.contains('hidden'),
    pillHidden: pill.classList.contains('hidden'),
    pillFits,
    opticalFullscreen,
    canvasDevicePx: canvas.width,
    cellPixels,
    stageWidth: Math.round(stageBox.getBoundingClientRect().width),
    stageHeight: Math.round(stageBox.getBoundingClientRect().height),
    statusBarPx: STATUS_BAR_PX,
    renderSizeText: renderSizeCell.textContent,
  }),
  setHoldMs: (value: number) => applyHoldMs(value),
  toggleOpticalFullscreen,
  relayout: () => layout(),
  start: startBroadcast,
  stop: stopAndFreeze,
  showChunk: (index: number) => {
    cursor = ((index % transfer.totalChunks) + transfer.totalChunks) % transfer.totalChunks;
    renderCurrent();
  },
};
