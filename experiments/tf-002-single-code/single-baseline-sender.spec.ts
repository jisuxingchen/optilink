/**
 * TF-012 r4 — Single-Code Baseline sender acceptance (real browser, real canvas).
 *
 * Verifies the sender page itself, not just the shared protocol module:
 *  13  sender Start button starts a cyclic broadcast from chunk 0
 *  14  sender Stop button freezes the broadcast
 *  15  sender cycles 0..15 and wraps back to chunk 0 (the loop is deterministic)
 *  ·   every rendered canvas is a VALID OptiGrid v1 frame (sampled from the real
 *      canvas and CRC-decoded in Node against the shared payload builder)
 */
import {test, expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {SINGLE_BASELINE_MATRIX, buildSingleBaselineTransfer} from './src/optical-core/single-baseline.ts';
import {decodeFrameCellsV1} from './src/optigrid-v1.ts';

const transfer = buildSingleBaselineTransfer();

type SenderState = {broadcasting: boolean; cursor: number; cycleCount: number; holdMs: number};

declare global {
  interface Window {
    __SINGLE_BASELINE_SENDER__: {
      payload: {quietCells: number};
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

  // Item 14 · Stop freezes the broadcast and the displayed chunk.
  await page.locator('#stopButton').click();
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
  await page.locator('#stopButton').click();
  expect((await state(page)).broadcasting).toBe(false);
});
