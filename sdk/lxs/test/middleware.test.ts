import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LXS } from '../src/index.js';
import { type FakeAgent, startFakeAgent } from '../src/testing.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const wait = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), 'condition not met in time');
};

async function harness(
  policy: Partial<Parameters<typeof startFakeAgent>[0]>,
  mutate?: (t: LXS) => void,
  options: ConstructorParameters<typeof LXS>[0] = {},
) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sdk-'));
  const agent: FakeAgent = await startFakeAgent({ runDir, fakeDecoy: true, ...policy });
  const t = new LXS({ runDir, ...options });
  t.create('web-admin', '/admin').create('web-bait', '/.env');
  t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
  t.honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });
  mutate?.(t);
  const mw = t.express();
  const server = http.createServer((req, res) => mw(req, res, () => res.end('real-app')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => setTimeout(r, 150)); // first policy poll
  const get = (
    p: string,
    headers: Record<string, string> = {},
    method = 'GET',
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end();
    });
  const close = async (): Promise<void> => {
    t.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await agent.close();
  };
  return { agent, get, close };
}

test('ordinary traffic passes straight through (fast path)', async () => {
  const h = await harness({});
  try {
    const r = await h.get('/api/products');
    assert.deepEqual([r.status, r.body], [200, 'real-app']);
    assert.equal(h.agent.decoyRequests.length, 0);
  } finally {
    await h.close();
  }
});

test('decoy paths are proxied over the socket with Cookie and Authorization stripped', async () => {
  const h = await harness({});
  try {
    const r = await h.get('/.env?x=1', {
      cookie: 'sid=SECRET',
      authorization: 'Bearer REAL',
      'x-ds-client-ip': '6.6.6.6',
      'user-agent': 'curl',
    });
    assert.deepEqual([r.status, r.body], [200, 'decoy']);
    const seen = h.agent.decoyRequests[0];
    assert.equal(seen?.url, '/.env?x=1');
    assert.equal(seen?.headers.cookie, undefined);
    assert.equal(seen?.headers.authorization, undefined);
    assert.equal(seen?.headers['x-ds-client-ip'], '127.0.0.1'); // forged header replaced by the socket address
    assert.equal(seen?.headers['x-ds-decoy-id'], 'web-bait-env');
    assert.ok(seen?.headers['x-ds-request-id']);
    const sub = await h.get('/admin/login');
    assert.equal(sub.body, 'decoy'); // web-admin covers its sub-paths
  } finally {
    await h.close();
  }
});

test('blocklisted sources get a generic 403 in enforce mode and an asset.blocked signal', async () => {
  const h = await harness({ blocklist: ['127.0.0.1'] });
  try {
    const r = await h.get('/api/products');
    assert.deepEqual([r.status, r.body], [403, 'Forbidden']);
    await wait(() => h.agent.signals.some((s) => s.kind === 'asset.blocked'));
  } finally {
    await h.close();
  }
});

test('monitor mode never blocks', async () => {
  const h = await harness({ blocklist: ['127.0.0.1'] }, undefined, { mode: 'monitor' });
  try {
    assert.equal((await h.get('/api/products')).status, 200);
  } finally {
    await h.close();
  }
});

test('watchlisted source touching a declared asset emits asset.access once per minute', async () => {
  const h = await harness({ watchlist: ['127.0.0.1'] });
  try {
    await h.get('/api/payments');
    await h.get('/api/payments'); // rate-gated
    await wait(() => h.agent.signals.some((s) => s.kind === 'asset.access'));
    const s = h.agent.signals.filter((x) => x.kind === 'asset.access');
    assert.equal(s.length, 1);
    assert.equal(s[0]?.asset, 'Payments API');
    assert.equal(s[0]?.critical, true);
    assert.equal(s[0]?.status, 200);
  } finally {
    await h.close();
  }
});

test('unwatched sources produce no signals', async () => {
  const h = await harness({ watchlist: ['203.0.113.1'] });
  try {
    await h.get('/api/payments');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(h.agent.signals.length, 0);
  } finally {
    await h.close();
  }
});

test('use of a planted honeytoken is reported by token id, never by value', async () => {
  const token = 'acme_live_ABCDEF0123456789ABCDEF0123456789';
  const h = await harness({ honeytokens: { [sha(token)]: 'ht_api_01' } });
  try {
    await h.get('/api/payments', { authorization: `Bearer ${token}` });
    await wait(() => h.agent.signals.some((s) => s.kind === 'honeytoken.use'));
    const s = h.agent.signals.find((x) => x.kind === 'honeytoken.use');
    assert.equal(s?.token_id, 'ht_api_01');
    assert.ok(!JSON.stringify(h.agent.signals).includes(token));
  } finally {
    await h.close();
  }
});

test('allowlisted sources are never proxied, blocked or reported', async () => {
  const h = await harness({ blocklist: ['127.0.0.1'], watchlist: ['127.0.0.1'] }, undefined, {
    allowlist: ['127.0.0.0/8'],
  });
  try {
    assert.equal((await h.get('/.env')).body, 'real-app');
    assert.equal((await h.get('/api/payments')).status, 200);
    assert.equal(h.agent.decoyRequests.length, 0);
  } finally {
    await h.close();
  }
});

test('fails open when the agent is unreachable, and decoy paths 404 if ds-web is gone', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sdk-'));
  const t = new LXS({ runDir, logger: { warn: () => undefined, error: () => undefined } });
  t.create('web-bait', '/.env');
  const mw = t.express();
  const server = http.createServer((req, res) => mw(req, res, () => res.end('real-app')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: p }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        })
        .on('error', reject);
    });
  try {
    assert.equal((await get('/api/products')).body, 'real-app');
    assert.equal((await get('/.env')).status, 404);
  } finally {
    t.close();
    server.closeAllConnections();
    server.close();
  }
});

test('disabled and missing-run-dir modes are no-ops', async () => {
  const off = new LXS({ disabled: true });
  off.create('web-bait', '/.env');
  let called = false;
  off.express()({ headers: {}, url: '/.env' } as never, {} as never, () => (called = true));
  assert.ok(called);

  if (process.platform !== 'win32') {
    const missing = new LXS({
      runDir: path.join(os.tmpdir(), 'ds-does-not-exist-xyz'),
      logger: { warn: () => undefined, error: () => undefined },
    });
    missing.create('web-bait', '/.env');
    let passed = false;
    missing.express()({ headers: {}, url: '/.env', socket: {} } as never, {} as never, () => {
      passed = true;
    });
    assert.ok(passed);
    missing.close();
  }
});

test('hot path stays cheap for non-decoy traffic', async () => {
  const h = await harness({});
  try {
    const t = new LXS({ runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bench-')) });
    t.create('web-bait', '/.env').create('web-admin', '/admin');
    fs.mkdirSync(path.join(t.options.runDir, 'agent'), { recursive: true });
    const mw = t.express();
    const req = {
      url: '/api/products?page=2',
      method: 'GET',
      headers: { host: 'x' },
      socket: { remoteAddress: '203.0.113.5' },
    } as never;
    const res = {} as never;
    const next = () => undefined;
    for (let i = 0; i < 20_000; i++) mw(req, res, next); // warm-up
    const N = 200_000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) mw(req, res, next);
    const perCallUs = Number(process.hrtime.bigint() - t0) / N / 1000;
    t.close();
    assert.ok(perCallUs < 50, `expected < 50us per request, got ${perCallUs.toFixed(2)}us`);
  } finally {
    await h.close();
  }
});
