import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { type DecoyEvent, DecoyEvent as DecoyEventSchema } from '@lxs/schema';
import { loadConfig } from '../src/config.js';
import { LruMap } from '../src/lru.js';
import {
  AuthAggregator,
  createLocalNormalizer,
  createNormalizer,
  type LineNormalizer,
} from '../src/normalize.js';
import { parseRemotePolicy } from '../src/policy.js';
import { type TailLine, TailManager, telemetryTailSources } from '../src/tail.js';

const opts = {
  salt: 'salt',
  commonCredsText: 'admin\n',
  simulated: false,
  sshPorts: new Map<string, number>(),
  honeyReads: [],
};

const failure = (ip: string, ms: number): DecoyEvent => ({
  id: `01JC${String(ms).padStart(22, '0')}`,
  schema_version: 1,
  timestamp: new Date(Date.parse('2026-11-01T10:00:05Z') + ms).toISOString(),
  sensor: 'ssh',
  decoy_id: 'ssh-1',
  is_decoy: true,
  src_ip: ip,
  dst_service: 'ssh:22',
  event_type: 'auth.attempt',
  outcome: 'failure',
  count: 1,
  simulated: false,
});

/* ------------------------------------------------------------------ LRU + flood collapser */

test('LruMap keeps hot entries while a flood evicts only the coldest, reporting each eviction', () => {
  const evicted: string[] = [];
  const m = new LruMap<number>(10, (k) => evicted.push(k));
  m.set('hot', 1);
  m.set('cold', 1);
  for (let i = 0; i < 1000; i++) {
    m.set(`f${i}`, i);
    m.get('hot');
  }
  assert.equal(m.get('hot'), 1);
  assert.equal(m.get('cold'), undefined);
  assert.equal(m.size, 10);
  assert.ok(evicted.includes('cold'));
  assert.ok(!evicted.includes('hot'));
});

test('flooding new sources does not reset a hot source in the auth flood collapser', () => {
  const agg = new AuthAggregator(20, 100);
  let shipped = 0;
  for (let i = 0; i < 20; i++) shipped += agg.push(failure('203.0.113.9', i)).length;
  assert.equal(shipped, 20);
  // 1,000 one-shot sources (10x capacity) interleaved with the hot source's continuing failures.
  let hotShipped = 0;
  const out: DecoyEvent[] = [];
  for (let i = 0; i < 1000; i++) {
    out.push(...agg.push(failure(`10.0.${Math.floor(i / 256)}.${i % 256}`, 100 + i)));
    if (i % 20 === 0) {
      hotShipped += agg
        .push(failure('203.0.113.9', 100 + i))
        .filter((e) => e.src_ip === '203.0.113.9').length;
    }
  }
  // Before: buckets.clear() at capacity re-opened the hot source's allowance of 20 per minute.
  assert.equal(hotShipped, 0, 'the hot source must stay collapsed');
  const flushed = agg.flush(Date.parse('2026-11-01T10:05:00Z'));
  const hot = flushed.find((e) => e.src_ip === '203.0.113.9');
  assert.equal(hot?.count, 50);
});

test('an evicted bucket emits its pending overflow instead of losing it', () => {
  const agg = new AuthAggregator(1, 2);
  const out: DecoyEvent[] = [];
  for (let i = 0; i < 5; i++) out.push(...agg.push(failure('198.51.100.1', i)));
  assert.equal(out.length, 1); // 1 through, 4 folded
  out.push(...agg.push(failure('198.51.100.2', 10)));
  out.push(...agg.push(failure('198.51.100.3', 11))); // evicts 198.51.100.1
  const folded = out.find((e) => e.src_ip === '198.51.100.1' && e.count > 1);
  assert.equal(folded?.count, 4);
});

test('policy parser drops /0 allowlist entries (they would disable blocking)', () => {
  const p = parseRemotePolicy({ version: 1, allowlist: ['10.0.0.0/8', '0.0.0.0/0', '::/0'] });
  assert.deepEqual(p?.allowlist, ['10.0.0.0/8']);
});

/* ------------------------------------------------------------------ production telemetry */

const FIREWALL = [
  '{"ts":"2026-11-01T10:40:55.000Z","src_ip":"203.0.113.66","src_port":51544,"dst_ip":"10.0.1.20","dst_port":22,"proto":"tcp","action":"deny"}',
  '{"ts":"2026-11-01T10:43:21.000Z","src_ip":"203.0.113.66","src_port":52011,"dst_ip":"10.0.1.20","dst_port":443,"proto":"tcp","action":"allow","asset":"Payments API"}',
  '{"ts":"2026-11-01T10:43:22.000Z","src_ip":"127.0.0.1","dst_ip":"10.0.1.20","dst_port":443,"action":"allow"}',
];
const AUTH = [
  '{"ts":"2026-11-01T10:43:24.000Z","src_ip":"203.0.113.66","user":"admin","service":"payments-api","result":"success","asset":"Payments API"}',
  'not json',
];

