/**
 * A bounded map with least-recently-used eviction, built on Map insertion order (the first key is
 * always the least recently seen). `get` and `set` refresh recency, so a flood of new keys only pushes
 * out the coldest entries instead of wiping state that is still in use. `onEvict` sees what is dropped.
 */
export class LruMap<V> {
  private readonly values = new Map<string, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be >= 1');
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): V | undefined {
    if (!this.values.has(key)) return undefined;
    const v = this.values.get(key) as V;
    this.values.delete(key);
    this.values.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string;
      const v = this.values.get(oldest) as V;
      this.values.delete(oldest);
      this.onEvict?.(oldest, v);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.values.entries();
  }
}
