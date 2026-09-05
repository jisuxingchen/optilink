export type FountainAddResult = 'accepted' | 'duplicate' | 'redundant';

const DEFAULT_C = 0.1;
const DEFAULT_DELTA = 0.5;
const DEFAULT_MAX_DEGREE = 128;

function xorInto(target: Uint8Array, source: Uint8Array): void {
  if (target.length !== source.length) throw new Error('fountain XOR block length mismatch');
  for (let i = 0; i < target.length; i += 1) target[i] ^= source[i];
}

function xorshift32(value: number): number {
  let x = value >>> 0;
  if (x === 0) x = 0x6d2b79f5;
  x ^= (x << 13) >>> 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

class DeterministicPrng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  nextUint32(): number {
    this.state = xorshift32(this.state);
    return this.state;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }
}

function buildDegreeCdf(sourceCount: number, maxDegree = DEFAULT_MAX_DEGREE): Float64Array {
  if (!Number.isSafeInteger(sourceCount) || sourceCount <= 0) throw new Error('sourceCount must be positive');
  const cappedDegree = Math.max(1, Math.min(sourceCount, maxDegree));
  const weights = new Float64Array(cappedDegree + 1);
  const r = DEFAULT_C * Math.log(sourceCount / DEFAULT_DELTA) * Math.sqrt(sourceCount);
  const spikeDegree = Math.max(1, Math.min(sourceCount, Math.floor(sourceCount / Math.max(r, 1e-9))));

  for (let degree = 1; degree <= sourceCount; degree += 1) {
    let weight = degree === 1 ? 1 / sourceCount : 1 / (degree * (degree - 1));
    if (degree < spikeDegree) weight += r / (degree * sourceCount);
    else if (degree === spikeDegree) weight += (r * Math.log(Math.max(r / DEFAULT_DELTA, 1))) / sourceCount;
    weights[Math.min(degree, cappedDegree)] += weight;
  }

  let total = 0;
  for (let degree = 1; degree <= cappedDegree; degree += 1) total += weights[degree];
  const cdf = new Float64Array(cappedDegree);
  let cumulative = 0;
  for (let degree = 1; degree <= cappedDegree; degree += 1) {
    cumulative += weights[degree] / total;
    cdf[degree - 1] = cumulative;
  }
  cdf[cdf.length - 1] = 1;
  return cdf;
}

function sampleDegree(cdf: Float64Array, random: number): number {
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (random <= cdf[mid]) high = mid;
    else low = mid + 1;
  }
  return low + 1;
}

