/**
 * Identity and tenancy flows through the real app, DB-free (FakeDb): email
 * verification, password reset, the role matrix, members and invites, per-org caps,
 * the signup rate limit and the admin org kill switch.
 */
process.env.LOG_LEVEL = 'silent';
process.env.SIGNUP_RATE_PER_HOUR = '6';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const { buildWorld, addMember, ORIGIN } = await import('./helpers/tenants.ts');
const { env } = await import('../src/env.ts');
const { hashPassword } = await import('../src/lib/crypto.ts');
type World = Awaited<ReturnType<typeof buildWorld>>;

const tick = () => new Promise((r) => setTimeout(r, 20));
const tokenIn = (text: string, path: string) =>
  decodeURIComponent(text.match(new RegExp(`${path}[?/](?:token=)?([^\\s&]+)`))?.[1] ?? '');

describe('identity routes', () => {
  let w: World;
  before(async () => {
    w = await buildWorld();
  });
  after(async () => {
    await w.close();
  });

  const call = (
    method: string,
    url: string,
    opts: { user?: string; body?: unknown; auth?: string } = {},
  ) =>
    w.app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(opts.user ? { cookie: w.cookie(opts.user) } : {}),
        ...(opts.auth ? { authorization: opts.auth } : {}),
        origin: ORIGIN,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { payload: JSON.stringify(opts.body ?? {}) }),
    });
  const code = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

  describe('email verification', () => {
    it('signup sends a single-use verify link; unverified users cannot create keys or invite', async () => {
      const res = await call('POST', '/v1/auth/signup', {
        body: { email: 'New.User@Example.test', password: 'longenough', name: 'New' },
      });
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json();
      assert.equal(body.user.email_verified, false);
      await tick();
      const mail = w.mail.sent.find((m) => m.to === 'new.user@example.test');
      assert.ok(mail, 'verification mail sent');
      const token = tokenIn(mail.text, '/verify-email');
      assert.ok(token);
      // Only the hash is at rest.
      const stored = w.fake.table('auth_tokens').find((t) => t.email === 'new.user@example.test');
      assert.ok(stored && !JSON.stringify(stored).includes(token.split('.')[1]!));

      const uid = body.user.id as string;
      const key = await call('POST', `/v1/projects/${body.project.id}/keys`, {
        user: uid,
        body: { name: 'k' },
      });
      assert.equal(key.statusCode, 403);
      assert.equal(code(key), 'E_EMAIL_UNVERIFIED');
      const org = body.orgs[0].id as string;
      const inv = await call('POST', `/v1/orgs/${org}/invites`, {
        user: uid,
        body: { email: 'x@example.test' },
      });
      assert.equal(code(inv), 'E_EMAIL_UNVERIFIED');

      const ok = await call('POST', '/v1/auth/verify-email', { body: { token } });
      assert.equal(ok.statusCode, 200, ok.body);
      const me = await call('GET', '/v1/me', { user: uid });
      assert.equal(me.json().user.email_verified, true);
      const again = await call('POST', '/v1/auth/verify-email', { body: { token } });
      assert.equal(code(again), 'E_TOKEN_INVALID');
      const key2 = await call('POST', `/v1/projects/${body.project.id}/keys`, {
        user: uid,
        body: { name: 'k' },
      });
      assert.equal(key2.statusCode, 201, key2.body);
    });

    it('rejects forged and expired verify tokens', async () => {
      const forged = await call('POST', '/v1/auth/verify-email', {
        body: { token: `${w.a.invite}.${'y'.repeat(43)}` },
      });
      assert.equal(code(forged), 'E_TOKEN_INVALID');
      const uid = addMember(w.fake, w.a.org, 'viewer', { verified: false });
      const sent = await call('POST', '/v1/auth/verify-email/resend', { user: uid });
      assert.equal(sent.json().sent, true);
      const row = w.fake.table('auth_tokens').find((t) => t.user_id === uid)!;
      row.expires_at = new Date(Date.now() - 1000);
      await tick();
      const token = tokenIn(w.mail.sent.at(-1)!.text, '/verify-email');
      const expired = await call('POST', '/v1/auth/verify-email', { body: { token } });
      assert.equal(code(expired), 'E_TOKEN_INVALID');
      // Inside the one-minute cooldown a second mail is refused.
      const cooldown = await call('POST', '/v1/auth/verify-email/resend', { user: uid });
      assert.equal(cooldown.statusCode, 429);
    });
  });

  describe('password reset', () => {
    it('answers the same for unknown and known addresses', async () => {
      const before = w.mail.sent.length;
      const unknown = await call('POST', '/v1/auth/password/forgot', {
        body: { email: 'nobody@example.test' },
      });
      const known = await call('POST', '/v1/auth/password/forgot', {
        body: { email: w.b.ownerEmail },
      });
      assert.equal(unknown.statusCode, 200);
      assert.equal(known.statusCode, 200);
      assert.equal(unknown.body, known.body);
      await tick();
      const mails = w.mail.sent.slice(before);
      assert.equal(mails.length, 1);
      assert.equal(mails[0]!.to, w.b.ownerEmail);
    });

    it('resets once, logs out other sessions, and allows login with the new password', async () => {
      const oldCookie = w.cookie(w.b.owner);
      const token = tokenIn(w.mail.sent.at(-1)!.text, '/reset-password');
      const res = await call('POST', '/v1/auth/password/reset', {
        body: { token, password: 'brand-new-pass' },
      });
      assert.equal(res.statusCode, 200, res.body);
      const stale = await w.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { cookie: oldCookie },
      });
      assert.equal(stale.statusCode, 401);
      const reuse = await call('POST', '/v1/auth/password/reset', {
        body: { token, password: 'another-pass' },
      });
      assert.equal(code(reuse), 'E_TOKEN_INVALID');
      const login = await call('POST', '/v1/auth/login', {
        body: { identifier: w.b.ownerEmail, password: 'brand-new-pass' },
      });
      assert.equal(login.statusCode, 200, login.body);
    });
  });

  describe('role matrix', () => {
    it('viewer reads but cannot act on incidents or settings', async () => {
      const v = addMember(w.fake, w.a.org, 'viewer');
      assert.equal((await call('GET', `/v1/projects/${w.a.project}`, { user: v })).statusCode, 200);
      for (const [m, u] of [
        ['PATCH', `/v1/incidents/${w.a.incident}`],
        ['POST', `/v1/incidents/${w.a.incident}/notes`],
        ['POST', `/v1/incidents/${w.a.incident}/actions`],
        ['POST', `/v1/projects/${w.a.project}/blocklist`],
        ['POST', `/v1/projects/${w.a.project}/keys`],
        ['PATCH', `/v1/projects/${w.a.project}`],
        ['POST', `/v1/orgs/${w.a.org}/invites`],
      ] as const) {
        const res = await call(m, u, { user: v, body: { name: 'x', email: 'q@example.test' } });
        assert.equal(res.statusCode, 403, `${m} ${u}: ${res.body}`);
        assert.equal(code(res), 'insufficient_role');
      }
    });

    it('analyst works incidents but cannot touch keys, settings, members or channels', async () => {
      const an = addMember(w.fake, w.a.org, 'analyst');
      for (const [m, u] of [
        ['PATCH', `/v1/incidents/${w.a.incident}`],
        ['POST', `/v1/incidents/${w.a.incident}/notes`],
        ['POST', `/v1/projects/${w.a.project}/blocklist`],
      ] as const) {
        const res = await call(m, u, { user: an });
        assert.notEqual(code(res), 'insufficient_role', `${m} ${u} should pass the role gate`);
      }
      for (const [m, u] of [
        ['GET', `/v1/projects/${w.a.project}/keys`],
        ['POST', `/v1/projects/${w.a.project}/keys`],
        ['PATCH', `/v1/projects/${w.a.project}`],
        ['GET', `/v1/projects/${w.a.project}/notification-channels`],
        ['POST', `/v1/projects/${w.a.project}/notification-channels`],
        ['POST', `/v1/orgs/${w.a.org}/invites`],
        ['PATCH', `/v1/orgs/${w.a.org}/members/${w.a.owner}`],
      ] as const) {
        const res = await call(m, u, { user: an, body: { role: 'viewer' } });
        assert.equal(code(res), 'insufficient_role', `${m} ${u}: ${res.body}`);
      }
    });
  });

  describe('members', () => {
    it('invite, then signup-then-accept joins the org with the invited role', async () => {
      const inv = await call('POST', `/v1/orgs/${w.a.org}/invites`, {
        user: w.a.owner,
        body: { email: 'Joiner@Example.test', role: 'analyst' },
      });
      assert.equal(inv.statusCode, 201, inv.body);
      assert.ok(!inv.body.includes('token'), 'the API never returns the invite token');
      await tick();
      const mail = w.mail.sent.find((m) => m.to === 'joiner@example.test')!;
      const token = tokenIn(mail.text, '/invite');
      const preview = await call('POST', '/v1/invites/preview', { body: { token } });
      assert.equal(preview.json().role, 'analyst');
      const wrong = await call('POST', '/v1/auth/signup', {
        body: { email: 'other@example.test', password: 'longenough', invite_token: token },
      });
      assert.equal(code(wrong), 'E_INVITE_EMAIL_MISMATCH');
      const res = await call('POST', '/v1/auth/signup', {
        body: { email: 'joiner@example.test', password: 'longenough', invite_token: token },
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().user.email_verified, true);
      const uid = res.json().user.id;
      const m = w.fake.table('memberships').find((x) => x.user_id === uid);
      assert.equal(m?.org_id, w.a.org);
      assert.equal(m?.role, 'analyst');
      assert.ok(w.fake.table('audit_logs').some((a) => a.action === 'member.join'));
      const reuse = await call('POST', '/v1/invites/accept', { user: uid, body: { token } });
      assert.equal(code(reuse), 'E_INVITE_INVALID');
    });

    it('logged-in accept requires the matching email', async () => {
      const inv = await call('POST', `/v1/orgs/${w.a.org}/invites`, {
        user: w.a.owner,
        body: { email: 'existing@example.test', role: 'viewer' },
      });
      assert.equal(inv.statusCode, 201);
      await tick();
      const token = tokenIn(
        w.mail.sent.find((m) => m.to === 'existing@example.test')!.text,
        '/invite',
      );
      const stranger = addMember(w.fake, w.b.org, 'owner');
      const no = await call('POST', '/v1/invites/accept', { user: stranger, body: { token } });
      assert.equal(code(no), 'E_INVITE_EMAIL_MISMATCH');
      const me = addMember(w.fake, w.b.org, 'viewer', { email: 'existing@example.test' });
      const yes = await call('POST', '/v1/invites/accept', { user: me, body: { token } });
      assert.equal(yes.statusCode, 200, yes.body);
      assert.equal(yes.json().role, 'viewer');
    });

    it('never removes or demotes the last owner, and audits role changes', async () => {
      // A fresh single-owner org, so earlier tests' extra owners don't interfere.
      const orgC = crypto.randomUUID();
      w.fake.table('organizations').push({
        id: orgC,
        name: 'C',
        slug: 'c',
        created_at: new Date(),
        disabled_at: null,
      });
      const owner = addMember(w.fake, orgC, 'owner');
      const last1 = await call('PATCH', `/v1/orgs/${orgC}/members/${owner}`, {
        user: owner,
        body: { role: 'analyst' },
      });
      assert.equal(last1.statusCode, 409);
      assert.equal(code(last1), 'E_LAST_OWNER');
      const last2 = await call('DELETE', `/v1/orgs/${orgC}/members/${owner}`, { user: owner });
      assert.equal(code(last2), 'E_LAST_OWNER');
      const second = addMember(w.fake, orgC, 'viewer');
      const promote = await call('PATCH', `/v1/orgs/${orgC}/members/${second}`, {
        user: owner,
        body: { role: 'owner' },
      });
      assert.equal(promote.statusCode, 200, promote.body);
      const demoteOk = await call('PATCH', `/v1/orgs/${orgC}/members/${owner}`, {
        user: owner,
        body: { role: 'analyst' },
      });
      assert.equal(demoteOk.statusCode, 200, demoteOk.body);
      assert.ok(
        w.fake
          .table('audit_logs')
          .some((a) => a.action === 'member.role_change' && a.org_id === orgC),
      );
      const remove = await call('DELETE', `/v1/orgs/${orgC}/members/${owner}`, { user: second });
      assert.equal(remove.statusCode, 204);
      assert.ok(w.fake.table('audit_logs').some((a) => a.action === 'member.remove'));
    });
  });

  describe('abuse limits', () => {
    it('caps active keys and projects per org', async () => {
      const prevKeys = env.MAX_KEYS_PER_ORG;
      const prevProjects = env.MAX_PROJECTS_PER_ORG;
      env.MAX_KEYS_PER_ORG = 1; // tenant A already holds one active key
      env.MAX_PROJECTS_PER_ORG = 1;
      try {
        const key = await call('POST', `/v1/projects/${w.a.project}/keys`, {
          user: w.a.owner,
          body: { name: 'one-too-many' },
        });
        assert.equal(key.statusCode, 403, key.body);
        assert.equal(code(key), 'E_LIMIT_REACHED');
        const proj = await call('POST', '/v1/projects', {
          user: w.a.owner,
          body: { name: 'Second', org_id: w.a.org },
        });
        assert.equal(code(proj), 'E_LIMIT_REACHED');
      } finally {
        env.MAX_KEYS_PER_ORG = prevKeys;
        env.MAX_PROJECTS_PER_ORG = prevProjects;
      }
    });

    it('rate-limits signup per client', async () => {
      let limited = false;
      for (let i = 0; i < 8 && !limited; i++) {
        const res = await call('POST', '/v1/auth/signup', { body: {} });
        limited = res.statusCode === 429;
      }
      assert.ok(limited, 'signup is rate limited');
    });

    it('the org kill switch blocks ingest, login and project access', async () => {
      const org = w.fake.table('organizations').find((o) => o.id === w.a.org)!;
      const user = w.fake.table('users').find((u) => u.id === w.a.owner)!;
      user.password_hash = await hashPassword('owner-a-pass');
      org.disabled_at = new Date();
      try {
        const ingest = await call('POST', '/v1/ingest', {
          auth: `Bearer ${w.a.ingestKey}`,
          body: { events: [] },
        });
        assert.equal(ingest.statusCode, 403, ingest.body);
        assert.equal(code(ingest), 'E_ORG_DISABLED');
        const login = await call('POST', '/v1/auth/login', {
          body: { identifier: w.a.ownerEmail, password: 'owner-a-pass' },
        });
        assert.equal(login.statusCode, 403);
        assert.equal(code(login), 'E_ORG_DISABLED');
        const proj = await call('GET', `/v1/projects/${w.a.project}`, { user: w.a.owner });
        assert.equal(code(proj), 'E_ORG_DISABLED');
        const list = await call('GET', '/v1/projects', { user: w.a.owner });
        assert.ok(!list.body.includes(w.a.project));
      } finally {
        org.disabled_at = null;
      }
    });
  });
});
