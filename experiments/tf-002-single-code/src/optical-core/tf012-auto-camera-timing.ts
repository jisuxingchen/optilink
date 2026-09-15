/**
 * TF-012 r19 — CAMERA CALLBACK TIMING (platform-neutral helper).
 *
 * WHY THIS EXISTS
 *
 * The r18 physical run stalled badly: SETUP planned ~5 s and took 9.55 s, and the run-wide
 * largest tick gap was 26.99 s. The obvious suspicion — "frame processing is starving the
 * orchestrator's timer loop" — could not be tested from the artefact, because nothing
 * recorded how often frames arrived or how long each one took to process.
 *
 * This helper is the HOST side of that evidence. The phone feeds it one call per camera
 * frame (arrival instant + processing duration) and the orchestrator snapshots it at every
 * boundary, exactly like the optical counters. It records TIMING only: no image data, no
 * payload, nothing from the network.
 *
 * Deliberate limitation: JavaScript is single-threaded, so "orchestrator ticks that happened
 * WHILE a frame was being processed" is not observable — a timer callback cannot run inside a
 * synchronous frame callback. The defensible substitutes are the per-interval
 * `processingDutyRatio` (fraction of wall time spent inside frame processing) together with
 * the callback interval percentiles and the orchestrator's own largest tick gap: if a stall
 * is of the same order as one frame's processing time, frame processing explains it; if the
 * gap is far larger than any single frame, something else does.
 */

/** Cumulative camera timing since the host's last metric reset. */
export interface Tf012AutoCameraTimingSnapshot {
  callbackCount: number;
  callbackIntervalAvgMs: number | null;
  callbackIntervalP50Ms: number | null;
  callbackIntervalP95Ms: number | null;
  callbackIntervalMaxMs: number | null;
  processCount: number;
  processSumMs: number;
  processDurationAvgMs: number | null;
  processDurationP50Ms: number | null;
  processDurationP95Ms: number | null;
  processDurationMaxMs: number | null;
}

function percentileOf(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * Bounded-sample camera timing accumulator.
 *
 * `count`, `sum` and `max` are EXACT cumulative values (the max is a running maximum, which
 * is exact for a window because the host resets at every step boundary). `p50`/`p95` come
 * from a bounded ring of the most recent samples and are therefore "trailing window"
 * percentiles — labelled that way, never presented as interval quantiles.
 */
export class Tf012AutoCameraTimingTracker {
  private readonly intervals: number[] = [];
  private readonly durations: number[] = [];
  private callbackCount = 0;
  private processCount = 0;
  private intervalSum = 0;
  private durationSum = 0;
  private intervalMax: number | null = null;
  private durationMax: number | null = null;
  private lastArrivalAt: number | null = null;
  private readonly cap: number;

  constructor(cap = 600) {
    this.cap = cap;
  }

  reset(): void {
    this.intervals.length = 0;
    this.durations.length = 0;
    this.callbackCount = 0;
    this.processCount = 0;
    this.intervalSum = 0;
    this.durationSum = 0;
    this.intervalMax = null;
    this.durationMax = null;
    this.lastArrivalAt = null;
  }

  /** One camera frame: when it ARRIVED and how long processing it took. */
  note(arrivalAtMs: number, processingMs: number): void {
    const duration = Number.isFinite(processingMs) ? Math.max(0, processingMs) : 0;
    this.processCount += 1;
    this.durationSum += duration;
    if (this.durationMax == null || duration > this.durationMax) this.durationMax = duration;
    if (this.durations.length < this.cap) this.durations.push(duration);

    if (this.lastArrivalAt != null) {
      const interval = Math.max(0, arrivalAtMs - this.lastArrivalAt);
      this.callbackCount += 1;
      this.intervalSum += interval;
      if (this.intervalMax == null || interval > this.intervalMax) this.intervalMax = interval;
      if (this.intervals.length < this.cap) this.intervals.push(interval);
    }
    this.lastArrivalAt = arrivalAtMs;
  }

  snapshot(): Tf012AutoCameraTimingSnapshot {
    const sortedIntervals = [...this.intervals].sort((a, b) => a - b);
    const sortedDurations = [...this.durations].sort((a, b) => a - b);
    return {
      callbackCount: this.callbackCount,
      callbackIntervalAvgMs: this.callbackCount > 0 ? this.intervalSum / this.callbackCount : null,
      callbackIntervalP50Ms: percentileOf(sortedIntervals, 0.5),
      callbackIntervalP95Ms: percentileOf(sortedIntervals, 0.95),
      callbackIntervalMaxMs: this.intervalMax,
      processCount: this.processCount,
      processSumMs: this.durationSum,
      processDurationAvgMs: this.processCount > 0 ? this.durationSum / this.processCount : null,
      processDurationP50Ms: percentileOf(sortedDurations, 0.5),
      processDurationP95Ms: percentileOf(sortedDurations, 0.95),
      processDurationMaxMs: this.durationMax,
    };
  }
}
