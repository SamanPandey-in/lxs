/**
 * Stream J, "reasons to come back": weekly digest, coverage score, milestones and the noise
 * counter. Pure functions first, then the routes and the digest job on the in-memory FakeDb.
 */
process.env.LOG_LEVEL = 'silent';
process.env.NOTIFY_ALLOW_PRIVATE = 'true';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const digestLib = await import('../src/lib/digest.ts');
const { CHECKS, MAX_SCORE, scoreCoverage } = await import('../src/lib/coverage.ts');
const { reachedMilestones, MILESTONES } = await import('../src/lib/milestones.ts');
const { sendProjectDigest } = await import('../src/worker/weekly-digest.ts');
const { encryptSecret } = await import('../src/lib/channel-crypto.ts');
const { signToken } = await import('../src/lib/crypto.ts');
const { env } = await import('../src/env.ts');
const { digestCron } = await import('../src/jobs/queue.ts');
type World = Awaited<ReturnType<typeof buildWorld>>;
type CoverageFacts = import('../src/lib/coverage.ts').CoverageFacts;

const {
  buildDigest,
  changeText,
  countsFromRow,
  delta,
  emptyCounts,
  formatDigestSlack,
  formatDigestWebhook,
  isoWeek,
  previousWindow,
  renderDigestHtml,
  renderDigestText,
  rollingWindow,
  unsubscribeToken,
  verifyUnsubscribeToken,
  weeklyWindow,
} = digestLib;

/** A counts row as the aggregate query returns it. */
const COUNTS_ROW = {
  attackers: { targeted: 2, opportunistic: 5, noise: 30 },
  incidents: { critical: 1, high: 2, medium: 3, low: 4 },
  techniques: [
    { id: 'T1110', name: 'Brute Force', incidents: 6 },
    { id: 'T1552', name: 'Unsecured Credentials', incidents: 2 },
  ],
  blocks_issued: 3,
  blocks_held: 5,
  actions: 4,
  noise_events: 1204,
  noise_incidents: 30,
  honeytoken_uses: 1,
  events: 1500,
};

/* ───────────────────────── windows ───────────────────────── */

describe('digest windows', () => {
  it('labels ISO weeks, including year boundaries', () => {
    assert.equal(isoWeek(new Date('2026-11-23T09:00:00Z')), '2026-W48');
    assert.equal(isoWeek(new Date('2026-11-16T00:00:00Z')), '2026-W47');
    assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z')), '2026-W01');
    assert.equal(isoWeek(new Date('2021-01-03T12:00:00Z')), '2020-W53');
    assert.equal(isoWeek(new Date('2024-12-30T12:00:00Z')), '2025-W01');
    assert.equal(isoWeek(new Date('2026-11-22T23:59:59Z')), '2026-W47'); // Sunday
  });

  it('the scheduled digest covers the last complete Monday-to-Monday week', () => {
    const w = weeklyWindow(new Date('2026-11-23T09:00:00Z')); // a Monday, the cron time
    assert.equal(w.start.toISOString(), '2026-11-16T00:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-11-23T00:00:00.000Z');
    assert.equal(w.week, '2026-W47');
    // Any time in the following week reports the same week (same dedupe key).
    assert.equal(weeklyWindow(new Date('2026-11-27T18:00:00Z')).week, '2026-W47');
    const p = previousWindow(w);
    assert.equal(p.start.toISOString(), '2026-11-09T00:00:00.000Z');
    assert.equal(p.end.toISOString(), '2026-11-16T00:00:00.000Z');
  });

  it('the preview covers the seven days ending now', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const w = rollingWindow(now);
    assert.equal(w.end.getTime(), now.getTime());
    assert.equal(now.getTime() - w.start.getTime(), 7 * 86_400_000);
  });

  it('DIGEST_CRON defaults to Monday 09:00 and can be switched off', () => {
    assert.equal(digestCron(), '0 9 * * 1');
    assert.equal(digestCron('OFF'), null);
    assert.equal(digestCron(' 0 8 * * 1 '), '0 8 * * 1');
  });
});

/* ───────────────────────── digest model and rendering ───────────────────────── */

