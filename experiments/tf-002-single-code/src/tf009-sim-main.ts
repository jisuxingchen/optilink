/**
 * TF-009 browser pixel simulation receiver — full receive chain.
 *
 *   real sender (standalone file mode)
 *     → rendered pixels (canvas framebuffer read)
 *     → PixelFrame 1280x720
 *     → SharedOpticalReceiveCore (orientation → preamble → Manifest → symbols)
 *     → FountainDecoder → reconstructed bytes
 *     → SHA-256 (adapter digest)
 *
 * EVIDENCE: SIMULATION ONLY. Not physical acquisition. Not Net Goodput.
 * The receiver reads rendered pixels only. The sender's payload object is
 * never read by this module — it is only used by the Playwright spec for the
 * final post-decode assertion.
 */
import {SharedOpticalReceiveCore} from './optical-core/receive-core.ts';
import {normalizeFrame} from './optical-core/orientation-acquisition.ts';
import type {PixelFrame} from './optical-core/pixel-frame.ts';

const SAMPLE_W = 1280;
const SAMPLE_H = 720;
// Protocol constant (same value the sender renders with). The fountain block
// size, seed, and total byte length are NOT hardcoded here — they are read
// optically from the decoded Manifest.
const FILE_MATRIX = 96;
const MAX_DYNAMIC_FRAMES = 256;
const MAX_MANIFEST_ATTEMPTS = 6;

function log(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
  // eslint-disable-next-line no-console
  console.log('[tf009-sim]', text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSender(): Promise<HTMLIFrameElement> {
  const frame = document.getElementById('senderFrame') as HTMLIFrameElement | null;
  if (!frame) throw new Error('sender iframe missing');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow as (Window & {__TF009_SENDER__?: unknown}) | null;
      if (doc && win && win.__TF009_SENDER__) return frame;
    } catch {
      // transient during redirect
    }
    await sleep(50);
  }
  throw new Error('timed out waiting for TF-009 file sender render');
}

function capture(frame: HTMLIFrameElement): PixelFrame {
  const doc = frame.contentDocument;
  if (!doc) throw new Error('sender document unavailable');
  const canvas = doc.getElementById('senderCanvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('sender canvas unavailable');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sender 2d context unavailable');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const raw: PixelFrame = {width: canvas.width, height: canvas.height, data: image.data};
  return normalizeFrame(raw, 'native', SAMPLE_W, SAMPLE_H);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i += 1) out += view[i].toString(16).padStart(2, '0');
  return out;
}

type SenderHandle = {
  renderOrientation: () => void;
  renderPreamble: () => void;
  renderManifest: (repetition: number) => void;
  renderNextSymbols: () => number;
  symbolIndex: () => number;
};

