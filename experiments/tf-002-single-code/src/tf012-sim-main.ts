/**
 * TF-012 real-time software frame-cadence stress test (SIMULATION ONLY).
 *
 * Two parts:
 *  1. BUDGET INVENTORY (Phase 1): per-stage avg/p50/p95/max over deterministic
 *     rendered-pixel frames using the public shared-core stage methods.
 *  2. REAL-TIME PIPELINE (Phase 7): a bounded producer/consumer model feeding
 *     15 / 20 / 30 FPS wall-clock frames through SharedOpticalReceiveCore.
 *
 * The bounded model is "one frame actively processing + one latest pending
 * frame". The producer renders at the target cadence; the consumer drains the
 * latest pending frame. No unbounded queue is ever built (maxQueueDepth <= 1).
 *
 * Receiver input is rendered pixels only. No oracle, no network payload path.
 */
import {SharedOpticalReceiveCore} from './optical-core/receive-core.ts';
import {normalizeFrame} from './optical-core/orientation-acquisition.ts';
import {sha256Hex} from './optical-core/sha256.ts';
import type {PixelFrame} from './optical-core/pixel-frame.ts';

const MATRIX = 96;
const SAMPLE_W = 1280;
const SAMPLE_H = 720;
const CYCLES = 8; // 8 cycles × (1 orient + 1 preamble + 3 manifest + replayEvery symbols)

type StageName = 'idle' | 'oriented' | 'preamble' | 'receiving' | 'complete';

function log(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
  // eslint-disable-next-line no-console
  console.log('[tf012-sim]', text);
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
      // transient during load
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

type Step = {kind: 'orientation' | 'preamble' | 'manifest' | 'symbols'; index: number};

function buildSchedule(replayEvery: number, cycles: number): Step[] {
  const out: Step[] = [];
  let sym = 0;
  for (let c = 0; c < cycles; c += 1) {
    out.push({kind: 'orientation', index: 0});
    out.push({kind: 'preamble', index: 0});
    for (let rep = 0; rep < 3; rep += 1) out.push({kind: 'manifest', index: rep});
    for (let i = 0; i < replayEvery; i += 1) { out.push({kind: 'symbols', index: sym}); sym += 1; }
  }
  return out;
}

function renderStep(sender: SenderHandle, d: Step): void {
  if (d.kind === 'orientation') sender.renderOrientation();
  else if (d.kind === 'preamble') sender.renderPreamble();
  else if (d.kind === 'manifest') sender.renderManifest(d.index);
  else sender.renderSymbols(d.index);
}

type TimingSummary = {n: number; avg: number; p50: number; p95: number; max: number};

function summarize(values: number[]): TimingSummary {
  if (!values.length) return {n: 0, avg: 0, p50: 0, p95: 0, max: 0};
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const p = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * f))];
  return {n: values.length, avg, p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1]};
}

function round(n: number, digits = 3): number {
  return Number(n.toFixed(digits));
}

