/**
 * TF-011 browser pixel broadcast/resume robustness regression (SIMULATION ONLY).
 * Drives the real standalone broadcast sender, runs the acceptance matrix A–H,
 * and writes machine-readable evidence to artifacts/tf011-sim/latest.json.
 */
import {execSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {test, expect} from '@playwright/test';

function gitHead() {
  try {
    return execSync('git rev-parse HEAD', {encoding: 'utf8'}).trim();
  } catch {
    return 'unknown';
  }
}

test('TF-011 broadcast/resume/session robustness (real sender → pixels → matrix A-H)', async ({page}) => {
  await page.goto('/tf011-sim-harness.html');
  await page.waitForFunction(
    () => (window.__TF011_SIM__ && (window.__TF011_SIM__.done === true || window.__TF011_SIM__.error)) === true,
    null,
    {timeout: 600_000},
  );
  const result = await page.evaluate(() => window.__TF011_SIM__);
  console.log(JSON.stringify(result, null, 2));

  expect(result.done, JSON.stringify(result && result.error)).toBe(true);
  expect(result.error, 'harness error').toBeUndefined();
  expect(result.networkPayloadPath).toBe('NONE');
  expect(result.oracleInputs).toEqual([]);

  const byId = new Map(result.cases.map((c) => [c.id, c]));
  const allCases = ['A-start-0', 'B-late-join', 'C-20pct-drop', 'D-30pct-dup', 'E-checkpoint-restore', 'F-session-isolation', 'G-repeated-manifest', 'H-invalid-manifest', 'CA-beacon', 'CB-after-beacon', 'CC-mid-dynamic', 'CD-before-manifest-replay', 'CE-worst-case'];
  for (const id of allCases) {
    const c = byId.get(id);
    expect(c, `missing case ${id}`).toBeTruthy();
    expect(c.pass, `${id} (${c.detail || ''})`).toBe(true);
  }
  // SHA-exact cases must carry a matching digest (H is rejection-only, no shaMatch).
  const shaCases = ['A-start-0', 'B-late-join', 'C-20pct-drop', 'D-30pct-dup', 'E-checkpoint-restore', 'F-session-isolation', 'G-repeated-manifest', 'CA-beacon', 'CB-after-beacon', 'CC-mid-dynamic', 'CD-before-manifest-replay', 'CE-worst-case'];
  for (const id of shaCases) {
    expect(byId.get(id).shaMatch, `${id} shaMatch`).toBe(true);
    expect(byId.get(id).reconstructedSha).toMatch(/^[0-9a-f]{64}$/);
  }

  const artifact = {
    evidenceClass: 'SIMULATED BROWSER PIXEL BROADCAST RESUME ROBUSTNESS',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    senderEntry: result.senderEntry,
    replayEvery: result.replayEvery,
    networkPayloadPath: result.networkPayloadPath,
    oracleInputs: result.oracleInputs,
    summary: result.summary,
    timings: result.timings,
    cases: result.cases,
    note: 'SIMULATION EVIDENCE ONLY. Not physical raw optical ingress. Not Net Goodput.',
  };

  mkdirSync('artifacts/tf011-sim', {recursive: true});
  writeFileSync('artifacts/tf011-sim/latest.json', JSON.stringify(artifact, null, 2));
  console.log('artifact written to artifacts/tf011-sim/latest.json');
});
