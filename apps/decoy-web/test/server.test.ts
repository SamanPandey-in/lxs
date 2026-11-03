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

function setup() {
  const lines: LogLine[] = [];
  const app = buildServer({ decoys, honeytokens, logger: { write: (l) => lines.push(l) } });
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
