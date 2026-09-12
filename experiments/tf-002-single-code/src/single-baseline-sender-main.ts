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

// The compact pill is the ONE overlay that stays on screen while broadcasting, so
// its geometry is part of the optical budget: it is docked to the very bottom edge
// and capped at this height, and layout() proves it fits in the free band below
// the carrier before it is ever shown.
const PILL_HEIGHT_PX = 24;
const PILL_DOCK_PX = 2;

function layout(): void {
  const stage = Math.min(window.innerWidth, window.innerHeight) * 0.98;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  cellPixels = Math.max(2, Math.floor((stage * dpr) / totalCells));
  const pixels = cellPixels * totalCells;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${Math.round(pixels / dpr)}px`;
  canvas.style.height = `${Math.round(pixels / dpr)}px`;
  // layout() floors to whole cells, so the centred carrier leaves a free band of
  // (viewport - canvas) / 2 above and below it. The pill lives in the bottom band.
  const freeBand = (window.innerHeight - Math.round(pixels / dpr)) / 2;
  pillFits = freeBand >= PILL_HEIGHT_PX + PILL_DOCK_PX + 1;
  updateRenderSize();
  applyOverlayVisibility();
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
// r10 overlay policy — the optical carrier is never covered while measuring
// ---------------------------------------------------------------------------
//
// MEASURED PROBLEM: the control panel is a fixed overlay, so at common window sizes
// it covered part of the code (r8: 3.9-15.8 % of the canvas area, r9: 5.3-21.2 %
// because the hold-time controls made it 170 px taller). A covered carrier cannot be
// decoded reliably, so the controls must get out of the way:
//
//   broadcasting  → control panel and hint HIDDEN; only the compact pill remains,
//                   docked to the bottom edge strictly BELOW the carrier (0 %)
//   stopped       → panel + hint visible; the long file table stays collapsed
//   optical full  → panel + hint hidden as well, for an unobstructed shot
//
// The carrier's own size is NOT affected by any of this: layout() depends only on
// the viewport, so hiding the UI can never change the established code size. This is
// asserted by the r10 layout regression tests.

let overlaysHidden = false;
let autoHiddenForBroadcast = false;
let opticalFullscreen = false;
/** Set by layout(): false when the viewport is too short for the pill to clear the carrier. */
let pillFits = true;

function setPanelHidden(hidden: boolean): void {
  panel.classList.toggle('hidden', hidden);
  hideButton.textContent = hidden ? 'Show / 显示' : 'Hide / 隐藏';
}

/** Apply the one overlay policy. Called from start/stop and the toggles. */
function applyOverlayVisibility(): void {
  if (opticalFullscreen) {
    setPanelHidden(true);
    hintBox.classList.add('hidden');
  } else {
    // Starting a broadcast is what HIDES the controls (it sets overlaysHidden), so
    // this is purely the user's current overlay choice. The Show button on the pill
    // therefore really brings the controls back — even mid-broadcast — which is how
    // a PO changes the hold time without hunting for a hidden panel.
    setPanelHidden(overlaysHidden);
    hintBox.classList.toggle('hidden', overlaysHidden);
  }
  // The compact pill lives in the bottom-right margin, which the centred carrier
  // never reaches — measured at 0% overlap at every tested viewport. It therefore
  // stays available whenever there is something to control, and it is the ONLY way
  // back out of optical fullscreen. Hiding it would trap a PO with no visible exit.
  // If the viewport is too short to clear the carrier, the pill is dropped entirely
  // and the keyboard shortcuts (F / S) remain the control path.
  pill.classList.toggle('hidden', !pillFits || !(broadcasting || opticalFullscreen));
  pillShowButton.textContent = opticalFullscreen ? 'Exit Fullscreen / 退出全屏' : 'Controls / 控制';
  pillStatus.textContent = broadcasting ? 'Broadcasting / 广播中' : 'Stopped / 已停止';
  pillHold.textContent = diagnosticMode ? 'diagnostic' : `${holdMs} ms`;
}

/** Optical Fullscreen / 光学全屏: hide every overlay so only the code is on screen. */
function toggleOpticalFullscreen(force?: boolean): void {
  opticalFullscreen = force === undefined ? !opticalFullscreen : force;
  fullscreenButton.textContent = opticalFullscreen
    ? 'Exit Fullscreen / 退出全屏'
    : 'Optical Fullscreen / 光学全屏';
  applyOverlayVisibility();
}

function stopBroadcast(): void {
  broadcasting = false;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  startButton.disabled = false;
  stopButton.disabled = true;
  if (autoHiddenForBroadcast) {
    autoHiddenForBroadcast = false;
    overlaysHidden = false;
  }
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
  // r10: the controls get out of the way for the whole measurement, so no overlay
  // can ever cover the optical carrier while the phone is decoding.
  autoHiddenForBroadcast = true;
  overlaysHidden = true;
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

/** Manual Show/Hide of the control panel; also leaves the automatic policy. */
function togglePanel(): void {
  overlaysHidden = !panel.classList.contains('hidden');
  autoHiddenForBroadcast = false;
  if (opticalFullscreen) toggleOpticalFullscreen(false);
  applyOverlayVisibility();
}

startButton.addEventListener('click', startBroadcast);
stopButton.addEventListener('click', stopAndFreeze);
hideButton.addEventListener('click', togglePanel);
fullscreenButton.addEventListener('click', () => toggleOpticalFullscreen());
detailsButton.addEventListener('click', () => {
  detailsBox.classList.toggle('hidden');
  detailsButton.textContent = detailsBox.classList.contains('hidden') ? 'Details / 详情' : 'Hide details / 收起详情';
});
pillStopButton.addEventListener('click', stopAndFreeze);
pillShowButton.addEventListener('click', () => {
  // In optical fullscreen this button is the visible way out; the panel button is
  // hidden by definition in that mode.
  const wasFullscreen = opticalFullscreen;
  overlaysHidden = false;
  autoHiddenForBroadcast = false;
  if (wasFullscreen) {
    toggleOpticalFullscreen(false);
  }
  applyOverlayVisibility();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'h' || event.key === 'H') {
    togglePanel();
  } else if (event.key === 'f' || event.key === 'F') {
    toggleOpticalFullscreen();
  } else if (event.key === 's' || event.key === 'S') {
    // Pair for every toggle: this is the guaranteed control path even when the
    // pill is dropped because the viewport is too short to clear the carrier.
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
    // r10: overlay policy + display-side geometry, so a test can prove the carrier
    // is neither resized nor covered when the benchmark UI is present.
    panelHidden: panel.classList.contains('hidden'),
    hintHidden: hintBox.classList.contains('hidden'),
    pillHidden: pill.classList.contains('hidden'),
    pillFits,
    opticalFullscreen,
    canvasDevicePx: canvas.width,
    cellPixels,
    renderSizeText: renderSizeCell.textContent,
  }),
  setHoldMs: (value: number) => applyHoldMs(value),
  togglePanel,
  toggleOpticalFullscreen,
  start: startBroadcast,
  stop: stopAndFreeze,
  showChunk: (index: number) => {
    cursor = ((index % transfer.totalChunks) + transfer.totalChunks) % transfer.totalChunks;
    renderCurrent();
  },
};
