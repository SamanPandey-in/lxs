import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { configTemplate } from '../src/cli/init.js';
import { generateAll } from '../src/generate/index.js';
import { LXS, LXSConfigError } from '../src/index.js';
import { decoySessionCookie, makeClientIp } from '../src/middleware/core.js';
import { isMatchAll } from '../src/netutil.js';
import { startFakeAgent } from '../src/testing.js';

const err = (fn: () => unknown): LXSConfigError | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof LXSConfigError) return e;
    throw e;
  }
  return undefined;
};

const req = (sock: string, xff?: string | string[]): IncomingMessage =>
  ({
    socket: { remoteAddress: sock },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as IncomingMessage;

/* ------------------------------------------------------------------ trustProxy parsing */

test('trustProxy: true is rejected with a clear error that names the alternatives', () => {
  const e = err(() => new LXS({ trustProxy: true as never }));
  assert.equal(e?.code, 'E_TRUST_PROXY');
  assert.match(e?.message ?? '', /leftmost X-Forwarded-For/);
  assert.match(e?.hint ?? '', /trustProxy: 1/);
  assert.match(e?.hint ?? '', /\['loopback'\]/);
});

test('trustProxy accepts false, a hop count, and proxy lists; rejects bad counts and /0', () => {
  assert.equal(new LXS({}).options.trustProxy, false);
  assert.equal(new LXS({ trustProxy: false }).options.trustProxy, false);
  assert.equal(new LXS({ trustProxy: 2 }).options.trustProxy, 2);
  assert.deepEqual(new LXS({ trustProxy: ['loopback', '10.0.0.0/8'] }).options.trustProxy, [
    'loopback',
    '10.0.0.0/8',
  ]);
  for (const bad of [0, -1, 1.5, 11]) {
    assert.equal(err(() => new LXS({ trustProxy: bad }))?.code, 'E_OPTIONS', String(bad));
  }
  for (const all of ['0.0.0.0/0', '::/0']) {
    const e = err(() => new LXS({ trustProxy: [all] }));
    assert.equal(e?.code, 'E_OPTIONS');
    assert.match(e?.message ?? '', /trusts every address/);
  }
  assert.equal(err(() => new LXS({ trustProxy: ['nope'] }))?.code, 'E_OPTIONS');
});

test('allowlist rejects prefix length 0 because it would disable blocking entirely', () => {
  for (const all of ['0.0.0.0/0', '::/0', '1.2.3.4/0']) {
    const e = err(() => new LXS({ allowlist: ['10.0.0.0/8', all] }));
    assert.equal(e?.code, 'E_OPTIONS', all);
    assert.match(e?.message ?? '', /disable blocking entirely/);
  }
  assert.deepEqual(new LXS({ allowlist: ['10.0.0.0/8', '0.0.0.0/1'] }).options.allowlist, [
    '10.0.0.0/8',
    '0.0.0.0/1',
  ]);
  assert.equal(isMatchAll('0.0.0.0/0'), true);
  assert.equal(isMatchAll('::/00'), true);
  assert.equal(isMatchAll('10.0.0.0/8'), false);
  assert.equal(isMatchAll('10.0.0.1'), false);
  assert.equal(isMatchAll('bogus/0'), false);
});

/* ------------------------------------------------------------------ client IP derivation */

test('default (false) ignores X-Forwarded-For entirely', () => {
  const ip = makeClientIp(false);
  assert.equal(ip(req('203.0.113.9', '1.1.1.1')), '203.0.113.9');
  assert.equal(ip(req('::ffff:203.0.113.9')), '203.0.113.9');
});

test('hop count walks X-Forwarded-For from the right; spoofed left entries are ignored', () => {
  const one = makeClientIp(1);
  // Attacker sends "X-Forwarded-For: 6.6.6.6"; the proxy (10.0.0.2) appends the real peer.
  assert.equal(one(req('10.0.0.2', '6.6.6.6, 198.51.100.7')), '198.51.100.7');
  assert.equal(one(req('10.0.0.2', '198.51.100.7')), '198.51.100.7');
  // Header split over several lines is one list.
  assert.equal(one(req('10.0.0.2', ['6.6.6.6', '198.51.100.7'])), '198.51.100.7');
  // No header: the socket peer is all we know.
  assert.equal(one(req('10.0.0.2')), '10.0.0.2');

  const two = makeClientIp(2);
  // CDN -> LB -> app: XFF = "<spoof>, client, cdn"
  assert.equal(two(req('10.0.0.3', '6.6.6.6, 1.1.1.1, 198.51.100.7, 172.16.0.5')), '198.51.100.7');
  // Fewer entries than hops: the leftmost appended entry is the furthest real hop.
  assert.equal(two(req('10.0.0.3', '198.51.100.7')), '198.51.100.7');
  // A garbage entry inside the trusted part means a misconfigured chain: fall back to the socket.
  assert.equal(two(req('10.0.0.3', '6.6.6.6, not-an-ip, 172.16.0.5')), '10.0.0.3');
  // ...but garbage the client wrote to the left of the trusted hops is never read.
  assert.equal(one(req('10.0.0.2', 'garbage, <script>, 198.51.100.7')), '198.51.100.7');
});

test('a proxy list skips trusted hops from the right and only trusts XFF from a listed peer', () => {
  const ip = makeClientIp(['loopback', '10.0.0.0/8']);
  assert.equal(ip(req('127.0.0.1', '6.6.6.6, 198.51.100.7, 10.1.2.3')), '198.51.100.7');
  // Spoofing a trusted-looking address on the left does not help: the walk stops at the first untrusted hop.
  assert.equal(ip(req('127.0.0.1', '10.9.9.9, 198.51.100.7')), '198.51.100.7');
  // Direct connection from an untrusted peer: XFF is ignored.
  assert.equal(ip(req('198.51.100.8', '6.6.6.6')), '198.51.100.8');
  assert.equal(ip(req('127.0.0.1')), '127.0.0.1');
});

/* ------------------------------------------------------------------ decoy session cookie */

test('only the decoy session cookie, in ds-web format, is forwarded', () => {
  const sid = 'PHPSESSID=0123456789abcdefghijklmnop';
  assert.equal(decoySessionCookie(`connect.sid=REAL; ${sid}; theme=dark`), sid);
  assert.equal(decoySessionCookie('PHPSESSID=REAL-APP-SESSION-VALUE'), null);
  assert.equal(decoySessionCookie('connect.sid=s%3Areal'), null);
  assert.equal(decoySessionCookie(undefined), null);
});

test('middleware forwards the decoy cookie and nothing else; ignores a /0 platform allowlist', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sdk-'));
  const agent = await startFakeAgent({
    runDir,
    fakeDecoy: true,
    blocklist: ['127.0.0.1'],
    allowlist: ['0.0.0.0/0', '::/0'],
  });
  const warnings: string[] = [];
  const t = new LXS({
    runDir,
    mode: 'monitor',
    logger: { warn: (m: string) => warnings.push(m), error: () => undefined },
  });
  t.create('web-admin', '/admin');
  const mw = t.express();
  const server = http.createServer((rq, rs) => mw(rq, rs, () => rs.end('real-app')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    await new Promise((r) => setTimeout(r, 200)); // first policy poll
    assert.equal(
      await get('/admin', { cookie: 'connect.sid=REAL; PHPSESSID=0123456789abcdefghijklmnop' }),
      200,
    );
    assert.equal(agent.decoyRequests[0]?.headers.cookie, 'PHPSESSID=0123456789abcdefghijklmnop');
    assert.equal(await get('/admin', { cookie: 'connect.sid=REAL' }), 200);
    assert.equal(agent.decoyRequests[1]?.headers.cookie, undefined);
    // The /0 allowlist entry was dropped: the source still reaches the decoy (an allowlisted source
    // would have been passed straight to the real app).
    assert.ok(warnings.some((w) => /\/0 entry/.test(w)));
  } finally {
    t.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await agent.close();
  }
});

/* ------------------------------------------------------------------ telemetry + init template */

test('telemetry mounts the host dir read-only into ds-agent and lists sources in the manifest', () => {
  const cfg = new LXS({ service: 'shop', telemetry: { dir: 'telemetry', sources: ['auth'] } })
    .create('web-bait', '/.env')
    .resolve();
  const g = generateAll(cfg);
  const doc = parseYaml(g.committed.get('lxs.compose.yml') as string, { merge: true }) as {
    services: Record<string, { volumes: string[] }>;
  };
  assert.ok(doc.services['ds-agent']?.volumes.includes('./telemetry:/var/log/lxs/telemetry:ro'));
  const manifest = JSON.parse(g.committed.get('.lxs/manifest.json') as string);
  assert.deepEqual(manifest.telemetry, { sources: ['auth'] });

  const none = generateAll(new LXS({ service: 'shop' }).create('web-bait', '/.env').resolve());
  assert.ok(!(none.committed.get('lxs.compose.yml') as string).includes('telemetry'));
  assert.equal(JSON.parse(none.committed.get('.lxs/manifest.json') as string).telemetry, undefined);

  assert.equal(err(() => new LXS({ telemetry: { dir: './x\n  evil: true' } }))?.code, 'E_OPTIONS');
  assert.deepEqual(new LXS({ telemetry: { dir: '/srv/tel' } }).options.telemetry, {
    dir: '/srv/tel',
    sources: ['firewall', 'auth'],
  });
});

test('the init template documents the new trustProxy forms and never suggests true', () => {
  const t = configTemplate('shop');
  assert.match(t, /trustProxy: 1,/);
  assert.match(t, /trustProxy: \['loopback'\]/);
  assert.ok(!/trustProxy: true/.test(t));
});
