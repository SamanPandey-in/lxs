/**
 * A bounded map with per-entry TTL and least-recently-used eviction, built on Map insertion order
 * (the first key is always the least recently seen). Reads and writes refresh recency, so a flood of
 * new keys only pushes out the coldest entries; state that is still in use is never wiped wholesale.
 */
export class LruTtlMap<V> {
  private readonly values = new Map<string, { value: V; expiresAt: number }>();
  /** Entries pushed out to make room (expired entries are not counted). */
  evicted = 0;

  constructor(
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be >= 1');
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.values.set(key, entry); // most recently seen goes last
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.values.delete(key);
    this.values.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string;
      const entry = this.values.get(oldest);
      this.values.delete(oldest);
      if (entry && entry.expiresAt > this.now()) this.evicted++;
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  has(key: string): boolean {
    const entry = this.values.get(key);
    return entry !== undefined && entry.expiresAt > this.now();
  }
}
