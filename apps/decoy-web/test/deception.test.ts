import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BaitValues, HoneytokenSet, WebDecoysFile } from '../src/config.js';
import { FALLBACK_BAIT, FALLBACK_HONEYTOKENS } from '../src/config.js';
import { createJitter, sampleLognormal } from '../src/jitter.js';
import type { LogLine } from '../src/log.js';
import { mintToken, parseMintSecret } from '../src/mint.js';
import { buildServer } from '../src/server.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');

const bait: BaitValues = {
  ...FALLBACK_BAIT,
  app_key: `base64:${Buffer.alloc(32, 9).toString('base64')}`,
  postgres: { server: '16.2 (Debian 16.2-1.pgdg120+2)', dump: '16.2 (Debian 16.2-1.pgdg120+2)' },
  versions: { ...FALLBACK_BAIT.versions, nginx: '1.22.1', wordpress: '6.3.2' },
  asset_build: 'abc12345',
};

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
    {
      id: 'web-bait-wp',
      type: 'web-bait',
      mount: '/wp-login.php',
      template: 'wp-login',
      assets: [
        '/wp-admin',
        '/wp-admin/css/login.min.css',
        '/wp-includes',
        '/wp-includes/css/buttons.min.css',
        '/wp-includes/js/jquery/jquery.min.js',
        '/wp-includes/images/spinner.gif',
        '/wp-content',
        '/readme.html',
        '/xmlrpc.php',
      ],
    },
    {
      id: 'web-bait-pma',
      type: 'web-bait',
      mount: '/phpmyadmin',
      template: 'phpmyadmin',
      assets: ['/phpmyadmin/index.php', '/phpmyadmin/themes/pmahomme/css/theme.css'],
    },
    {
      id: 'web-bait-git',
      type: 'web-bait',
      mount: '/.git/config',
      template: 'git-config',
      assets: ['/.git', '/.git/HEAD', '/.git/description'],
    },
  ],
  breadcrumbs: { ssh: { host: 'db-backup-01', port: 22, user: 'deploy' }, adminMount: '/admin' },
  bait,
};

const tokens = (mint: boolean): HoneytokenSet => ({
  ...FALLBACK_HONEYTOKENS,
  tokens: [
    {
      id: 'ht_api_01',
      kind: 'api_key',
      value: 'acme_live_STATICSTATICSTATICSTATICSTATIC00',
      prefix: 'acme_live_',
    },
    {
      id: 'ht_db_01',
      kind: 'db_url',
      value: 'postgres://svc_reporting:Copper%23Meadow42@db-backup-01.internal:5432/shop_prod',
    },
  ],
  ...(mint ? { mint_secret: SECRET } : {}),
});

function setup(opts: { mint?: boolean; perVisitorTokens?: boolean; file?: WebDecoysFile } = {}) {
  const lines: LogLine[] = [];
  const app = buildServer({
    decoys: opts.file ?? decoys,
    honeytokens: tokens(opts.mint ?? false),
    logger: { write: (l) => lines.push(l) },
    ...(opts.perVisitorTokens !== undefined ? { perVisitorTokens: opts.perVisitorTokens } : {}),
  });
  return { app, lines };
}
const H = { 'x-ds-client-ip': '203.0.113.9', 'x-ds-request-id': 'r1', 'user-agent': 'curl/8' };
const get = (
  app: ReturnType<typeof setup>['app'],
  url: string,
  headers: Record<string, string> = H,
) => app.inject({ method: 'GET', url, headers });

/* ------------------------------------------------------------------ per-template look */

test('each template has its own markup and its own stylesheet', async () => {
  const { app } = setup();
  const admin = (await get(app, '/admin')).body;
  const wp = (await get(app, '/wp-login.php')).body;
  const pma = (await get(app, '/phpmyadmin')).body;
  assert.match(admin, /href="\/admin\/assets\/css\/app\.abc12345\.css"/);
  assert.match(admin, /class="auth-card"/);
  assert.match(wp, /id="loginform"/);
  assert.match(wp, /name="log"/);
  assert.match(wp, /wp-admin\/css\/login\.min\.css\?ver=6\.3\.2/);
  assert.match(pma, /id="login_form"/);
  assert.match(pma, /name="pma_username"/);
  assert.match(pma, /themes\/pmahomme\/css\/theme\.css/);
  // No shared inline stylesheet or wrapper any more.
  for (const [a, b] of [
    [admin, wp],
    [wp, pma],
    [admin, pma],
  ] as const) {
    assert.ok(!a.includes('<style>') || !b.includes('<style>'));
    assert.notEqual(a.slice(0, 120), b.slice(0, 120));
  }
});

