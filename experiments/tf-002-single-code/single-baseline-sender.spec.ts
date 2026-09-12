/**
 * TF-012 r6 — Single-Code Baseline sender acceptance (real browser, real canvas).
 *
 * Verifies the sender page itself, not just the shared protocol module:
 *  13  sender Start button starts a cyclic broadcast from chunk 0
 *  14  sender Stop button freezes the broadcast
 *  15  sender cycles 0..15 and wraps back to chunk 0 (the loop is deterministic)
 *  ·   every rendered canvas is a VALID OptiGrid v1 frame (sampled from the real
 *      canvas and CRC-decoded in Node against the shared payload builder)
 *  r5  ?diagnostic=chunk0 holds ONE known chunk with no timer (G7 bring-up)
 *  r6  ?holdMs= honours the whole speed ladder and the readout prints the
 *      DECLARED theoretical rates — never Net Goodput, never throughput
 */
import {test, expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {SINGLE_BASELINE_MATRIX, buildSingleBaselineTransfer} from './src/optical-core/single-baseline.ts';
import {decodeFrameCellsV1} from './src/optigrid-v1.ts';

const transfer = buildSingleBaselineTransfer();

type SenderState = {
  broadcasting: boolean;
  cursor: number;
  cycleCount: number;
  holdMs: number;
  diagnosticMode?: boolean;
  stageBLadder?: number[];
  selectValue?: string;
  applyNote?: string;
  urlHoldMs?: string | null;
  // r10 layout-regression surface.
  panelHidden?: boolean;
  hintHidden?: boolean;
  pillHidden?: boolean;
  pillFits?: boolean;
  paused?: boolean;
  opticalFullscreen?: boolean;
  canvasDevicePx?: number;
  cellPixels?: number;
  renderSizeText?: string;
};

declare global {
  interface Window {
    __SINGLE_BASELINE_SENDER__: {
      payload: {quietCells: number; diagnosticMode: boolean; heldChunk: number | null};
      state: () => SenderState;
      showChunk: (index: number) => void;
    };
  }
}

const state = async (page: Page): Promise<SenderState> =>
  (await page.evaluate(() => window.__SINGLE_BASELINE_SENDER__.state())) as SenderState;

const showChunk = async (page: Page, index: number): Promise<void> => {
  await page.evaluate((value: number) => window.__SINGLE_BASELINE_SENDER__.showChunk(value), index);
};

/**
 * r11: the carrier bounding box must not intersect ANY other visible element.
 *
 * This is deliberately generic — it walks the whole document instead of naming a
 * few ids, so a future `position:fixed` overlay (which is exactly what broke the
 * PO's physical run) fails the test automatically. Ancestors and descendants of
 * the canvas necessarily contain it and are skipped; zero-area and invisible
 * elements contribute nothing.
 *
 * Returns the worst offender with its intersection area in CSS px².
 */
async function carrierIntersection(page: Page): Promise<{total: number; worst: string; worstArea: number}> {
  return page.evaluate(() => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ancestors = new Set<Element>();
    for (let node: Element | null = canvas; node; node = node.parentElement) ancestors.add(node);

    let total = 0;
    let worst = '';
    let worstArea = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (ancestors.has(element)) continue;
      if (element.contains(canvas)) continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const width = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left));
      const height = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
      const area = Math.round(width * height);
      if (area <= 0) continue;
      total += area;
      if (area > worstArea) {
        worstArea = area;
        worst = `${element.tagName.toLowerCase()}#${element.id || ''}.${element.className || ''}`;
      }
    }
    return {total, worst, worstArea};
  });
}

/** Intersection area (CSS px²) of the carrier with one specific element. */
async function intersectionWith(page: Page, selector: string): Promise<number> {
  return page.evaluate((target: string) => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const node = document.querySelector<HTMLElement>(target);
    if (!node) return -1;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return 0;
    const rect = canvas.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const width = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left));
    const height = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
    return Math.round(width * height);
  }, selector);
}

/**
 * r11: the carrier is sized from the STAGE box — the viewport minus the sidebar — with
 * the reserved control-strip band subtracted, so the strip and the sidebar always live
 * outside it.
 */
function expectedCarrierPx(stageWidth: number, stageHeight: number, dpr: number, quietCells: number): number {
  const available = Math.min(stageWidth, stageHeight - 34) * 0.98;
  const scale = Math.min(2, Math.max(1, dpr));
  const totalCells = SINGLE_BASELINE_MATRIX + quietCells * 2;
  return Math.max(2, Math.floor((available * scale) / totalCells)) * totalCells;
}

/** Sample the real sender canvas at every cell centre (single readback). */
async function sampleCanvasCells(page: Page): Promise<Uint8Array> {
  const quiet = (await page.evaluate(() => window.__SINGLE_BASELINE_SENDER__.payload.quietCells)) as number;
  const cells = await page.evaluate(({matrixSize, quietCells}) => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const cellPx = canvas.width / (matrixSize + quietCells * 2);
    const origin = quietCells * cellPx;
    const out: number[] = [];
    for (let row = 0; row < matrixSize; row += 1) {
      for (let column = 0; column < matrixSize; column += 1) {
        const x = Math.min(canvas.width - 1, Math.floor(origin + (column + 0.5) * cellPx));
        const y = Math.min(canvas.height - 1, Math.floor(origin + (row + 0.5) * cellPx));
        const offset = (y * canvas.width + x) * 4;
        out.push(image.data[offset] < 128 ? 1 : 0);
      }
    }
    return out;
  }, {matrixSize: SINGLE_BASELINE_MATRIX, quietCells: quiet});
  return Uint8Array.from(cells);
}

