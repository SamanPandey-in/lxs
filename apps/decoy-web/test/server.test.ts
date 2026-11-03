import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebDecoysFile } from '../src/config.js';
import { FALLBACK_HONEYTOKENS } from '../src/config.js';
import type { LogLine } from '../src/log.js';
import { buildServer } from '../src/server.js';

const decoys: WebDecoysFile = {
  service: 'shop',
  decoys: [
    {
      id: 'web-admin-admin',
      type: 'web-admin',
      mount: '/admin',
      brand: 'Acme Shop',
      acceptCredentials: [['admin', 'admin']],
      panel: 'customers',
    },
    { id: 'web-bait-env', type: 'web-bait', mount: '/.env', template: 'dotenv', breadcrumbs: true },
    {
      id: 'web-bait-backup-sql',
      type: 'web-bait',
      mount: '/backup.sql',
      template: 'sql-dump',
      breadcrumbs: true,
    },
  ],
  breadcrumbs: { ssh: { host: 'db-backup-01', port: 22, user: 'deploy' }, adminMount: '/admin' },
};
const honeytokens = {
  ...FALLBACK_HONEYTOKENS,
  tokens: [
    {
      id: 'ht_api_01',
      kind: 'api_key',
      value: 'acme_live_TESTTOKEN000000000000000000000',
      prefix: 'acme_live_',
    },
    {
      id: 'ht_db_01',
      kind: 'db_url',
      value: 'postgres://svc:pw@db-backup-01.internal:5432/shop_prod',
    },
  ],
};

function setup(options: { decoys?: WebDecoysFile; now?: () => number } = {}) {
  const lines: LogLine[] = [];
  const app = buildServer({
    decoys: options.decoys ?? decoys,
    honeytokens,
    logger: { write: (l) => lines.push(l) },
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, lines };
}
const H = { 'x-ds-client-ip': '203.0.113.66', 'x-ds-request-id': 'req1', 'user-agent': 'curl/8' };

test('login page is served and logged', async () => {
  const { app, lines } = setup();
  const r = await app.inject({ method: 'GET', url: '/admin', headers: H });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Acme Shop/);
  assert.equal(lines[0]?.ip, '203.0.113.66');
  assert.equal(lines[0]?.decoy_id, 'web-admin-admin');
});

test('default credentials open the panel; the export is a canary download', async () => {
  const { app, lines } = setup();
  const login = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'username=admin&password=admin',
  });
  assert.equal(login.statusCode, 302);
  const l = lines.find((x) => x.kind === 'login');
  assert.deepEqual([l?.username, l?.password, l?.accepted], ['admin', 'admin', true]);
  const panel = await app.inject({ method: 'GET', url: '/admin/panel', headers: H });
  assert.match(panel.body, /Export customers/);
  const csv = await app.inject({ method: 'GET', url: '/admin/export.csv', headers: H });
  assert.match(csv.body, /maria\.okafor@example\.com/);
  assert.equal(lines.at(-1)?.kind, 'export');
});

test('wrong credentials are rejected; panel needs login', async () => {
  const { app, lines } = setup();
  const r = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'root', password: 'toor' }),
  });
  assert.equal(r.statusCode, 401);
  assert.equal(lines[0]?.accepted, false);
  const p = await app.inject({
    method: 'GET',
    url: '/admin/panel',
    headers: { ...H, 'x-ds-client-ip': '198.51.100.9' },
  });
  assert.equal(p.statusCode, 302);
});

test('attacker input is escaped and never reflected as HTML', async () => {
  const { app } = setup();
  const r = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `username=${encodeURIComponent('<script>alert(1)</script>')}&password=x`,
  });
  assert.ok(!r.body.includes('<script>alert'));
  const g = await app.inject({ method: 'GET', url: '/admin?next=%3Cscript%3E', headers: H });
  assert.ok(!g.body.includes('<script>'));
});

test('bait files embed breadcrumbs and the honeytoken, and report the token id', async () => {
  const { app, lines } = setup();
  const env = await app.inject({ method: 'GET', url: '/.env', headers: H });
  assert.match(env.body, /SSH_HOST=db-backup-01/);
  assert.match(env.body, /acme_live_TESTTOKEN/);
  assert.equal(lines[0]?.kind, 'bait');
  assert.equal(lines[0]?.honeytoken_id, 'ht_api_01');
  const sql = await app.inject({ method: 'GET', url: '/backup.sql', headers: H });
  assert.match(sql.body, /INSERT INTO public\.customers/);
  assert.match(sql.headers['content-disposition'] as string, /attachment/);
});

