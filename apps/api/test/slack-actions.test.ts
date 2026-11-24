/**
 * Block from Slack: signature verification (v0, 5 min window, constant-time), the signed
 * actions route (no session), member mapping and role checks, and the cross-tenant rule:
 * a valid signature for project A can never act on project B.
 */
process.env.LOG_LEVEL = 'silent';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const { encryptSecret } = await import('../src/lib/channel-crypto.ts');
const { formatSlack, SLACK_ACTIONS, slackActionValue } = await import(
  '../src/lib/alert-delivery.ts'
);
const {
  isSlackResponseUrl,
  parseSlackAction,
  setSlackTransport,
  slackSignature,
  updatedMessage,
  verifySlackSignature,
} = await import('../src/modules/integrations-slack.ts');

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);

describe('verifySlackSignature', () => {
  const body = 'payload=%7B%7D';
  const ts = '1700000000';
  const sig = slackSignature(SECRET_A, ts, body);

  it('accepts the v0 signature inside the window', () => {
    assert.match(sig, /^v0=[0-9a-f]{64}$/);
    assert.ok(
      verifySlackSignature({
        secret: SECRET_A,
        body,
        timestamp: ts,
        signature: sig,
        nowSec: 1700000100,
      }),
    );
  });

  it('refuses stale timestamps, wrong secrets, tampered bodies and junk', () => {
    const base = { secret: SECRET_A, body, timestamp: ts, signature: sig, nowSec: 1700000000 };
    assert.ok(!verifySlackSignature({ ...base, nowSec: 1700000000 + 301 }));
    assert.ok(!verifySlackSignature({ ...base, nowSec: 1700000000 - 301 }));
    assert.ok(!verifySlackSignature({ ...base, secret: SECRET_B }));
    assert.ok(!verifySlackSignature({ ...base, body: `${body}x` }));
    assert.ok(!verifySlackSignature({ ...base, signature: undefined }));
    assert.ok(!verifySlackSignature({ ...base, signature: 'v1=abc' }));
    assert.ok(!verifySlackSignature({ ...base, timestamp: 'abc' }));
  });
});

describe('Slack payload helpers', () => {
  it('only posts back to hooks.slack.com over https', () => {
    assert.ok(isSlackResponseUrl('https://hooks.slack.com/actions/T1/1/abc'));
    assert.ok(!isSlackResponseUrl('http://hooks.slack.com/actions/x'));
    assert.ok(!isSlackResponseUrl('https://hooks.slack.com.evil.test/x'));
    assert.ok(!isSlackResponseUrl('https://169.254.169.254/'));
    assert.ok(!isSlackResponseUrl(null));
  });

  it('replaces the response buttons with a status line and the next action', () => {
    const m = updatedMessage(
      [{ type: 'header' }, { type: 'actions', block_id: 'lxs_response' }],
      'Blocked',
      { actionId: SLACK_ACTIONS.undo, label: 'Undo block', value: '{}' },
    ) as { blocks: { type: string; block_id?: string }[]; replace_original: boolean };
    assert.equal(m.replace_original, true);
    assert.deepEqual(
      m.blocks.map((b) => b.block_id ?? b.type),
      ['header', 'lxs_response_status', 'lxs_response'],
    );
  });

  it('rejects payloads that are not ours', () => {
    assert.equal(parseSlackAction('payload=not-json'), null);
    assert.equal(
      parseSlackAction(`payload=${encodeURIComponent('{"type":"view_submission"}')}`),
      null,
    );
  });
});

describe('formatSlack interactive buttons', () => {
  const i = {
    id: '0b4a7f2e-0000-4000-8000-000000000001',
    number: 42,
    title: 'x',
    severity: 'critical',
    score: 91,
    label: 'targeted',
    srcIp: '203.0.113.9',
    stages: [],
    techniques: [],
    realAssetReached: false,
    honeytokenUsed: false,
  };
  const pid = '0b4a7f2e-0000-4000-8000-0000000000aa';
  it('adds Block 24h / Ignore only on Critical with a Slack app configured', () => {
    const plain = JSON.stringify(formatSlack(i, 'https://x'));
    assert.ok(!plain.includes(SLACK_ACTIONS.block));
    const withApp = JSON.stringify(formatSlack(i, 'https://x', { projectId: pid }));
    assert.ok(withApp.includes(SLACK_ACTIONS.block));
    assert.ok(withApp.includes(SLACK_ACTIONS.ignore));
    assert.ok(withApp.includes(JSON.stringify(slackActionValue(pid, i.id)).slice(1, -1)));
    const high = JSON.stringify(
      formatSlack({ ...i, severity: 'high' }, 'https://x', { projectId: pid }),
    );
    assert.ok(!high.includes(SLACK_ACTIONS.block));
  });
});