// ---------------------------------------------------------------------------
// Phase 1: per-stage budget inventory on deterministic rendered-pixel frames.
// ---------------------------------------------------------------------------
function runBudgetInventory(sender: SenderHandle, frame: HTMLIFrameElement): Record<string, unknown> {
  const wrap: number[] = [];
  const beaconProbeAccept: number[] = [];
  const beaconProbeReject: number[] = [];
  const orientationFiducial: number[] = [];
  const preambleLock: number[] = [];
  const manifestDecode: number[] = [];
  const dynamicDecode: number[] = [];
  const checkpoint: number[] = [];
  const reconstruct: number[] = [];
  const sha256Times: number[] = [];

  // Capture static reference frames (wrapping is also timed separately below).
  sender.renderOrientation();
  const beaconFrame = capture(frame);
  sender.renderPreamble();
  const preambleFrame = capture(frame);
  sender.renderManifest(0);
  const manifestFrame = capture(frame);
  sender.renderSymbols(0);
  const symbolFrame = capture(frame);

  // 1. PixelFrame wrapping (getImageData + normalize to 1280x720).
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    sender.renderSymbols(i % 16);
    capture(frame);
    wrap.push(performance.now() - t0);
  }

  const probeCore = new SharedOpticalReceiveCore();
  // 2. Cheap beacon probe: accept (64 beacon) and reject (96 frames).
  for (let i = 0; i < 10; i += 1) {
    let t0 = performance.now();
    probeCore.isLikelyOrientationBeacon(beaconFrame as unknown as ImageData);
    beaconProbeAccept.push(performance.now() - t0);
    t0 = performance.now();
    probeCore.isLikelyOrientationBeacon(symbolFrame as unknown as ImageData);
    beaconProbeReject.push(performance.now() - t0);
  }

  // 3. fiducialOnly orientation acquisition (fresh core each sample).
  for (let i = 0; i < 5; i += 1) {
    const core = new SharedOpticalReceiveCore();
    const t0 = performance.now();
    core.acquireOrientation(beaconFrame, {fiducialOnly: true});
    orientationFiducial.push(performance.now() - t0);
  }

  // 4-7. Preamble lock, Manifest decode, dynamic decode, checkpoint (fresh core
  // each sample so each stage cost is isolated from prior state).
  for (let i = 0; i < 5; i += 1) {
    const c = new SharedOpticalReceiveCore();
    c.acquireOrientation(beaconFrame, {fiducialOnly: true});
    let t0 = performance.now();
    c.lockPreamble(preambleFrame, MATRIX);
    preambleLock.push(performance.now() - t0);
    if (!c.manifest) {
      t0 = performance.now();
      c.readManifest(manifestFrame, MATRIX);
      manifestDecode.push(performance.now() - t0);
      t0 = performance.now();
      c.acceptDynamicFrame(symbolFrame, MATRIX);
      dynamicDecode.push(performance.now() - t0);
      // 7. checkpoint work (export the in-progress session).
      t0 = performance.now();
      c.exportCheckpoint();
      checkpoint.push(performance.now() - t0);
    }
  }

  // 8. SHA-256 over a reconstructed-size buffer (64 KiB).
  const probeBytes = new Uint8Array(64 * 1024);
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    sha256Hex(probeBytes);
    sha256Times.push(performance.now() - t0);
  }

  // 9. Reconstruction + SHA over a completed core (drive to completion).
  const full = new SharedOpticalReceiveCore();
  full.acquireOrientation(beaconFrame, {fiducialOnly: true});
  full.lockPreamble(preambleFrame, MATRIX);
  full.readManifest(manifestFrame, MATRIX);
  const schedule = buildSchedule(sender.replayEvery, CYCLES);
  let i = 0;
  while (!full.complete && i < schedule.length) {
    const d = schedule[i];
    if (d.kind === 'manifest') full.readManifest(manifestFrame, MATRIX);
    else if (d.kind === 'symbols') { sender.renderSymbols(d.index); full.acceptDynamicFrame(capture(frame), MATRIX); }
    i += 1;
  }
  if (full.complete) {
    let t0 = performance.now();
    const bytes = full.reconstruct();
    reconstruct.push(performance.now() - t0);
    if (bytes) {
      t0 = performance.now();
      sha256Hex(bytes);
      sha256Times.push(performance.now() - t0);
    }
  }

  return {
    wrapMs: {n: wrap.length, avg: round(summarize(wrap).avg), p50: round(summarize(wrap).p50), p95: round(summarize(wrap).p95), max: round(summarize(wrap).max)},
    beaconProbeAcceptMs: {n: beaconProbeAccept.length, avg: round(summarize(beaconProbeAccept).avg), p50: round(summarize(beaconProbeAccept).p50), p95: round(summarize(beaconProbeAccept).p95), max: round(summarize(beaconProbeAccept).max)},
    beaconProbeRejectMs: {n: beaconProbeReject.length, avg: round(summarize(beaconProbeReject).avg), p50: round(summarize(beaconProbeReject).p50), p95: round(summarize(beaconProbeReject).p95), max: round(summarize(beaconProbeReject).max)},
    orientationFiducialMs: {n: orientationFiducial.length, avg: round(summarize(orientationFiducial).avg), p50: round(summarize(orientationFiducial).p50), p95: round(summarize(orientationFiducial).p95), max: round(summarize(orientationFiducial).max)},
    preambleLockMs: {n: preambleLock.length, avg: round(summarize(preambleLock).avg), p50: round(summarize(preambleLock).p50), p95: round(summarize(preambleLock).p95), max: round(summarize(preambleLock).max)},
    manifestDecodeMs: {n: manifestDecode.length, avg: round(summarize(manifestDecode).avg), p50: round(summarize(manifestDecode).p50), p95: round(summarize(manifestDecode).p95), max: round(summarize(manifestDecode).max)},
    dynamicDecodeMs: {n: dynamicDecode.length, avg: round(summarize(dynamicDecode).avg), p50: round(summarize(dynamicDecode).p50), p95: round(summarize(dynamicDecode).p95), max: round(summarize(dynamicDecode).max)},
    checkpointMs: {n: checkpoint.length, avg: round(summarize(checkpoint).avg), p50: round(summarize(checkpoint).p50), p95: round(summarize(checkpoint).p95), max: round(summarize(checkpoint).max)},
    reconstructMs: {n: reconstruct.length, avg: round(summarize(reconstruct).avg), p50: round(summarize(reconstruct).p50), p95: round(summarize(reconstruct).p95), max: round(summarize(reconstruct).max)},
    sha256Ms: {n: sha256Times.length, avg: round(summarize(sha256Times).avg), p50: round(summarize(sha256Times).p50), p95: round(summarize(sha256Times).p95), max: round(summarize(sha256Times).max)},
    note: 'dynamicDecodeMs includes track + decode + Fountain addSymbol (items 8+9). CameraFrame callback rate, UI setData, and local file write are measured on-device (Mini Program adapter).',
  };
}