test('sender renders ONE valid OptiGrid per chunk and cycles deterministically', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=150');

  // Sender readout reports the frozen baseline identity.
  await expect(page.locator('#fileName')).toHaveText('baseline-10k.txt');
  await expect(page.locator('#fileSize')).toHaveText('10240 bytes');
  await expect(page.locator('#totalChunks')).toHaveText('16');
  await expect(page.locator('#chunkData')).toHaveText('640 bytes');
  await expect(page.locator('#chunkPayload')).toHaveText('706 / 708 bytes');
  await expect(page.locator('#matrixSize')).toHaveText('96 × 96');
  await expect(page.locator('#fileSha')).toHaveText(transfer.fileSha256Hex);
  await expect(page.locator('#statusText')).toHaveText('Stopped / 已停止');

  // Before Start the sender is stopped but already shows chunk 0.
  expect((await state(page)).broadcasting).toBe(false);
  await expect(page.locator('#currentChunk')).toHaveText('0 / 15');

  const hashes: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    await showChunk(page, index);
    const cells = await sampleCanvasCells(page);
    // Every rendered canvas is a real OptiGrid v1 frame with a valid CRC.
    const decoded = decodeFrameCellsV1(cells, SINGLE_BASELINE_MATRIX);
    expect(decoded, 'chunk ' + index + ' canvas must be a valid OptiGrid frame').not.toBeNull();
    expect(Array.from(decoded!.payload), 'chunk ' + index + ' payload must match the shared builder')
      .toEqual(Array.from(transfer.payloads[index]));
    expect(decoded!.sequence & 0xffff).toBe(index);
    hashes.push(Buffer.from(cells).toString('base64'));
  }
  expect(new Set(hashes).size, 'all 16 chunks render distinct frames').toBe(16);

  // Item 15 · the cyclic loop wraps 15 → 0 with byte-identical rendering.
  await showChunk(page, 0);
  const chunkZero = await sampleCanvasCells(page);
  expect(Buffer.from(chunkZero).toString('base64')).toBe(hashes[0]);

  // Item 13 · Start begins a cyclic broadcast at chunk 0.
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  const afterStart = await state(page);
  expect(afterStart.broadcasting).toBe(true);
  expect(afterStart.cycleCount).toBe(0);
  expect(afterStart.cursor).toBe(0);

  // The broadcast really advances by itself, without any external driver.
  await page.waitForFunction(
    () => window.__SINGLE_BASELINE_SENDER__.state().cycleCount >= 1,
    null,
    {timeout: 30_000},
  );
  const looped = await state(page);
  expect(looped.cycleCount).toBeGreaterThanOrEqual(1);
  expect(looped.cursor).toBeLessThan(16);
  // The visible readout tracks the broadcast (it refreshes once per hold).
  await expect(page.locator('#cycleCount')).not.toHaveText('0');
  await expect(page.locator('#currentChunk')).toHaveText(looped.cursor + ' / 15');

  // Item 14 · Stop freezes the broadcast and the displayed chunk. The panel is
  // auto-hidden while broadcasting, so the pill is the stop control that is
  // actually on screen — exactly what the PO uses.
  await page.locator('#pillStop').click();
  const stopped = await state(page);
  expect(stopped.broadcasting).toBe(false);
  await expect(page.locator('#statusText')).toHaveText('Stopped / 已停止');
  const frozen = await sampleCanvasCells(page);
  await page.waitForTimeout(600);
  expect(await state(page)).toEqual(stopped);
  expect(Buffer.from(await sampleCanvasCells(page)).toString('base64')).toBe(Buffer.from(frozen).toString('base64'));

  // Start again restarts from chunk 0.
  await page.locator('#startButton').click();
  const restarted = await state(page);
  expect(restarted.broadcasting).toBe(true);
  expect(restarted.cycleCount).toBe(0);
  expect(restarted.cursor).toBe(0);
  expect(Buffer.from(await sampleCanvasCells(page)).toString('base64')).toBe(hashes[0]);
  await page.locator('#pillStop').click();
  expect((await state(page)).broadcasting).toBe(false);
});

test('diagnostic mode holds ONE known chunk indefinitely (?diagnostic=chunk0)', async ({page}) => {
  await page.goto('/single-baseline.html?diagnostic=chunk0');

  // The UI declares diagnostic mode and the held chunk.
  await expect(page.locator('#panelTitle')).toHaveText('TF-012 Single-Code Baseline · Diagnostic 诊断模式');
  await expect(page.locator('#diagnosticMode')).toHaveText('Static hold / 静态固定');
  await expect(page.locator('#heldChunk')).toHaveText('0');
  await expect(page.locator('#holdTime')).toHaveText('static (diagnostic)');
  await expect(page.locator('#currentChunk')).toHaveText('0 / 15');
  expect((await state(page)).diagnosticMode).toBe(true);

  // The held canvas is a real, CRC-valid chunk-0 OptiGrid (same encoding as baseline).
  const before = Buffer.from(await sampleCanvasCells(page)).toString('base64');
  const decoded = decodeFrameCellsV1(Uint8Array.from(Buffer.from(before, 'base64')), SINGLE_BASELINE_MATRIX);
  expect(decoded).not.toBeNull();
  expect(decoded!.sequence & 0xffff).toBe(0);

  // Start holds it: no timer, no advance, cycle count stays 0.
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Holding / 固定中');
  const started = await state(page);
  expect(started.broadcasting).toBe(true);
  expect(started.cycleCount).toBe(0);
  expect(started.cursor).toBe(0);
  await page.waitForTimeout(2500);
  const held = await state(page);
  expect(held.cursor).toBe(0);
  expect(held.cycleCount).toBe(0);
  expect(Buffer.from(await sampleCanvasCells(page)).toString('base64')).toBe(before);

  await page.locator('#pillStop').click();
  expect((await state(page)).broadcasting).toBe(false);
  await expect(page.locator('#statusText')).toHaveText('Stopped / 已停止');
});

/**
 * TF-012 r6 speed ladder. The only new degree of freedom is the hold duration,
 * so the sender must (a) honour every ladder value through the URL and (b) show
 * the DECLARED theoretical rates without ever calling them Net Goodput.
 */
test('speed ladder: holdMs is honoured from the URL and theoretical rates are declared', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=100');

  await expect(page.locator('#holdTime')).toHaveText('100 ms');
  await expect(page.locator('#chunkRate')).toHaveText('10 chunk/s');
  await expect(page.locator('#payloadRate')).toHaveText('6400 B/s · 6.25 KiB/s');
  expect((await state(page)).holdMs).toBe(100);

  // The full ladder is advertised on the page (not a single hard-coded value).
  await expect(page.locator('#ladder')).toHaveText('1500 / 1000 / 750 / 500 / 333 / 250 / 200 / 150 / 100 / 75 / 50 / 33 ms');
  // TF-012 r7: the Stage B operating-window set is advertised too, and 125/80 are
  // deliberately absent until Stage B results justify them.
  await expect(page.locator('#stageB')).toHaveText('100 / 90 / 75 / 60 / 50 / 40 ms');
  expect((await state(page)).stageBLadder).toEqual([100, 90, 75, 60, 50, 40]);

  // The URL is the source of truth, and the broadcast really uses that period.
  await page.goto('/single-baseline.html?holdMs=250');
  await expect(page.locator('#holdTime')).toHaveText('250 ms');
  await expect(page.locator('#chunkRate')).toHaveText('4 chunk/s');
  await expect(page.locator('#payloadRate')).toHaveText('2560 B/s · 2.5 KiB/s');
  expect((await state(page)).holdMs).toBe(250);

  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  // ~4 chunks/s: a full cycle (16 chunks) is ~4 s, so a 0.9 s window cannot
  // finish a cycle and must have advanced at least twice.
  await page.waitForTimeout(900);
  const running = await state(page);
  expect(running.broadcasting).toBe(true);
  expect(running.cycleCount).toBe(0);
  expect(running.cursor, 'the 250 ms period really advances the cycle').toBeGreaterThanOrEqual(2);
  await page.locator('#pillStop').click();
});

