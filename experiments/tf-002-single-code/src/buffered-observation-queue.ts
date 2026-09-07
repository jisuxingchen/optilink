export type OverflowPolicy = 'drop-oldest' | 'drop-newest';

export class BoundedObservationQueue<T> {
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  dropped = 0;
  private items: T[] = [];

  constructor(options: {capacity: number; overflow?: OverflowPolicy}) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new Error('capacity must be a positive integer');
    this.capacity = options.capacity;
    this.overflow = options.overflow ?? 'drop-oldest';
  }

  get length(): number { return this.items.length; }

  push(value: T): boolean {
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return true;
    }
    this.dropped += 1;
    if (this.overflow === 'drop-newest') return false;
    this.items.shift();
    this.items.push(value);
    return true;
  }

  shift(): T | undefined { return this.items.shift(); }

  clear(): void { this.items.length = 0; }

  snapshot(): readonly T[] { return [...this.items]; }
}