// ---------------------------------------------------------------------------
// Phase 3: beacon gate false-positive / false-negative measurement.
// ---------------------------------------------------------------------------
function runBeaconGate(sender: SenderHandle, frame: HTMLIFrameElement): Record<string, unknown> {
  const core = new SharedOpticalReceiveCore();
  sender.renderOrientation();
  const beacon = capture(frame);
  sender.renderPreamble();
  const preamble = capture(frame);
  sender.renderManifest(0);
  const manifest = capture(frame);
  const schedule = buildSchedule(sender.replayEvery, 1);
  let falsePositives = 0;
  let falseNegatives = 0;
  let nonBeaconSamples = 0;
  let beaconSamples = 0;
  // Non-beacon frames must all reject (no false positives).
  const nonBeacon = [preamble, manifest];
  for (let i = 0; i < 16; i += 1) {
    const d = schedule[i];
    if (d.kind === 'symbols') { sender.renderSymbols(d.index); nonBeacon.push(capture(frame)); }
  }
  for (const f of nonBeacon) {
    nonBeaconSamples += 1;
    if (core.isLikelyOrientationBeacon(f as unknown as ImageData)) falsePositives += 1;
  }
  // Beacon frames must all accept (no false negatives).
  for (let i = 0; i < 8; i += 1) {
    beaconSamples += 1;
    if (!core.isLikelyOrientationBeacon(beacon as unknown as ImageData)) falseNegatives += 1;
  }
  return {nonBeaconSamples, beaconSamples, falsePositives, falseNegatives};
}

// ---------------------------------------------------------------------------
// Phase 7: bounded producer/consumer real-time run at one cadence.
//
// Models the Mini Program's ACTUAL synchronous main-thread architecture (no
// Worker — see docs/TF012_WORKER_DECISION.md). The producer fires at the target
// cadence; the consumer drains the latest pending frame through the shared core
// and keeps at most one pending frame (bounded slot). Because both run on one
// thread, the camera callback is naturally throttled by processing: when a
// heavy stage (e.g. preamble lock) runs, producer ticks queue behind it and the
// slot never grows beyond depth 1. Frames are dropped at the native-camera
// level, not queued in JS — so skipped/replaced reads 0 in the synchronous
// model (this is the honest on-device behaviour without a Worker).
// ---------------------------------------------------------------------------
async function runRealTimeRun(
  sender: SenderHandle,
  frame: HTMLIFrameElement,
  fps: number,
): Promise<Record<string, unknown>> {
  const core = new SharedOpticalReceiveCore();
  const period = 1000 / fps;
  const schedule = buildSchedule(sender.replayEvery, CYCLES);
  let stepIndex = 0;
  let producerFrames = 0;
  let processedFrames = 0;
  let replacedFrames = 0;
  let maxQueueDepth = 0;
  let pending: PixelFrame | null = null;
  let done = false;
  const stageTimes: Record<StageName, number[]> = {idle: [], oriented: [], preamble: [], receiving: [], complete: []};

  const startedAt = performance.now();

  const producer = window.setInterval(() => {
    if (done || stepIndex >= schedule.length) return;
    const d = schedule[stepIndex];
    stepIndex += 1;
    renderStep(sender, d);
    const f = capture(frame);
    producerFrames += 1;
    if (pending) replacedFrames += 1; // bounded slot: overwrite the pending frame
    pending = f;
    if (pending && 1 > maxQueueDepth) maxQueueDepth = 1;
  }, period);

  while (!done) {
    if (pending) {
      const f = pending;
      pending = null;
      const stageBefore = core.stage;
      const t0 = performance.now();
      core.processFrame(f, MATRIX);
      stageTimes[stageBefore].push(performance.now() - t0);
      processedFrames += 1;
      if (core.complete) { done = true; break; }
    } else if (stepIndex >= schedule.length) {
      done = true; // stream exhausted without completion
      break;
    }
    await sleep(0);
  }
  window.clearInterval(producer);

  const elapsedMs = performance.now() - startedAt;
  const skippedBusy = Math.max(0, producerFrames - processedFrames);
  let reconstructedSha: string | null = null;
  let shaMatch = false;
  let reconstructMs = 0;
  let shaMs = 0;
  if (core.complete) {
    const r0 = performance.now();
    const bytes = core.reconstruct();
    reconstructMs = performance.now() - r0;
    if (bytes) {
      const s0 = performance.now();
      reconstructedSha = sha256Hex(bytes);
      shaMs = performance.now() - s0;
      shaMatch = reconstructedSha === sender.payloads[0].sha256;
    }
  }

  const s = (v: number[]) => summarize(v);
  return {
    targetFps: fps,
    framePeriodMs: round(period, 1),
    complete: core.complete,
    shaMatch,
    reconstructedSha,
    producerFps: round(producerFrames / (elapsedMs / 1000), 2),
    processedFps: round(processedFrames / (elapsedMs / 1000), 2),
    producerFrames,
    processedFrames,
    skippedBusyFrames: skippedBusy,
    replacedFrames,
    maxQueueDepth,
    usefulSymbolRate: round(core.stats.decodedSymbols / (elapsedMs / 1000), 2),
    elapsedMs: round(elapsedMs, 1),
    reconstructMs: round(reconstructMs),
    shaMs: round(shaMs),
    orientationMs: round(s(stageTimes.idle).max),
    stageTimes: {
      idle: {n: s(stageTimes.idle).n, avg: round(s(stageTimes.idle).avg), p50: round(s(stageTimes.idle).p50), p95: round(s(stageTimes.idle).p95), max: round(s(stageTimes.idle).max)},
      oriented: {n: s(stageTimes.oriented).n, avg: round(s(stageTimes.oriented).avg), p50: round(s(stageTimes.oriented).p50), p95: round(s(stageTimes.oriented).p95), max: round(s(stageTimes.oriented).max)},
      preamble: {n: s(stageTimes.preamble).n, avg: round(s(stageTimes.preamble).avg), p50: round(s(stageTimes.preamble).p50), p95: round(s(stageTimes.preamble).p95), max: round(s(stageTimes.preamble).max)},
      receiving: {n: s(stageTimes.receiving).n, avg: round(s(stageTimes.receiving).avg), p50: round(s(stageTimes.receiving).p50), p95: round(s(stageTimes.receiving).p95), max: round(s(stageTimes.receiving).max)},
    },
    coreStats: {...core.stats},
  };
}

