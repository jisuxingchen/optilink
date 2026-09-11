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
  trackReservedLock,
  type PixelLock,
} from '../tiled-training-solver.ts';
import {
  decodeManifestObservation,
  summarizeManifestRecovery,
  type ManifestRecoveryResult,
} from '../tf007g-manifest-recovery.ts';
import type {OltpManifestV1} from '../oltp-manifest.ts';
import {FountainDecoder, type FountainAddResult} from '../fountain.ts';

export type ReceiveStage = 'idle' | 'oriented' | 'preamble' | 'receiving' | 'complete';

export type DynamicFrameStats = {
  capturedFrames: number;
  decodedSymbols: number;
  duplicateSymbols: number;
  redundantSymbols: number;
  decodeFailures: number;
  trackFallbacks: number;
};

const TILE_COUNT = 3;

function asImageData(frame: PixelFrame): ImageData {
  return frame as unknown as ImageData;
}

export class SharedOpticalReceiveCore {
  stage: ReceiveStage = 'idle';
  orientation: OrientationAcquisition | null = null;
  normalizedMode: OrientationMode | null = null;
  manifest: OltpManifestV1 | null = null;
  manifestRecovery: ManifestRecoveryResult | null = null;
  stats: DynamicFrameStats = {
    capturedFrames: 0,
    decodedSymbols: 0,
    duplicateSymbols: 0,
    redundantSymbols: 0,
    decodeFailures: 0,
    trackFallbacks: 0,
  };

  private orientationLocks: PixelLock[] = [];
  private dataLocks: PixelLock[] = [];
  private decoder: FountainDecoder | null = null;
  private attempt = 0;

  /** Normalize a raw camera-like frame to the canonical 1280x720 buffer. */
  private normalized(frame: PixelFrame): PixelFrame {
    return normalizeFrame(frame, this.normalizedMode ?? 'native', SAMPLE_WIDTH, SAMPLE_HEIGHT);
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

  /** Stage 1: orientation acquisition (verdict + shared geometry locks). */
  acquireOrientation(frame: PixelFrame): OrientationAcquisition {
    this.orientation = acquireOrientation(frame);
    if (this.orientation.locked && this.orientation.best && this.orientation.best.orientationMode) {
      this.normalizedMode = this.orientation.best.orientationMode;
      this.orientationLocks = this.orientation.best.tiles
        .map((tile) => tile.lock)
        .filter((lock): lock is PixelLock => Boolean(lock));
      this.stage = 'oriented';
    }
    return this.orientation;
  }

  /** Stage 2: acquire the 3 preamble locks at the data matrix size. */
  lockPreamble(frame: PixelFrame, matrixSize: number): boolean {
    const image = asImageData(this.normalized(frame));
    const locks: PixelLock[] = [];
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const lock = acquireKnownTrainingLock(image, matrixSize, preambleCells(matrixSize, tile), lane(tile));
      if (!lock) return false;
      locks.push(lock);
    }
    this.dataLocks = locks;
    this.stage = 'preamble';
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
    this.dataLocks = observation.locks;
    this.manifestRecovery = summarizeManifestRecovery(this.attempt, observation.recovered, observation.diagnostics);
    if (observation.recovered.length > 0 && !this.manifest) {
      this.manifest = observation.recovered[0];
      const blockSize = this.manifest.transport.fountainSourceBlockBytes;
      const seed = this.manifest.transport.fountainSeed;
      const sourceCount = Math.ceil(this.manifest.file.byteLength / blockSize);
      this.decoder = new FountainDecoder(sourceCount, blockSize, seed);
      this.stage = 'receiving';
      return true;
    }
    return this.manifest !== null;
  }

  /** Stage 4: decode one rendered dynamic frame (3 symbols) into the fountain decoder. */
  acceptDynamicFrame(frame: PixelFrame, matrixSize: number): number {
    if (this.stage !== 'receiving' || !this.decoder) return 0;
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
    if (this.decoder.complete) this.stage = 'complete';
    return decoded;
  }

  /** Stage 5: reconstruct the file bytes (only when complete). */
  reconstruct(): Uint8Array | null {
    if (!this.decoder || !this.manifest || !this.decoder.complete) return null;
    return this.decoder.reconstruct(this.manifest.file.byteLength);
  }
}
