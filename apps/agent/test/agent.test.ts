import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DecoyEvent } from '@lxs/schema';
import { agentSocketPath, createLocalApi, signalToEvent } from '../src/local-api.js';
import { AuthAggregator, createLocalNormalizer, createNormalizer } from '../src/normalize.js';
import { PolicyStore, parseRemotePolicy } from '../src/policy.js';
import { Counters, createLogger, registerSecret, resetSecrets } from '../src/telemetry.js';
import { deterministicUlid, ULID_RE } from '../src/ulid.js';

const opts = {
  salt: 'salt',
  commonCredsText: 'admin\nroot/root\npassword\n',
  simulated: false,
  sshPorts: new Map([
    ['ssh-db-backup-01', 22],
    ['redis-6380', 6380],
    ['postgres-5433', 5433],
  ]),
  honeyReads: [
    { decoyId: 'ssh-db-backup-01', path: '/home/deploy/.config/acme.json', tokenId: 'ht_api_01' },
  ],
};

const webLogin = JSON.stringify({
  ts: '2026-11-01T10:41:02.120Z',
  decoy_id: 'web-admin-admin',
  kind: 'login',
  ip: '203.0.113.66',
  method: 'POST',
  path: '/admin/login',
  ua: 'Mozilla/5.0',
  username: 'admin',
  password: 'admin',
  accepted: true,
  req_id: 'r1',
});
const webBait = JSON.stringify({
  ts: '2026-11-01T10:41:00.000Z',
  decoy_id: 'web-bait-env',
  kind: 'bait',
  ip: '203.0.113.66',
  method: 'GET',
  path: '/.env',
  file: '.env',
  bytes: 300,
  status: 200,
  honeytoken_id: 'ht_api_01',
  honeytoken_ids: ['ht_api_01', 'ht_db_01'],
  req_id: 'r0',
});
const cowrieCmd = JSON.stringify({
  eventid: 'cowrie.command.input',
  timestamp: '2026-11-01T10:43:00.000000Z',
  src_ip: '203.0.113.66',
  session: 'abc',
  input: 'cat /home/deploy/.config/acme.json',
  dst_port: 2222,
});

for (const impl of ['package', 'local'] as const) {
  test(`normalizer (${impl}): web login, bait and cowrie command`, async () => {
    const n = impl === 'package' ? await createNormalizer(opts) : createLocalNormalizer(opts);
    assert.equal(n.name, impl);
    const [login] = n.normalize({
      source: 'web',
      decoyId: 'ds-web',
      fileKey: 'web/ds-web.jsonl',
      offset: 0,
      text: webLogin,
    });
    assert.equal(login?.event_type, 'auth.attempt');
    assert.equal(login?.outcome, 'success');
    assert.equal(login?.password_clear, 'admin');
    assert.ok(ULID_RE.test(login?.id ?? ''));

    const bait = n.normalize({
      source: 'web',
      decoyId: 'ds-web',
      fileKey: 'web/ds-web.jsonl',
      offset: 100,
      text: webBait,
    });
    assert.deepEqual(
      bait.map((e) => e.event_type),
      ['file.download', 'honeytoken.read', 'honeytoken.read'],
    );
    assert.deepEqual(
      bait.filter((e) => e.honeytoken_id).map((e) => e.honeytoken_id),
      ['ht_api_01', 'ht_db_01'],
    );

    const ssh = n.normalize({
      source: 'ssh',
      decoyId: 'ssh-db-backup-01',
      fileKey: 'ssh/cowrie.json',
      offset: 0,
      text: cowrieCmd,
    });
    assert.deepEqual(
      ssh.map((e) => e.event_type),
      ['command.exec', 'honeytoken.read'],
    );
    assert.equal(ssh[0]?.dst_service, 'ssh:22');
    assert.equal(ssh[1]?.honeytoken_id, 'ht_api_01');
  });

  test(`normalizer (${impl}): event ids are deterministic so replays are idempotent`, async () => {
    const n = impl === 'package' ? await createNormalizer(opts) : createLocalNormalizer(opts);
    const raw = {
      source: 'web' as const,
      decoyId: 'ds-web',
      fileKey: 'web/ds-web.jsonl',
      offset: 42,
      text: webLogin,
    };
    assert.equal(n.normalize(raw)[0]?.id, n.normalize(raw)[0]?.id);
    assert.notEqual(n.normalize(raw)[0]?.id, n.normalize({ ...raw, offset: 43 })[0]?.id);
  });

  test(`normalizer (${impl}): loopback and garbage are dropped, unknown passwords are masked`, async () => {
    const n = impl === 'package' ? await createNormalizer(opts) : createLocalNormalizer(opts);
    const lo = JSON.stringify({
      eventid: 'cowrie.session.connect',
      src_ip: '127.0.0.1',
      timestamp: '2026-11-01T10:00:00Z',
    });
    assert.deepEqual(
      n.normalize({
        source: 'ssh',
        decoyId: 'ssh-db-backup-01',
        fileKey: 'k',
        offset: 0,
        text: lo,
      }),
      [],
    );
    assert.deepEqual(
      n.normalize({ source: 'web', decoyId: 'ds-web', fileKey: 'k', offset: 0, text: '{not json' }),
      [],
    );
    const login = JSON.stringify({
      kind: 'login',
      ip: '198.51.100.7',
      decoy_id: 'x',
      username: 'u',
      password: 'Zx9!secret',
      accepted: false,
      ts: '2026-11-01T10:00:00Z',
    });
    const [e] = n.normalize({
      source: 'web',
      decoyId: 'ds-web',
      fileKey: 'k',
      offset: 5,
      text: login,
    });
    assert.equal(e?.password_clear, undefined);
    assert.equal(e?.password_masked, 'Z***t');
    assert.equal(e?.password_sha256?.length, 64);
  });
}

