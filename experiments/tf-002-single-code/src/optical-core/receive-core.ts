/**
 * TF-009 platform-neutral optical receive core.
 *
 * This is the shared orchestration state machine consumed by BOTH the browser
 * pixel simulation and (in the future) the WeChat Mini Program receiver:
 *
 *   Platform Adapter (browser canvas / WeChat CameraFrame)
 *       → PixelFrame {width,height,data}
 *       → SharedOpticalReceiveCore
 *             orientation → preamble → manifest → dynamic symbols
 *             → FountainDecoder → reconstructed bytes
 *       → reconstruction digest (computed by the adapter)
 *
 * The core is DOM-free / canvas-free / camera-free / WebSocket-free / wx.*-free.
 * It knows only PixelFrame and the existing pure TS optical modules. The adapter
 * owns everything platform-specific (rendered-pixel capture, SHA-256 digest).
 *
 * Evidence: SIMULATION ONLY. No physical acquisition, no Net Goodput.
 */
import {
  acquireOrientation,
  lane,
  normalizeFrame,
  preambleCells,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  type OrientationAcquisition,
  type OrientationMode,
} from './orientation-acquisition.ts';
import type {PixelFrame} from './pixel-frame.ts';
import {
  acquireKnownTrainingLock,
  decodeWithPixelLock,
  sampleLuma,
  trackReservedLock,
  type PixelLock,
} from '../tiled-training-solver.ts';
import {locateOrientationFiducials} from '../tiled-orientation-fiducial.ts';
import {homographyFromUnitSquare, mapHomography} from '../optigrid-geometry.ts';
import {
  decodeManifestObservation,
  summarizeManifestRecovery,
  type ManifestRecoveryResult,
} from '../tf007g-manifest-recovery.ts';
import {OLTP_MANIFEST_SEQUENCE_BASE} from '../oltp-optical-session.ts';
import type {OltpManifestV1} from '../oltp-manifest.ts';
import {FountainDecoder, type FountainAddResult} from '../fountain.ts';
import {base64ToBytes, bytesToBase64} from './base64.ts';

export type ReceiveStage = 'idle' | 'oriented' | 'preamble' | 'receiving' | 'complete';

export type DynamicFrameStats = {
  capturedFrames: number;
  decodedSymbols: number;
  duplicateSymbols: number;
  redundantSymbols: number;
  decodeFailures: number;
  trackFallbacks: number;
  rejectedFrames: number;
};

export type ReceiveCheckpoint = {
  version: 1;
  sessionKey: string;
  manifest: OltpManifestV1;
  solvedBlocks: Array<{index: number; data: string}>; // base64 per solved block
  solvedCount: number;
  totalBlocks: number;
  normalizedMode: OrientationMode | null;
  dataLocks: PixelLock[]; // serializable geometric lock (stable struct)
  stats: DynamicFrameStats;
  updatedAt: number;
};

const TILE_COUNT = 3;

const EMPTY_STATS: DynamicFrameStats = {
  capturedFrames: 0,
  decodedSymbols: 0,
  duplicateSymbols: 0,
  redundantSymbols: 0,
  decodeFailures: 0,
  trackFallbacks: 0,
  rejectedFrames: 0,
};

function asImageData(frame: PixelFrame): ImageData {
  return frame as unknown as ImageData;
}

/**
 * Canonical session identity for an OLTP Manifest. A dynamic symbol is only
 * ever routed to the decoder of the session whose Manifest produced this key.
 */
export function sessionKey(manifest: OltpManifestV1): string {
  return [
    manifest.protocol,
    manifest.version,
    manifest.sessionId,
    manifest.file.sha256,
    manifest.file.byteLength,
    manifest.transport.matrixSize,
    manifest.transport.fountainSourceBlockBytes,
    manifest.transport.fountainSeed,
  ].join('|');
}