/* ───────── the route, over the FakeDb ───────── */

describe('POST /v1/integrations/slack/actions', () => {
  let w: Awaited<ReturnType<typeof buildWorld>>;
  const responses: { url: string; body: Record<string, unknown> }[] = [];
  const emails = new Map<string, string>();
  let prev: ReturnType<typeof setSlackTransport>;
  let analystA = '';
  let viewerA = '';

  before(async () => {
    w = await buildWorld();
    prev = setSlackTransport({
      userEmail: async (_t, uid) => emails.get(uid) ?? null,
      respond: async (url, body) => {
        responses.push({ url, body });
      },
    });
    for (const [t, ip] of [
      [w.a, '45.155.205.10'],
      [w.b, '45.155.205.20'],
    ] as const) {
      w.fake.table('attackers').find((r) => r.id === t.attacker)!.ip = ip;
      Object.assign(w.fake.table('incidents').find((r) => r.id === t.incident)!, {
        number: 9,
        severity: 'critical',
        label: 'targeted',
      });
    }
    w.fake.table('slack_integrations').push(
      {
        project_id: w.a.project,
        signing_secret_encrypted: encryptSecret(SECRET_A),
        bot_token_encrypted: null,
        team_id: 'TAAAA',
      },
      {
        project_id: w.b.project,
        signing_secret_encrypted: encryptSecret(SECRET_B),
        bot_token_encrypted: null,
        team_id: null,
      },
    );
    analystA = addMember(w.fake, w.a.org, 'analyst');
    viewerA = addMember(w.fake, w.a.org, 'viewer');
    w.fake
      .table('slack_user_links')
      .push(
        { project_id: w.a.project, slack_user_id: 'UANALYST', user_id: analystA },
        { project_id: w.a.project, slack_user_id: 'UVIEWER', user_id: viewerA },
      );
  });
  after(async () => {
    setSlackTransport(prev);
    await w.close();
  });
  beforeEach(() => {
    responses.length = 0;
  });

  const payload = (o: {
    action?: string;
    project: string;
    incident: string;
    block?: string;
    user?: string;
    team?: string;
  }) =>
    `payload=${encodeURIComponent(
      JSON.stringify({
        type: 'block_actions',
        user: { id: o.user ?? 'UANALYST', username: 'sam' },
        team: { id: o.team ?? 'TAAAA' },
        response_url: 'https://hooks.slack.com/actions/TAAAA/1/xyz',
        message: { blocks: [{ type: 'header' }, { type: 'actions', block_id: 'lxs_response' }] },
        actions: [
          {
            action_id: o.action ?? SLACK_ACTIONS.block,
            value: slackActionValue(o.project, o.incident, o.block),
          },
        ],
      }),
    )}`;

  const post = (body: string, secret: string, ts = String(now())) =>
    w.app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/actions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': slackSignature(secret, ts, body),
      },
      payload: body,
    });

  const blocksFor = (pid: string) =>
    w.fake.table('blocklist_entries').filter((b) => b.project_id === pid && b.source === 'slack');

  it('a linked analyst blocks for 24 h; audited with the Slack user; message updated with Undo', async () => {
    const res = await post(payload({ project: w.a.project, incident: w.a.incident }), SECRET_A);
    assert.equal(res.statusCode, 200, res.body);
    const [entry] = blocksFor(w.a.project);
    assert.ok(entry, 'blocklist row with source slack');
    assert.equal(entry.ip, '45.155.205.10');
    assert.equal(entry.created_by, analystA);
    const log = w.fake
      .table('audit_logs')
      .find((r) => r.action === 'response.block_ip' && r.target_id === entry.id);
    const meta = typeof log?.metadata === 'string' ? JSON.parse(log.metadata) : log?.metadata;
    assert.equal(log?.actor_id, analystA);
    assert.equal(meta.slack_user_id, 'UANALYST');
    assert.equal(meta.source, 'slack');
    assert.equal(responses.length, 1);
    assert.ok(JSON.stringify(responses[0]!.body).includes(SLACK_ACTIONS.undo));
  });

  it('Undo from the message unblocks through the same path', async () => {
    const [entry] = blocksFor(w.a.project);
    const res = await post(
      payload({
        action: SLACK_ACTIONS.undo,
        project: w.a.project,
        incident: w.a.incident,
        block: entry!.id as string,
      }),
      SECRET_A,
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(entry!.removed_at, 'removed');
    assert.ok(w.fake.table('audit_logs').some((r) => r.action === 'response.unblock_ip'));
  });

  it('a valid signature for project A cannot act on project B', async () => {
    const before = blocksFor(w.b.project).length;
    // Signed with A's secret but naming B's project and incident: checked with B's secret.
    const res = await post(payload({ project: w.b.project, incident: w.b.incident }), SECRET_A);
    assert.equal(res.statusCode, 401);
    // Naming A's project but B's incident: the incident lookup is scoped to A.
    const res2 = await post(payload({ project: w.a.project, incident: w.b.incident }), SECRET_A);
    assert.equal(res2.statusCode, 200);
    assert.equal(blocksFor(w.b.project).length, before);
    assert.ok(
      !w.fake.table('blocklist_entries').some((b) => b.ip === '45.155.205.20' && !b.removed_at),
    );
    assert.match(String(responses.at(-1)?.body.text), /no longer exists/);
  });

  it('refuses bad signatures, stale timestamps, JSON bodies and the wrong workspace', async () => {
    const body = payload({ project: w.a.project, incident: w.a.incident });
    assert.equal((await post(body, SECRET_B)).statusCode, 401);
    assert.equal((await post(body, SECRET_A, String(now() - 600))).statusCode, 401);
    const json = await w.app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/actions',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(json.statusCode, 401);
    const other = payload({ project: w.a.project, incident: w.a.incident, team: 'TOTHER' });
    assert.equal((await post(other, SECRET_A)).statusCode, 401);
  });

  it('viewers and unlinked Slack users cannot block', async () => {
    const before = blocksFor(w.a.project).filter((b) => !b.removed_at).length;
    for (const user of ['UVIEWER', 'UNOBODY']) {
      const res = await post(
        payload({ project: w.a.project, incident: w.a.incident, user }),
        SECRET_A,
      );
      assert.equal(res.statusCode, 200);
    }
    assert.equal(blocksFor(w.a.project).filter((b) => !b.removed_at).length, before);
    assert.match(String(responses[0]!.body.text), /analyst role/);
    assert.match(String(responses[1]!.body.text), /not linked/);
    assert.equal(
      w.fake.table('audit_logs').filter((r) => r.action === 'response.slack.denied').length,
      2,
    );
  });

  it('with a bot token the Slack user is matched by email', async () => {
    const row = w.fake.table('slack_integrations').find((r) => r.project_id === w.a.project)!;
    row.bot_token_encrypted = encryptSecret('xoxb-test-token-123456');
    emails.set('UOWNER', w.a.ownerEmail);
    const res = await post(
      payload({
        action: SLACK_ACTIONS.ignore,
        project: w.a.project,
        incident: w.a.incident,
        user: 'UOWNER',
      }),
      SECRET_A,
    );
    assert.equal(res.statusCode, 200);
    const log = w.fake.table('audit_logs').find((r) => r.action === 'response.slack.ignore');
    assert.equal(log?.actor_id, w.a.owner);
    assert.match(String(responses[0]!.body.text), /Ignored by <@UOWNER>/);
    row.bot_token_encrypted = null;
  });

  it('config: owners store the app secrets encrypted and never read them back', async () => {
    const url = `/v1/projects/${w.b.project}/integrations/slack`;
    const headers = {
      cookie: w.cookie(w.b.owner),
      origin: ORIGIN,
      'content-type': 'application/json',
    };
    const put = await w.app.inject({
      method: 'PUT',
      url,
      headers,
      payload: JSON.stringify({ signing_secret: 'c'.repeat(32), bot_token: 'xoxb-abc-1234567890' }),
    });
    assert.equal(put.statusCode, 200, put.body);
    const row = w.fake.table('slack_integrations').find((r) => r.project_id === w.b.project)!;
    assert.ok(!String(row.signing_secret_encrypted).includes('cccc'));
    const got = await w.app.inject({
      method: 'GET',
      url,
      headers: { cookie: w.cookie(w.b.owner) },
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().configured, true);
    assert.ok(!got.body.includes('cccc') && !got.body.includes('xoxb'));
    assert.match(got.json().request_url, /\/v1\/integrations\/slack\/actions$/);
    const links = await w.app.inject({
      method: 'PUT',
      url: `${url}/user-links`,
      headers,
      payload: JSON.stringify({ links: [{ slack_user_id: 'U123', user_id: w.a.owner }] }),
    });
    assert.equal(links.statusCode, 422, 'a user from another org cannot be linked');
  });
});