test('response headers differ per product', async () => {
  const { app } = setup();
  const wp = await get(app, '/wp-login.php');
  assert.equal(wp.headers.expires, 'Wed, 11 Jan 1984 05:00:00 GMT');
  assert.match(String(wp.headers['set-cookie']), /^wordpress_test_cookie=/);
  const pma = await get(app, '/phpmyadmin');
  assert.equal(pma.headers['x-frame-options'], 'DENY');
  assert.match(String(pma.headers['set-cookie']), /^phpMyAdmin=[0-9a-f]{32}; path=\/phpmyadmin\//);
  const env = await get(app, '/.env');
  assert.equal(env.headers.server, 'nginx/1.22.1');
  assert.equal(env.headers['content-type'], 'application/octet-stream');
  assert.match(String(env.headers.etag), /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal(env.headers['last-modified'], bait.assets_modified);
});

test('404s look like the product that would answer them', async () => {
  const { app } = setup();
  const admin = await get(app, '/admin/nope');
  assert.equal(admin.statusCode, 404);
  assert.match(admin.body, /<div class="code">404<\/div>/);

  const nginx = await get(app, '/nothing-here');
  assert.equal(nginx.statusCode, 404);
  assert.match(nginx.body, /<center>nginx\/1\.22\.1<\/center>/);
  assert.match(nginx.body, /\r\n/);

  const wp = await get(app, '/wp-includes/nope.css', { ...H, 'x-ds-decoy-id': 'web-bait-wp' });
  assert.equal(wp.statusCode, 404);
  // Routed by hint but not a known companion: the WordPress-style theme 404 vs nginx's.
  const wpRouted = await get(app, '/readme.html');
  assert.equal(wpRouted.statusCode, 200);

  const pma = await get(app, '/pma-nope', { ...H, 'x-ds-decoy-id': 'web-bait-pma' });
  assert.equal(pma.statusCode, 404);
  assert.match(pma.body, /<address>Apache\/2\.4\.57 \(Debian\) Server at/);

  const bodies = new Set([admin.body, nginx.body, pma.body]);
  assert.equal(bodies.size, 3);
});

test('second-order assets are served with static-file headers', async () => {
  const { app } = setup();
  const css = await get(app, '/admin/assets/css/app.abc12345.css');
  assert.equal(css.statusCode, 200);
  assert.equal(css.headers['content-type'], 'text/css');
  assert.match(String(css.headers['cache-control']), /immutable/);
  const ico = await get(app, '/admin/favicon.ico');
  assert.equal(ico.headers['content-type'], 'image/x-icon');
  assert.equal(ico.rawPayload.readUInt16LE(2), 1);
  const stale = await get(app, '/admin/assets/css/app.deadbeef.css');
  assert.equal(stale.statusCode, 404);

  const wpCss = await get(app, '/wp-admin/css/login.min.css');
  assert.equal(wpCss.statusCode, 200);
  assert.match(wpCss.body, /#loginform|#login\{/);
  const gif = await get(app, '/wp-includes/images/spinner.gif');
  assert.equal(gif.rawPayload.subarray(0, 6).toString(), 'GIF89a');
  const wpAdmin = await get(app, '/wp-admin');
  assert.equal(wpAdmin.statusCode, 302);
  assert.match(String(wpAdmin.headers.location), /^\/wp-login\.php\?redirect_to=.*&reauth=1$/);
  const xmlrpc = await get(app, '/xmlrpc.php');
  assert.equal(xmlrpc.statusCode, 405);
  assert.equal(xmlrpc.body, 'XML-RPC server accepts POST requests only.');
  assert.equal((await get(app, '/wp-includes')).statusCode, 403);

  const theme = await get(app, '/phpmyadmin/themes/pmahomme/css/theme.css');
  assert.equal(theme.statusCode, 200);
  const pmaIndex = await get(app, '/phpmyadmin/index.php');
  assert.match(pmaIndex.body, /pma_password/);

  const head = await get(app, '/.git/HEAD');
  assert.equal(head.body, 'ref: refs/heads/main\n');
  assert.equal((await get(app, '/.git')).statusCode, 403);
});

test('asset requests are logged against the bait decoy', async () => {
  const { app, lines } = setup();
  await get(app, '/wp-includes/css/buttons.min.css');
  assert.equal(lines.at(-1)?.decoy_id, 'web-bait-wp');
  assert.equal(lines.at(-1)?.kind, 'request');
});

/* ------------------------------------------------------------------ per-build bait */

test('bait values come from the build: APP_KEY, pg_dump banner, DB settings', async () => {
  const { app } = setup();
  const env = (await get(app, '/.env')).body;
  const key = /^APP_KEY=base64:(.+)$/m.exec(env)?.[1] as string;
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(`base64:${key}`, bait.app_key);
  assert.ok(!env.includes('VGhpcyBpcyBub3QgYSByZWFsIGtleSBhdCBhbGwhISE='));
  assert.match(env, /^DB_PASSWORD=Copper#Meadow42$/m);
  assert.match(env, /^DB_HOST=db-backup-01\.internal$/m);

  const sql = (await get(app, '/backup.sql')).body;
  assert.match(sql, /^-- Dumped from database version 16\.2 \(Debian 16\.2-1\.pgdg120\+2\)$/m);
  assert.match(sql, /^-- Dumped by pg_dump version 16\.2 /m);
  assert.match(sql, /^-- Started on 2026-01-12 02:14:37 UTC$/m);
  assert.match(sql, /INSERT INTO public\.customers/);
  assert.ok(!sql.includes('14.9'));
});

test('an older web-decoys.json without bait still renders plausible values', async () => {
  const { bait: _drop, ...old } = decoys;
  const { app } = setup({ file: old });
  const env = (await get(app, '/.env')).body;
  assert.match(env, /^APP_KEY=base64:[A-Za-z0-9+/]{43}=$/m);
});

/* ------------------------------------------------------------------ per-visitor tokens */

test('mint derivation is pinned (apps/agent/test pins the same vector)', () => {
  const secret = parseMintSecret(SECRET) as Buffer;
  const a = mintToken(secret, { id: 'ht_api_01', prefix: 'acme_live_' }, '203.0.113.9', '');
  assert.equal(a.id, 'ht_api_01.swvxpgns7opr');
  assert.equal(a.value, 'acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw');
  const b = mintToken(
    secret,
    { id: 'ht_api_01', prefix: 'acme_live_' },
    '203.0.113.9',
    'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  assert.equal(b.id, 'ht_api_01.4j2gqppzcx7e');
  assert.equal(parseMintSecret('short'), null);
});

test('each visitor gets its own token; a refetch gets the same one; a mint line is logged', async () => {
  const { app, lines } = setup({ mint: true });
  const tokenOf = (body: string): string => /^ACME_LIVE_API_KEY=(.+)$/m.exec(body)?.[1] as string;
  const a1 = tokenOf((await get(app, '/.env')).body);
  const a2 = tokenOf((await get(app, '/.env')).body);
  const b = tokenOf((await get(app, '/.env', { ...H, 'x-ds-client-ip': '198.51.100.4' })).body);
  const c = tokenOf(
    (await get(app, '/.env', { ...H, cookie: 'PHPSESSID=aaaaaaaaaaaaaaaaaaaaaaaaaa' })).body,
  );
  assert.equal(a1, 'acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(c, 'acme_live_PyxK11iQEOWbhF3hfCYA9iFb195dZKp8');
  assert.match(a1, /^acme_live_[A-Za-z0-9]{32}$/);

  const baitLine = lines.find((l) => l.kind === 'bait');
  assert.equal(baitLine?.honeytoken_id, 'ht_api_01');
  assert.deepEqual(baitLine?.honeytoken_ids, ['ht_db_01', 'ht_api_01']);
  const mints = lines.filter((l) => l.kind === 'mint');
  assert.equal(mints.length, 4);
  assert.deepEqual(
    {
      id: mints[0]?.mint_id,
      base: mints[0]?.honeytoken_id,
      ip: mints[0]?.ip,
      path: mints[0]?.path,
      decoy: mints[0]?.decoy_id,
    },
    {
      id: 'ht_api_01.swvxpgns7opr',
      base: 'ht_api_01',
      ip: '203.0.113.9',
      path: '/.env',
      decoy: 'web-bait-env',
    },
  );
  assert.equal(mints[3]?.session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
  // The plaintext value never reaches the log.
  assert.ok(!JSON.stringify(lines).includes(a1));
});

test('without a mint secret (older builds) or with minting off, the static token is served', async () => {
  for (const opts of [{ mint: false }, { mint: true, perVisitorTokens: false }]) {
    const { app, lines } = setup(opts);
    const body = (await get(app, '/.env')).body;
    assert.match(body, /ACME_LIVE_API_KEY=acme_live_STATICSTATIC/);
    assert.equal(lines.filter((l) => l.kind === 'mint').length, 0);
  }
});

/* ------------------------------------------------------------------ jitter */

test('jitter is off unless configured, and lognormal around the median when on', () => {
  assert.equal(createJitter(undefined), null);
  assert.equal(createJitter(false), null);
  let seed = 1;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const xs = Array.from({ length: 4001 }, () => sampleLognormal(60, 0.45, 4, 600, rand)).sort(
    (a, b) => a - b,
  );
  const median = xs[2000] as number;
  assert.ok(median >= 50 && median <= 70, `median ${median}`);
  assert.ok((xs[0] as number) >= 4 && (xs.at(-1) as number) <= 600);
  const j = createJitter({ medianMs: { nginx: 0 }, default: 50 }, rand);
  assert.equal(j?.delay('nginx'), 0);
  assert.ok((j?.delay('admin') ?? 0) > 0);
});

test('a configured jitter delays canned responses', async () => {
  const app = buildServer({
    decoys,
    honeytokens: tokens(false),
    logger: { write: () => undefined },
    jitter: { delay: () => 60 },
  });
  const t0 = Date.now();
  const r = await get(app, '/.env');
  assert.equal(r.statusCode, 200);
  assert.ok(Date.now() - t0 >= 50, 'response should wait for the jitter delay');
  const fast = buildServer({
    decoys,
    honeytokens: tokens(false),
    logger: { write: () => undefined },
  });
  const t1 = Date.now();
  await get(fast, '/.env');
  assert.ok(Date.now() - t1 < 50);
});