for (const impl of ['package', 'local'] as const) {
  test(`normalizer (${impl}): Redis/Postgres JSON logs are bounded and redact arguments`, async () => {
    const n = impl === 'package' ? await createNormalizer(opts) : createLocalNormalizer(opts);
    const [redis] = n.normalize({
      source: 'redis',
      decoyId: 'redis-6380',
      fileKey: 'redis/redis.jsonl',
      offset: 10,
      text: JSON.stringify({
        ts: '2026-11-01T10:00:00Z', src_ip: '203.0.113.9', src_port: 50000,
        command: 'set', key: 'synthetic-password', value: 'must-not-be-retained', outcome: 'success',
      }),
    });
    assert.equal(redis?.sensor, 'redis');
    assert.equal(redis?.event_type, 'db.command');
    assert.equal(redis?.dst_service, 'redis:6380');
    assert.equal(redis?.command, 'SET');
    assert.equal(redis?.raw, undefined);
    assert.equal(JSON.stringify(redis).includes('must-not-be-retained'), false);

    const [failedAuth] = n.normalize({
      source: 'postgres',
      decoyId: 'postgres-5433',
      fileKey: 'postgres/postgres.json',
      offset: 20,
      text: JSON.stringify({
        timestamp: '2026-11-01 10:01:00 UTC', remote_host: '198.51.100.12', remote_port: '50001',
        user: 'lxs_fake', error_severity: 'FATAL',
        message: 'password authentication failed for user "lxs_fake"; password=must-not-be-retained',
      }),
    });
    assert.equal(failedAuth?.sensor, 'postgres');
    assert.equal(failedAuth?.event_type, 'auth.attempt');
    assert.equal(failedAuth?.outcome, 'failure');
    assert.equal(failedAuth?.dst_service, 'postgres:5433');
    assert.equal(failedAuth?.username, 'lxs_fake');
    assert.equal(JSON.stringify(failedAuth).includes('must-not-be-retained'), false);

    const [statement] = n.normalize({
      source: 'postgres',
      decoyId: 'postgres-5433',
      fileKey: 'postgres/postgres.json',
      offset: 21,
      text: JSON.stringify({
        timestamp: '2026-11-01 10:02:00 UTC', remote_host: '198.51.100.12',
        message: "statement: SELECT 'sql-literal-must-not-be-retained'",
      }),
    });
    assert.equal(statement?.event_type, 'db.command');
    assert.equal(statement?.command, 'SELECT');
    assert.equal(JSON.stringify(statement).includes('sql-literal-must-not-be-retained'), false);
  });
}

test('auth floods collapse after 20 failures per minute into one counted event', () => {
  const agg = new AuthAggregator(20);
  const mk = (i: number): DecoyEvent => ({
    id: deterministicUlid(Date.parse('2026-11-01T10:00:00Z') + i, `s${i}`),
    schema_version: 1,
    timestamp: new Date(Date.parse('2026-11-01T10:00:05Z') + i).toISOString(),
    sensor: 'ssh',
    decoy_id: 'ssh-1',
    is_decoy: true,
    src_ip: '203.0.113.9',
    dst_service: 'ssh:22',
    event_type: 'auth.attempt',
    outcome: 'failure',
    count: 1,
    simulated: false,
  });
  let shipped = 0;
  for (let i = 0; i < 100; i++) shipped += agg.push(mk(i)).length;
  assert.equal(shipped, 20);
  const flushed = agg.flush(Date.parse('2026-11-01T10:05:00Z'));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.count, 80);
});

