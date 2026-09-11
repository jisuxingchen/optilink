/**
 * TF-008 PC/browser simulation receiver harness.
 *
 * PURPOSE
 * Prove the FULL software path end-to-end on a PC, before any physical phone
 * retest:
 *
 *   real sender page (tf-008-orientation-sender.html)
 *   → browser-rendered pixels (the real sender canvas framebuffer)
 *   → captured RGBA framebuffer
 *   → PixelFrame ({width,height,data})
 *   → orientation transform selection
 *   → macro-marker detection (trusted triplet)
 *   → 64x64 tile acquisition (3/3 exact)
 *
 * The receiver consumes ONLY rendered pixels. It never reads sender internal
 * matrices, DOM data attributes, JS payload variables, encoder buffers,
 * expected tile arrays, hidden JSON, WebSocket payloads, or filesystem source
 * payloads. The only data path into the receiver is:
 *
 *   browser-rendered visual pixels → framebuffer read → PixelFrame → acquireOrientation()
 *
 * EVIDENCE TERMINOLOGY (hard rule)
 * This is SIMULATION EVIDENCE ONLY. It is NOT physical optical ingress, NOT a
 * physical acquisition PASS, and NOT Net Goodput. Desktop timings reported here
 * are desktop/simulation timings only.
 */
import {
  acquireOrientation,
  normalizeFrame,
  type OrientationMode,
} from './optical-core/orientation-acquisition.ts';
import type {PixelFrame} from './optical-core/pixel-frame.ts';

// Observed Mini Program physical camera geometry (moto razr 40 ultra).
const PORTRAIT_W = 720;
const PORTRAIT_H = 1280;
// The sender canvas backing store (tiled-physical-v5.html renders 1920x1080).
const SENDER_BACKING_W = 1920;
const SENDER_BACKING_H = 1080;

const SENDER_OVERLAY_TEXTS = [
  'TF-008 STANDALONE ORIENTATION 64×64',
  'NO COORDINATOR',
  'STATIC PHYSICAL TEST PATTERN',
];

function log(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
  // eslint-disable-next-line no-console
  console.log('[tf008-sim]', text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the real sender page (loaded in the iframe) has rendered the
 * standalone orientation pattern. Returns the real sender canvas element.
 */
async function waitForSender(): Promise<HTMLCanvasElement> {
  const frame = document.getElementById('senderFrame') as HTMLIFrameElement | null;
  if (!frame) throw new Error('sender iframe missing');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const doc = frame.contentDocument;
      if (doc) {
        const canvas = doc.getElementById('senderCanvas') as HTMLCanvasElement | null;
        const bodyText = doc.body ? doc.body.textContent || '' : '';
        const allTexts = SENDER_OVERLAY_TEXTS.every((t) => bodyText.includes(t));
        if (canvas && allTexts) {
          // Confirm the canvas is actually painted (not the initial opaque
          // black state of an alpha:false canvas) before returning it.
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const corner = ctx.getImageData(0, 0, 1, 1).data;
            if (corner[0] !== 0 || corner[1] !== 0 || corner[2] !== 0) return canvas;
          }
        }
      }
    } catch {
      // Transient (redirect in progress). Retry.
    }
    await sleep(50);
  }
  throw new Error('timed out waiting for standalone orientation sender render');
}

/**
 * Read the sender canvas framebuffer as RGBA pixels. This is the ONLY data the
 * receiver ever receives — rendered pixels, nothing else.
 */
function captureFramebuffer(canvas: HTMLCanvasElement): PixelFrame {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sender canvas 2d context unavailable');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {width: canvas.width, height: canvas.height, data: image.data};
}

type MarginStyle = 'black' | 'neutral';

/**
 * Place the landscape sender content UPRIGHT into a portrait 720x1280 frame,
 * letterboxed (the 16:9 content becomes a central 720x405 strip). This models a
 * portrait sensor seeing an upright landscape screen as a horizontal strip.
 */
