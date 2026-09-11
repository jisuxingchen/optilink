/**
 * TF-011 browser pixel broadcast/resume robustness simulation.
 *
 * Drives the REAL standalone broadcast sender (rendered pixels only) through the
 * deterministic acceptance matrix A–E (frame-0, late join, drop, duplicate,
 * checkpoint/restore) plus session isolation (F), repeated Manifest (G), and
 * invalid-Manifest rejection (H). Writes SIMULATION evidence to the page result.
 */
import {SharedOpticalReceiveCore, sessionKey} from './optical-core/receive-core.ts';
import {normalizeFrame} from './optical-core/orientation-acquisition.ts';
import {sha256Hex} from './optical-core/sha256.ts';
import type {PixelFrame} from './optical-core/pixel-frame.ts';

const MATRIX = 96;
const SAMPLE_W = 1280;
const SAMPLE_H = 720;
const MAX_SYM_FRAMES = 160;

function log(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
  // eslint-disable-next-line no-console
  console.log('[tf011-sim]', text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SenderHandle = {
  payloads: Array<{sha256: string; byteLength: number; sourceCount: number}>;
  sessionCount: number;
  replayEvery: number;
  setSession: (i: number) => void;
  currentSession: () => number;
  renderOrientation: () => void;
  renderPreamble: () => void;
  renderManifest: (repetition: number) => void;
  renderSymbols: (symFrame: number) => void;
};

async function waitForSender(): Promise<HTMLIFrameElement> {
  const frame = document.getElementById('senderFrame') as HTMLIFrameElement | null;
  if (!frame) throw new Error('sender iframe missing');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const win = frame.contentWindow as (Window & {__TF011_SENDER__?: unknown}) | null;
      if (win && win.__TF011_SENDER__) return frame;
    } catch {
      // transient during redirect
    }
    await sleep(50);
  }
  throw new Error('timed out waiting for TF-011 broadcast sender');
}

function capture(frame: HTMLIFrameElement): PixelFrame {
  const doc = frame.contentDocument;
  if (!doc) throw new Error('sender document unavailable');
  const canvas = doc.getElementById('senderCanvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('sender canvas unavailable');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sender 2d context unavailable');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return normalizeFrame({width: canvas.width, height: canvas.height, data: image.data}, 'native', SAMPLE_W, SAMPLE_H);
}

function orientAndPreamble(core: SharedOpticalReceiveCore, sender: SenderHandle, frame: HTMLIFrameElement): void {
  sender.renderOrientation();
  const orient = core.acquireOrientation(capture(frame));
  if (!orient.locked) throw new Error('orientation failed');
  sender.renderPreamble();
  if (!core.lockPreamble(capture(frame), MATRIX)) throw new Error('preamble failed');
}

type DriveStats = {rendered: number; captured: number; dropped: number; duplicated: number};

function drive(
  core: SharedOpticalReceiveCore,
  sender: SenderHandle,
  frame: HTMLIFrameElement,
  options: {joinAt?: number; dropEvery?: number; dupEvery?: number; maxFrames?: number} = {},
): DriveStats {
  const {joinAt = 0, dropEvery = 0, dupEvery = 0, maxFrames = 0} = options;
  const replayEvery = sender.replayEvery;
  const stats: DriveStats = {rendered: 0, captured: 0, dropped: 0, duplicated: 0};
  let sym = 0;
  while (sym < MAX_SYM_FRAMES) {
    for (let rep = 0; rep < 3; rep += 1) {
      stats.rendered += 1;
      if (stats.rendered <= joinAt) { stats.dropped += 1; continue; }
      if (dropEvery && stats.rendered % dropEvery === 0) { stats.dropped += 1; continue; }
      sender.renderManifest(rep);
      const f = capture(frame);
      stats.captured += 1;
      core.readManifest(f, MATRIX);
      if (dupEvery && stats.rendered % dupEvery === 0) { stats.duplicated += 1; core.readManifest(f, MATRIX); }
      if (core.complete) return stats;
    }
    for (let i = 0; i < replayEvery && sym < MAX_SYM_FRAMES; i += 1) {
      stats.rendered += 1;
      if (stats.rendered <= joinAt) { stats.dropped += 1; sym += 1; continue; }
      if (dropEvery && stats.rendered % dropEvery === 0) { stats.dropped += 1; sym += 1; continue; }
      sender.renderSymbols(sym);
      const f = capture(frame);
      stats.captured += 1;
      core.acceptDynamicFrame(f, MATRIX);
      if (dupEvery && stats.rendered % dupEvery === 0) { stats.duplicated += 1; core.acceptDynamicFrame(f, MATRIX); }
      sym += 1;
      if (core.complete) return stats;
      if (maxFrames && stats.rendered >= maxFrames) return stats;
    }
  }
  return stats;
}

