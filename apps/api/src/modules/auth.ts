import { randomBytes } from 'node:crypto';
import { and, asc, sql as dsql, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type DbOrTx, db } from '../db/client.js';
import { authTokens, memberships, organizations, projects, users } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { captchaPublicConfig, verifyCaptcha } from '../lib/captcha.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { conflict, HttpError } from '../lib/errors.js';
import {
  appLink,
  mailer,
  resetPasswordMessage,
  sendInBackground,
  verifyEmailMessage,
} from '../lib/mailer.js';
import { parse } from '../lib/parse.js';
import {
  mintToken,
  parseToken,
  RESET_TTL_MS,
  secretMatches,
  VERIFY_TTL_MS,
} from '../lib/tokens.js';
import {
  clearSession,
  E_ORG_DISABLED,
  issueSession,
  requireSession,
  type SessionUser,
  userOrgs,
} from '../plugins/auth-session.js';
import { acceptInviteTx, findInvite, inviteInvalid, inviteStatus } from './members.js';

const Login = z
  .object({
    identifier: z.string().trim().min(1).max(256).optional(),
    email: z.string().trim().max(256).optional(),
    password: z.string().min(1).max(256),
  })
  .refine((v) => !!(v.identifier || v.email), 'Email or username is required');
const Username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/);
const Password = z.string().min(8).max(256);
const Signup = z.object({
  email: z.string().email().max(256),
  username: Username.optional(),
  password: Password,
  name: z.string().max(128).default(''),
  org_name: z.string().min(1).max(128).optional(),
  project_name: z.string().min(1).max(128).default('My First Project'),
  invite_token: z.string().max(256).optional(),
  captcha_token: z.string().max(2048).optional(),
});
const TokenBody = z.object({ token: z.string().min(1).max(256) });
const ForgotBody = z.object({
  email: z.string().trim().max(256),
  captcha_token: z.string().max(2048).optional(),
});
const ResetBody = z.object({ token: z.string().min(1).max(256), password: Password });

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org';

export type TokenPurpose = 'verify_email' | 'reset_password';

export const E_TOKEN_INVALID = 'E_TOKEN_INVALID';
const tokenInvalid = () =>
  new HttpError(
    400,
    E_TOKEN_INVALID,
    'This link is invalid, expired or already used. Request a new one.',
  );

/** Minimum gap between two emails of the same kind to one account. */
const MAIL_COOLDOWN_MS = 60_000;

const userJson = (u: {
  id: string;
  email: string;
  username: string;
  name: string;
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
}) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  name: u.name,
  email_verified: u.emailVerified ?? u.emailVerifiedAt != null,
});

/**
 * Issue a fresh single-use token for `purpose`, retiring any earlier unused one so
 * only the newest link works. Returns null (send nothing) inside the cooldown.
 */
export async function issueAuthToken(
  dbx: DbOrTx,
  user: { id: string; email: string },
  purpose: TokenPurpose,
): Promise<string | null> {
  const [recent] = await dbx
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, user.id),
        eq(authTokens.purpose, purpose),
        gt(authTokens.createdAt, new Date(Date.now() - MAIL_COOLDOWN_MS)),
      ),
    )
    .limit(1);
  if (recent) return null;
  await dbx
    .update(authTokens)
    .set({ usedAt: dsql`now()` })
    .where(
      and(
        eq(authTokens.userId, user.id),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
      ),
    );
  const t = mintToken();
  const ttl = purpose === 'verify_email' ? VERIFY_TTL_MS : RESET_TTL_MS;
  await dbx.insert(authTokens).values({
    id: t.id,
    userId: user.id,
    purpose,
    tokenHash: t.hash,
    email: user.email,
    expiresAt: new Date(Date.now() + ttl),
  });
  return t.token;
}

/**
 * Verify and burn a token in one step. The secret is compared in constant time; the
 * conditional UPDATE makes it single-use even under concurrent requests.
 */
export async function consumeAuthToken(
  dbx: DbOrTx,
  token: string,
  purpose: TokenPurpose,
): Promise<{ userId: string; email: string }> {
  const parsed = parseToken(token);
  if (!parsed) throw tokenInvalid();
  const [row] = await dbx
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.id, parsed.id), eq(authTokens.purpose, purpose)))
    .limit(1);
  if (!row || !secretMatches(parsed.secret, row.tokenHash)) throw tokenInvalid();
  const [burned] = await dbx
    .update(authTokens)
    .set({ usedAt: dsql`now()` })
    .where(
      and(
        eq(authTokens.id, row.id),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, dsql`now()`),
      ),
    )
    .returning({ id: authTokens.id });
  if (!burned) throw tokenInvalid();
  return { userId: row.userId, email: row.email };
}