describe('digest content', () => {
  const window = weeklyWindow(new Date('2026-11-23T09:00:00Z'));
  const current = countsFromRow(COUNTS_ROW);
  const previous = countsFromRow({
    ...COUNTS_ROW,
    attackers: { targeted: 0, opportunistic: 5, noise: 27 },
    incidents: { low: 4 },
    noise_events: 1000,
  });
  const digest = buildDigest({
    project: { id: randomUUID(), name: 'Acme <Shop>' },
    window,
    current,
    previous,
    milestones: [
      {
        key: 'first_targeted',
        title: 'First targeted attacker',
        reached_at: '2026-11-18T00:00:00Z',
      },
    ],
  });

  it('maps the aggregate row and derives totals', () => {
    assert.equal(current.attackers.total, 37);
    assert.equal(current.incidents.total, 10);
    assert.deepEqual(current.blocks, { issued: 3, held: 5 });
    assert.equal(current.techniques[0]!.id, 'T1110');
    assert.deepEqual(countsFromRow(undefined), emptyCounts());
    assert.deepEqual(countsFromRow({ techniques: 'not json' }).techniques, []);
  });

  it('computes week-over-week change', () => {
    assert.deepEqual(delta(37, 32), { current: 37, previous: 32, diff: 5, pct: 16 });
    assert.equal(delta(3, 0).pct, null);
    assert.equal(changeText(delta(37, 32)), '+5 (+16%) vs last week');
    assert.equal(changeText(delta(1, 3)), '-2 (-67%) vs last week');
    assert.equal(changeText(delta(2, 2)), 'same as last week');
    assert.equal(digest.change.attackers.diff, 5);
    assert.equal(digest.change.targeted.diff, 2);
    assert.equal(digest.change.critical.diff, 1);
  });

  it('the text email has every section and the unsubscribe link', () => {
    const text = renderDigestText(digest, {
      dashboard: 'https://app.example/',
      unsubscribe: 'https://app.example/digest/unsubscribe?token=x',
    });
    for (const s of [
      'Week 2026-W47, 2026-11-16 to 2026-11-22 (UTC)',
      'Attackers caught: 37 (+5 (+16%) vs last week)',
      'targeted 2, opportunistic 5, noise 30',
      'critical 1, high 2, medium 3, low 4',
      'T1110 Brute Force: 6 incidents',
      'Blocks: 3 issued, 5 in force at week end, 4 response actions applied',
      'Noise you did not have to read: 1,204 events across 30 incidents',
      '80% of all events',
      'Honeytoken uses: 1',
      'Milestones reached: First targeted attacker',
      'Sample data and test hits are not counted.',
      'Stop these emails: https://app.example/digest/unsubscribe?token=x',
    ])
      assert.ok(text.includes(s), `missing: ${s}\n${text}`);
  });

  it('the HTML email escapes project names and links', () => {
    const html = renderDigestHtml(digest, {
      dashboard: 'https://app.example/?a=1&b="2"',
      unsubscribe: 'https://app.example/u',
    });
    assert.ok(html.includes('Acme &lt;Shop&gt;'));
    assert.ok(!html.includes('Acme <Shop>'));
    assert.ok(html.includes('href="https://app.example/?a=1&amp;b=&quot;2&quot;"'));
    assert.ok(html.includes('Stop these emails'));
  });

  it('a week with nothing says so instead of a wall of zeros', () => {
    const quiet = buildDigest({
      project: { id: randomUUID(), name: 'Quiet' },
      window,
      current: emptyCounts(),
      previous: emptyCounts(),
    });
    assert.match(renderDigestText(quiet, { dashboard: 'x' }), /A quiet week/);
    assert.ok(!renderDigestText(quiet, { dashboard: 'x' }).includes('Stop these emails'));
  });

  it('Slack and webhook payloads carry the same numbers', () => {
    const slack = formatDigestSlack(digest, 'https://app.example') as {
      text: string;
      blocks: { type: string }[];
    };
    assert.match(slack.text, /37 attackers, 10 incidents, 1,204 noise events/);
    const header = slack.blocks[0] as unknown as {
      type: string;
      text: { type: string; text: string };
    };
    assert.equal(header.text.type, 'plain_text'); // plain_text needs no escaping
    assert.match(header.text.text, /Weekly digest: Acme <Shop> \(2026-W47\)/);
    const hook = formatDigestWebhook(digest, 'https://app.example', new Date(0)) as Record<
      string,
      unknown
    >;
    assert.equal(hook.type, 'digest.weekly');
    assert.equal(hook.week, '2026-W47');
    assert.deepEqual((hook.current as { noise: unknown }).noise, { events: 1204, incidents: 30 });
    assert.equal((hook.previous as { noise: { events: number } }).noise.events, 1000);
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips the user id', () => {
    const uid = randomUUID();
    assert.equal(verifyUnsubscribeToken(unsubscribeToken(uid)), uid);
  });

  it('rejects tampering, expiry, junk and session cookies', () => {
    const uid = randomUUID();
    const t = unsubscribeToken(uid);
    const [h, b, s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: 'digest_unsubscribe', uid: randomUUID(), exp: 9e9 }),
    ).toString('base64url');
    assert.equal(verifyUnsubscribeToken(`${h}.${forged}.${s}`), null);
    assert.equal(verifyUnsubscribeToken(`${h}.${b}.${s}x`), null);
    assert.equal(
      verifyUnsubscribeToken(unsubscribeToken(uid, new Date(Date.now() - 200 * 86_400_000))),
      null,
    );
    assert.equal(verifyUnsubscribeToken('nope'), null);
    assert.equal(verifyUnsubscribeToken(42), null);
    // A session token is signed with a different key and has no purpose.
    const session = signToken(
      { uid, exp: Math.floor(Date.now() / 1000) + 60, ver: 0 },
      env.SESSION_SECRET,
    );
    assert.equal(verifyUnsubscribeToken(session), null);
  });
});

