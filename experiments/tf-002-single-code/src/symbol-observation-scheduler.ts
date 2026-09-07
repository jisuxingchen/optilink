export type ObservationDecision = {
  capture: boolean;
  symbolIndex: number;
  skippedSymbols: number;
  phase: number;
};

/**
 * Cheap camera-clock gate. The sender keeps one optical symbol visible for a
 * full symbol period; the receiver accepts the first camera frame at/after the
 * center of that period, avoiding transition edges and 60-fps decode pressure.
 */
export class SymbolObservationScheduler {
  readonly sessionStartMs: number;
  readonly symbolHz: number;
  readonly symbolPeriodMs: number;
  private lastCapturedSymbol = -1;

  constructor(options: {sessionStartMs: number; symbolHz: number}) {
    if (!Number.isFinite(options.sessionStartMs)) throw new Error('sessionStartMs must be finite');
    if (!Number.isFinite(options.symbolHz) || options.symbolHz <= 0) throw new Error('symbolHz must be positive');
    this.sessionStartMs = options.sessionStartMs;
    this.symbolHz = options.symbolHz;
    this.symbolPeriodMs = 1000 / options.symbolHz;
  }

  consider(timestampMs: number): ObservationDecision {
    const elapsed = timestampMs - this.sessionStartMs;
    if (elapsed < 0) return {capture: false, symbolIndex: -1, skippedSymbols: 0, phase: 0};
    const symbolIndex = Math.floor(elapsed / this.symbolPeriodMs);
    const phase = (elapsed - symbolIndex * this.symbolPeriodMs) / this.symbolPeriodMs;
    if (symbolIndex <= this.lastCapturedSymbol || phase < 0.5) return {capture: false, symbolIndex, skippedSymbols: 0, phase};
    const skippedSymbols = Math.max(0, symbolIndex - this.lastCapturedSymbol - 1);
    this.lastCapturedSymbol = symbolIndex;
    return {capture: true, symbolIndex, skippedSymbols, phase};
  }

  reset(): void { this.lastCapturedSymbol = -1; }
}
