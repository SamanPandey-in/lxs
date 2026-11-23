import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  type AlertIncident,
  COOLDOWN_MS,
  decide,
  formatSlack,
  formatWebhook,
  matchesChannel,
  type PriorDelivery,
  postJson,
  sendToChannel,
  signatureHeader,
  verifySignature,
} from '../src/lib/alert-delivery.js';
import {
  decryptSecret,
  decryptSecretWithInfo,
  encryptionKeyFrom,
  encryptSecret,
  type Keyring,
  legacyKeyFrom,
} from '../src/lib/channel-crypto.js';
import { blockedReason } from '../src/lib/ssrf.js';
import { safeUrl } from '../src/modules/notifications.js';

/* ───────── SSRF classifier ───────── */

describe('blockedReason', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.9.9.9', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::FFFF:10.0.0.1', 'private'],
    ['[::ffff:169.254.169.254]', 'link-local'],
    ['::ffff:100.64.1.1', 'cgnat'],
    ['0:0:0:0:0:ffff:c0a8:0101', 'private'],
    ['::ffff:0:127.0.0.1', 'loopback'],
    ['::127.0.0.1', 'ipv4-compatible'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:7f00:1::1', 'loopback'],
    ['2001:db8::1', 'documentation'],
    ['not-an-ip', 'invalid'],
    ['1.2.3', 'invalid'],
    ['1:2:3:4:5:6:7:8:9', 'invalid'],
  ];
  for (const [ip, why] of blocked)
    test(`${ip} is ${why}`, () => assert.equal(blockedReason(ip), why));

  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])
    test(`${ip} is public`, () => assert.equal(blockedReason(ip), null));
});

describe('safeUrl (create-time check)', () => {
  test('accepts public https and refuses literal private hosts', () => {
    assert.equal(safeUrl('https://hooks.slack.com/services/x', false), true);
    for (const u of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://100.64.0.9/x',
      'https://[::1]/x',
      'https://user:pw@example.com/x',
      'ftp://example.com/x',
      'not a url',
    ])
      assert.equal(safeUrl(u, false), false, u);
  });
});

/* ───────── transport against a local receiver ───────── */

type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