async function main(): Promise<void> {
  const frame = await waitForSender();
  const sender = (frame.contentWindow as unknown as {__TF011_SENDER__: SenderHandle}).__TF011_SENDER__;
  const startedAt = performance.now();

  log('TF-012 budget inventory (Phase 1)…');
  const budgetInventory = runBudgetInventory(sender, frame);

  log('TF-012 beacon gate (Phase 3)…');
  const beaconGate = runBeaconGate(sender, frame);

  const fpsRuns: Array<Record<string, unknown>> = [];
  for (const fps of [15, 20, 30]) {
    log(`TF-012 real-time run @ ${fps} FPS…`);
    fpsRuns.push(await runRealTimeRun(sender, frame, fps));
  }

  const result = {
    done: true,
    evidenceClass: 'SIMULATED REAL-TIME FRAME-CADENCE STRESS',
    note: 'SIMULATION EVIDENCE ONLY. Not physical camera ingress. Not Net Goodput. Single-threaded producer/consumer stand-in for the on-device bounded pipeline.',
    senderEntry: '/tiled-physical-v5.html?role=sender&standalone=broadcast&sessions=2&replayEvery=16',
    networkPayloadPath: 'NONE',
    oracleInputs: [],
    replayEvery: sender.replayEvery,
    acquisitionBeacon: 'orientation(64) + preamble(96) emitted at the start of every broadcast cycle',
    boundedModel: 'one frame actively processing + one latest pending frame (maxQueueDepth <= 1)',
    budgetInventory,
    beaconGate,
    fpsRuns,
    summary: {
      runs: fpsRuns.length,
      allComplete: fpsRuns.every(r => r.complete === true),
      allShaMatch: fpsRuns.every(r => r.shaMatch === true),
      allBounded: fpsRuns.every(r => (r.maxQueueDepth as number) <= 1),
    },
    timings: {totalMs: round(performance.now() - startedAt, 1), timingNote: 'DESKTOP / SIMULATION timing only'},
  };

  (window as unknown as Record<string, unknown>).__TF012_SIM__ = result;
  log('SIM ' + (result.summary.allComplete && result.summary.allShaMatch ? 'PASS' : 'FAIL') +
    ': ' + fpsRuns.map(r => `${r.targetFps}FPS=${r.complete ? 'complete' : 'incomplete'}(${r.processedFps}proc/s)`).join(' '));
}

main().catch((error) => {
  log('ERROR: ' + String(error && (error as Error).message ? (error as Error).message : error));
  (window as unknown as Record<string, unknown>).__TF012_SIM__ = {
    done: false,
    error: String(error && (error as Error).message ? (error as Error).message : error),
    evidenceClass: 'SIMULATED REAL-TIME FRAME-CADENCE STRESS',
    networkPayloadPath: 'NONE',
    oracleInputs: [],
  };
});
