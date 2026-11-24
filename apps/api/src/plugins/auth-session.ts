import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/client.js';
import { memberships, organizations, projects, users } from '../db/schema.js';
import { env } from '../env.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';

export type Role = 'owner' | 'analyst' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'analyst', 'viewer'];
const RANK: Record<Role, number> = { viewer: 1, analyst: 2, owner: 3 };
export const roleAtLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];

/**
 * Role matrix, enforced through `projectAccess`/`orgAccess`:
 *   viewer  - read only.
 *   analyst - read, plus incident work: notes, status, block/unblock.
 *   owner   - everything, including keys, project settings, members and channels.
 * Routes pass the minimum role they need; on top of that, any non-read request
 * needs at least analyst, so a route that forgets its `min` cannot hand a viewer
 * write access.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function effectiveMinRole(method: string, min: Role): Role {
  if (!SAFE_METHODS.has(method.toUpperCase()) && RANK[min] < RANK.analyst) return 'analyst';
  return min;
}

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  name: string;
  emailVerified: boolean;
}

export const E_EMAIL_UNVERIFIED = 'E_EMAIL_UNVERIFIED';
export const E_ORG_DISABLED = 'E_ORG_DISABLED';

/** 403 unless the session user has confirmed their email address. */
export function requireVerified(user: SessionUser | undefined): void {
  if (!user) throw unauthorized();
  if (!user.emailVerified)
    throw new HttpError(
      403,
      E_EMAIL_UNVERIFIED,
      'Verify your email address first. Check your inbox or resend the link from the banner.',
    );
}

export const orgDisabled = () =>
  new HttpError(403, E_ORG_DISABLED, 'This organization has been disabled. Contact support.');

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export const SESSION_COOKIE = 'ds_session';

export function issueSession(reply: FastifyReply, userId: string, version: number): void {
  const exp = Math.floor(Date.now() / 1000) + env.SESSION_TTL_HOURS * 3600;
  const token = signToken({ uid: userId, exp, ver: version }, env.SESSION_SECRET);
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600,
  });
}

export function clearSession(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const allowedOrigins = new Set(
  env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
export const isAllowedOrigin = (origin: string | undefined): boolean =>
  !!origin && origin !== 'null' && (allowedOrigins.has(origin) || origin === env.PUBLIC_URL);

async function loadUser(req: FastifyRequest): Promise<SessionUser | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    const tok = verifyToken<{ uid: string; exp: number; ver: number }>(raw, env.SESSION_SECRET);
    if (tok && typeof tok.uid === 'string' && tok.uid.length > 0 && Number.isInteger(tok.ver)) {
      const [u] = await db
        .select({
          id: users.id,
          email: users.email,
          username: users.username,
          name: users.name,
          sessionVersion: users.sessionVersion,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, tok.uid))
        .limit(1);
      if (u && u.sessionVersion === tok.ver) {
        return {
          id: u.id,
          email: u.email,
          username: u.username,
          name: u.name,
          emailVerified: u.emailVerifiedAt != null,
        };
      }
    }
  }
  if (
    env.DEV_AUTH_BYPASS &&
    env.NODE_ENV === 'development' &&
    ['127.0.0.1', '::1', 'localhost'].includes(env.HOST)
  ) {
    // Dev convenience: anonymous requests act as the oldest user.
    const [u] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        name: users.name,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    return u
      ? {
          id: u.id,
          email: u.email,
          username: u.username,
          name: u.name,
          emailVerified: u.emailVerifiedAt != null,
        }
      : null;
  }
  return null;
}

/** preHandler: requires a session cookie; browser mutations must carry an allowed Origin. */
export async function requireSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) throw forbidden('A trusted Origin is required', 'csrf_origin');
  }
  const user = await loadUser(req);
  if (!user) throw unauthorized();
  req.user = user;
}

export async function roleInOrg(userId: string, orgId: string): Promise<Role | null> {
  return (await membershipInOrg(userId, orgId))?.role ?? null;
}

/** The user's role in an org plus whether the org is disabled; null for non-members. */
export async function membershipInOrg(
  userId: string,
  orgId: string,
): Promise<{ role: Role; disabled: boolean } | null> {
  const [m] = await db
    .select({ role: memberships.role, disabledAt: organizations.disabledAt })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!m) return null;
  return { role: m.role as Role, disabled: m.disabledAt != null };
}

/**
 * Resolve an org the session user belongs to, with at least `min` role. Non-members
 * get 404 (the org's existence is not confirmed); disabled orgs get 403.
 */
export async function orgAccess(
  req: FastifyRequest,
  orgId: string,
  min: Role = 'viewer',
): Promise<{ orgId: string; role: Role; user: SessionUser }> {
  if (!req.user) throw unauthorized();
  if (!isUuid(orgId)) throw notFound('Organization');
  const m = await membershipInOrg(req.user.id, orgId);
  if (!m) throw notFound('Organization');
  if (m.disabled) throw orgDisabled();
  const need = effectiveMinRole(req.method, min);
  if (!roleAtLeast(m.role, need)) throw forbidden(`Requires ${need} role`, 'insufficient_role');
  return { orgId, role: m.role, user: req.user };
}

export interface ProjectAccess {
  project: typeof projects.$inferSelect;
  role: Role;
  user: SessionUser;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** Resolve a project the session user may access with at least `min` role. 404 hides foreign projects. */
export async function projectAccess(
  req: FastifyRequest,
  projectId: string,
  min: Role = 'viewer',
): Promise<ProjectAccess> {
  if (!req.user) throw unauthorized();
  if (!isUuid(projectId)) throw notFound('Project');
  // Soft-deleted projects are gone for every route; only restore (modules/data.ts) sees them.
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!p) throw notFound('Project');
  const m = await membershipInOrg(req.user.id, p.orgId);
  if (!m) throw notFound('Project');
  if (m.disabled) throw orgDisabled();
  const need = effectiveMinRole(req.method, min);
  if (!roleAtLeast(m.role, need)) throw forbidden(`Requires ${need} role`, 'insufficient_role');
  return { project: p, role: m.role, user: req.user };
}

export async function userOrgs(userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), isNull(organizations.disabledAt)));
}

export default fp(async function authSession(app: FastifyInstance) {
  app.decorateRequest('user', undefined);
});