function letterboxPortrait(
  raw: PixelFrame,
  rotate180: boolean,
  margins: MarginStyle,
): PixelFrame {
  const contentW = PORTRAIT_W;
  const contentH = Math.round((PORTRAIT_W * 9) / 16); // 405
  const content = normalizeFrame(raw, rotate180 ? 'rotate180' : 'native', contentW, contentH);

  const out = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  // Fill margins.
  const r = margins === 'black' ? 0 : 236;
  const g = margins === 'black' ? 0 : 239;
  const b = margins === 'black' ? 0 : 241;
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  const y0 = Math.round((PORTRAIT_H - contentH) / 2);
  for (let y = 0; y < contentH; y++) {
    for (let x = 0; x < contentW; x++) {
      const s = (y * contentW + x) * 4;
      const d = ((y0 + y) * PORTRAIT_W + x) * 4;
      out[d] = content.data[s];
      out[d + 1] = content.data[s + 1];
      out[d + 2] = content.data[s + 2];
      out[d + 3] = 255;
    }
  }
  return {width: PORTRAIT_W, height: PORTRAIT_H, data: out};
}

/**
 * Upright letterbox content with a scaling + translation perturbation, to
 * exercise transform-selection robustness against real-world framing error.
 */
function letterboxPortraitScaled(
  raw: PixelFrame,
  scale: number,
  dx: number,
  dy: number,
): PixelFrame {
  const contentW = Math.max(1, Math.round(PORTRAIT_W * scale));
  const contentH = Math.max(1, Math.round((contentW * 9) / 16));
  const content = normalizeFrame(raw, 'native', contentW, contentH);
  const out = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  const x0 = Math.round((PORTRAIT_W - contentW) / 2) + dx;
  const y0 = Math.round((PORTRAIT_H - contentH) / 2) + dy;
  for (let y = 0; y < contentH; y++) {
    for (let x = 0; x < contentW; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= PORTRAIT_W || sy >= PORTRAIT_H) continue;
      const s = (y * contentW + x) * 4;
      const d = (sy * PORTRAIT_W + sx) * 4;
      out[d] = content.data[s];
      out[d + 1] = content.data[s + 1];
      out[d + 2] = content.data[s + 2];
      out[d + 3] = 255;
    }
  }
  return {width: PORTRAIT_W, height: PORTRAIT_H, data: out};
}

type SimCase = {
  id: string;
  placement: string;
  expectedTransform: OrientationMode;
  primary: boolean;
  result: CaseResult;
};

type CaseResult = {
  selectedTransform: OrientationMode | null;
  orientationMode: OrientationMode | null;
  locked: boolean;
  detectedMarkerComponentCount: number;
  validTripletMarkerCount: number;
  tripletValid: boolean;
  support: string;
  lockMode: string;
  exactTiles: number;
  tileCount: number;
  projection: boolean | null;
  bitErrors: Array<number | null>;
  tripletRejectReason: string;
  transformCandidates: unknown[];
  profile: {
    preScanMs: number;
    normalizeMs: number;
    lockMs: number;
    refineMs: number;
    errorsMs: number;
    calibrationMs: number;
    totalMs: number;
  } | null;
  wallMs: number;
  pass: boolean;
};

function runCase(
  id: string,
  placement: string,
  expectedTransform: OrientationMode,
  primary: boolean,
  frame: PixelFrame,
): SimCase {
  const started = performance.now();
  const result = acquireOrientation(frame);
  const wallMs = performance.now() - started;
  const best = result.best;
  const bitErrors = best ? best.tiles.map((t) => t.bitErrors) : [];
  const pass =
    result.selectedTransform === expectedTransform &&
    result.locked === true &&
    best !== null &&
    best.validTripletMarkerCount === 3 &&
    best.tripletValid === true &&
    best.locatorSupport === 'triplet' &&
    best.lockMode === 'triplet-seeded' &&
    best.exactTiles === 3 &&
    best.tiles.length === 3 &&
    best.projectionSafe === true &&
    bitErrors.every((e) => e === 0);

  const caseResult: CaseResult = {
    selectedTransform: result.selectedTransform,
    orientationMode: result.orientationMode,
    locked: result.locked,
    detectedMarkerComponentCount: best ? best.detectedMarkerComponentCount : 0,
    validTripletMarkerCount: best ? best.validTripletMarkerCount : 0,
    tripletValid: best ? best.tripletValid : false,
    support: best ? best.locatorSupport : 'none',
    lockMode: best ? best.lockMode : 'n/a',
    exactTiles: best ? best.exactTiles : 0,
    tileCount: best ? best.tiles.length : 0,
    projection: best ? best.projectionSafe : null,
    bitErrors,
    tripletRejectReason: best ? best.tripletRejectReason : 'no-result',
    transformCandidates: result.transformCandidates,
    profile: result.profile
      ? {
          preScanMs: result.profile.preScanMs,
          normalizeMs: result.profile.normalizeMs,
          lockMs: result.profile.lockMs,
          refineMs: result.profile.refineMs,
          errorsMs: result.profile.errorsMs,
          calibrationMs: result.profile.calibrationMs,
          totalMs: result.profile.totalMs,
        }
      : null,
    wallMs,
    pass,
  };

  return {id, placement, expectedTransform, primary, result: caseResult};
}

