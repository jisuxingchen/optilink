/**
 * Platform-neutral optical receive core bundle entry.
 *
 * This is the single shared source consumed by BOTH the browser simulation
 * and the WeChat Mini Program receiver. It re-exports the orientation
 * acquisition core, the shared receive state machine, and the shared SHA-256
 * implementation — one algorithm, two platform adapters.
 */
export * from './orientation-acquisition.ts';
export {SharedOpticalReceiveCore, sessionKey} from './receive-core.ts';
export type {ReceiveStage, DynamicFrameStats, ReceiveCheckpoint} from './receive-core.ts';
export {sha256, sha256Hex} from './sha256.ts';
export type {PixelFrame} from './pixel-frame.ts';
// TF-012 r4 minimum physical single-code baseline (单码基线).
export * from './single-baseline.ts';
// TF-012 r13 automated physical test harness: the plan, the strict control-channel
// schema and the deterministic orchestrator are shared with the Mini Program so both
// ends read the SAME step definition (and therefore the same hold time).
export * from './tf012-auto-plan.ts';
export * from './tf012-auto-orchestrator.ts';
