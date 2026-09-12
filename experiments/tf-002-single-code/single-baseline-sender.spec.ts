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
 * r10: how much of the carrier canvas the *visible* overlays cover, in percent of
 * the canvas area. This is the number the PO's physical result depends on, so a
 * regression test can assert it directly instead of trusting a screenshot.
 * Hidden elements contribute 0 — that is the point.
 */
async function panelOverlapCanvasPercent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.getElementById('codeCanvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (!area) return -1;
    let covered = 0;
    for (const node of Array.from(document.querySelectorAll('#panel,#hint,#pill'))) {
      const element = node as HTMLElement;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left));
      const height = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
      covered += width * height;
    }
    return Math.round((covered / area) * 10000) / 100;
  });
}

/**
 * r10: the carrier size formula. layout() derives the whole canvas from the
 * viewport alone, so this must hold with the benchmark UI present. If a future UI
 * change starts feeding the overlays into layout(), this assertion fails.
 */
function expectedCanvasDevicePx(width: number, height: number, dpr: number, quietCells: number): number {
  const stage = Math.min(width, height) * 0.98;
  const scale = Math.min(2, Math.max(1, dpr));
  const totalCells = SINGLE_BASELINE_MATRIX + quietCells * 2;
  const cellPixels = Math.max(2, Math.floor((stage * scale) / totalCells));
  return cellPixels * totalCells;
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

  // r10: while stopped the controls must be usable — the overlay policy hides them
  // only while broadcasting (or in optical fullscreen).
  expect(after.panelHidden).toBe(false, 'the panel is visible while stopped');
  expect(after.pillHidden).toBe(true, 'the compact pill is broadcast-only');
  await expect(page.locator('#holdMsSelect')).toBeVisible();
});