type CaseResult = {
  id: string;
  pass: boolean;
  shaMatch: boolean;
  reconstructedSha: string | null;
  stats: DriveStats;
  coreStats: Record<string, number>;
  detail?: string;
};

function runCase(
  id: string,
  core: SharedOpticalReceiveCore,
  sender: SenderHandle,
  frame: HTMLIFrameElement,
  options: Record<string, unknown>,
): CaseResult {
  try {
    orientAndPreamble(core, sender, frame);
    const stats = drive(core, sender, frame, options);
    const complete = core.complete;
    const bytes = complete ? core.reconstruct() : null;
    const sha = bytes ? sha256Hex(bytes) : null;
    const manifestSha = core.manifest ? core.manifest.file.sha256 : null;
    const shaMatch = complete && sha !== null && sha === manifestSha;
    return {
      id,
      pass: complete && shaMatch,
      shaMatch,
      reconstructedSha: sha,
      stats,
      coreStats: {...core.stats},
    };
  } catch (error) {
    return {id, pass: false, shaMatch: false, reconstructedSha: null, stats: {rendered: 0, captured: 0, dropped: 0, duplicated: 0}, coreStats: {...core.stats}, detail: String(error)};
  }
}

async function main(): Promise<void> {
  const frame = await waitForSender();
  const sender = (frame.contentWindow as unknown as {__TF011_SENDER__: SenderHandle}).__TF011_SENDER__;
  const startedAt = performance.now();
  const cases: CaseResult[] = [];

  log('A: frame 0');
  cases.push(runCase('A-start-0', new SharedOpticalReceiveCore(), sender, frame, {}));

  log('B: late join');
  cases.push(runCase('B-late-join', new SharedOpticalReceiveCore(), sender, frame, {joinAt: 17}));

  log('C: 20% drop');
  cases.push(runCase('C-20pct-drop', new SharedOpticalReceiveCore(), sender, frame, {dropEvery: 5}));

  log('D: 30% duplicate');
  cases.push(runCase('D-30pct-dup', new SharedOpticalReceiveCore(), sender, frame, {dupEvery: 3}));

  log('E: checkpoint/restore');
  {
    const core = new SharedOpticalReceiveCore();
    orientAndPreamble(core, sender, frame);
    drive(core, sender, frame, {maxFrames: 25});
    const cp = core.exportCheckpoint();
    const restored = cp ? (JSON.parse(JSON.stringify(cp)) as ReturnType<typeof core.exportCheckpoint>) : null;
    const core2 = new SharedOpticalReceiveCore();
    if (restored && core2.restoreCheckpoint(restored)) {
      const stats2 = drive(core2, sender, frame, {joinAt: 25});
      const bytes = core2.complete ? core2.reconstruct() : null;
      const sha = bytes ? sha256Hex(bytes) : null;
      const manifestSha = core2.manifest ? core2.manifest.file.sha256 : null;
      const shaMatch = core2.complete && sha !== null && sha === manifestSha;
      cases.push({id: 'E-checkpoint-restore', pass: core2.complete && shaMatch, shaMatch, reconstructedSha: sha, stats: stats2, coreStats: {...core2.stats}});
    } else {
      cases.push({id: 'E-checkpoint-restore', pass: false, shaMatch: false, reconstructedSha: null, stats: {rendered: 0, captured: 0, dropped: 0, duplicated: 0}, coreStats: {}, detail: 'checkpoint restore failed'});
    }
  }

  log('F: session isolation');
  {
    const core = new SharedOpticalReceiveCore();
    orientAndPreamble(core, sender, frame);
    sender.setSession(0);
    core.readManifest(capture(frame), MATRIX);
    for (let i = 0; i < 10; i += 1) { sender.renderSymbols(i); core.acceptDynamicFrame(capture(frame), MATRIX); }
    const keyA = core.activeSessionKey;
    sender.setSession(1);
    core.readManifest(capture(frame), MATRIX);
    let frames = 0;
    while (!core.complete && frames < 300) { sender.renderSymbols(frames); core.acceptDynamicFrame(capture(frame), MATRIX); frames += 1; }
    const bytes = core.complete ? core.reconstruct() : null;
    const sha = bytes ? sha256Hex(bytes) : null;
    const shaMatch = core.complete && sha !== null && sha === sender.payloads[1].sha256;
    const isolated = keyA !== core.activeSessionKey && core.previousCheckpoints.has(keyA || '');
    cases.push({id: 'F-session-isolation', pass: core.complete && shaMatch && isolated, shaMatch, reconstructedSha: sha, stats: {rendered: 0, captured: 0, dropped: 0, duplicated: 0}, coreStats: {...core.stats}, detail: isolated ? '' : 'isolation check failed'});
  }

  log('G: repeated manifest');
  {
    const core = new SharedOpticalReceiveCore();
    orientAndPreamble(core, sender, frame);
    sender.setSession(0);
    core.readManifest(capture(frame), MATRIX);
    for (let i = 0; i < 6; i += 1) { sender.renderSymbols(i); core.acceptDynamicFrame(capture(frame), MATRIX); }
    const before = core.solvedCount;
    sender.renderManifest(1); core.readManifest(capture(frame), MATRIX);
    const notReset = core.solvedCount === before;
    drive(core, sender, frame, {joinAt: 6});
    const bytes = core.complete ? core.reconstruct() : null;
    const sha = bytes ? sha256Hex(bytes) : null;
    const shaMatch = core.complete && sha !== null && sha === sender.payloads[0].sha256;
    cases.push({id: 'G-repeated-manifest', pass: core.complete && shaMatch && notReset, shaMatch, reconstructedSha: sha, stats: {rendered: 0, captured: 0, dropped: 0, duplicated: 0}, coreStats: {...core.stats}, detail: notReset ? '' : 'progress was reset'});
  }

  log('H: invalid manifest');
  {
    const core = new SharedOpticalReceiveCore();
    orientAndPreamble(core, sender, frame);
    sender.setSession(0);
    core.readManifest(capture(frame), MATRIX);
    const key = core.activeSessionKey;
    sender.renderManifest(0);
    const corrupted = capture(frame);
    // Corrupt a region of the rendered manifest → invalid observation.
    const w = corrupted.width;
    for (let y = 300; y < 420; y += 1) for (let x = 200; x < 400; x += 1) {
      const o = (y * w + x) * 4;
      corrupted.data[o] = (x + y) & 255; corrupted.data[o + 1] = (x * 3) & 255; corrupted.data[o + 2] = (y * 5) & 255;
    }
    core.readManifest(corrupted, MATRIX);
    const preserved = core.activeSessionKey === key;
    cases.push({id: 'H-invalid-manifest', pass: preserved, shaMatch: false, reconstructedSha: null, stats: {rendered: 0, captured: 0, dropped: 0, duplicated: 0}, coreStats: {...core.stats}, detail: preserved ? '' : 'session was replaced by invalid manifest'});
  }

  const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const result = {
    done: true,
    evidenceClass: 'SIMULATED BROWSER PIXEL BROADCAST RESUME ROBUSTNESS',
    note: 'SIMULATION EVIDENCE ONLY. Not physical acquisition. Not Net Goodput.',
    senderEntry: '/tiled-physical-v5.html?role=sender&standalone=broadcast&sessions=2&replayEvery=16',
    networkPayloadPath: 'NONE',
    oracleInputs: [],
    replayEvery: sender.replayEvery,
    cases,
    summary: {total: cases.length, passed: cases.filter(c => c.pass).length},
    timings: {totalMs, timingNote: 'DESKTOP / SIMULATION timing only'},
  };
  (window as unknown as Record<string, unknown>).__TF011_SIM__ = result;
  log('SIM ' + (cases.every(c => c.pass) ? 'PASS' : 'FAIL') + ': ' + cases.map(c => c.id + (c.pass ? '✓' : '✗')).join(' '));
}

main().catch((error) => {
  log('ERROR: ' + String(error && (error as Error).message ? (error as Error).message : error));
  (window as unknown as Record<string, unknown>).__TF011_SIM__ = {
    done: false,
    error: String(error),
    evidenceClass: 'SIMULATED BROWSER PIXEL BROADCAST RESUME ROBUSTNESS',
  };
});
