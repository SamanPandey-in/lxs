import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruTtlMap } from '../src/lru.js';

test('LRU keeps hot entries while a flood of new keys evicts only the coldest', () => {
  const m = new LruTtlMap<number>(100);
  m.set('hot', 1, 60_000);
  m.set('cold', 1, 60_000);
  for (let i = 0; i < 10_000; i++) {
    m.set(`flood-${i}`, i, 60_000);
    if (i % 50 === 0) assert.equal(m.get('hot'), 1);
  }
  assert.equal(m.get('hot'), 1);
  assert.equal(m.get('cold'), undefined);
  assert.equal(m.size, 100);
  assert.ok(m.evicted > 0);
});

test('LRU entries expire after their TTL', () => {
  let t = 0;
  const m = new LruTtlMap<string>(10, () => t);
  m.set('a', 'x', 1000);
  t = 999;
  assert.equal(m.get('a'), 'x');
  t = 1000;
  assert.equal(m.get('a'), undefined);
  assert.equal(m.size, 0);
});