describe('postJson / sendToChannel', () => {
  let server: http.Server;
  let base = '';
  const hits: Hit[] = [];
  let failNext = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: `${base}/target` });
          return res.end();
        }
        if (req.url === '/hang') return; // never answers
        if (req.url === '/flaky' && failNext > 0) {
          failNext--;
          res.writeHead(503);
          return res.end('try later');
        }
        if (req.url === '/fail') {
          res.writeHead(500);
          return res.end('boom');
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('delivers JSON and signs generic webhooks with a verifiable HMAC', async () => {
    hits.length = 0;
    const secret = 'whsec_test';
    const payload = { type: 'test', message: 'hello' };
    const now = new Date('2026-11-23T12:00:00Z');
    const r = await sendToChannel({ type: 'webhook', url: `${base}/hook`, secret }, payload, {
      allowPrivate: true,
      now,
    });
    assert.deepEqual(r, { delivered: true, status: 200, error: null });
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.method, 'POST');
    assert.equal(hit.headers['content-type'], 'application/json');
    assert.equal(hit.body, JSON.stringify(payload));
    const sig = String(hit.headers['x-lxs-signature']);
    const t = Math.floor(now.getTime() / 1000);
    assert.match(sig, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(sig, signatureHeader(secret, hit.body, t));
    assert.equal(verifySignature(secret, hit.body, sig, 300, t + 10), true);
    assert.equal(verifySignature(secret, `${hit.body} `, sig, 300, t), false, 'tampered body');
    assert.equal(verifySignature('other', hit.body, sig, 300, t), false, 'wrong secret');
    assert.equal(verifySignature(secret, hit.body, sig, 300, t + 301), false, 'stale timestamp');
  });

  test('Slack channels are not signed', async () => {
    hits.length = 0;
    const r = await sendToChannel(
      { type: 'slack', url: `${base}/slack`, secret: null },
      { text: 'x' },
      { allowPrivate: true },
    );
    assert.equal(r.delivered, true);
    assert.equal(hits[0]!.headers['x-lxs-signature'], undefined);
  });

  test('reports non-2xx as a failure with the status', async () => {
    const r = await postJson(`${base}/fail`, '{}', {}, { allowPrivate: true });
    assert.equal(r.delivered, false);
    assert.equal(r.status, 500);
    assert.match(r.error ?? '', /HTTP 500/);
  });

  test('does not follow redirects', async () => {
    hits.length = 0;
    const r = await postJson(`${base}/redirect`, '{}', {}, { allowPrivate: true });
    assert.equal(r.delivered, false);
    assert.equal(r.status, 302);
    assert.match(r.error ?? '', /redirect refused/);
    assert.deepEqual(
      hits.map((h) => h.url),
      ['/redirect'],
      'the redirect target must never be requested',
    );
  });

  test('times out', async () => {
    const started = Date.now();
    const r = await postJson(`${base}/hang`, '{}', {}, { allowPrivate: true, timeoutMs: 200 });
    assert.equal(r.delivered, false);
    assert.equal(r.status, null);
    assert.match(r.error ?? '', /timeout after 200 ms/);
    assert.ok(Date.now() - started < 2000);
  });

  test('a retry after a transient failure succeeds', async () => {
    failNext = 1;
    const first = await postJson(`${base}/flaky`, '{}', {}, { allowPrivate: true });
    const second = await postJson(`${base}/flaky`, '{}', {}, { allowPrivate: true });
    assert.equal(first.status, 503);
    assert.equal(second.delivered, true);
  });

  test('refuses a literal loopback target without the dev override', async () => {
    hits.length = 0;
    const r = await postJson(`${base}/hook`, '{}', {});
    assert.equal(r.delivered, false);
    assert.match(r.error ?? '', /refused: 127\.0\.0\.1 is a loopback address/);
    assert.equal(hits.length, 0);
  });

  test('SSRF via DNS: a public-looking name resolving to a private IP is refused', async () => {
    hits.length = 0;
    const port = (server.address() as AddressInfo).port;
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const r = await postJson(`http://alerts.example.com:${port}/hook`, '{}', {}, { resolver });
    assert.equal(r.delivered, false);
    assert.match(r.error ?? '', /resolves to a loopback address/);
    assert.equal(hits.length, 0, 'no connection is made');
  });

  test('SSRF via DNS: v4-mapped IPv6 and mixed answers are refused', async () => {
    const port = (server.address() as AddressInfo).port;
    const mapped = async () => [{ address: '::ffff:10.0.0.1', family: 6 }];
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    for (const resolver of [mapped, mixed]) {
      const r = await postJson(`http://x.example.com:${port}/`, '{}', {}, { resolver });
      assert.equal(r.delivered, false);
      assert.match(r.error ?? '', /refused/);
    }
  });

  test('connects to the vetted address (resolver answer is what the socket uses)', async () => {
    hits.length = 0;
    const port = (server.address() as AddressInfo).port;
    const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    const r = await postJson(
      `http://alerts.example.com:${port}/hook`,
      '{}',
      {},
      { resolver, allowPrivate: true },
    );
    assert.equal(r.delivered, true);
    assert.equal(hits[0]!.headers.host, `alerts.example.com:${port}`);
  });
});

/* ───────── filter + dedupe ───────── */

describe('matchesChannel', () => {
  const ch = { enabled: true, minSeverity: 'high', labels: ['targeted'] };
  test('applies min severity, labels and enabled', () => {
    assert.equal(matchesChannel(ch, { severity: 'critical', label: 'targeted' }), true);
    assert.equal(matchesChannel(ch, { severity: 'high', label: 'targeted' }), true);
    assert.equal(matchesChannel(ch, { severity: 'medium', label: 'targeted' }), false);
    assert.equal(matchesChannel(ch, { severity: 'critical', label: 'noise' }), false);
    assert.equal(
      matchesChannel({ ...ch, enabled: false }, { severity: 'critical', label: 'targeted' }),
      false,
    );
    assert.equal(matchesChannel({ ...ch, labels: [] }, { severity: 'high', label: 'noise' }), true);
  });
});

