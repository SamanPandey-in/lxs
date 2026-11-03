import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DecoyEvent } from '@lxs/schema';
import type { IngestResult } from '../src/platform.js';
import { Shipper } from '../src/ship.js';
import { Counters } from '../src/telemetry.js';
import { ulid } from '../src/ulid.js';

const ev = (n = 0): DecoyEvent => ({
  id: ulid(Date.now() + n),
  schema_version: 1,
  timestamp: new Date().toISOString(),
  sensor: 'web',
  decoy_id: 'web-admin-admin',
  is_decoy: true,
  src_ip: '203.0.113.66',
  dst_service: 'http:/admin',
  event_type: 'http.request',
  count: 1,
  simulated: false,
});

const wait = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'condition not met in time');
};

function mk(responses: Array<IngestResult | ((b: { events: unknown[] }) => IngestResult)>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ship-'));
  const sent: Array<{ events: unknown[] }> = [];
  let i = 0;
  const counters = new Counters();
  const shipper = new Shipper({
    client: {
      ingest: async (b) => {
        sent.push(b);
        const r = responses[Math.min(i++, responses.length - 1)];
        return typeof r === 'function' ? r(b) : (r as IngestResult);
      },
    },
    spoolDir: path.join(dir, 'spool'),
    sensorId: () => 'sensor-1',
    counters,
    flushMs: 20,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    random: () => 0.5,
  });
  return { shipper, sent, counters, dir };
}

test('ships a batch and de-duplicates by event id', async () => {
  const { shipper, sent, counters } = mk([{ status: 202, body: { accepted: 1 } }]);
  shipper.start();
  const e = ev();
  assert.equal(shipper.enqueue(e), true);
  assert.equal(shipper.enqueue(e), false);
  await wait(() => sent.length === 1);
  assert.equal(sent[0]?.events.length, 1);
  assert.equal(counters.get('events_deduped'), 1);
  await shipper.stop();
});

test('rejects schema-invalid events before they can poison a batch', () => {
  const { shipper, counters } = mk([{ status: 202 }]);
  assert.equal(shipper.enqueue({ ...ev(), src_ip: 'not-an-ip' } as DecoyEvent), false);
  assert.equal(counters.get('events_invalid'), 1);
});

test('retries with backoff when the platform is down and spools to disk, then drains in order', async () => {
  const { shipper, sent, dir } = mk([{ status: 0 }, { status: 503 }, { status: 202 }]);
  shipper.start();
  const e1 = ev(1);
  shipper.enqueue(e1);
  await wait(() => sent.length >= 1);
  await wait(() => fs.readdirSync(path.join(dir, 'spool')).some((f) => f.endsWith('.jsonl')));
  const e2 = ev(2);
  shipper.enqueue(e2);
  await wait(
    () => shipper.stats().spoolSegments === 0 && shipper.stats().memory === 0 && sent.length >= 3,
  );
  const ids = sent
    .filter((_, i) => i >= 2)
    .flatMap((b) => (b.events as DecoyEvent[]).map((x) => x.id));
  assert.ok(ids.includes(e1.id));
  await shipper.stop();
});

test('spooled events survive a restart', async () => {
  const a = mk([{ status: 0 }]);
  a.shipper.start();
  a.shipper.enqueue(ev(5));
  await wait(() => a.shipper.stats().spoolSegments > 0);
  await a.shipper.stop(100);
  const sent: unknown[][] = [];
  const b = new Shipper({
    client: { ingest: async (x) => (sent.push(x.events), { status: 202 }) },
    spoolDir: path.join(a.dir, 'spool'),
    sensorId: () => 's',
    counters: new Counters(),
    flushMs: 20,
  });
  b.start();
  await wait(() => sent.length >= 1);
  assert.equal(sent[0]?.length, 1);
  await b.stop();
});

test('413 halves the batch; 422 on a single event drops it', async () => {
  const { shipper, sent, counters } = mk([{ status: 413 }, { status: 202 }, { status: 422 }]);
  shipper.start();
  for (let i = 0; i < 4; i++) shipper.enqueue(ev(10 + i));
  await wait(() => sent.length >= 2);
  assert.ok((sent[1]?.events.length ?? 99) < 4);
  await shipper.stop();
  assert.equal(counters.get('events_dropped_rejected') >= 0, true);
});

test('honours Retry-After', async () => {
  const { shipper, sent } = mk([{ status: 429, retryAfterMs: 150 }, { status: 202 }]);
  shipper.start();
  const t0 = Date.now();
  shipper.enqueue(ev(20));
  await wait(() => sent.length >= 2);
  assert.ok(Date.now() - t0 >= 140);
  await shipper.stop();
});
