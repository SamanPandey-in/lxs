import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/client.js';
import { memberships, organizations, projects, users } from '../db/schema.js';
import { env } from '../env.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export type Role = 'owner' | 'analyst' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, analyst: 2, owner: 3 };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export const SESSION_COOKIE = 'ds_session';

export function issueSession(reply: FastifyReply, userId: string): void {
  const exp = Math.floor(Date.now() / 1000) + env.SESSION_TTL_HOURS * 3600;
  const token = signToken({ uid: userId, exp }, env.SESSION_SECRET);
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
  !!origin && (allowedOrigins.has(origin) || allowedOrigins.has('*') || origin === env.PUBLIC_URL);

async function loadUser(req: FastifyRequest): Promise<SessionUser | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    const tok = verifyToken<{ uid: string; exp: number }>(raw, env.SESSION_SECRET);
    if (tok) {
      const [u] = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, tok.uid))
        .limit(1);
      if (u) return u;
    }
  }
  if (env.DEV_AUTH_BYPASS) {
    // Dev convenience: anonymous requests act as the oldest user.
    const [u] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    return u ?? null;
  }
  return null;
}

/** preHandler: requires a session (cookie); mutations also get a CSRF Origin check. */
export async function requireSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) throw forbidden('Origin not allowed', 'csrf_origin');
  }
  const user = await loadUser(req);
  if (!user) throw unauthorized();
  req.user = user;
}

export async function roleInOrg(userId: string, orgId: string): Promise<Role | null> {
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return (m?.role as Role | undefined) ?? null;
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
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw notFound('Project');
  const role = await roleInOrg(req.user.id, p.orgId);
  if (!role) throw notFound('Project');
  if (RANK[role] < RANK[min]) throw forbidden(`Requires ${min} role`, 'insufficient_role');
  return { project: p, role, user: req.user };
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
    .where(eq(memberships.userId, userId));
}

export default fp(async function authSession(app: FastifyInstance) {
  app.decorateRequest('user', undefined);
});
