export type StabilityDecision = {
  stable: boolean;
  capture: boolean;
  stableFrames: number;
  distanceFromCandidate: number;
};

export function hammingRatio(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let mismatches = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) mismatches += 1;
  return mismatches / a.length;
}

/**
 * Offline-safe transition filter. It does not know sender sequence numbers or
 * payload bytes. It only observes a sparse binary optical fingerprint and
 * emits one capture after the same visual state remains stable across several
 * camera frames.
 */
export class StableFingerprintGate {
  readonly requiredStableFrames: number;
  readonly maxHammingRatio: number;
  private candidate: Uint8Array | null = null;
  private candidateFrames = 0;
  private lastEmitted: Uint8Array | null = null;

  constructor(options: {requiredStableFrames?: number; maxHammingRatio?: number} = {}) {
    this.requiredStableFrames = options.requiredStableFrames ?? 2;
    this.maxHammingRatio = options.maxHammingRatio ?? 0.05;
    if (!Number.isInteger(this.requiredStableFrames) || this.requiredStableFrames < 1) throw new Error('requiredStableFrames must be positive');
    if (!Number.isFinite(this.maxHammingRatio) || this.maxHammingRatio < 0 || this.maxHammingRatio >= 1) throw new Error('maxHammingRatio must be in [0,1)');
  }

  consider(fingerprint: Uint8Array): StabilityDecision {
    if (!fingerprint.length) return {stable: false, capture: false, stableFrames: 0, distanceFromCandidate: 1};
    const distance = this.candidate ? hammingRatio(this.candidate, fingerprint) : 1;
    if (!this.candidate || distance > this.maxHammingRatio) {
      this.candidate = fingerprint.slice();
      this.candidateFrames = 1;
      return {stable: this.requiredStableFrames === 1, capture: this.shouldEmit(), stableFrames: this.candidateFrames, distanceFromCandidate: distance};
    }
    this.candidateFrames += 1;
    // Keep the first candidate as the cluster anchor; this avoids slow drift
    // turning a transition into an apparently stable state.
    const stable = this.candidateFrames >= this.requiredStableFrames;
    return {stable, capture: stable && this.shouldEmit(), stableFrames: this.candidateFrames, distanceFromCandidate: distance};
  }

  reset(): void {
    this.candidate = null;
    this.candidateFrames = 0;
    this.lastEmitted = null;
  }

  private shouldEmit(): boolean {
    if (!this.candidate || this.candidateFrames < this.requiredStableFrames) return false;
    if (this.lastEmitted && hammingRatio(this.lastEmitted, this.candidate) <= this.maxHammingRatio) return false;
    this.lastEmitted = this.candidate.slice();
    return true;
  }
}