test('speed ladder: the fast end is not silently clamped to 100 ms', async ({page}) => {
  for (const [holdMs, chunksPerSecond] of [[75, '13.333'], [50, '20'], [33, '30.303']] as Array<[number, string]>) {
    await page.goto('/single-baseline.html?holdMs=' + holdMs);
    await expect(page.locator('#holdTime')).toHaveText(holdMs + ' ms');
    await expect(page.locator('#chunkRate')).toHaveText(chunksPerSecond + ' chunk/s');
    expect((await state(page)).holdMs, 'holdMs ' + holdMs + ' must reach the sender unclamped').toBe(holdMs);
  }
});

test('speed ladder: every Stage B value is reachable through the URL', async ({page}) => {
  for (const holdMs of [100, 90, 75, 60, 50, 40]) {
    await page.goto('/single-baseline.html?holdMs=' + holdMs);
    await expect(page.locator('#holdTime')).toHaveText(holdMs + ' ms');
    expect((await state(page)).holdMs, 'Stage B ' + holdMs + ' ms must be reachable').toBe(holdMs);
  }
  // Stage B deliberately excludes these for now: they are only introduced if the
  // Stage B results justify an interpolation.
  for (const excluded of [125, 80]) {
    await page.goto('/single-baseline.html?holdMs=' + excluded);
    await expect(page.locator('#stageB')).not.toContainText(String(excluded));
  }
});

test('speed ladder: diagnostic static hold reports no theoretical rate', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=100&diagnostic=chunk0');
  await expect(page.locator('#holdTime')).toHaveText('static (diagnostic)');
  await expect(page.locator('#chunkRate')).toHaveText('n/a (static hold)');
  await expect(page.locator('#payloadRate')).toHaveText('n/a (static hold)');
  // A static hold has no chunk rate, so no rate may be reported.
  const url = new URL(page.url());
  expect(url.searchParams.get('holdMs')).toBe('100');
});

/** The Stage B operating window plus the 750 ms outlier check. */
const STAGE_B_AND_OUTLIER = [100, 90, 75, 60, 50, 40, 750];

const selectedOptionValues = async (page: Page): Promise<number[]> =>
  page.evaluate(() => Array.from(
    (document.getElementById('holdMsSelect') as HTMLSelectElement).options,
  ).map((option) => Number.parseInt(option.value, 10)));

test('holdMs dropdown: the URL preselects the value', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=75');

  // ?holdMs= is still the entry point and now drives the visible control.
  await expect(page.locator('#holdMsSelect')).toHaveValue('75');
  await expect(page.locator('#holdTime')).toHaveText('75 ms');
  await expect(page.locator('#chunkRate')).toHaveText('13.333 chunk/s');
  expect((await state(page)).selectValue).toBe('75');

  // A value with no ?holdMs= still works and defaults to 1000 ms.
  await page.goto('/single-baseline.html');
  await expect(page.locator('#holdMsSelect')).toHaveValue('1000');
});

test('holdMs dropdown: every Stage B value and 750 ms is selectable', async ({page}) => {
  await page.goto('/single-baseline.html');
  const values = await selectedOptionValues(page);
  for (const holdMs of STAGE_B_AND_OUTLIER) {
    expect(values, 'dropdown must offer ' + holdMs + ' ms').toContain(holdMs);
  }
  // The dropdown is grouped so Stage B is impossible to miss.
  const groups = await page.evaluate(() => Array.from(
    document.querySelectorAll('#holdMsSelect optgroup'),
  ).map((group) => (group as HTMLOptGroupElement).label));
  expect(groups[0]).toContain('Stage B');
  expect(groups.some((label) => label.includes('Outlier'))).toBe(true);
});

test('holdMs dropdown: changing the value updates the readout and the URL', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=75');
  await expect(page.locator('#chunkRate')).toHaveText('13.333 chunk/s');

  await page.selectOption('#holdMsSelect', '60');

  await expect(page.locator('#holdTime')).toHaveText('60 ms');
  await expect(page.locator('#chunkRate')).toHaveText('16.667 chunk/s');
  await expect(page.locator('#payloadRate')).toHaveText('10666.7 B/s · 10.417 KiB/s');

  const after = await state(page);
  expect(after.holdMs).toBe(60, 'the applied hold time follows the dropdown');
  expect(after.selectValue).toBe('60');
  expect(after.urlHoldMs, 'the URL query is kept in sync').toBe('60');
  expect(after.broadcasting).toBe(false, 'a stopped sender stays stopped');

  // r11: while stopped the sidebar is visible and the strip is not needed.
  expect(after.panelHidden).toBe(false, 'the sidebar is visible while stopped');
  expect(after.pillHidden).toBe(true, 'the control strip is only needed while the code is on screen');
  await expect(page.locator('#holdMsSelect')).toBeVisible();
});