export class SharedOpticalReceiveCore {
  stage: ReceiveStage = 'idle';
  orientation: OrientationAcquisition | null = null;
  normalizedMode: OrientationMode | null = null;
  manifest: OltpManifestV1 | null = null;
  manifestRecovery: ManifestRecoveryResult | null = null;
  activeSessionKey: string | null = null;
  stats: DynamicFrameStats = {...EMPTY_STATS};
  /**
   * Protocol-event counters for physical metric capture (TF-012 Phase 12).
   * Platform-neutral: both the browser simulation and the Mini Program adapter
   * read these directly rather than re-deriving them from stage transitions.
   */
  readonly eventCounts = {
    beaconProbes: 0,        // cheap non-beacon gate evaluations (idle stage)
    orientationAttempts: 0, // expensive fiducialOnly acquisitions actually run
    orientationSuccess: 0,  // acquisitions that produced locks
    manifestAcquisitions: 0,// distinct Manifest recoveries (session switches)
    preambleAttempts: 0,    // expensive 96-lock attempts (cheap gate passed)
    preambleSuccess: 0,     // successful 96-preamble locks (3/3 + namespace verified)
    preambleRejectedOrSkipped: 0, // frames rejected by cheap gate or failed lock/verify
  };
  /** Last protocol stage transition label + timestamp (PO diagnostics). */
  lastStageTransition = 'IDLE';
  lastStageTransitionAt = 0;
  /** Checkpoints of prior incomplete sessions, keyed by sessionKey. */
  readonly previousCheckpoints = new Map<string, ReceiveCheckpoint>();

  private orientationLocks: PixelLock[] = [];
  private dataLocks: PixelLock[] = [];
  private decoder: FountainDecoder | null = null;
  private attempt = 0;

  /** Record a stage transition once (idempotent re-plays do not spam the log). */
  private setStage(next: ReceiveStage, label: string): void {
    if (this.stage === next) return;
    this.stage = next;
    this.lastStageTransition = label;
    this.lastStageTransitionAt = Date.now();
  }

  /** Normalize a raw camera-like frame to the canonical 1280x720 buffer. */
  private normalized(frame: PixelFrame): PixelFrame {
    return normalizeFrame(frame, this.normalizedMode ?? 'native', SAMPLE_WIDTH, SAMPLE_HEIGHT);
  }

  /**
   * Cheap orientation-beacon probe (used only while idle during cold late join).
   * Counts luma transitions along a scanline through the middle tile: the 64-cell
   * acquisition beacon has ~36 transitions, while 96-cell frames (preamble ~58 /
   * Manifest ~58 / symbols 48..76) have 48+. Threshold 42 sits between the two
   * (measured over 256 symbol frames: min 48; beacon middle row 36), so it
   * rejects non-beacon frames without risking a false negative. This avoids
   * running the expensive training lock on every non-beacon frame. A wrong
   * answer is safe (one frame wasted).
   *
   * Public so platform adapters and the TF-012 budget inventory can profile the
   * cheap non-beacon gate separately from the expensive fiducialOnly acquisition.
   */
  isLikelyOrientationBeacon(image: ImageData): boolean {
    const fid = locateOrientationFiducials(image);
    const triplet = fid.triplet;
    if (!triplet || triplet.support !== 'triplet') return false;
    const point = triplet.points[1];
    const side = triplet.estimatedTileSide;
    const cy = Math.max(1, Math.min(image.height - 2, Math.round(point.y)));
    const x0 = Math.max(1, Math.round(point.x - side / 2));
    const x1 = Math.min(image.width - 2, Math.round(point.x + side / 2));
    let minL = 255, maxL = 0;
    for (let x = x0; x <= x1; x += 1) { const l = sampleLuma(image, x, cy); minL = Math.min(minL, l); maxL = Math.max(maxL, l); }
    if (maxL - minL < 60) return false;
    const threshold = (minL + maxL) / 2;
    let transitions = 0;
    let prev = sampleLuma(image, x0, cy) < threshold;
    for (let x = x0 + 1; x <= x1; x += 1) {
      const cur = sampleLuma(image, x, cy) < threshold;
      if (cur !== prev) transitions += 1;
      prev = cur;
    }
    return transitions <= 42;
  }

