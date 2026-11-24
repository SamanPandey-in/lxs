import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebDecoysFile } from '../src/config.js';
import { FALLBACK_HONEYTOKENS } from '../src/config.js';
import { buildServer, readSessionId } from '../src/server.js';

const H = { 'x-ds-client-ip': '203.0.113.66', 'x-ds-request-id': 'req1', 'user-agent': 'curl/8' };

const adminDecoys = (acceptAfter?: number): WebDecoysFile => ({
  service: 'shop',
  decoys: [
    {
      id: 'web-admin-admin',
      type: 'web-admin',
      mount: '/admin',
      brand: 'Acme Shop',
      acceptCredentials: acceptAfter ? [] : [['admin', 'admin']],
      ...(acceptAfter ? { acceptAfter } : {}),
      panel: 'customers',
    },
    { id: 'web-bait-env', type: 'web-bait', mount: '/.env', template: 'dotenv', breadcrumbs: true },
  ],
});

function setup(opts: { acceptAfter?: number; maxTracked?: number } = {}) {
  return buildServer({
    decoys: adminDecoys(opts.acceptAfter),
    honeytokens: FALLBACK_HONEYTOKENS,
    logger: { write: () => undefined },
    ...(opts.maxTracked ? { maxTracked: opts.maxTracked } : {}),
  });
}

const cookieOf = (r: { headers: Record<string, unknown> }): string | undefined => {
  const raw = r.headers['set-cookie'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.split(';')[0] : undefined;
};

const A = 'PHPSESSID=aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'PHPSESSID=bbbbbbbbbbbbbbbbbbbbbbbbbb';

test('readSessionId only accepts the decoy cookie in its exact format', () => {
  assert.equal(readSessionId(`foo=1; ${A}; bar=2`), 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(readSessionId('PHPSESSID=short'), undefined);
  assert.equal(readSessionId('PHPSESSID=AAAAAAAAAAAAAAAAAAAAAAAAAA'), undefined);
  assert.equal(readSessionId('connect.sid=aaaaaaaaaaaaaaaaaaaaaaaaaa'), undefined);
  assert.equal(readSessionId(undefined), undefined);
});

test('a cookie-less client is issued an innocuous session cookie scoped to the mount', async () => {
  const app = setup();
  const r = await app.inject({ method: 'GET', url: '/admin', headers: H });
  assert.match(
    String(r.headers['set-cookie']),
    /^PHPSESSID=[0-9a-v]{26}; path=\/admin; HttpOnly; SameSite=Lax$/,
  );
  const kept = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { ...H, cookie: cookieOf(r) as string },
  });
  assert.equal(kept.headers['set-cookie'], undefined);
  const bad = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { ...H, cookie: 'PHPSESSID=../../etc/passwd' },
  });
  assert.ok(bad.headers['set-cookie']);
  // Bait files never set cookies.
  const env = await app.inject({ method: 'GET', url: '/.env', headers: H });
  assert.equal(env.headers['set-cookie'], undefined);
  await app.close();
});

test('sessions are keyed on IP + cookie: same-IP clients with other cookies do not share a login', async () => {
  const app = setup();
  const login = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, cookie: A, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.statusCode, 302);
  const panel = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/admin/panel', headers });
  assert.equal((await panel({ ...H, cookie: A })).statusCode, 200);
  assert.equal((await panel({ ...H, cookie: B })).statusCode, 302);
  assert.equal((await panel(H)).statusCode, 302);
  // The same cookie from another IP is another session.
  assert.equal(
    (await panel({ ...H, 'x-ds-client-ip': '198.51.100.7', cookie: A })).statusCode,
    302,
  );
  await app.close();
});

test('without a cookie the session falls back to IP, and the issued cookie carries it on', async () => {
  const app = setup();
  const login = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...H, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.statusCode, 302);
  const issued = cookieOf(login) as string;
  assert.match(issued, /^PHPSESSID=[0-9a-v]{26}$/);
  const noCookie = await app.inject({ method: 'GET', url: '/admin/panel', headers: H });
  assert.equal(noCookie.statusCode, 200);
  const withCookie = await app.inject({
    method: 'GET',
    url: '/admin/panel',
    headers: { ...H, cookie: issued },
  });
  assert.equal(withCookie.statusCode, 200);
  await app.close();
});

test('acceptAfter is randomised per session within N..N+2 and differs across sessions', async () => {
  const app = setup({ acceptAfter: 3 });
  const acceptedAt: number[] = [];
  for (let s = 0; s < 24; s++) {
    const ip = `198.51.100.${s + 1}`;
    let n = 0;
    for (let i = 1; i <= 6 && n === 0; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { ...H, 'x-ds-client-ip': ip, 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'u', password: `p${i}` }),
      });
      if (r.statusCode === 302) n = i;
      else assert.equal(r.statusCode, 401);
    }
    acceptedAt.push(n);
  }
  for (const n of acceptedAt) assert.ok(n >= 3 && n <= 5, `accepted on attempt ${n}`);
  // 24 sessions all drawing the same value from 3 has probability 3^-23.
  assert.ok(new Set(acceptedAt).size > 1, 'per-session thresholds must not all be equal');
  await app.close();
});

test('cookie sessions on one IP progress towards acceptAfter independently', async () => {
  const app = setup({ acceptAfter: 1 });
  // N=1 accepts on attempt 1..3; drive cookie A to acceptance, then cookie B starts from zero.
  const attempt = (cookie: string) =>
    app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { ...H, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'u', password: 'p' }),
    });
  let tries = 0;
  for (let s = 0; s !== 302; ) {
    s = (await attempt(A)).statusCode;
    tries++;
  }
  assert.ok(tries >= 1 && tries <= 3);
  const panelB = await app.inject({
    method: 'GET',
    url: '/admin/panel',
    headers: { ...H, cookie: B },
  });
  assert.equal(panelB.statusCode, 302);
  await app.close();
});

test('flooding new sources evicts only cold state: a hot rate-limited source stays limited', async () => {
  const app = setup({ maxTracked: 50 });
  const hot = { ...H, 'x-ds-client-ip': '203.0.113.200' };
  for (let i = 0; i < 120; i++) await app.inject({ method: 'GET', url: '/.env', headers: hot });
  assert.equal((await app.inject({ method: 'GET', url: '/.env', headers: hot })).statusCode, 429);
  // 500 distinct sources (10x capacity) while the hot source keeps probing.
  for (let i = 0; i < 500; i++) {
    await app.inject({
      method: 'GET',
      url: '/.env',
      headers: { ...H, 'x-ds-client-ip': `10.9.${Math.floor(i / 256)}.${i % 256}` },
    });
    if (i % 10 === 0) {
      const r = await app.inject({ method: 'GET', url: '/.env', headers: hot });
      assert.equal(r.statusCode, 429, `hot source was reset after ${i} flood sources`);
    }
  }
  await app.close();
});