test('holdMs dropdown: a running broadcast is stopped, never retimed mid-cycle', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=250');
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  await page.waitForTimeout(600);

  // r11: the code is on screen, so the non-essential help text disappears and the
  // strip below the carrier takes over. The sidebar stays because it is a separate
  // column, and NOTHING intersects the carrier in this state.
  const casting = await state(page);
  expect(casting.panelHidden, 'the sidebar stays usable while broadcasting').toBe(false);
  expect(casting.hintHidden, 'help text hides while broadcasting').toBe(true);
  expect(casting.pillHidden).toBe(false);
  await expect(page.locator('#pill')).toBeVisible();
  expect(await carrierIntersection(page), 'nothing may touch the carrier while broadcasting')
    .toEqual({total: 0, worst: '', worstArea: 0});

  // The hold time is still changeable mid-run (the sidebar was never hidden).
  await expect(page.locator('#holdMsSelect')).toBeVisible();
  await page.selectOption('#holdMsSelect', '100');

  const after = await state(page);
  // SAFETY: no cycle is ever retimed halfway through — the sender stops instead.
  expect(after.broadcasting).toBe(false);
  expect(after.holdMs).toBe(100);
  await expect(page.locator('#statusText')).toHaveText('Stopped / 已停止');
  await expect(page.locator('#holdApplyNote')).toContainText('Stopped and applied 100 ms');
  await expect(page.locator('#holdApplyNote')).toContainText('press Start again');

  // The button state must follow: a stopped sender must be restartable. This is
  // the exact defect CI caught — stopping from the dropdown used to leave Start
  // disabled, so pressing it again was impossible.
  await expect(page.locator('#startButton')).toBeEnabled();
  await expect(page.locator('#stopButton')).toBeDisabled();

  // Pressing Start again really uses the new period.
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  expect((await state(page)).cycleCount).toBe(0);
  await expect(page.locator('#startButton')).toBeDisabled();
  await expect(page.locator('#stopButton')).toBeEnabled();
  expect((await state(page)).hintHidden, 'restarting hides the help text again').toBe(true);
  await page.waitForTimeout(700);
  expect((await state(page)).cursor, '100 ms advances at least 5 chunks in 700 ms').toBeGreaterThanOrEqual(5);

  // Stopping from the strip returns to the idle state.
  await page.locator('#pillStop').click();
  await expect(page.locator('#startButton')).toBeEnabled();
  await expect(page.locator('#panel')).toBeVisible();
  expect((await state(page)).pillHidden).toBe(true);
  expect(await carrierIntersection(page), 'the idle page must not touch the carrier either').toEqual({total: 0, worst: '', worstArea: 0});
});

test('holdMs dropdown: the harness applies the same value as the dropdown', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.evaluate(() => (window as unknown as {
    __SINGLE_BASELINE_SENDER__: {setHoldMs: (value: number) => void};
  }).__SINGLE_BASELINE_SENDER__.setHoldMs(40));

  await expect(page.locator('#holdMsSelect')).toHaveValue('40');
  await expect(page.locator('#holdTime')).toHaveText('40 ms');
  expect((await state(page)).urlHoldMs).toBe('40');
});

// ---------------------------------------------------------------------------
// r10 鈥?layout regression guard (visual-layout only, no protocol change)
// ---------------------------------------------------------------------------
//
// r10/r11 layout regression guard.
//
// The physical failure that triggered this work was a decode collapse (647/647 CRC
// failures, 3.0 px/cell observed by the camera). Measurement showed the UI did NOT
// shrink the carrier, but the fixed control panel and the bottom-right help text
// covered part of it (up to 21.2% of the canvas area). r11 removed every overlay:
// the sidebar is a separate flex column and the control strip is a flow element in
// a band BELOW the carrier that `layout()` reserves.
//
// These tests freeze the invariants that protect the physical result:
//
//   1. the carrier is sized from the stage box (viewport minus sidebar, minus the
//      reserved strip band) and never collapses below 4 px/cell;
//   2. NO visible element intersects the carrier bounding box — not the help text,
//      not the controls, not the strip — in any state and at any viewport.

/** The viewport set the PO's PC sender uses; all six must be overlap-free. */
const FIXED_VIEWPORTS = [
  {width: 1920, height: 1080},
  {width: 1600, height: 900},
  {width: 1440, height: 900},
  {width: 1366, height: 768},
  {width: 1280, height: 800},
  {width: 1024, height: 768},
];

test('r11 layout: the help text and the controls never intersect the carrier', async ({page}) => {
  for (const viewport of FIXED_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

    // Stopped: the sidebar (controls + readout + help) is on screen.
    await expect(page.locator('#hint')).toBeVisible();
    expect(await intersectionWith(page, '#hint'), `help text ∩ carrier while stopped at ${label}`).toBe(0);
    expect(await intersectionWith(page, '#panel'), `sidebar ∩ carrier while stopped at ${label}`).toBe(0);

    // Broadcasting: the code is on screen and the help text is gone.
    await page.locator('#startButton').click();
    await expect(page.locator('#pill')).toBeVisible();
    expect((await state(page)).hintHidden, `help hidden while broadcasting at ${label}`).toBe(true);
    expect(await intersectionWith(page, '#panel'), `sidebar ∩ carrier while broadcasting at ${label}`).toBe(0);
    expect(await intersectionWith(page, '#pill'), `strip ∩ carrier while broadcasting at ${label}`).toBe(0);
    // The strict, generic requirement: nothing at all may touch the carrier.
    expect(await carrierIntersection(page), `any element ∩ carrier while broadcasting at ${label}`)
      .toEqual({total: 0, worst: '', worstArea: 0});

    await page.locator('#pillStop').click();

    // Optical fullscreen: sidebar and help gone, only the code plus the out-of-carrier
    // strip.
    await page.locator('#fullscreenButton').click();
    const fullscreen = await state(page);
    expect(fullscreen.opticalFullscreen).toBe(true);
    expect(fullscreen.panelHidden, `sidebar hidden in fullscreen at ${label}`).toBe(true);
    await expect(page.locator('#hint')).toBeHidden();
    expect(await intersectionWith(page, '#panel'), `sidebar ∩ carrier in fullscreen at ${label}`).toBe(0);
    expect(await intersectionWith(page, '#pill'), `strip ∩ carrier in fullscreen at ${label}`).toBe(0);
    expect(await carrierIntersection(page), `any element ∩ carrier in fullscreen at ${label}`)
      .toEqual({total: 0, worst: '', worstArea: 0});
    // The only controls left are Stop and Exit, both outside the carrier.
    await expect(page.locator('#pillStop')).toBeVisible();
    await expect(page.locator('#pillShow')).toHaveText('Exit Fullscreen / 退出全屏');
    await expect(page.locator('#pillShow')).toBeVisible();
    // Explanatory text is gone.
    await expect(page.locator('#panel')).toBeHidden();

    await page.locator('#pillShow').click();
    expect((await state(page)).opticalFullscreen).toBe(false);
  }
});