  /**
   * Cheap 96-preamble candidate gate (used while 'oriented' before the expensive
   * full lock). Samples a coarse grid of the KNOWN preamble cell pattern through
   * the orientation tile homography — no exhaustive search. A non-preamble frame
   * (Manifest / dynamic symbol / beacon) matches ~50%, a real preamble ~100%.
   * A wrong answer is safe: a false reject just waits one more broadcast cycle;
   * a false accept is caught by the namespace verification in lockPreamble.
   */
  isLikelyPreamble(image: ImageData, matrixSize: number): boolean {
    if (this.orientationLocks.length !== TILE_COUNT) return false;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const lock = this.orientationLocks[tile];
      const h = homographyFromUnitSquare(lock.quad);
      if (!h) return false;
      const cells = preambleCells(matrixSize, tile);
      let matches = 0;
      let samples = 0;
      const start = 12;
      const end = matrixSize - 12;
      const step = 7;
      for (let r = start; r < end; r += step) {
        for (let c = start; c < end; c += step) {
          const expectedBlack = cells[r * matrixSize + c] === 1;
          const p = mapHomography(h, (c + 0.5) / matrixSize, (r + 0.5) / matrixSize);
          const v = sampleLuma(image, p.x, p.y);
          samples += 1;
          if ((v < 128) === expectedBlack) matches += 1;
        }
      }
      if (samples > 0 && matches / samples < 0.7) return false;
    }
    return true;
  }

  get complete(): boolean {
    return this.decoder !== null && this.decoder.complete;
  }

  get solvedCount(): number {
    return this.decoder ? this.decoder.solvedCount : 0;
  }

  get sourceCount(): number {
    return this.decoder ? this.decoder.sourceCount : 0;
  }

  /** Reset to idle for a fresh deterministic scenario (keeps no decoder state). */
  reset(): void {
    this.stage = 'idle';
    this.orientation = null;
    this.normalizedMode = null;
    this.manifest = null;
    this.manifestRecovery = null;
    this.activeSessionKey = null;
    this.orientationLocks = [];
    this.dataLocks = [];
    this.decoder = null;
    this.attempt = 0;
    this.stats = {...EMPTY_STATS};
    this.eventCounts.beaconProbes = 0;
    this.eventCounts.orientationAttempts = 0;
    this.eventCounts.orientationSuccess = 0;
    this.eventCounts.manifestAcquisitions = 0;
    this.eventCounts.preambleAttempts = 0;
    this.eventCounts.preambleSuccess = 0;
    this.eventCounts.preambleRejectedOrSkipped = 0;
    this.lastStageTransition = 'IDLE';
    this.lastStageTransitionAt = Date.now();
    this.previousCheckpoints.clear();
  }

  /** Stage 1: orientation acquisition (verdict + shared geometry locks). */
  acquireOrientation(frame: PixelFrame, options?: {fiducialOnly?: boolean}): OrientationAcquisition {
    this.orientation = acquireOrientation(frame, undefined, options);
    if (this.orientation.locked && this.orientation.best && this.orientation.best.orientationMode) {
      this.normalizedMode = this.orientation.best.orientationMode;
      this.orientationLocks = this.orientation.best.tiles
        .map((tile) => tile.lock)
        .filter((lock): lock is PixelLock => Boolean(lock));
      this.setStage('oriented', 'ORIENTATION');
      this.eventCounts.orientationSuccess += 1;
    }
    return this.orientation;
  }

  /**
   * Stage 2: acquire the 3 preamble locks at the data matrix size.
   *
   * Physical cold-join tolerant: the frame after orientation is NOT assumed to
   * be a preamble (camera latency can skip it). A cheap known-pattern gate runs
   * first; only a plausible preamble frame triggers the expensive full lock.
   * Every locked tile is then namespace-verified (0x54xxxxxx) so a false lock
   * on a Manifest/symbol frame can never advance the stage with corrupt geometry.
   */
  lockPreamble(frame: PixelFrame, matrixSize: number): boolean {
    const image = asImageData(this.normalized(frame));
    this.eventCounts.preambleAttempts += 1;
    if (!this.isLikelyPreamble(image, matrixSize)) {
      this.eventCounts.preambleRejectedOrSkipped += 1;
      return false;
    }
    const locks: PixelLock[] = [];
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const lock = acquireKnownTrainingLock(image, matrixSize, preambleCells(matrixSize, tile), lane(tile));
      if (!lock) {
        this.eventCounts.preambleRejectedOrSkipped += 1;
        return false;
      }
      // Namespace verification: a locked tile must decode to the 0x54 preamble
      // beacon namespace. Prevents a false lock on Manifest/symbol content.
      const decoded = decodeWithPixelLock(image, matrixSize, lock);
      if (!decoded || (decoded.sequence & 0xff000000) !== 0x54000000) {
        this.eventCounts.preambleRejectedOrSkipped += 1;
        return false;
      }
      locks.push(lock);
    }
    this.dataLocks = locks;
    this.eventCounts.preambleSuccess += 1;
    this.setStage('preamble', 'PREAMBLE');
    return true;
  }

  /**
   * Stage 3: read the optically-rendered manifest. On first recovery, the
   * fountain decoder is constructed from the manifest's own transport fields
   * (block size + seed) — nothing is received out-of-band.
   */
  readManifest(frame: PixelFrame, matrixSize: number): boolean {
    this.attempt += 1;
    const image = asImageData(this.normalized(frame));
    const observation = decodeManifestObservation(image, matrixSize, this.dataLocks, this.attempt);
    this.manifestRecovery = summarizeManifestRecovery(this.attempt, observation.recovered, observation.diagnostics);
    if (observation.recovered.length === 0) {
      // No Manifest on this frame (dynamic symbol / beacon / invalid). Do NOT
      // drift the geometry locks on a non-Manifest frame — keep them pristine
      // for the next real Manifest. Remain in PREAMBLE, no throw, no reset.
      return this.manifest !== null;
    }
    // A Manifest was decoded: accept the observation's tracked (refined) locks.
    this.dataLocks = observation.locks;

    const next = observation.recovered[0];
    const key = sessionKey(next);

    if (this.activeSessionKey === key) {
      // Idempotent replay of the active session — do not reset progress.
      this.setStage('receiving', 'MANIFEST');
      return true;
    }

    this.eventCounts.manifestAcquisitions += 1;

    // Different session: preserve the current incomplete checkpoint, then switch.
    if (this.activeSessionKey && this.decoder && !this.decoder.complete) {
      const cp = this.exportCheckpoint();
      if (cp) this.previousCheckpoints.set(this.activeSessionKey, cp);
    }

    this.manifest = next;
    this.activeSessionKey = key;
    const blockSize = next.transport.fountainSourceBlockBytes;
    const seed = next.transport.fountainSeed;
    const sourceCount = Math.ceil(next.file.byteLength / blockSize);
    this.decoder = new FountainDecoder(sourceCount, blockSize, seed);
    this.setStage('receiving', 'MANIFEST');

    const existing = this.previousCheckpoints.get(key);
    if (existing) this.restoreCheckpoint(existing);
    return true;
  }

  /** Stage 4: decode one rendered dynamic frame (3 symbols) into the fountain decoder. */
  acceptDynamicFrame(frame: PixelFrame, matrixSize: number): number {
    if (this.stage !== 'receiving' || !this.decoder || !this.activeSessionKey) {
      this.stats.rejectedFrames += 1; // late join / no valid manifest yet
      return 0;
    }
    this.stats.capturedFrames += 1;
    const image = asImageData(this.normalized(frame));
    let decoded = 0;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const tracked = trackReservedLock(image, matrixSize, this.dataLocks[tile]);
      if (!tracked) {
        this.stats.trackFallbacks += 1;
        continue;
      }
      this.dataLocks[tile] = tracked;
      const symbol = decodeWithPixelLock(image, matrixSize, tracked);
      if (!symbol) {
        this.stats.decodeFailures += 1;
        continue;
      }
      // Manifest frames carry the 'MF' sequence namespace — they are NOT fountain
      // symbols. During dynamic reception a manifest frame is an idempotent replay
      // (same session) or a session switch (different session).
      if ((symbol.sequence & 0xffff0000) === OLTP_MANIFEST_SEQUENCE_BASE) {
        this.readManifest(frame, matrixSize);
        return decoded;
      }
      // Acquisition beacon frames (orientation 64 / preamble 96) use the
      // 0x54000000 sequence namespace — they are beacons for late-joining
      // receivers, not fountain symbols. Skip them during dynamic reception.
      if ((symbol.sequence & 0xff000000) === 0x54000000) {
        continue;
      }
      const result: FountainAddResult = this.decoder.addSymbol(symbol.sequence, symbol.payload);
      if (result === 'accepted') {
        this.stats.decodedSymbols += 1;
        decoded += 1;
      } else if (result === 'duplicate') {
        this.stats.duplicateSymbols += 1;
      } else {
        this.stats.redundantSymbols += 1;
      }
    }
    if (this.decoder.complete) this.setStage('complete', 'COMPLETE');
    return decoded;
  }

  /** Stage 5: reconstruct the file bytes (only when complete). */
  reconstruct(): Uint8Array | null {
    if (!this.decoder || !this.manifest || !this.decoder.complete) return null;
    return this.decoder.reconstruct(this.manifest.file.byteLength);
  }

  /**
   * Drive the whole state machine with a single rendered frame. This is the
   * COLD LATE JOIN entry point: a completely fresh receiver (no orientation,
   * no locks, no manifest, no decoder) feeds every captured frame here and the
   * core greedily attempts the current stage, advancing only when it succeeds.
   * Failed stage attempts (e.g. a symbol frame before the next acquisition
   * beacon) are retried on later frames. No sender restart, no ACK.
   */
  processFrame(frame: PixelFrame, matrixSize: number): void {
    switch (this.stage) {
      case 'idle': {
        // Cold late join: only attempt the (expensive) orientation lock when the
        // frame is likely the 64-cell acquisition beacon.
        this.eventCounts.beaconProbes += 1;
        if (this.isLikelyOrientationBeacon(asImageData(this.normalized(frame)))) {
          this.eventCounts.orientationAttempts += 1;
          this.acquireOrientation(frame, {fiducialOnly: true});
        }
        break;
      }
      case 'oriented': this.lockPreamble(frame, matrixSize); break;
      case 'preamble': this.readManifest(frame, matrixSize); break;
      case 'receiving': this.acceptDynamicFrame(frame, matrixSize); break;
      default: break; // complete
    }
  }

  /** Export a serializable checkpoint of the active session (or null if none). */
  exportCheckpoint(): ReceiveCheckpoint | null {
    if (!this.manifest || !this.decoder || !this.activeSessionKey) return null;
    return {
      version: 1,
      sessionKey: this.activeSessionKey,
      manifest: this.manifest,
      solvedBlocks: this.decoder.solvedBlocksSnapshot().map(({index, block}) => ({index, data: bytesToBase64(block)})),
      solvedCount: this.decoder.solvedCount,
      totalBlocks: this.decoder.sourceCount,
      normalizedMode: this.normalizedMode,
      dataLocks: this.dataLocks.map(lock => ({
        quad: {tl: {...lock.quad.tl}, tr: {...lock.quad.tr}, br: {...lock.quad.br}, bl: {...lock.quad.bl}},
        phaseX: lock.phaseX, phaseY: lock.phaseY, threshold: lock.threshold,
        score: lock.score, contrast: lock.contrast, bitErrors: lock.bitErrors, bits: lock.bits,
      })),
      stats: {...this.stats},
      updatedAt: Date.now(),
    };
  }

  /**
   * Restore from a checkpoint. Rebuilds decoder progress deterministically by
   * re-adding each persisted solved block as a degree-1 source symbol — it does
   * NOT assume the FountainDecoder internals are serializable. Geometric locks
   * and transform are restored directly (stable, serializable structs).
   */
  restoreCheckpoint(checkpoint: ReceiveCheckpoint): boolean {
    if (!checkpoint || checkpoint.version !== 1 || !checkpoint.manifest) return false;
    const key = sessionKey(checkpoint.manifest);
    this.manifest = checkpoint.manifest;
    this.activeSessionKey = key;
    this.normalizedMode = checkpoint.normalizedMode;
    this.dataLocks = checkpoint.dataLocks.map(lock => ({
      quad: {tl: {...lock.quad.tl}, tr: {...lock.quad.tr}, br: {...lock.quad.br}, bl: {...lock.quad.bl}},
      phaseX: lock.phaseX, phaseY: lock.phaseY, threshold: lock.threshold,
      score: lock.score, contrast: lock.contrast, bitErrors: lock.bitErrors, bits: lock.bits,
    }));
    const blockSize = checkpoint.manifest.transport.fountainSourceBlockBytes;
    const seed = checkpoint.manifest.transport.fountainSeed;
    const sourceCount = Math.ceil(checkpoint.manifest.file.byteLength / blockSize);
    this.decoder = new FountainDecoder(sourceCount, blockSize, seed);
    for (const {index, data} of checkpoint.solvedBlocks) {
      this.decoder.addSymbol(index, base64ToBytes(data));
    }
    this.stats = {...checkpoint.stats};
    this.setStage(this.decoder.complete ? 'complete' : 'receiving', 'MANIFEST');
    return true;
  }
}