async function main(): Promise<void> {
  log('waiting for real sender page render…');
  const canvas = await waitForSender();
  log('sender rendered — capturing framebuffer pixels (rendered pixels only)');

  const raw = captureFramebuffer(canvas);
  const topLeft = {r: raw.data[0], g: raw.data[1], b: raw.data[2]};
  log(`captured ${raw.width}x${raw.height} RGBA framebuffer`);

  // Build the deterministic portrait camera frames (720x1280 RGBA), matching
  // the physical Mini Program camera geometry, from the real rendered pixels.
  const cases: SimCase[] = [
    runCase(
      'A-native-letterbox',
      'upright landscape content, black letterbox margins',
      'native',
      true,
      letterboxPortrait(raw, false, 'black'),
    ),
    runCase(
      'A2-native-letterbox-neutral',
      'upright landscape content, neutral letterbox margins',
      'native',
      false,
      letterboxPortrait(raw, false, 'neutral'),
    ),
    runCase(
      'B-rotate180-letterbox',
      '180-degree landscape content, black letterbox margins',
      'rotate180',
      true,
      letterboxPortrait(raw, true, 'black'),
    ),
    runCase(
      'C-rotateCW-content',
      'landscape content rotated 90 deg CW (full-bleed portrait)',
      'rotateCCW',
      true,
      normalizeFrame(raw, 'rotateCW', PORTRAIT_W, PORTRAIT_H),
    ),
    runCase(
      'D-rotateCCW-content',
      'landscape content rotated 90 deg CCW (full-bleed portrait)',
      'rotateCW',
      true,
      normalizeFrame(raw, 'rotateCCW', PORTRAIT_W, PORTRAIT_H),
    ),
    runCase(
      'E-native-scaled-offset',
      'upright content, 0.97 scale + (+6,-6)px offset, black margins',
      'native',
      false,
      letterboxPortraitScaled(raw, 0.97, 6, -6),
    ),
  ];

  const primary = cases.filter((c) => c.primary);
  const primaryPass = primary.every((c) => c.result.pass);

  const payload = {
    done: true,
    evidenceClass: 'SIMULATED BROWSER PIXEL TF-008 ACQUISITION',
    note: 'SIMULATION EVIDENCE ONLY. Not physical optical ingress. Not physical acquisition PASS. Not Net Goodput.',
    senderEntry: '/tf-008-orientation-sender.html',
    senderOverlayConfirmed: SENDER_OVERLAY_TEXTS.join(' | '),
    noCoordinatorConfirmed: true,
    capture: {
      method: 'canvas framebuffer getImageData (rendered pixels only)',
      width: raw.width,
      height: raw.height,
      bytes: raw.data.length,
      topLeftPixel: topLeft,
      expectedBacking: {width: SENDER_BACKING_W, height: SENDER_BACKING_H},
    },
    inputFrame: {width: PORTRAIT_W, height: PORTRAIT_H, format: 'RGBA'},
    networkPayloadPath: 'NONE',
    oracleInputs: [],
    primaryPass,
    summary: {
      primaryCases: primary.length,
      primaryPassed: primary.filter((c) => c.result.pass).length,
      allCases: cases.length,
      allPassed: cases.filter((c) => c.result.pass).length,
    },
    cases,
  };

  (window as unknown as Record<string, unknown>).__TF008_SIM__ = payload;
  log(primaryPass ? 'SIM PASS (primary cases 3/3 exact)' : 'SIM FAIL — see cases');
}

main().catch((error) => {
  log('ERROR: ' + String(error && (error as Error).message ? (error as Error).message : error));
  (window as unknown as Record<string, unknown>).__TF008_SIM__ = {
    done: false,
    error: String(error),
    evidenceClass: 'SIMULATED BROWSER PIXEL TF-008 ACQUISITION',
  };
});