test('r11 layout: the carrier is sized from the stage box and never collapses', async ({page}) => {
  for (const viewport of FIXED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

    const quiet = (await page.evaluate(
      () => (window.__SINGLE_BASELINE_SENDER__.payload as unknown as {quietCells: number}).quietCells,
    )) as number;

    const measured = await page.evaluate(() => {
      const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const stage = document.getElementById('stage') as HTMLElement;
      const stageRect = stage.getBoundingClientRect();
      return {
        devicePx: canvas.width,
        cssPx: Math.round(rect.width),
        dpr: window.devicePixelRatio || 1,
        stageWidth: Math.round(stageRect.width),
        stageHeight: Math.round(stageRect.height),
      };
    });

    const expected = expectedCarrierPx(measured.stageWidth, measured.stageHeight, measured.dpr, quiet);
    expect(measured.devicePx, `carrier device px at ${viewport.width}x${viewport.height}`).toBe(expected);
    // The carrier must not be squeezed into a token size on a desktop sender.
    expect(measured.devicePx, `carrier floor at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(408);
    expect(Math.floor(measured.devicePx / (SINGLE_BASELINE_MATRIX + quiet * 2)),
      `cell pixels at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4);

    // The carrier is fully inside the stage, and the strip sits in its reserved band.
    const inside = await page.evaluate(() => {
      const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
      const stage = document.getElementById('stage') as HTMLElement;
      const crate = canvas.getBoundingClientRect();
      const srect = stage.getBoundingClientRect();
      return {
        contained: crate.left >= srect.left - 0.5 && crate.right <= srect.right + 0.5
          && crate.top >= srect.top - 0.5 && crate.bottom <= srect.bottom + 0.5,
        bandPx: Math.round(srect.bottom - crate.bottom),
      };
    });
    expect(inside.contained, `carrier inside the stage at ${viewport.width}x${viewport.height}`).toBe(true);
    expect(inside.bandPx, `reserved strip band at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(24);
  }
});

test('r11 layout: optical fullscreen releases the sidebar and keeps the carrier clean', async ({page}) => {
  for (const viewport of FIXED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
    const windowed = await state(page);

    await page.locator('#fullscreenButton').click();
    const fullscreen = await state(page);

    // The sidebar column is released, so the carrier can only grow or stay equal.
    expect(fullscreen.canvasDevicePx, `fullscreen must not shrink the carrier at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(windowed.canvasDevicePx);
    expect(fullscreen.stageWidth).toBeGreaterThan(windowed.stageWidth);
    expect(await carrierIntersection(page), 'fullscreen must leave the carrier untouched')
      .toEqual({total: 0, worst: '', worstArea: 0});

    await page.locator('#pillShow').click();
    const restored = await state(page);
    expect(restored.canvasDevicePx, 'leaving fullscreen restores the windowed carrier size')
      .toBe(windowed.canvasDevicePx);
    expect(await carrierIntersection(page), 'the restored page must not touch the carrier')
      .toEqual({total: 0, worst: '', worstArea: 0});
  }
});

/**
 * The strip lives in the band the carrier reserves below itself, so even at the
 * small default Playwright viewport (480x480) it must clear the code completely.
 */
test('r11 layout: the control strip clears the carrier at a small viewport', async ({page}) => {
  for (const viewport of [{width: 480, height: 480}, {width: 800, height: 600}]) {
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

    const geometry = await page.evaluate(() => {
      const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return {bottom: rect.bottom, right: rect.right, viewportH: window.innerHeight, viewportW: window.innerWidth};
    });

    await page.locator('#startButton').click();
    await expect(page.locator('#pill')).toBeVisible();
    const pill = await page.locator('#pill').boundingBox();
    expect(pill, 'the strip must be measurable while broadcasting').not.toBeNull();
    expect((await state(page)).pillFits, `the strip must fit at ${viewport.width}x${viewport.height}`).toBe(true);
    expect(pill!.y, `strip top must be below the carrier at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(geometry.bottom);
    expect(pill!.height, 'the strip height is capped').toBe(24);
    expect(await carrierIntersection(page), `nothing may touch the carrier at ${viewport.width}x${viewport.height}`)
      .toEqual({total: 0, worst: '', worstArea: 0});

    await page.locator('#pillStop').click();
  }
});

/**
 * Platform fonts differ: the CI runner's Linux font gave the strip's status span a
 * taller line box than the developer's Windows font, which pushed the span's box up
 * into the carrier by ~49 px². That is a real overlap, so the strip must be immune to
 * font metrics rather than tuned to one platform's. This test injects a deliberately
 * huge font and requires the intersection to stay exactly 0.
 */
test('r11 layout: a pathological font cannot push the strip onto the carrier', async ({page}) => {
  for (const viewport of [{width: 1024, height: 768}, {width: 480, height: 480}]) {
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.locator('#startButton').click();
    await expect(page.locator('#pill')).toBeVisible();

    await page.addStyleTag({
      content: '#pill>*{font-size:48px !important;line-height:48px !important;'
        + 'font-family:"Noto Sans CJK SC","DejaVu Sans",monospace !important}',
    });

    expect(await carrierIntersection(page),
      `a 48px font must not reach the carrier at ${viewport.width}x${viewport.height}`)
      .toEqual({total: 0, worst: '', worstArea: 0});

    const pill = await page.locator('#pill').boundingBox();
    const canvas = await page.locator('#codeCanvas').boundingBox();
    expect(pill!.y, 'the strip stays below the carrier whatever the font does')
      .toBeGreaterThanOrEqual(canvas!.y + canvas!.height);
    expect(pill!.height, 'the strip height is fixed regardless of the font').toBe(24);
  }
});

/**
 * TF-012 r12 — sender-path equivalence.
 *
 * Physical evidence: `?diagnostic=chunk0` decoded 970/970 frames on the phone while
 * the normal CYCLIC sender at holdMs = 1000 produced 0 successful decodes out of 209
 * camera frames. Before touching the receiver, the two SENDER paths must be proven
 * equivalent: `drawChunk()` is the same function in both modes, so chunk 0 must come
 * out pixel-for-pixel identical, and starting the cycle must not move or resize the
 * carrier.
 *
 * These tests lock that down so any future divergence in the sender rendering path
 * (or in the layout on Start) fails immediately.
 */
type CanvasIdentity = {
  sha256: string;
  cursor: number;
  devicePx: number;
  cssPx: number;
  cellPixels: number;
  rect: string;
};

/** Exact SHA-256 of the carrier's RGBA ImageData, plus the geometry it was drawn at. */
async function canvasIdentity(page: Page): Promise<CanvasIdentity> {
  return page.evaluate(async () => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(image.data.buffer.slice(0)));
    const sha256 = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    const rect = canvas.getBoundingClientRect();
    const state = (window as unknown as {
      __SINGLE_BASELINE_SENDER__: {state: () => {cursor: number; cellPixels: number}};
    }).__SINGLE_BASELINE_SENDER__.state();
    return {
      sha256,
      cursor: state.cursor,
      devicePx: canvas.width,
      cssPx: Math.round(rect.width),
      cellPixels: state.cellPixels,
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(','),
    };
  });
}

test('r12 equivalence: diagnostic chunk0 and cyclic chunk0 render the identical canvas', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});

  // A · static diagnostic path.
  await page.goto('/single-baseline.html?diagnostic=chunk0');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
  const staticIdentity = await canvasIdentity(page);
  const staticCells = await sampleCanvasCells(page);
  expect(staticIdentity.cursor).toBe(0);

  // B · normal cyclic path, parked on chunk 0 within the 1000 ms hold.
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
  await page.locator('#startButton').click();
  await showChunk(page, 0);
  const cyclicIdentity = await canvasIdentity(page);
  const cyclicCells = await sampleCanvasCells(page);
  expect(cyclicIdentity.cursor, 'the cyclic capture must still be on chunk 0').toBe(0);
  expect((await state(page)).broadcasting).toBe(true);

  // Exact pixels: same SHA-256 over the whole RGBA carrier, not a sampled grid.
  expect(cyclicIdentity.sha256, 'cyclic chunk 0 must be byte-identical to diagnostic chunk 0')
    .toBe(staticIdentity.sha256);

  // Same geometry and same module pitch.
  expect(cyclicIdentity.devicePx).toBe(staticIdentity.devicePx);
  expect(cyclicIdentity.cssPx).toBe(staticIdentity.cssPx);
  expect(cyclicIdentity.cellPixels).toBe(staticIdentity.cellPixels);
  expect(cyclicIdentity.rect, 'the carrier must not move when the cycle starts')
    .toBe(staticIdentity.rect);

  // Same matrix bits, and they are the shared builder's chunk 0.
  expect(Buffer.from(cyclicCells).toString('base64')).toBe(Buffer.from(staticCells).toString('base64'));
  expect(Array.from(cyclicCells)).toEqual(Array.from(transfer.frames[0]));

  // Same ENCODED bytes: decode both canvases and compare the reconstructed payload,
  // its sequence (which carries fileId + chunkIndex) and the CRC-validated frame.
  const staticDecoded = decodeFrameCellsV1(staticCells, SINGLE_BASELINE_MATRIX);
  const cyclicDecoded = decodeFrameCellsV1(cyclicCells, SINGLE_BASELINE_MATRIX);
  expect(staticDecoded, 'the static canvas must be a valid OptiGrid frame').not.toBeNull();
  expect(cyclicDecoded, 'the cyclic canvas must be a valid OptiGrid frame').not.toBeNull();
  expect(cyclicDecoded!.sequence).toBe(staticDecoded!.sequence);
  expect(Buffer.from(cyclicDecoded!.payload).toString('base64'))
    .toBe(Buffer.from(staticDecoded!.payload).toString('base64'));
  expect(Buffer.from(cyclicDecoded!.payload).toString('base64'))
    .toBe(Buffer.from(transfer.payloads[0]).toString('base64'));
});

test('r12 equivalence: starting the cycle never changes the carrier geometry', async ({page}) => {
  for (const viewport of FIXED_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=1000');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

    const idle = await canvasIdentity(page);
    await page.locator('#startButton').click();
    await showChunk(page, 0);
    const running = await canvasIdentity(page);

    expect(running.cursor, `cyclic capture on chunk 0 at ${label}`).toBe(0);
    expect(running.devicePx, `carrier device px must not change on Start at ${label}`).toBe(idle.devicePx);
    expect(running.cssPx, `carrier CSS px must not change on Start at ${label}`).toBe(idle.cssPx);
    expect(running.cellPixels, `module pitch must not change on Start at ${label}`).toBe(idle.cellPixels);
    expect(running.rect, `carrier box must not move on Start at ${label}`).toBe(idle.rect);
    // The static path draws chunk 0 at the same size, so switching modes is a
    // rendering-path change only, never a geometry change.
    expect(running.sha256, `chunk 0 pixels must survive Start at ${label}`).toBe(idle.sha256);

    await page.locator('#pillStop').click();
  }
});

test('r12 equivalence: the carrier stays stable for the whole hold period', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
  await page.locator('#startButton').click();

  // Sample every animation frame for one hold period. Within a single cursor value
  // there must be exactly ONE distinct canvas hash: the sender must not repaint
  // different pixels while a chunk is being held.
  const result = await page.evaluate(async () => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const harness = (window as unknown as {
      __SINGLE_BASELINE_SENDER__: {state: () => {cursor: number}};
    }).__SINGLE_BASELINE_SENDER__;
    const sampled = (): string => {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      let hash = 0x811c9dc5;
      for (let index = 0; index < image.data.length; index += 257) {
        hash ^= image.data[index];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16);
    };
    const byCursor = new Map<number, Set<string>>();
    const started = performance.now();
    while (performance.now() - started < 1100) {
      const {cursor} = harness.state();
      if (!byCursor.has(cursor)) byCursor.set(cursor, new Set());
      (byCursor.get(cursor) as Set<string>).add(sampled());
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return {
      cursors: Array.from(byCursor.keys()),
      unstable: Array.from(byCursor.entries())
        .filter(([, hashes]) => hashes.size !== 1)
        .map(([cursor, hashes]) => [cursor, hashes.size]),
    };
  });

  expect(result.cursors.length, 'the hold window must cover at least one chunk').toBeGreaterThanOrEqual(1);
  expect(result.unstable, 'the canvas must not change while a chunk is held').toEqual([]);
});

/**
 * TF-012 r13 — PAUSE CURRENT FRAME.
 *
 * The A4 auto-test step asks whether decode success appears only once a cyclic frame
 * is frozen. That question is only meaningful if pausing leaves the optical frame
 * EXACTLY as it was: same pixels, same cursor, same chunk, sender still "on air" so
 * the phone keeps decoding. These tests drive the pause through the same control
 * message path the orchestrator uses (`__SINGLE_BASELINE_SENDER__.applyAutoMessage`).
 */
async function canvasBytes(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0x811c9dc5;
    for (let index = 0; index < image.data.length; index += 3) {
      hash ^= image.data[index];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let nonWhite = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index] < 128) nonWhite += 1;
    }
    return `${hash.toString(16)}:${nonWhite}`;
  });
}

async function applyControl(page: Page, message: Record<string, unknown>): Promise<string> {
  return page.evaluate((payload: string) => (window as unknown as {
    __SINGLE_BASELINE_SENDER__: {applyAutoMessage: (value: unknown) => string};
  }).__SINGLE_BASELINE_SENDER__.applyAutoMessage(JSON.parse(payload)), JSON.stringify(message));
}

test('r13 pause: PAUSE CURRENT FRAME does not alter a single canvas pixel', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

  await page.locator('#startButton').click();
  await page.waitForTimeout(400);

  const before = await canvasBytes(page);
  const beforeState = await state(page);
  expect(beforeState.broadcasting).toBe(true);
  expect(beforeState.paused).toBe(false);

  expect(await applyControl(page, {
    type: 'command', action: 'PAUSE', runId: 'r-test', stepId: 'A4', chunkIndex: beforeState.cursor,
  })).toBe('pause');

  // Sample repeatedly across the whole freeze window: every frame must be identical.
  const hashes: string[] = [before];
  for (let index = 0; index < 6; index += 1) {
    await page.waitForTimeout(200);
    hashes.push(await canvasBytes(page));
  }
  expect(new Set(hashes).size, 'the canvas must not change at all while paused').toBe(1);

  // The frame is still on screen and still being broadcast — NOT stopped.
  const pausedState = await state(page);
  expect(pausedState.paused).toBe(true);
  expect(pausedState.broadcasting, 'pause must not stop the broadcast').toBe(true);
  expect(pausedState.canvasDevicePx).toBe(beforeState.canvasDevicePx);
  expect(pausedState.holdMs, 'pause must not change the declared hold time').toBe(beforeState.holdMs);
  expect(hashes[0].split(':')[1], 'the frozen frame must not be blank').not.toBe('0');
  await expect(page.locator('#statusText')).toHaveText('Paused / 已暂停');
});

test('r13 pause: the cursor does not advance while paused, and RESUME continues it', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
  await page.locator('#startButton').click();
  await page.waitForTimeout(300);

  const started = await state(page);
  await applyControl(page, {type: 'command', action: 'PAUSE', runId: 'r-test', stepId: 'A4', chunkIndex: started.cursor});

  const frozenCursor = (await state(page)).cursor;
  const frozenCycle = (await state(page)).cycleCount;
  const frozenHash = await canvasBytes(page);
  // Far longer than one hold period: if the timer were still live the cursor would
  // have advanced several times by now.
  await page.waitForTimeout(2500);
  const stillFrozen = await state(page);
  expect(stillFrozen.cursor, 'the cursor must not advance while paused').toBe(frozenCursor);
  expect(stillFrozen.cycleCount, 'the cycle counter must not advance while paused').toBe(frozenCycle);
  expect(await canvasBytes(page)).toBe(frozenHash);

  // The receiver keeps its target: the frame is pinned, so a RESUME must continue
  // from the SAME cursor rather than restarting the cycle.
  expect(await applyControl(page, {type: 'command', action: 'RESUME', runId: 'r-test', stepId: 'A4'})).toBe('resume');
  await page.waitForTimeout(1200);
  const resumed = await state(page);
  expect(resumed.paused).toBe(false);
  expect(resumed.cycleCount, 'resume continues the same cycle').toBe(frozenCycle);
  expect(resumed.cursor, 'the cursor advances again after RESUME').not.toBe(frozenCursor);
  expect(await canvasBytes(page)).not.toBe(frozenHash);
});

test('r13 pause: a paused sender still reports itself as on air', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);
  await page.locator('#startButton').click();
  await applyControl(page, {type: 'command', action: 'PAUSE', runId: 'r-test', stepId: 'A4', chunkIndex: 0});

  // Telemetry is what the orchestrator records for the duringPause block, so it must
  // carry the paused flag, the frozen cursor and the canvas digest.
  const sample = await page.evaluate(() => (window as unknown as {
    __SINGLE_BASELINE_SENDER__: {autoSample: () => Record<string, unknown>};
  }).__SINGLE_BASELINE_SENDER__.autoSample());
  expect(sample.paused).toBe(true);
  expect(sample.broadcasting).toBe(true);
  expect(typeof sample.canvasHash).toBe('string');
  expect((sample.canvasHash as string).length).toBeGreaterThan(0);
  const clientStatus = await page.evaluate(() => (window as unknown as {
    __SINGLE_BASELINE_SENDER__: {state: () => Record<string, unknown>};
  }).__SINGLE_BASELINE_SENDER__.state());
  expect(clientStatus.pillHidden, 'the code is on air, so the control strip stays available').toBe(false);
});

test('r13 control channel: the page rejects payload-shaped control messages', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

  expect(await applyControl(page, {type: 'command', action: 'SET_HOLD_MS', holdMs: 5000, fileBytes: 'AA'}))
    .toBe('rejected:field fileBytes is not allowed on SET_HOLD_MS');
  expect(await applyControl(page, {type: 'command', action: 'START', chunkPayload: 'AAEC'}))
    .toBe('rejected:field chunkPayload is not allowed on START');
  expect(await applyControl(page, {type: 'command', action: 'START', expectedDecodedChunk: 0}))
    .toBe('rejected:field expectedDecodedChunk is not allowed on START');
  expect(await applyControl(page, {type: 'command', action: 'SEND_FILE'}))
    .toBe('rejected:unknown action SEND_FILE');
  // A legal receiver-metrics message (measurements only, payloadPath NONE) is accepted.
  expect(await applyControl(page, {
    type: 'command', action: 'RECEIVER_METRICS', runId: 'r1', stepId: 'A3', phase: 'STEP',
    payloadPath: 'NONE', successfulDecodes: 0, crcFailures: 209,
  })).toBe('receiver_metrics');
});

test('r13 auto test: the sender applies the orchestrator command sequence', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

  // Exactly the messages the A1..A5 orchestrator emits, in order.
  const script: Array<Record<string, unknown>> = [
    {type: 'command', action: 'SET_MODE', runId: 'r1', stepId: 'A1', mode: 'static', chunkIndex: 0},
    {type: 'command', action: 'START', runId: 'r1', stepId: 'A1'},
  ];
  for (const message of script) expect(await applyControl(page, message)).not.toMatch(/^rejected:/);
  let current = await state(page);
  expect(current.diagnosticMode, 'A1 is the static diagnostic step').toBe(true);
  expect(current.broadcasting).toBe(true);
  expect(current.cursor).toBe(0);

  await applyControl(page, {type: 'command', action: 'SET_MODE', runId: 'r1', stepId: 'A2', mode: 'cyclic', chunkIndex: null});
  await applyControl(page, {type: 'command', action: 'SET_HOLD_MS', runId: 'r1', stepId: 'A2', holdMs: 5000});
  await applyControl(page, {type: 'command', action: 'START', runId: 'r1', stepId: 'A2'});
  current = await state(page);
  expect(current.diagnosticMode, 'A2 is cyclic').toBe(false);
  expect(current.holdMs, 'the sender hold time follows the active step').toBe(5000);
  expect(current.broadcasting).toBe(true);
  await expect(page.locator('#holdMsSelect')).toHaveValue('5000');
  await expect(page.locator('#holdTime')).toHaveText('5000 ms');

  await applyControl(page, {type: 'command', action: 'SET_HOLD_MS', runId: 'r1', stepId: 'A3', holdMs: 1000});
  expect((await state(page)).holdMs).toBe(1000);

  await applyControl(page, {type: 'command', action: 'STOP', runId: 'r1'});
  const stopped = await state(page);
  expect(stopped.broadcasting).toBe(false);
  expect(stopped.paused).toBe(false);
});

test('r13 auto test: the sender panel names the run state, the mode, the holdMs and the frozen cursor', async ({page}) => {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.goto('/single-baseline.html?holdMs=1000');
  await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

  // The PO must be able to read the run state off the sidebar without inferring it.
  // A4's sequence: cyclic at 1000 ms, then PAUSE CURRENT FRAME.
  await applyControl(page, {type: 'command', action: 'SET_MODE', runId: 'r9', stepId: 'A4', mode: 'cyclic', chunkIndex: null});
  await applyControl(page, {type: 'command', action: 'SET_HOLD_MS', runId: 'r9', stepId: 'A4', holdMs: 1000});
  await applyControl(page, {type: 'command', action: 'START', runId: 'r9', stepId: 'A4'});
  await expect(page.locator('#autoStatus')).toContainText('RUNNING');
  await expect(page.locator('#autoMode')).toHaveText('CYCLIC 1000 ms');
  await expect(page.locator('#autoPaused')).toHaveText('no');
  // The cursor readout is the frame the receiver's PAUSE will report.
  const cyclicCursor = (await state(page)).cursor;
  await expect(page.locator('#autoCursor')).toHaveText(`frame ${cyclicCursor}`);

  await applyControl(page, {type: 'command', action: 'PAUSE', runId: 'r9', stepId: 'A4', chunkIndex: cyclicCursor});
  const frozen = await state(page);
  expect(frozen.paused, 'PAUSE CURRENT FRAME pauses without stopping').toBe(true);
  expect(frozen.broadcasting, 'a paused sender is still on air').toBe(true);
  expect(frozen.cursor, 'PAUSE must not move the cursor').toBe(cyclicCursor);
  await expect(page.locator('#autoStatus')).toContainText('PAUSED');
  await expect(page.locator('#autoPaused')).toHaveText('YES / 已暂停');
  await expect(page.locator('#autoCursor')).toHaveText(`frame ${cyclicCursor} (frozen / 已冻结)`);

  await applyControl(page, {type: 'command', action: 'RESUME', runId: 'r9', stepId: 'A4'});
  await expect(page.locator('#autoPaused')).toHaveText('no');
  await expect(page.locator('#autoCursor')).not.toContainText('frozen');

  // A static step keeps the chunk vocabulary, so the two ends never mix units.
  await applyControl(page, {type: 'command', action: 'SET_MODE', runId: 'r9', stepId: 'A5', mode: 'static', chunkIndex: 0});
  await expect(page.locator('#autoMode')).toHaveText('STATIC chunk0');
  await expect(page.locator('#autoCursor')).toHaveText('chunk 0');

  // Stopping must return the panel to a non-running state, not leave it green.
  await applyControl(page, {type: 'command', action: 'STOP', runId: 'r9'});
  await expect(page.locator('#autoStatus')).not.toContainText('RUNNING');
  await expect(page.locator('#autoPaused')).toHaveText('no');
});

test('r11 layout: the long file table is collapsed, and the rendered size readout is honest', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/single-baseline.html?holdMs=75');

  // The r9 regression was 170 px of extra sidebar height; the file table is the
  // reason, so it starts collapsed and stays reachable behind one button.
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#fileSha')).toBeHidden();
  await page.locator('#detailsButton').click();
  await expect(page.locator('#details')).toBeVisible();
  await expect(page.locator('#fileSha')).toBeVisible();

  // The readout reports the DISPLAY-side size and says so — it is never presented
  // as what the camera sees, which is the only size that matters physically.
  const text = (await state(page)).renderSizeText ?? '';
  const times = '\u00d7'; // the readout uses a real multiplication sign
  expect(text).toContain('canvas device px');
  expect(text).toContain('CSS px');
  expect(text).toContain('device px/cell');
  expect(text, 'the readout must warn that this is not the camera-observed size')
    .toContain('NOT the camera-observed size');

  const geometry = await page.evaluate(() => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const stage = document.getElementById('stage') as HTMLElement;
    const stageRect = stage.getBoundingClientRect();
    const cellPixels = Number.parseInt((document.getElementById('renderSize')?.textContent ?? '')
      .match(/(\d+) device px\/cell/)?.[1] ?? '0', 10);
    return {
      devicePx: canvas.width, cssPx: Math.round(rect.width), cellPixels,
      stageWidth: Math.round(stageRect.width), stageHeight: Math.round(stageRect.height),
    };
  });
  expect(geometry.devicePx).toBe(expectedCarrierPx(geometry.stageWidth, geometry.stageHeight, 1, 3));
  expect(geometry.cellPixels).toBe(Math.floor(geometry.devicePx / 102));
  expect(text, 'the readout quotes the real canvas device size')
    .toContain(`${geometry.devicePx}${times}${geometry.devicePx} canvas device px`);
  expect(text, 'the readout quotes the real CSS size').toContain(`${geometry.cssPx}${times}${geometry.cssPx} CSS px`);
  expect(text, 'the readout quotes the real cell size').toContain(`${geometry.cellPixels} device px/cell`);
});