test('policy parser accepts both the schema shape and the documented shape', () => {
  const a = parseRemotePolicy({
    policy_version: 3,
    blocklist: [{ ip: '203.0.113.66', expires_at: null }],
    watchlist: ['198.51.100.7'],
    block_ttl_seconds: 60,
  });
  assert.equal(a?.version, 3);
  assert.deepEqual(a?.watchlist, ['198.51.100.7']);
  const b = parseRemotePolicy({
    version: 44,
    blocklist: [{ ip: '203.0.113.66', expires_at: '2999-01-01T00:00:00Z' }],
    watchlist: { window_hours: 24, ips: ['198.51.100.7'] },
    allowlist: ['10.0.0.0/8', 'bogus'],
  });
  assert.equal(b?.version, 44);
  assert.deepEqual(b?.allowlist, ['10.0.0.0/8']);
});

test('policy store: expired blocks pruned, local watch merged, revision bumps (ETag)', () => {
  let now = 1_000_000;
  const store = new PolicyStore({ abc: 'ht_api_01' }, 1000, () => now);
  const r0 = store.snapshot().revision;
  store.update({
    version: 5,
    blocklist: [
      { ip: '1.1.1.1', expiresAt: now + 500 },
      { ip: '2.2.2.2', expiresAt: null },
    ],
    watchlist: ['3.3.3.3'],
    allowlist: [],
  });
  store.addLocalWatch('4.4.4.4');
  let s = store.snapshot();
  assert.ok(s.revision > r0);
  assert.deepEqual(s.blocklist.sort(), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(s.watchlist.sort(), ['3.3.3.3', '4.4.4.4']);
  assert.equal(s.honeytokens.abc, 'ht_api_01');
  now += 2000;
  s = store.snapshot();
  assert.deepEqual(s.blocklist, ['2.2.2.2']);
  assert.deepEqual(s.watchlist, ['3.3.3.3']);
});

test('signals map to sdk events about real assets', () => {
  const e = signalToEvent(
    {
      kind: 'asset.access',
      ip: '203.0.113.66',
      method: 'GET',
      path: '/api/payments',
      status: 200,
      asset: 'Payments API',
      critical: true,
    },
    false,
  );
  assert.equal(e?.sensor, 'sdk');
  assert.equal(e?.is_decoy, false);
  assert.equal(e?.dst_service, 'app:/api/payments');
  assert.equal(e?.asset_name, 'Payments API');
  assert.equal(
    signalToEvent({ kind: 'asset.access', ip: 'nope', method: 'GET', path: '/x' }, false),
    null,
  );
});

function req(
  sock: string,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        socketPath: sock,
        method,
        path: p,
        headers: {
          ...(data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: t, headers: res.headers }),
        );
      },
    );
    r.on('error', reject);
    r.end(data);
  });
}

test('local API: policy with ETag, signals become events, selftest forwarded', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-run-'));
  const store = new PolicyStore({});
  store.update({
    version: 1,
    blocklist: [{ ip: '203.0.113.66', expiresAt: null }],
    watchlist: ['203.0.113.66'],
    allowlist: [],
  });
  const events: DecoyEvent[] = [];
  let report: unknown;
  const api = createLocalApi({
    runDir,
    policy: store,
    counters: new Counters(),
    simulated: false,
    onEvent: (e) => events.push(e),
    onSelftest: async (r) => ((report = r), true),
  });
  const sock = await api.start();
  assert.equal(sock, agentSocketPath(runDir));
  try {
    const p = await req(sock, 'GET', '/v1/policy');
    assert.equal(p.status, 200);
    assert.deepEqual(JSON.parse(p.body).blocklist, ['203.0.113.66']);
    const again = await req(sock, 'GET', '/v1/policy', undefined, {
      'if-none-match': String(p.headers.etag),
    });
    assert.equal(again.status, 304);

    const s = await req(sock, 'POST', '/v1/signals', {
      signals: [
        {
          kind: 'asset.access',
          ip: '203.0.113.66',
          method: 'GET',
          path: '/api/payments',
          status: 200,
          asset: 'Payments API',
        },
      ],
      dropped: 2,
    });
    assert.equal(s.status, 202);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'asset.access');

    assert.equal((await req(sock, 'POST', '/v1/signals', { signals: 'nope' })).status, 400);
    assert.equal(
      (
        await req(sock, 'POST', '/v1/selftest-report', {
          passed: true,
          checks: [{ name: 'x', passed: true }],
        })
      ).status,
      202,
    );
    assert.ok(report);
  } finally {
    await api.stop();
  }
});

test('the ingest key never appears in log output', () => {
  const lines: string[] = [];
  registerSecret('super-secret-key-value');
  const log = createLogger({ write: (l) => lines.push(l) });
  log.error('boom super-secret-key-value ds_live_abcdef123456', { k: 'super-secret-key-value' });
  resetSecrets();
  assert.ok(!lines[0]?.includes('super-secret-key-value'));
  assert.ok(!lines[0]?.includes('abcdef123456'));
});
