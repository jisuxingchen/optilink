export type SpoolObservation = {
  captureId: number;
  capturedAtMs: number;
  fingerprint: string;
  quality: number;
  bytes: Uint8Array;
};

/**
 * Retains the best camera observation for each cheap optical fingerprint.
 * This is intentionally pre-decode: fingerprint is expected to come from a
 * low-cost ROI/luma signature, not from decoded OLTP payload bytes.
 */
export class ObservationSpool {
  readonly maxBytes: number;
  private records = new Map<string, SpoolObservation>();
  private order: string[] = [];
  storedBytes = 0;
  replaced = 0;
  evicted = 0;

  constructor(options: {maxBytes: number}) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('maxBytes must be a positive integer');
    this.maxBytes = options.maxBytes;
  }

  get size(): number { return this.records.size; }

  add(observation: SpoolObservation): void {
    if (!Number.isFinite(observation.quality)) throw new Error('quality must be finite');
    const existing = this.records.get(observation.fingerprint);
    if (existing) {
      if (observation.quality <= existing.quality) return;
      this.storedBytes -= existing.bytes.byteLength;
      this.records.set(observation.fingerprint, observation);
      this.storedBytes += observation.bytes.byteLength;
      this.replaced += 1;
      this.enforceBudget();
      return;
    }
    this.records.set(observation.fingerprint, observation);
    this.order.push(observation.fingerprint);
    this.storedBytes += observation.bytes.byteLength;
    this.enforceBudget();
  }

  drain(): SpoolObservation[] {
    const output = this.order
      .map(key => this.records.get(key))
      .filter((value): value is SpoolObservation => Boolean(value))
      .sort((a, b) => a.captureId - b.captureId);
    this.records.clear();
    this.order = [];
    this.storedBytes = 0;
    return output;
  }

  private enforceBudget(): void {
    while (this.storedBytes > this.maxBytes && this.order.length) {
      const key = this.order.shift()!;
      const record = this.records.get(key);
      if (!record) continue;
      this.records.delete(key);
      this.storedBytes -= record.bytes.byteLength;
      this.evicted += 1;
    }
  }
}

export function estimatePackedObservationBytes(input: {tileCount: number; matrixSize: number; bitsPerCell?: number}): number {
  const bitsPerCell = input.bitsPerCell ?? 4;
  if (!Number.isInteger(input.tileCount) || input.tileCount < 1) throw new Error('tileCount must be positive');
  if (!Number.isInteger(input.matrixSize) || input.matrixSize < 1) throw new Error('matrixSize must be positive');
  if (![1, 2, 4, 8].includes(bitsPerCell)) throw new Error('bitsPerCell must be 1, 2, 4 or 8');
  return Math.ceil(input.tileCount * input.matrixSize * input.matrixSize * bitsPerCell / 8);
}