async function main(): Promise<void> {
  log('waiting for TF-009 file sender…');
  const frame = await waitForSender();
  const sender = (frame.contentWindow as unknown as {__TF009_SENDER__: SenderHandle}).__TF009_SENDER__;
  const core = new SharedOpticalReceiveCore();
  const startedAt = performance.now();

  // Stage 1 — orientation (64x64).
  sender.renderOrientation();
  const orientation = core.acquireOrientation(capture(frame));
  if (!orientation.locked || !core.orientation) {
    throw new Error('orientation acquisition failed: ' + JSON.stringify(orientation.best?.tripletRejectReason ?? 'no result'));
  }
  log('orientation locked: ' + (core.normalizedMode ?? '?'));

  // Stage 2 — preamble lock at the data matrix size.
  sender.renderPreamble();
  if (!core.lockPreamble(capture(frame), FILE_MATRIX)) {
    throw new Error('data preamble lock failed at ' + FILE_MATRIX);
  }
  log('data preamble locked at ' + FILE_MATRIX);

  // Stage 3 — optical Manifest.
  let manifestRecovered = false;
  for (let attempt = 0; attempt < MAX_MANIFEST_ATTEMPTS && !manifestRecovered; attempt += 1) {
    sender.renderManifest(attempt);
    manifestRecovered = core.readManifest(capture(frame), FILE_MATRIX);
  }
  if (!manifestRecovered || !core.manifest) {
    throw new Error('manifest not recovered after ' + MAX_MANIFEST_ATTEMPTS + ' attempts');
  }
  log('manifest recovered: ' + core.manifest.file.name + ' ' + core.manifest.file.byteLength + ' B');

  // Stage 4 — dynamic symbols until the fountain decoder is complete.
  const dynamicStarted = performance.now();
  let frames = 0;
  while (!core.complete && frames < MAX_DYNAMIC_FRAMES) {
    sender.renderNextSymbols();
    core.acceptDynamicFrame(capture(frame), FILE_MATRIX);
    frames += 1;
  }
  const dynamicMs = performance.now() - dynamicStarted;
  const totalMs = performance.now() - startedAt;

  // Stage 5 — reconstruct + adapter digest.
  const bytes = core.reconstruct();
  if (!bytes) {
    throw new Error('reconstruction incomplete: ' + core.solvedCount + '/' + core.sourceCount);
  }
  const reconstructedSha = await sha256Hex(bytes);
  const manifestSha = core.manifest.file.sha256;
  const shaMatch = reconstructedSha === manifestSha;

  const result = {
    done: true,
    evidenceClass: 'SIMULATED BROWSER PIXEL END-TO-END RECONSTRUCTION',
    note: 'SIMULATION EVIDENCE ONLY. Not physical optical ingress. Not physical acquisition PASS. Not Net Goodput.',
    senderEntry: '/tiled-physical-v5.html?role=sender&standalone=file',
    receiverPipeline: 'rendered pixels → PixelFrame → SharedOpticalReceiveCore (orientation→preamble→manifest→symbols) → FountainDecoder → SHA-256',
    networkPayloadPath: 'NONE',
    oracleInputs: [],
    orientation: orientation.best
      ? {
          mode: orientation.best.orientationMode,
          locked: orientation.locked,
          support: orientation.best.locatorSupport,
          tripletValid: orientation.best.tripletValid,
          lockMode: orientation.best.lockMode,
          exactTiles: orientation.best.exactTiles,
          projectionSafe: orientation.best.projectionSafe,
          selectedTransform: orientation.selectedTransform,
        }
      : null,
    manifest: core.manifest
      ? {
          protocol: core.manifest.protocol,
          version: core.manifest.version,
          file: {name: core.manifest.file.name, byteLength: core.manifest.file.byteLength},
          matrixSize: core.manifest.transport.matrixSize,
          fountainSourceBlockBytes: core.manifest.transport.fountainSourceBlockBytes,
          fountainSeed: core.manifest.transport.fountainSeed,
        }
      : null,
    frameStats: {
      renderedFrames: frames,
      ...core.stats,
    },
    reconstruction: {
      sourceSize: core.manifest.file.byteLength,
      reconstructedSize: bytes.length,
      reconstructedSha256: reconstructedSha,
      manifestSha256: manifestSha,
      shaMatch,
      solvedBlocks: core.solvedCount,
      totalBlocks: core.sourceCount,
    },
    timings: {
      totalMs: Math.round(totalMs * 10) / 10,
      dynamicMs: Math.round(dynamicMs * 10) / 10,
      timingNote: 'DESKTOP / SIMULATION timing only',
    },
  };

  (window as unknown as Record<string, unknown>).__TF009_SIM__ = result;
  log(shaMatch ? 'SIM PASS — SHA-256 match' : 'SIM FAIL — SHA-256 mismatch');
}

main().catch((error) => {
  log('ERROR: ' + String(error && (error as Error).message ? (error as Error).message : error));
  (window as unknown as Record<string, unknown>).__TF009_SIM__ = {
    done: false,
    error: String(error),
    evidenceClass: 'SIMULATED BROWSER PIXEL END-TO-END RECONSTRUCTION',
  };
});