export function fountainSeedFromSession(sessionId: string): number {
  const hex = sessionId.slice(0, 8);
  if (/^[a-f0-9]{8}$/iu.test(hex)) return Number.parseInt(hex, 16) >>> 0;
  let hash = 0x811c9dc5;
  for (const character of sessionId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x4f505449;
}

export class FountainPlan {
  readonly sourceCount: number;
  readonly seed: number;
  private readonly degreeCdf: Float64Array;

  constructor(sourceCount: number, seed: number, maxDegree = DEFAULT_MAX_DEGREE) {
    if (!Number.isSafeInteger(sourceCount) || sourceCount <= 0) throw new Error('sourceCount must be positive');
    this.sourceCount = sourceCount;
    this.seed = seed >>> 0 || 0x4f505449;
    this.degreeCdf = buildDegreeCdf(sourceCount, maxDegree);
  }

  indicesFor(symbolId: number): number[] {
    if (!Number.isSafeInteger(symbolId) || symbolId < 0) throw new Error('symbolId must be a non-negative integer');
    if (symbolId < this.sourceCount) return [symbolId];

    const mixed = (this.seed ^ Math.imul((symbolId + 1) >>> 0, 0x9e3779b9)) >>> 0;
    const prng = new DeterministicPrng(mixed);
    const degree = Math.min(this.sourceCount, sampleDegree(this.degreeCdf, prng.nextFloat()));
    const selected = new Set<number>();
    while (selected.size < degree) selected.add(Math.floor(prng.nextFloat() * this.sourceCount));
    return [...selected];
  }
}

export function createFountainSourceBlocks(bytes: Uint8Array, blockSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('blockSize must be a positive integer');
  const sourceCount = Math.max(1, Math.ceil(bytes.length / blockSize));
  const blocks = Array.from({length: sourceCount}, () => new Uint8Array(blockSize));
  for (let index = 0; index < sourceCount; index += 1) {
    blocks[index].set(bytes.subarray(index * blockSize, Math.min(bytes.length, (index + 1) * blockSize)));
  }
  return blocks;
}

export class FountainEncoder {
  readonly blockSize: number;
  readonly sourceCount: number;
  readonly seed: number;
  private readonly blocks: Uint8Array[];
  private readonly plan: FountainPlan;

  constructor(bytes: Uint8Array, blockSize: number, seed: number) {
    this.blocks = createFountainSourceBlocks(bytes, blockSize);
    this.blockSize = blockSize;
    this.sourceCount = this.blocks.length;
    this.seed = seed >>> 0 || 0x4f505449;
    this.plan = new FountainPlan(this.sourceCount, this.seed);
  }

  symbol(symbolId: number): Uint8Array {
    const indices = this.plan.indicesFor(symbolId);
    const payload = new Uint8Array(this.blockSize);
    for (const index of indices) xorInto(payload, this.blocks[index]);
    return payload;
  }
}

type Equation = {
  indices: Set<number>;
  payload: Uint8Array;
};

export class FountainDecoder {
  readonly sourceCount: number;
  readonly blockSize: number;
  readonly seed: number;
  acceptedSymbols = 0;
  duplicateSymbols = 0;
  redundantSymbols = 0;

  private readonly plan: FountainPlan;
  private readonly solvedBlocks: Array<Uint8Array | undefined>;
  private readonly seenSymbols = new Set<number>();
  private readonly equations = new Map<number, Equation>();
  private readonly adjacency: Array<Set<number>>;
  private nextEquationId = 1;
  private solved = 0;

  constructor(sourceCount: number, blockSize: number, seed: number) {
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('blockSize must be positive');
    this.sourceCount = sourceCount;
    this.blockSize = blockSize;
    this.seed = seed >>> 0 || 0x4f505449;
    this.plan = new FountainPlan(sourceCount, this.seed);
    this.solvedBlocks = new Array(sourceCount);
    this.adjacency = Array.from({length: sourceCount}, () => new Set<number>());
  }

  get solvedCount(): number {
    return this.solved;
  }

  get complete(): boolean {
    return this.solved === this.sourceCount;
  }

  get pendingEquationCount(): number {
    return this.equations.size;
  }

  addSymbol(symbolId: number, payload: Uint8Array): FountainAddResult {
    if (payload.length !== this.blockSize) throw new Error(`fountain symbol length ${payload.length}; expected ${this.blockSize}`);
    if (this.seenSymbols.has(symbolId)) {
      this.duplicateSymbols += 1;
      return 'duplicate';
    }
    this.seenSymbols.add(symbolId);
    this.acceptedSymbols += 1;

    const work = payload.slice();
    const unknown: number[] = [];
    for (const index of this.plan.indicesFor(symbolId)) {
      const known = this.solvedBlocks[index];
      if (known) xorInto(work, known);
      else unknown.push(index);
    }

    if (unknown.length === 0) {
      this.redundantSymbols += 1;
      return 'redundant';
    }
    if (unknown.length === 1) {
      this.solveBlock(unknown[0], work);
      return 'accepted';
    }

    const equationId = this.nextEquationId++;
    const equation: Equation = {indices: new Set(unknown), payload: work};
    this.equations.set(equationId, equation);
    for (const index of unknown) this.adjacency[index].add(equationId);
    return 'accepted';
  }

  reconstruct(totalBytes: number): Uint8Array {
    if (!this.complete) throw new Error(`fountain decoder incomplete: ${this.solved}/${this.sourceCount}`);
    const capacity = this.sourceCount * this.blockSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > capacity) throw new Error('invalid fountain totalBytes');
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const block of this.solvedBlocks) {
      if (!block) throw new Error('missing solved fountain block');
      const writable = Math.min(block.length, totalBytes - offset);
      if (writable <= 0) break;
      output.set(block.subarray(0, writable), offset);
      offset += writable;
    }
    return output;
  }

  private solveBlock(index: number, payload: Uint8Array): void {
    const queue: Array<{index: number; payload: Uint8Array}> = [{index, payload: payload.slice()}];
    while (queue.length) {
      const next = queue.shift();
      if (!next || this.solvedBlocks[next.index]) continue;
      this.solvedBlocks[next.index] = next.payload;
      this.solved += 1;

      const affected = [...this.adjacency[next.index]];
      this.adjacency[next.index].clear();
      for (const equationId of affected) {
        const equation = this.equations.get(equationId);
        if (!equation || !equation.indices.delete(next.index)) continue;
        xorInto(equation.payload, next.payload);

        if (equation.indices.size === 0) {
          this.equations.delete(equationId);
          this.redundantSymbols += 1;
          continue;
        }
        if (equation.indices.size === 1) {
          const remaining = equation.indices.values().next().value as number;
          this.adjacency[remaining].delete(equationId);
          this.equations.delete(equationId);
          queue.push({index: remaining, payload: equation.payload});
        }
      }
    }
  }
}