/* ───────────────────────── coverage ───────────────────────── */

const NOW = new Date('2026-11-24T12:00:00Z');
const fullFacts = (): CoverageFacts => ({
  decoyTypes: ['web-admin', 'web-bait', 'ssh', 'redis'],
  webHits7d: 140,
  networkHits7d: 12,
  honeytokens: 2,
  sensors: 1,
  lastHeartbeatAt: new Date(NOW.getTime() - 60_000),
  channels: [{ name: '#soc', enabled: true, lastStatus: 'ok' }],
  modes: ['enforce'],
  allowlistSize: 2,
  allowlistReviewedAt: new Date(NOW.getTime() - 10 * 86_400_000),
  selftests: [{ passed: true, at: NOW }],
});
const emptyFacts = (): CoverageFacts => ({
  decoyTypes: [],
  webHits7d: 0,
  networkHits7d: 0,
  honeytokens: 0,
  sensors: 0,
  lastHeartbeatAt: null,
  channels: [],
  modes: [],
  allowlistSize: 0,
  allowlistReviewedAt: null,
  selftests: [],
});

describe('coverage score', () => {
  it('the checks add up to 100 and have stable ids', () => {
    assert.equal(MAX_SCORE, 100);
    assert.deepEqual(
      CHECKS.map((c) => [c.id, c.points]),
      [
        ['web_decoy', 15],
        ['network_decoy', 15],
        ['honeytokens', 15],
        ['agent_heartbeat', 15],
        ['alert_channel', 15],
        ['enforce_mode', 10],
        ['selftest', 10],
        ['allowlist_reviewed', 5],
      ],
    );
  });

  it('a fully set up project scores 100 with no recommendations', () => {
    const r = scoreCoverage(fullFacts(), NOW);
    assert.equal(r.score, 100);
    assert.equal(r.recommendations.length, 0);
    assert.match(r.checks[0]!.detail, /2 web decoys, 140 hits in the last 7 days/);
  });

  it('an empty project scores 0; every check becomes a recommendation, biggest gain first', () => {
    const r = scoreCoverage(emptyFacts(), NOW);
    assert.equal(r.score, 0);
    assert.equal(r.recommendations.length, CHECKS.length);
    const pts = r.recommendations.map((x) => x.points);
    assert.deepEqual(
      pts,
      [...pts].sort((a, b) => b - a),
    );
    for (const rec of r.recommendations) {
      assert.ok(rec.title && rec.why && rec.fix.text, rec.id);
      assert.ok(rec.fix.cli || rec.fix.href, `${rec.id} needs a CLI snippet or a link`);
    }
  });

  it('is deterministic and explains each failure', () => {
    const f = fullFacts();
    f.lastHeartbeatAt = new Date(NOW.getTime() - 16 * 60_000);
    f.channels = [{ name: '#soc', enabled: true, lastStatus: 'failed' }];
    f.modes = ['enforce', 'monitor'];
    f.selftests = [
      { passed: true, at: NOW },
      { passed: false, at: NOW },
    ];
    f.allowlistReviewedAt = new Date(NOW.getTime() - 91 * 86_400_000);
    const a = scoreCoverage(f, NOW);
    assert.deepEqual(a, scoreCoverage(f, NOW));
    assert.equal(a.score, 45);
    const by = Object.fromEntries(a.checks.map((c) => [c.id, c]));
    assert.match(by.agent_heartbeat!.detail, /16 min ago/);
    assert.match(by.alert_channel!.detail, /failing \(#soc\)/);
    assert.match(by.enforce_mode!.detail, /1 sensor in monitor mode/);
    assert.match(by.selftest!.detail, /failed on 1 sensor/);
    assert.match(by.allowlist_reviewed!.detail, /last reviewed 91 days ago/);
    assert.deepEqual(
      a.recommendations.map((r) => r.id),
      ['agent_heartbeat', 'alert_channel', 'enforce_mode', 'selftest', 'allowlist_reviewed'],
    );
  });

  it('a channel that never sent does not count as healthy; a missing mode defaults to enforce', () => {
    const f = fullFacts();
    f.channels = [{ name: 'x', enabled: true, lastStatus: null }];
    f.modes = [null];
    const by = Object.fromEntries(scoreCoverage(f, NOW).checks.map((c) => [c.id, c]));
    assert.equal(by.alert_channel!.passed, false);
    assert.match(by.alert_channel!.detail, /never sent/);
    assert.equal(by.enforce_mode!.passed, true);
    assert.match(by.enforce_mode!.detail, /default is enforce/);
  });
});

/* ───────────────────────── milestones ───────────────────────── */

describe('milestones', () => {
  it('reports only what the facts show, in catalogue order', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const r = reachedMilestones({
      firstCatchAt: at,
      firstTargetedAt: null,
      firstHoneytokenUseAt: at,
      firstBlockAt: null,
      hundredthAttackerAt: null,
      quietWeekEndAt: at,
      quietWeek: '2026-W44',
    });
    assert.deepEqual(
      r.map((m) => m.key),
      ['first_catch', 'first_honeytoken_use', 'quiet_week'],
    );
    assert.deepEqual(r[2]!.detail, { week: '2026-W44' });
    assert.equal(MILESTONES.length, 6);
  });
});

/* ───────────────────────── routes and the job (FakeDb) ───────────────────────── */

describe('retention routes and the weekly digest job', () => {
  let w: World;
  let hook: http.Server;
  let hookUrl = '';
  const received: unknown[] = [];

  before(async () => {
    w = await buildWorld();
    for (const u of w.fake.table('users')) u.digest_opt_out ??= false;
    w.fake.defaults.users = { ...w.fake.defaults.users, digest_opt_out: false };
    // Aggregate queries the generic fake engine cannot run: canned answers.
    w.fake.raw.unshift(
      { match: /with ev as \(/, rows: () => [COUNTS_ROW] },
      {
        match: /with first_ev as \(/,
        rows: () => [{ first_catch_at: new Date('2026-11-18T10:00:00Z') }],
      },
      {
        // The digest claim: unique per (project, week), like the real index.
        match: /^insert into "digest_runs"/,
        rows: (p, f) => {
          const t = f.table('digest_runs');
          if (t.some((r) => r.project_id === p[0] && r.week === p[1])) return [];
          const id = randomUUID();
          t.push({ id, project_id: p[0], week: p[1] });
          return [{ id }];
        },
      },
    );
    hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((ok) => hook.listen(0, '127.0.0.1', ok));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  });
  after(async () => {
    await w.close();
    await new Promise((ok) => hook.close(ok));
  });

  const req = (method: string, url: string, userId: string | null, payload?: unknown) =>
    w.app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(userId ? { cookie: w.cookie(userId) } : {}),
        origin: ORIGIN,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  it('GET coverage: explainable report for members, 404 for other tenants', async () => {
    const res = await req('GET', `/v1/projects/${w.a.project}/coverage`, w.a.owner);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.score, 0);
    assert.equal(body.max, 100);
    assert.equal(body.checks.length, CHECKS.length);
    assert.equal(body.recommendations[0].points, 15);
    const other = await req('GET', `/v1/projects/${w.a.project}/coverage`, w.b.owner);
    assert.equal(other.statusCode, 404);
  });

  it('allowlist review: owner only, stamped and audited', async () => {
    const viewer = addMember(w.fake, w.a.org, 'viewer');
    const denied = await req(
      'POST',
      `/v1/projects/${w.a.project}/coverage/allowlist-reviewed`,
      viewer,
      {},
    );
    assert.equal(denied.statusCode, 403);
    const ok = await req(
      'POST',
      `/v1/projects/${w.a.project}/coverage/allowlist-reviewed`,
      w.a.owner,
      {},
    );
    assert.equal(ok.statusCode, 200, ok.body);
    const check = ok.json().checks.find((c: { id: string }) => c.id === 'allowlist_reviewed');
    assert.equal(check.passed, true);
    assert.ok(w.fake.table('projects').find((p) => p.id === w.a.project)!.allowlist_reviewed_at);
    assert.ok(w.fake.table('audit_logs').some((a) => a.action === 'project.allowlist_reviewed'));
  });

  it('GET noise: the digest noise numbers for the last 7 days', async () => {
    const res = await req('GET', `/v1/projects/${w.a.project}/noise`, w.a.owner);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      { e: res.json().events, i: res.json().incidents, t: res.json().events_total },
      { e: 1204, i: 30, t: 1500 },
    );
  });

  it('GET milestones: records once with the timestamp from the data', async () => {
    const first = await req('GET', `/v1/projects/${w.a.project}/milestones`, w.a.owner);
    assert.equal(first.statusCode, 200, first.body);
    const rows = w.fake.table('project_milestones').filter((r) => r.project_id === w.a.project);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, 'first_catch');
    assert.equal(new Date(rows[0]!.reached_at as Date).toISOString(), '2026-11-18T10:00:00.000Z');
  });

  it('POST digest/preview: analysts and owners, not viewers', async () => {
    const viewer = addMember(w.fake, w.a.org, 'viewer');
    assert.equal(
      (await req('POST', `/v1/projects/${w.a.project}/digest/preview`, viewer, {})).statusCode,
      403,
    );
    const analyst = addMember(w.fake, w.a.org, 'analyst');
    const res = await req('POST', `/v1/projects/${w.a.project}/digest/preview`, analyst, {});
    assert.equal(res.statusCode, 200, res.body);
    const b = res.json();
    assert.match(b.subject, /LXS weekly digest for Project a: 37 attackers, 1 critical incident/);
    assert.match(b.text, /Noise you did not have to read: 1,204 events/);
    assert.match(b.html, /<!doctype html>/);
    assert.equal(b.digest.current.attackers.total, 37);
    // The preview never contains a live unsubscribe token.
    assert.ok(!b.text.includes('token='));
  });

  it('per-user opt-out: read, set, and the signed unsubscribe link', async () => {
    const uid = addMember(w.fake, w.a.org, 'analyst');
    assert.deepEqual((await req('GET', '/v1/me/digest', uid)).json(), { opt_out: false });
    assert.equal((await req('PATCH', '/v1/me/digest', uid, { opt_out: true })).statusCode, 200);
    assert.deepEqual((await req('GET', '/v1/me/digest', uid)).json(), { opt_out: true });
    await req('PATCH', '/v1/me/digest', uid, { opt_out: false });

    const bad = await req('POST', '/v1/digest/unsubscribe', null, { token: 'forged' });
    assert.equal(bad.statusCode, 422);
    const ok = await req('POST', '/v1/digest/unsubscribe', null, { token: unsubscribeToken(uid) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(w.fake.table('users').find((u) => u.id === uid)!.digest_opt_out, true);
  });

  it('channels: digest flag in create, view and PATCH (owner only)', async () => {
    const created = await req(
      'POST',
      `/v1/projects/${w.a.project}/notification-channels`,
      w.a.owner,
      {
        type: 'slack',
        name: '#digest',
        url: 'https://hooks.slack.com/services/T000/B000/xyz',
      },
    );
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().digest, false);
    const id = created.json().id;
    const analyst = addMember(w.fake, w.a.org, 'analyst');
    assert.equal(
      (
        await req('PATCH', `/v1/projects/${w.a.project}/notification-channels/${id}`, analyst, {
          digest: true,
        })
      ).statusCode,
      403,
    );
    const on = await req(
      'PATCH',
      `/v1/projects/${w.a.project}/notification-channels/${id}`,
      w.a.owner,
      { digest: true },
    );
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().digest, true);
    const empty = await req(
      'PATCH',
      `/v1/projects/${w.a.project}/notification-channels/${id}`,
      w.a.owner,
      {},
    );
    assert.equal(empty.statusCode, 422);
    const foreign = await req(
      'PATCH',
      `/v1/projects/${w.b.project}/notification-channels/${id}`,
      w.b.owner,
      { digest: true },
    );
    assert.equal(foreign.statusCode, 404);
  });

  it('the job emails opted-in owners/analysts, posts to digest channels, once per ISO week', async () => {
    const proj = { id: w.b.project, name: 'Project b', orgId: w.b.org };
    for (const u of w.fake.table('users')) u.digest_opt_out ??= false;
    addMember(w.fake, w.b.org, 'analyst', { email: 'analyst-b@example.test' });
    const optedOut = addMember(w.fake, w.b.org, 'analyst', { email: 'out-b@example.test' });
    w.fake.table('users').find((u) => u.id === optedOut)!.digest_opt_out = true;
    addMember(w.fake, w.b.org, 'viewer', { email: 'viewer-b@example.test' });
    addMember(w.fake, w.b.org, 'owner', { email: 'unverified-b@example.test', verified: false });
    for (const u of w.fake.table('users')) u.digest_opt_out ??= false;
    const ch = (name: string, digest: boolean, type = 'webhook') => ({
      id: randomUUID(),
      project_id: w.b.project,
      type,
      name,
      url_encrypted: encryptSecret(hookUrl),
      secret_encrypted: type === 'webhook' ? encryptSecret('whsec_test') : null,
      min_severity: 'high',
      labels: [],
      enabled: true,
      digest,
      created_at: new Date(),
    });
    w.fake
      .table('notification_channels')
      .push(ch('digest-on', true), ch('digest-off', false), ch('slack-on', true, 'slack'));

    const before = w.mail.sent.length;
    const now = new Date('2026-11-23T09:00:00Z');
    const out = await sendProjectDigest(proj, now, { error: () => {} });
    assert.equal(out.status, 'sent');
    assert.equal(out.week, '2026-W47');
    const mails = w.mail.sent.slice(before);
    assert.deepEqual(
      mails.map((m) => m.to).sort(),
      ['analyst-b@example.test', w.b.ownerEmail].sort(),
    );
    assert.ok(mails[0]!.html?.includes('Stop these emails'));
    const link = mails[0]!.text.match(/token=([\w.-]+)/)?.[1];
    assert.ok(
      link && verifyUnsubscribeToken(decodeURIComponent(link)),
      'a working unsubscribe link',
    );
    assert.equal(out.channelsSent, 2);
    assert.equal(out.channelsFailed, 0);
    const kinds = received.map((r) => (r as { type?: string; text?: string }).type ?? 'slack');
    assert.deepEqual(kinds.sort(), ['digest.weekly', 'slack']);
    assert.ok(
      w.fake.table('notification_deliveries').filter((d) => d.kind === 'digest').length === 2,
    );

    const again = await sendProjectDigest(proj, new Date('2026-11-24T09:00:00Z'), {
      error: () => {},
    });
    assert.equal(again.status, 'duplicate');
    assert.equal(w.mail.sent.length, before + 2);
    assert.equal(received.length, 2);
  });
});
