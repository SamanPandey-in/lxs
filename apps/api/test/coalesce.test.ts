/**
 * G5: per-source coalescing of process-events work, and the in-memory incident chain that
 * replaced the post-attach re-read. The scoring itself is untouched; these lock the plumbing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enqueueProcessSources,
  MAX_SOURCE_JOBS_PER_BATCH,
  PROCESS_COALESCE_SECONDS,
  type ProcessEventsJob,
  setInProcessProcessor,
} from '../src/jobs/queue.ts';
import { buildIncidentChain } from '../src/worker/process-events.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WINDOW_MS = PROCESS_COALESCE_SECONDS * 250 + 100;

describe('enqueueProcessSources (in-process fallback, no pg-boss)', () => {
  it('collapses a burst for one source into one source-scoped run', async () => {
    const calls: ProcessEventsJob[] = [];
    setInProcessProcessor(async (job) => {
      calls.push(job);
    });
    for (let i = 0; i < 20; i++)
      await enqueueProcessSources('p1', [{ id: `e${i}`, srcIp: '203.0.113.9' }]);
    await enqueueProcessSources('p1', [{ id: 'x', srcIp: '198.51.100.1' }]);
    await wait(WINDOW_MS);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.srcIp).sort(), ['198.51.100.1', '203.0.113.9']);
    assert.ok(calls.every((c) => c.projectId === 'p1' && !c.eventIds));
  });

  it('schedules a new run for events that arrive after the previous one fired', async () => {
    const calls: ProcessEventsJob[] = [];
    setInProcessProcessor(async (job) => {
      calls.push(job);
    });
    await enqueueProcessSources('p2', [{ id: 'a', srcIp: '203.0.113.10' }]);
    await wait(WINDOW_MS);
    await enqueueProcessSources('p2', [{ id: 'b', srcIp: '203.0.113.10' }]);
    await wait(WINDOW_MS);
    assert.equal(calls.length, 2);
  });

  it('keeps one id-scoped job for a batch spanning many sources', async () => {
    const calls: ProcessEventsJob[] = [];
    setInProcessProcessor(async (job) => {
      calls.push(job);
    });
    const rows = Array.from({ length: MAX_SOURCE_JOBS_PER_BATCH + 1 }, (_, i) => ({
      id: `id${i}`,
      srcIp: `192.0.2.${i}`,
    }));
    await enqueueProcessSources('p3', rows);
    await wait(50);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.srcIp, undefined);
    assert.equal(calls[0]?.eventIds?.length, rows.length);
  });
});

type Row = Parameters<typeof buildIncidentChain>[0][number];
const row = (id: string, at: number, techniques: string[] = []): Row =>
  ({ id, occurredAt: new Date(at), techniques, count: 1 }) as unknown as Row;

describe('buildIncidentChain', () => {
  it('orders like "order by occurred_at, id" and applies the batch techniques', () => {
    const prior = [row('00000000-0000-0000-0000-00000000000b', 2000, ['T1595'])];
    const batch = [
      row('00000000-0000-0000-0000-00000000000a', 2000, []),
      row('00000000-0000-0000-0000-00000000000c', 1000, []),
    ];
    const tagged = batch.map((r, i) => ({
      row: r,
      tag: { techniques: [{ id: i === 0 ? 'T1110' : 'T1046' }] },
    }));
    const chain = buildIncidentChain(prior, batch, tagged);
    // Time first, then uuid on a tie; prior rows are not forced first.
    assert.deepEqual(
      chain.map((r) => r.id.slice(-1)),
      ['c', 'a', 'b'],
    );
    assert.deepEqual(
      chain.map((r) => r.techniques),
      [['T1046'], ['T1110'], ['T1595']],
    );
    // Inputs are not mutated.
    assert.deepEqual(batch[0]?.techniques, []);
  });

  it('keeps the earliest CHAIN_LIMIT rows, like the old LIMIT', () => {
    const prior = Array.from({ length: 5000 }, (_, i) =>
      row(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, 10_000 + i),
    );
    const batch = [row('ffffffff-0000-0000-0000-000000000000', 1)];
    const chain = buildIncidentChain(prior, batch, []);
    assert.equal(chain.length, 5000);
    assert.equal(chain[0]?.id, batch[0]?.id);
    assert.equal(chain.at(-1)?.occurredAt.getTime(), 10_000 + 4998);
  });
});