describe('decide', () => {
  const channel = { enabled: true, minSeverity: 'low', labels: [] as string[] };
  const now = new Date('2026-11-23T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const inc = (severity: string, id = 'i1', openedAt = ago(60_000)) => ({
    id,
    severity,
    label: 'targeted',
    openedAt,
  });
  const sent = (
    severity: string,
    incidentId = 'i1',
    at = ago(30_000),
    status = 'ok',
  ): PriorDelivery => ({
    incidentId,
    severity,
    status,
    createdAt: at,
  });
  const run = (
    incident: ReturnType<typeof inc>,
    prior: PriorDelivery[] = [],
    siblings = [] as Array<{ id: string; severity: string; label: string; openedAt: Date }>,
    ch = channel,
  ) => decide({ channel: ch, incident, prior, siblings, now });

  test('first alert for an incident is sent', () => {
    assert.deepEqual(run(inc('high')), { action: 'send' });
  });

  test('filtered by the channel', () => {
    assert.deepEqual(run(inc('medium'), [], [], { ...channel, minSeverity: 'high' }), {
      action: 'skip',
      reason: 'filtered',
    });
  });

  test('one message per incident per severity step', () => {
    assert.deepEqual(run(inc('high'), [sent('high')]), { action: 'skip', reason: 'duplicate' });
    assert.deepEqual(run(inc('high'), [sent('critical')]), { action: 'skip', reason: 'duplicate' });
    // Same step long after the cooldown is still a duplicate for that incident.
    assert.deepEqual(run(inc('high'), [sent('high', 'i1', ago(COOLDOWN_MS * 5))]), {
      action: 'skip',
      reason: 'duplicate',
    });
  });

  test('a failed delivery does not count as paged', () => {
    assert.deepEqual(run(inc('high'), [sent('high', 'i1', ago(1000), 'failed')]), {
      action: 'send',
    });
  });

  test('a climbing chain inside the cooldown defers non-critical steps', () => {
    const d = run(inc('high'), [sent('medium', 'i1', ago(60_000))]);
    assert.equal(d.action, 'defer');
    if (d.action === 'defer') assert.equal(d.until.getTime(), ago(60_000).getTime() + COOLDOWN_MS);
  });

  test('critical always goes out once, even inside the cooldown', () => {
    assert.deepEqual(run(inc('critical'), [sent('high', 'i1', ago(1000))]), { action: 'send' });
  });

  test('a step-up after the cooldown is sent', () => {
    assert.deepEqual(run(inc('high'), [sent('medium', 'i1', ago(COOLDOWN_MS + 1))]), {
      action: 'send',
    });
  });

  test('cooldown is per attacker across incidents', () => {
    // Another incident of the same attacker already paged critical a minute ago.
    assert.deepEqual(run(inc('critical', 'i2'), [sent('critical', 'i1', ago(60_000))]), {
      action: 'skip',
      reason: 'cooldown',
    });
    assert.deepEqual(run(inc('high', 'i2'), [sent('critical', 'i1', ago(60_000))]), {
      action: 'skip',
      reason: 'cooldown',
    });
  });

  test('a newer same-or-higher incident of the same attacker supersedes this one', () => {
    const newer = { id: 'i2', severity: 'critical', label: 'targeted', openedAt: ago(1000) };
    assert.deepEqual(run(inc('high'), [], [newer]), { action: 'skip', reason: 'superseded' });
    // ...unless the channel would not accept the newer one.
    assert.deepEqual(
      run(inc('high'), [], [{ ...newer, label: 'noise' }], { ...channel, labels: ['targeted'] }),
      { action: 'send' },
    );
    // An older or lower sibling does not supersede.
    assert.deepEqual(run(inc('high'), [], [{ ...newer, openedAt: ago(120_000) }]), {
      action: 'send',
    });
    assert.deepEqual(run(inc('high'), [], [{ ...newer, severity: 'medium' }]), { action: 'send' });
  });

  test('replay: low → medium → high → critical pages at most twice in one cooldown', () => {
    const prior: PriorDelivery[] = [];
    let pages = 0;
    for (const [i, sev] of ['low', 'medium', 'high', 'critical'].entries()) {
      const d = run(inc(sev, 'i1', ago(60_000)), prior);
      if (d.action === 'send') {
        pages++;
        prior.unshift(sent(sev, 'i1', ago(50_000 - i * 1000)));
      }
    }
    assert.equal(pages, 2); // the first step, then critical
  });
});