test('holdMs dropdown: a running broadcast is stopped, never retimed mid-cycle', async ({page}) => {
  await page.goto('/single-baseline.html?holdMs=250');
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  await page.waitForTimeout(600);

  // r10: starting a broadcast hides the controls so nothing can cover the code,
  // and the compact pill (which sits in a margin the centred canvas never uses)
  // becomes the only overlay. This is the whole point of the r10 fix.
  const casting = await state(page);
  expect(casting.panelHidden, 'the control panel auto-hides while broadcasting').toBe(true);
  expect(casting.hintHidden).toBe(true);
  expect(casting.pillHidden).toBe(false);
  await expect(page.locator('#pill')).toBeVisible();
  expect(await panelOverlapCanvasPercent(page), 'a broadcasting overlay must cover 0% of the canvas').toBe(0);

  // The pill's Show button brings the controls back WITHOUT stopping the broadcast,
  // so a PO can still change the hold time mid-run.
  await page.locator('#pillShow').click();
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

  // Pressing Start again really uses the new period, and re-hides the controls.
  await page.locator('#startButton').click();
  await expect(page.locator('#statusText')).toHaveText('Broadcasting / 广播中');
  expect((await state(page)).cycleCount).toBe(0);
  await expect(page.locator('#startButton')).toBeDisabled();
  await expect(page.locator('#stopButton')).toBeEnabled();
  expect((await state(page)).panelHidden, 'restarting re-hides the controls').toBe(true);
  await page.waitForTimeout(700);
  expect((await state(page)).cursor, '100 ms advances at least 5 chunks in 700 ms').toBeGreaterThanOrEqual(5);

  // Stopping from the pill restores the full control panel.
  await page.locator('#pillStop').click();
  await expect(page.locator('#startButton')).toBeEnabled();
  await expect(page.locator('#panel')).toBeVisible();
  expect((await state(page)).pillHidden).toBe(true);
  // NOTE: deliberately bringing the panel back mid-broadcast (the Show button) does
  // cover part of the carrier — that is the PO's explicit choice. The DEFAULT
  // broadcast path is the one that must be clean, and that was asserted above.
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
// The physical failure that triggered r10 was a decode collapse (647/647 CRC
// failures, 3.0 px/cell observed by the camera). Measurement showed the r9 UI did
// NOT shrink the carrier, but it made the control panel 170 px taller and pushed
// its overlap of the canvas from 3.9-15.8% up to 5.3-21.2%. These tests freeze the
// two invariants that protect the physical result:
//
//   1. the carrier size depends on the viewport ONLY (adding UI never shrinks it);
//   2. while broadcasting, the overlays cover 0% of the canvas.

/** A desktop viewport set representative of the PO's PC sender. */
const FIXED_VIEWPORTS = [
  {width: 1920, height: 1080},
  {width: 1600, height: 900},
  {width: 1440, height: 900},
  {width: 1366, height: 768},
];

test('r10 layout: the code display size does not shrink when the benchmark UI is present', async ({page}) => {
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
      return {devicePx: canvas.width, cssPx: rect.width, dpr: window.devicePixelRatio || 1};
    });

    const expected = expectedCanvasDevicePx(viewport.width, viewport.height, measured.dpr, quiet);
    expect(measured.devicePx, `carrier device px at ${viewport.width}x${viewport.height}`).toBe(expected);
    expect(measured.devicePx, 'the canvas must never collapse to a token size').toBeGreaterThanOrEqual(408);
    // A 96-cell OptiGrid needs real pixels per cell to survive a camera.
    expect(Math.floor(measured.devicePx / (SINGLE_BASELINE_MATRIX + quiet * 2)),
      `cell pixels at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4);
  }
});

test('r10 layout: a broadcasting overlay never covers the canvas, and fullscreen hides everything', async ({page}) => {
  for (const viewport of FIXED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/single-baseline.html?holdMs=75');
    await page.waitForFunction(() => (document.getElementById('codeCanvas') as HTMLCanvasElement).width > 0);

    const stopped = await state(page);
    expect(stopped.panelHidden, `panel visible while stopped at ${viewport.width}x${viewport.height}`).toBe(false);
    expect(stopped.pillHidden, 'the pill is broadcast-only').toBe(true);

    await page.locator('#startButton').click();
    await expect(page.locator('#pill')).toBeVisible();

    const casting = await state(page);
    expect(casting.panelHidden, 'the panel auto-hides while broadcasting').toBe(true);
    expect(casting.hintHidden, 'the hint auto-hides while broadcasting').toBe(true);
    // The regression that broke the physical run: clickable UI sitting on top of
    // the code. Zero, not "small".
    expect(await panelOverlapCanvasPercent(page),
      `overlay occlusion while broadcasting at ${viewport.width}x${viewport.height}`).toBe(0);
    // Hiding UI must not touch the established carrier geometry.
    expect(casting.canvasDevicePx, 'broadcasting must not resize the carrier').toBe(stopped.canvasDevicePx);
    expect(casting.cellPixels).toBe(stopped.cellPixels);

    await page.locator('#pillStop').click();
    await expect(page.locator('#panel')).toBeVisible();

    // Optical fullscreen additionally hides the panel and the hint. The compact
    // pill stays because it is measured at 0% overlap and is the only visible way
    // back out — without it the mode would be a trap.
    await page.locator('#fullscreenButton').click();
    const fullscreen = await state(page);
    expect(fullscreen.opticalFullscreen).toBe(true);
    expect(fullscreen.panelHidden, 'optical fullscreen hides the panel').toBe(true);
    expect(fullscreen.hintHidden).toBe(true);
    expect(await panelOverlapCanvasPercent(page), 'fullscreen must leave only the code on screen').toBe(0);
    expect(fullscreen.canvasDevicePx, 'fullscreen must not resize the carrier').toBe(stopped.canvasDevicePx);

    // The pill's button is the visible exit from fullscreen.
    await expect(page.locator('#pillShow')).toHaveText('Exit Fullscreen / 退出全屏');
    await page.locator('#pillShow').click();
    await expect(page.locator('#panel')).toBeVisible();
    expect((await state(page)).opticalFullscreen).toBe(false);
    expect((await state(page)).canvasDevicePx, 'leaving fullscreen must not resize the carrier')
      .toBe(stopped.canvasDevicePx);
  }
});

/**
 * The compact pill is the only overlay that stays on screen while broadcasting,
 * so it must clear the carrier even at the small default Playwright viewport
 * (480x480) — that is where the centred code gets closest to the corners.
 */
test('r10 layout: the compact pill clears the carrier at a small viewport', async ({page}) => {
  for (const viewport of [{width: 480, height: 480}, {width: 1024, height: 768}]) {
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
    expect(pill, 'the pill must be measurable while broadcasting').not.toBeNull();
    // The pill is docked to the bottom-right corner and must sit BELOW the code.
    expect((await state(page)).pillFits, `the pill must fit at ${viewport.width}x${viewport.height}`).toBe(true);
    expect(pill!.y, `pill top must be below the carrier at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(geometry.bottom);
    expect(pill!.height, 'the pill height is capped so it can clear the carrier').toBe(24);
    expect(await panelOverlapCanvasPercent(page),
      `overlay occlusion at ${viewport.width}x${viewport.height}`).toBe(0);

    await page.locator('#pillStop').click();
  }
});

test('r10 layout: the long file table is collapsed, and the rendered size readout is honest', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/single-baseline.html?holdMs=75');

  // The r9 regression was 170 px of extra panel height; the file table is the
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
    const cellPixels = Number.parseInt((document.getElementById('renderSize')?.textContent ?? '')
      .match(/(\d+) device px\/cell/)?.[1] ?? '0', 10);
    return {devicePx: canvas.width, cssPx: Math.round(rect.width), cellPixels};
  });
  expect(geometry.devicePx).toBe(expectedCanvasDevicePx(1440, 900, 1, 3));
  expect(geometry.cellPixels).toBe(Math.floor(geometry.devicePx / 102));
  expect(text, 'the readout quotes the real canvas device size')
    .toContain(`${geometry.devicePx}${times}${geometry.devicePx} canvas device px`);
  expect(text, 'the readout quotes the real CSS size').toContain(`${geometry.cssPx}${times}${geometry.cssPx} CSS px`);
  expect(text, 'the readout quotes the real cell size').toContain(`${geometry.cellPixels} device px/cell`);
});