function checkTelemetry(n: LineNormalizer): void {
  const line = (text: string, kind: 'firewall' | 'auth', offset: number) =>
    n.normalize({
      source: 'telemetry',
      telemetry: kind,
      decoyId: `prod-${kind}`,
      fileKey: `telemetry/${kind}.jsonl`,
      offset,
      text,
    });
  const [deny] = line(FIREWALL[0] as string, 'firewall', 0);
  assert.equal(deny?.event_type, 'prod.firewall');
  assert.equal(deny?.sensor, 'prod');
  assert.equal(deny?.is_decoy, false);
  assert.equal(deny?.decoy_id, undefined);
  assert.equal(deny?.outcome, 'failure');
  assert.equal(deny?.dst_service, 'fw:10.0.1.20:22');
  assert.equal(deny?.src_port, 51544);
  const [allow] = line(FIREWALL[1] as string, 'firewall', 140);
  assert.equal(allow?.outcome, 'success');
  assert.equal(allow?.asset_name, 'Payments API');
  assert.equal(allow?.timestamp, '2026-11-01T10:43:21.000Z');
  assert.deepEqual(line(FIREWALL[2] as string, 'firewall', 280), []); // loopback dropped
  const [auth] = line(AUTH[0] as string, 'auth', 0);
  assert.equal(auth?.event_type, 'prod.auth');
  assert.equal(auth?.outcome, 'success');
  assert.equal(auth?.username, 'admin');
  assert.equal(auth?.dst_service, 'auth:payments-api');
  assert.equal(auth?.asset_name, 'Payments API');
  assert.deepEqual(line(AUTH[1] as string, 'auth', 200), []);
  // The file hint decides the type even when the record's fields are ambiguous.
  const [hinted] = line('{"ts":"2026-11-01T10:43:24Z","src_ip":"198.51.100.4"}', 'auth', 300);
  assert.equal(hinted?.event_type, 'prod.auth');
  assert.equal(hinted?.outcome, 'unknown');
  // Same file + offset => same id (idempotent re-ship after a restart).
  assert.equal(line(AUTH[0] as string, 'auth', 0)[0]?.id, auth?.id);
  for (const ev of [deny, allow, auth, hinted]) {
    const r = DecoyEventSchema.safeParse(ev);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  }
}

test('telemetry lines normalise to prod.firewall / prod.auth (package normalizer)', async () => {
  const n = await createNormalizer(opts);
  assert.equal(n.name, 'package');
  checkTelemetry(n);
});

test('telemetry lines normalise identically in the local fallback normalizer', () => {
  checkTelemetry(createLocalNormalizer(opts));
});

test('the agent tails firewall.jsonl and auth.jsonl from the telemetry dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tel-'));
  const telDir = path.join(dir, 'telemetry');
  fs.mkdirSync(telDir);
  fs.writeFileSync(path.join(telDir, 'firewall.jsonl'), `${FIREWALL.join('\n')}\n`);
  fs.writeFileSync(path.join(telDir, 'auth.jsonl'), `${AUTH[0]}\n`);
  fs.writeFileSync(path.join(telDir, 'other.jsonl'), `${AUTH[0]}\n`);
  const sources = telemetryTailSources(['auth', 'firewall', 'bogus'], telDir);
  assert.deepEqual(
    sources.map((s) => s.telemetry),
    ['firewall', 'auth'],
  );
  const n = await createNormalizer(opts);
  const events: DecoyEvent[] = [];
  const tail = new TailManager({
    sources,
    statePath: path.join(dir, 'state', 'offsets.json'),
    onLine: (l: TailLine) => {
      events.push(
        ...n.normalize({
          source: l.source.kind,
          ...(l.source.telemetry ? { telemetry: l.source.telemetry } : {}),
          decoyId: l.source.decoyId,
          fileKey: `${path.basename(path.dirname(l.file))}/${path.basename(l.file)}`,
          offset: l.offset,
          text: l.text,
        }),
      );
    },
  });
  await tail.pollOnce();
  await tail.stop();
  assert.deepEqual(events.map((e) => e.event_type).sort(), [
    'prod.auth',
    'prod.firewall',
    'prod.firewall',
  ]);
  assert.ok(events.every((e) => e.is_decoy === false && e.sensor === 'prod'));
  assert.deepEqual(telemetryTailSources(['firewall'], telDir).length, 1);
  assert.deepEqual(telemetryTailSources([], telDir), []);
});

test('LXS_TELEMETRY_DIR overrides the telemetry dir and turns tailing on', () => {
  const base = { LXS_INGEST_KEY: 'k', LXS_ENDPOINT: 'http://x' };
  const d = loadConfig(base);
  assert.equal(d.telemetryDir, '/var/log/lxs/telemetry');
  assert.equal(d.telemetryFromEnv, false);
  const e = loadConfig({ ...base, LXS_TELEMETRY_DIR: '/srv/tel' });
  assert.equal(e.telemetryDir, '/srv/tel');
  assert.equal(e.telemetryFromEnv, true);
});