/* ───────── formatters ───────── */

describe('formatters', () => {
  const i: AlertIncident = {
    id: '0b4a7f2e-0000-4000-8000-000000000001',
    number: 42,
    title: 'Credential stuffing from 203.0.113.9',
    severity: 'critical',
    score: 91,
    label: 'targeted',
    srcIp: '203.0.113.9',
    stages: ['recon', 'credential_access', 'exfiltration'],
    techniques: ['T1110', 'T1552'],
    realAssetReached: false,
    honeytokenUsed: true,
  };

  test('Slack blocks carry severity, IP, score, kill chain and the incident link', () => {
    const s = formatSlack(i, 'https://app.lxs.dev/');
    const json = JSON.stringify(s);
    assert.match(String(s.text), /\[Critical\] #42/);
    assert.ok(json.includes('https://app.lxs.dev/incidents/0b4a7f2e-0000-4000-8000-000000000001'));
    assert.ok(json.includes('203.0.113.9'));
    assert.ok(json.includes('*Score*\\n91'));
    assert.ok(json.includes('recon → credential_access → exfiltration (2 techniques)'));
    assert.ok(json.includes('honeytoken used'));
  });

  test('generic webhook body', () => {
    const w = formatWebhook(i, 'http://localhost:3000', 'p1', new Date('2026-01-01T00:00:00Z'));
    assert.equal(w.type, 'incident.alert');
    assert.equal(w.project_id, 'p1');
    const body = w.incident as Record<string, unknown>;
    assert.equal(body.severity, 'critical');
    assert.equal(body.attacker_ip, '203.0.113.9');
    assert.equal(body.url, 'http://localhost:3000/incidents/0b4a7f2e-0000-4000-8000-000000000001');
  });
});

/* ───────── channel encryption ───────── */

describe('channel encryption', () => {
  const ring: Keyring = {
    current: Buffer.alloc(32, 7),
    version: 1,
    legacy: legacyKeyFrom('old-session-secret-1234'),
  };

  test('new ciphertext starts with the key-version byte and round-trips', () => {
    const buf = encryptSecret('https://hooks.slack.com/services/T/B/x', ring);
    assert.equal(buf[0], 1);
    assert.deepEqual(decryptSecretWithInfo(buf, ring), {
      plain: 'https://hooks.slack.com/services/T/B/x',
      legacy: false,
    });
  });

  test('legacy rows (SESSION_SECRET-derived key, no version byte) still decrypt', async () => {
    const { createCipheriv, randomBytes } = await import('node:crypto');
    const key = createHash('sha256').update('channels:old-session-secret-1234').digest();
    for (let n = 0; n < 20; n++) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(`https://example.com/${n}`, 'utf8'), c.final()]);
      const legacyBuf = Buffer.concat([iv, c.getAuthTag(), enc]);
      assert.deepEqual(decryptSecretWithInfo(legacyBuf, ring), {
        plain: `https://example.com/${n}`,
        legacy: true,
      });
    }
  });

  test('wrong key fails closed', () => {
    const buf = encryptSecret('x', ring);
    assert.throws(() =>
      decryptSecret(buf, { ...ring, current: Buffer.alloc(32, 8), legacy: null }),
    );
  });

  test('ENCRYPTION_KEY accepts 32 bytes as hex or base64 only', () => {
    const raw = Buffer.alloc(32, 3);
    assert.deepEqual(encryptionKeyFrom(raw.toString('hex')), raw);
    assert.deepEqual(encryptionKeyFrom(raw.toString('base64')), raw);
    assert.deepEqual(encryptionKeyFrom(raw.toString('base64url')), raw);
    assert.throws(() => encryptionKeyFrom('too-short'));
    assert.throws(() => encryptionKeyFrom(Buffer.alloc(16).toString('base64')));
  });
});
