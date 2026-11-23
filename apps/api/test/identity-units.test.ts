/**
 * Identity building blocks (G4/H1) that need no app: tokens, mailer transports,
 * captcha verification, the role matrix, caps and the kill-switch CLI arguments.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/db/org-kill-switch.ts';
import { verifyCaptcha } from '../src/lib/captcha.ts';
import { HttpError } from '../src/lib/errors.ts';
import {
  appLink,
  ConsoleMailer,
  createMailer,
  inviteMessage,
  ResendMailer,
  resetPasswordMessage,
  verifyEmailMessage,
} from '../src/lib/mailer.ts';
import { mintToken, parseToken, secretMatches } from '../src/lib/tokens.ts';
import { inviteStatus } from '../src/modules/members.ts';
import { assertUnderCap } from '../src/modules/projects.ts';
import { effectiveMinRole, requireVerified, roleAtLeast } from '../src/plugins/auth-session.ts';

describe('emailed tokens', () => {
  it('round-trips and stores only a hash of the secret', () => {
    const t = mintToken();
    const p = parseToken(t.token);
    assert.ok(p);
    assert.equal(p.id, t.id);
    assert.equal(t.hash.length, 32);
    assert.ok(!t.token.includes(t.hash.toString('hex')));
    assert.equal(secretMatches(p.secret, t.hash), true);
  });

  it('rejects a wrong secret, a malformed token and a missing hash', () => {
    const a = mintToken();
    const b = mintToken();
    assert.equal(secretMatches(parseToken(b.token)!.secret, a.hash), false);
    assert.equal(secretMatches(parseToken(a.token)!.secret, null), false);
    for (const bad of [
      '',
      'x',
      `${a.id}`,
      `${a.id}.short`,
      `not-a-uuid.${'a'.repeat(43)}`,
      42,
      null,
    ])
      assert.equal(parseToken(bad), null, String(bad));
  });

  it('mints distinct tokens', () => {
    assert.notEqual(mintToken().token, mintToken().token);
  });
});

describe('mailer', () => {
  it('console transport writes the whole message, link included', async () => {
    const lines: string[] = [];
    const m = new ConsoleMailer('LXS <no-reply@lxs.dev>', (l) => lines.push(l));
    await m.send(verifyEmailMessage('a@b.co', 'http://app/verify-email?token=abc'));
    assert.match(lines.join('\n'), /To: {6}a@b\.co/);
    assert.match(lines.join('\n'), /http:\/\/app\/verify-email\?token=abc/);
  });

  it('resend transport posts to the Resend API with the key', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const m = new ResendMailer('re_test', 'LXS <x@y.z>', async (url, init) => {
      seen = { url, init };
      return new Response('{"id":"1"}', { status: 200 });
    });
    await m.send(resetPasswordMessage('a@b.co', 'http://app/reset-password?token=t'));
    assert.ok(seen);
    const s = seen as { url: string; init: RequestInit };
    assert.equal(s.url, 'https://api.resend.com/emails');
    assert.equal((s.init.headers as Record<string, string>).Authorization, 'Bearer re_test');
    const body = JSON.parse(String(s.init.body));
    assert.deepEqual(body.to, ['a@b.co']);
    assert.match(body.text, /reset-password\?token=t/);
  });

  it('resend transport surfaces a refusal', async () => {
    const m = new ResendMailer('k', 'f', async () => new Response('nope', { status: 422 }));
    await assert.rejects(m.send(verifyEmailMessage('a@b.co', 'l')), /HTTP 422/);
  });

  it('createMailer picks the transport and refuses smtp until implemented', () => {
    assert.equal(createMailer({ MAIL_TRANSPORT: 'console', MAIL_FROM: 'f' }).transport, 'console');
    assert.equal(
      createMailer({ MAIL_TRANSPORT: 'resend', MAIL_FROM: 'f', RESEND_API_KEY: 'k' }).transport,
      'resend',
    );
    assert.throws(
      () => createMailer({ MAIL_TRANSPORT: 'resend', MAIL_FROM: 'f' }),
      /RESEND_API_KEY/,
    );
    assert.throws(
      () => createMailer({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'f' }),
      /not implemented/,
    );
  });

  it('builds absolute app links with encoded query values', () => {
    assert.equal(
      appLink('/reset-password', { token: 'a.b+c' }, 'https://app.lxs.dev'),
      'https://app.lxs.dev/reset-password?token=a.b%2Bc',
    );
    assert.match(
      inviteMessage('a@b.co', 'l', { orgName: 'Acme', inviter: 'Sam', role: 'analyst' }).text,
      /as an analyst/,
    );
  });
});

describe('captcha', () => {
  const on = { provider: 'turnstile' as const, secret: 's' };
  it('is a no-op when the provider is none', async () => {
    await verifyCaptcha(undefined, '1.2.3.4', { provider: 'none' });
  });
  it('accepts a token the verifier confirms', async () => {
    let body = '';
    await verifyCaptcha('tok', '1.2.3.4', on, async (_u, init) => {
      body = String(init.body);
      return new Response('{"success":true}');
    });
    assert.match(body, /secret=s/);
    assert.match(body, /response=tok/);
  });
  it('fails closed on a missing token, a rejection or an unreachable verifier', async () => {
    const isCaptcha = (e: unknown) => e instanceof HttpError && e.code === 'E_CAPTCHA';
    await assert.rejects(verifyCaptcha(undefined, undefined, on), isCaptcha);
    await assert.rejects(
      verifyCaptcha('t', undefined, on, async () => new Response('{"success":false}')),
      isCaptcha,
    );
    await assert.rejects(
      verifyCaptcha('t', undefined, on, async () => {
        throw new Error('down');
      }),
      isCaptcha,
    );
  });
});

describe('role matrix', () => {
  it('ranks owner > analyst > viewer', () => {
    assert.ok(roleAtLeast('owner', 'analyst'));
    assert.ok(roleAtLeast('analyst', 'viewer'));
    assert.ok(!roleAtLeast('viewer', 'analyst'));
    assert.ok(!roleAtLeast('analyst', 'owner'));
  });
  it('never lets a viewer write, even where a route forgot its minimum', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE'])
      assert.equal(effectiveMinRole(m, 'viewer'), 'analyst');
    for (const m of ['GET', 'HEAD', 'OPTIONS'])
      assert.equal(effectiveMinRole(m, 'viewer'), 'viewer');
    assert.equal(effectiveMinRole('POST', 'owner'), 'owner');
  });
  it('requireVerified throws E_EMAIL_UNVERIFIED for unverified users', () => {
    const u = { id: '1', email: 'a@b.co', username: 'a', name: '', emailVerified: false };
    assert.throws(
      () => requireVerified(u),
      (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === 'E_EMAIL_UNVERIFIED',
    );
    requireVerified({ ...u, emailVerified: true });
  });
});

describe('abuse caps', () => {
  it('allows under the cap and refuses at it with E_LIMIT_REACHED', () => {
    assertUnderCap('keys', 9, 10);
    assert.throws(
      () => assertUnderCap('keys', 10, 10),
      (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === 'E_LIMIT_REACHED',
    );
    assert.throws(() => assertUnderCap('projects', 5, 5), /limit of 5 projects/);
  });
});

describe('invite status', () => {
  const base = {
    id: 'i',
    orgId: 'o',
    email: 'a@b.co',
    role: 'viewer',
    tokenHash: Buffer.alloc(32),
    invitedBy: null,
    acceptedBy: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    revokedAt: null,
  };
  it('reports pending, accepted, revoked and expired', () => {
    assert.equal(inviteStatus(base), 'pending');
    assert.equal(inviteStatus({ ...base, acceptedAt: new Date() }), 'accepted');
    assert.equal(inviteStatus({ ...base, revokedAt: new Date() }), 'revoked');
    assert.equal(inviteStatus({ ...base, expiresAt: new Date(Date.now() - 1) }), 'expired');
  });
});

describe('org kill switch CLI', () => {
  it('parses list, disable with a reason, and enable', () => {
    assert.deepEqual(parseArgs(['list']), { cmd: 'list' });
    assert.deepEqual(parseArgs(['disable', 'acme', 'spam', 'signups']), {
      cmd: 'disable',
      org: 'acme',
      reason: 'spam signups',
    });
    assert.deepEqual(parseArgs(['enable', 'acme']), { cmd: 'enable', org: 'acme' });
    assert.ok('error' in parseArgs(['disable']));
    assert.ok('error' in parseArgs([]));
  });
});