async function sendVerification(
  user: { id: string; email: string },
  req: FastifyRequest,
): Promise<boolean> {
  const token = await issueAuthToken(db, user, 'verify_email');
  if (!token) return false;
  sendInBackground(verifyEmailMessage(user.email, appLink('/verify-email', { token })), req.log);
  return true;
}

/** True when every org the user belongs to is switched off (and there is at least one). */
async function allOrgsDisabled(userId: string): Promise<boolean> {
  const rows = await db
    .select({ disabledAt: organizations.disabledAt })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId));
  return rows.length > 0 && rows.every((r) => r.disabledAt != null);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Fail at boot, not on the first signup, when the mail transport is misconfigured.
  const transport = mailer().transport;
  if (env.NODE_ENV === 'production' && transport === 'console')
    app.log.warn('MAIL_TRANSPORT=console in production: emailed links will only be logged');

  const tight = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  const signupLimit = { rateLimit: { max: env.SIGNUP_RATE_PER_HOUR, timeWindow: '1 hour' } };
  const mailLimit = { rateLimit: { max: 5, timeWindow: '15 minutes' } };

  /** Public, unauthenticated: what the auth pages need to render (captcha widget). */
  app.get('/v1/auth/config', async () => ({ captcha: captchaPublicConfig() }));

  app.post('/v1/auth/login', { config: tight }, async (req, reply) => {
    const body = parse(Login, req.body);
    const identifier = (body.identifier ?? body.email ?? '').trim().toLowerCase();
    const isEmail = identifier.includes('@');
    const [u] = await db
      .select()
      .from(users)
      .where(isEmail ? eq(users.email, identifier) : eq(users.username, identifier))
      .limit(1);
    // Always verify something so timing does not reveal whether the account exists.
    const ok = await verifyPassword(
      body.password,
      u?.passwordHash ??
        'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    if (!u || !ok)
      throw new HttpError(401, 'invalid_credentials', 'Invalid email/username or password');
    // Admin kill switch: only after the password checks out, so it reveals nothing.
    if (await allOrgsDisabled(u.id))
      throw new HttpError(
        403,
        E_ORG_DISABLED,
        'Your organization has been disabled. Contact support.',
      );
    issueSession(reply, u.id, u.sessionVersion);
    return { user: userJson(u), orgs: await userOrgs(u.id) };
  });

  app.post('/v1/auth/signup', { config: signupLimit }, async (req, reply) => {
    const body = parse(Signup, req.body);
    await verifyCaptcha(body.captcha_token, req.ip);
    const email = body.email.toLowerCase();

    // Signup-then-accept: a valid invite for this address joins its org instead of
    // creating a new one, and counts as proof of the address.
    let invite: Awaited<ReturnType<typeof findInvite>> = null;
    if (body.invite_token) {
      invite = await findInvite(db, body.invite_token);
      if (!invite || invite.orgDisabled || inviteStatus(invite.invite) !== 'pending')
        throw inviteInvalid();
      if (invite.invite.email !== email)
        throw new HttpError(
          403,
          'E_INVITE_EMAIL_MISMATCH',
          `This invitation was sent to ${invite.invite.email}. Sign up with that address.`,
        );
    }

    const baseUsername = (body.username ?? email.split('@')[0] ?? 'user')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z]+/, 'user-')
      .slice(0, 25);
    let username = body.username?.toLowerCase() ?? baseUsername;
    const [takenUsername] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!body.username && takenUsername)
      username = `${baseUsername.slice(0, 24)}-${randomBytes(3).toString('hex')}`;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) throw conflict('An account with this email already exists');
    const result = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email,
          username,
          name: body.name,
          passwordHash: await hashPassword(body.password),
          emailVerifiedAt: invite ? new Date() : null,
        })
        .returning({
          id: users.id,
          email: users.email,
          username: users.username,
          name: users.name,
          sessionVersion: users.sessionVersion,
          emailVerifiedAt: users.emailVerifiedAt,
        });
      if (invite) {
        await acceptInviteTx(tx, invite.invite, u!, req);
        const [project] = await tx
          .select({ id: projects.id, name: projects.name, slug: projects.slug })
          .from(projects)
          .where(eq(projects.orgId, invite.invite.orgId))
          .orderBy(asc(projects.createdAt))
          .limit(1);
        return { user: u!, project: project ?? null };
      }
      const orgName = body.org_name ?? `${body.name || email.split('@')[0]}'s org`;
      const [org] = await tx
        .insert(organizations)
        .values({ name: orgName, slug: `${slugify(orgName)}-${randomBytes(3).toString('hex')}` })
        .returning({ id: organizations.id });
      await tx.insert(memberships).values({ orgId: org!.id, userId: u!.id, role: 'owner' });
      const [project] = await tx
        .insert(projects)
        .values({
          orgId: org!.id,
          name: body.project_name,
          slug: slugify(body.project_name),
          environment: 'production',
          passwordSalt: randomBytes(16),
        })
        .returning({ id: projects.id, name: projects.name, slug: projects.slug });
      return { user: u!, project: project! };
    });
    if (!invite) await sendVerification(result.user, req);
    issueSession(reply, result.user.id, result.user.sessionVersion);
    return reply.status(201).send({
      user: userJson(result.user),
      project: result.project,
      orgs: await userOrgs(result.user.id),
    });
  });

  /* ------------------------- email verification ------------------------- */

  // Public: the link may be opened in a browser that is not signed in.
  app.post('/v1/auth/verify-email', { config: tight }, async (req) => {
    const { token } = parse(TokenBody, req.body);
    const res = await db.transaction(async (tx) => {
      const t = await consumeAuthToken(tx, token, 'verify_email');
      // The link proves the address it was sent to; if the account's email has
      // changed since, it proves nothing about the current one.
      const [u] = await tx
        .update(users)
        .set({ emailVerifiedAt: dsql`coalesce(${users.emailVerifiedAt}, now())` })
        .where(and(eq(users.id, t.userId), eq(users.email, t.email)))
        .returning({ email: users.email });
      if (!u) throw tokenInvalid();
      return u;
    });
    return { ok: true, email: res.email };
  });

  app.post(
    '/v1/auth/verify-email/resend',
    { preHandler: requireSession, config: mailLimit },
    async (req) => {
      const user = req.user as SessionUser;
      if (user.emailVerified) return { ok: true, already_verified: true, sent: false };
      const sent = await sendVerification(user, req);
      if (!sent)
        throw new HttpError(
          429,
          'rate_limited',
          'A verification email was sent less than a minute ago. Check your inbox, then try again.',
        );
      return { ok: true, already_verified: false, sent: true };
    },
  );

  /* --------------------------- password reset --------------------------- */

  // Always 200 with the same body, and the lookup runs after the reply, so neither
  // the answer nor its timing says whether the address has an account.
  app.post('/v1/auth/password/forgot', { config: mailLimit }, async (req) => {
    const body = parse(ForgotBody, req.body);
    await verifyCaptcha(body.captcha_token, req.ip);
    const email = body.email.toLowerCase();
    if (email.includes('@')) {
      setImmediate(() => {
        void (async () => {
          const [u] = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          if (!u) return;
          const token = await issueAuthToken(db, u, 'reset_password');
          if (!token) return;
          sendInBackground(
            resetPasswordMessage(u.email, appLink('/reset-password', { token })),
            req.log,
          );
        })().catch((err: unknown) => req.log.error({ err }, 'password reset request failed'));
      });
    }
    return {
      ok: true,
      message: 'If an account uses that address, a reset link is on its way.',
    };
  });

  app.post('/v1/auth/password/reset', { config: mailLimit }, async (req, reply) => {
    const body = parse(ResetBody, req.body);
    const passwordHash = await hashPassword(body.password);
    const userId = await db.transaction(async (tx) => {
      const t = await consumeAuthToken(tx, body.token, 'reset_password');
      const [u] = await tx
        .update(users)
        .set({
          passwordHash,
          // Every existing session (cookie version) stops working.
          sessionVersion: dsql`${users.sessionVersion} + 1`,
          // The link reached the inbox, so the address is proven.
          emailVerifiedAt: dsql`coalesce(${users.emailVerifiedAt}, now())`,
        })
        .where(and(eq(users.id, t.userId), eq(users.email, t.email)))
        .returning({ id: users.id });
      if (!u) throw tokenInvalid();
      // Any other outstanding reset link for this account dies with this one.
      await tx
        .update(authTokens)
        .set({ usedAt: dsql`now()` })
        .where(
          and(
            eq(authTokens.userId, u.id),
            eq(authTokens.purpose, 'reset_password'),
            isNull(authTokens.usedAt),
          ),
        );
      return u.id;
    });
    const orgs = await db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    for (const o of orgs)
      await audit(db, {
        orgId: o.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: userId,
        req,
      });
    // This browser's cookie carries the old version too; drop it so the user signs in fresh.
    clearSession(reply);
    return { ok: true };
  });

  app.post('/v1/auth/logout', { preHandler: requireSession }, async (req, reply) => {
    await db
      .update(users)
      .set({ sessionVersion: dsql`${users.sessionVersion} + 1` })
      .where(eq(users.id, req.user!.id));
    clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/v1/me', { preHandler: requireSession }, async (req) => ({
    user: userJson(req.user!),
    orgs: await userOrgs(req.user!.id),
  }));
}