test('forged client ip headers cannot inject log lines', async () => {
  const { app, lines } = setup();
  await app.inject({
    method: 'GET',
    url: '/.env',
    headers: { ...H, 'x-ds-client-ip': '1.2.3.4 {"kind":"login"}' },
  });
  assert.equal(lines[0]?.ip, '0.0.0.0');
  assert.equal(lines[0]?.kind, 'bait');
});

test('oversized bodies are refused with 413 and logged', async () => {
  const { app, lines } = setup();
  const r = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'text/plain' },
    payload: 'a'.repeat(40_000),
  });
  assert.equal(r.statusCode, 413);
  assert.equal(lines.at(-1)?.status, 413);
});

test('unknown paths get a generic 404', async () => {
  const { app } = setup();
  const r = await app.inject({ method: 'GET', url: '/nope', headers: H });
  assert.equal(r.statusCode, 404);
});

test('request throttling is per source and decoy, and expires after its window', async () => {
  let time = 1_000_000;
  const { app } = setup({ now: () => time });
  for (let i = 0; i < 120; i++) {
    const r = await app.inject({ method: 'GET', url: '/.env', headers: H });
    assert.equal(r.statusCode, 200);
  }
  const limited = await app.inject({ method: 'GET', url: '/.env', headers: H });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');

  const otherSource = await app.inject({
    method: 'GET',
    url: '/.env',
    headers: { ...H, 'x-ds-client-ip': '198.51.100.44' },
  });
  assert.equal(otherSource.statusCode, 200);
  const otherDecoy = await app.inject({ method: 'GET', url: '/admin', headers: H });
  assert.equal(otherDecoy.statusCode, 200);
  time += 60_000;
  const afterWindow = await app.inject({ method: 'GET', url: '/.env', headers: H });
  assert.equal(afterWindow.statusCode, 200);
  await app.close();
});

test('login throttling preserves decoy behavior for other sources', async () => {
  const { app } = setup();
  const login = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { ...H, 'x-ds-client-ip': ip, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'wrong', password: 'wrong' }),
    });
  for (let i = 0; i < 10; i++) assert.equal((await login('203.0.113.18')).statusCode, 401);
  assert.equal((await login('203.0.113.18')).statusCode, 429);
  assert.equal((await login('203.0.113.19')).statusCode, 401);
  await app.close();
});

test('state capacity never clears unrelated sessions or acceptAfter progress', async () => {
  const progressDecoy: WebDecoysFile = {
    ...decoys,
    decoys: [
      {
        id: 'admin-progress',
        type: 'web-admin',
        mount: '/progress',
        acceptAfter: 2,
        panel: 'customers',
      },
      decoys.decoys[0]!,
    ],
  };
  const { app } = setup({ decoys: progressDecoy });
  const login = (ip: string, mount = '/progress') =>
    app.inject({
      method: 'POST',
      url: `${mount}/login`,
      headers: { ...H, 'x-ds-client-ip': ip, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'invalid', password: 'invalid' }),
    });

  // Keep a live authenticated session while filling the independent attempt/request stores.
  const authenticated = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(authenticated.statusCode, 302);

  // Source 0 has one failed attempt; the admin session and other sources fill request state.
  assert.equal((await login('198.51.100.1')).statusCode, 401);
  for (let i = 2; i <= 4999; i++) {
    const ip = `10.${Math.floor(i / 65536)}.${Math.floor((i >> 8) % 256)}.${i % 256}`;
    const r = await login(ip);
    assert.equal(r.statusCode, 401, `source ${i} should retain normal decoy behavior`);
  }

  // Existing per-source state remains usable at capacity: acceptAfter reaches its threshold,
  // and the already-authenticated session remains valid after the flood.
  assert.equal((await login('198.51.100.1')).statusCode, 302);
  const panel = await app.inject({ method: 'GET', url: '/admin/panel', headers: H });
  assert.equal(panel.statusCode, 200);
  assert.match(panel.body, /Export customers/);
  await app.close();
});
