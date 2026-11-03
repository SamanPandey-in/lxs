import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memberships, organizations, projects, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { conflict, HttpError } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { clearSession, issueSession, requireSession, userOrgs } from '../plugins/auth-session.js';

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
const Signup = z.object({
  email: z.string().email().max(256),
  username: Username.optional(),
  password: z.string().min(8).max(256),
  name: z.string().max(128).default(''),
  org_name: z.string().min(1).max(128).optional(),
  project_name: z.string().min(1).max(128).default('My First Project'),
});

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const tight = { rateLimit: { max: 20, timeWindow: '1 minute' } };

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
    issueSession(reply, u.id, u.sessionVersion);
    return {
      user: { id: u.id, email: u.email, username: u.username, name: u.name },
      orgs: await userOrgs(u.id),
    };
  });

  app.post('/v1/auth/signup', { config: tight }, async (req, reply) => {
    const body = parse(Signup, req.body);
    const email = body.email.toLowerCase();
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
        })
        .returning({
          id: users.id,
          email: users.email,
          username: users.username,
          name: users.name,
          sessionVersion: users.sessionVersion,
        });
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
    issueSession(reply, result.user.id, result.user.sessionVersion);
    const user = {
      id: result.user.id,
      email: result.user.email,
      username: result.user.username,
      name: result.user.name,
    };
    return reply
      .status(201)
      .send({ user, project: result.project, orgs: await userOrgs(result.user.id) });
  });

  app.post('/v1/auth/logout', { preHandler: requireSession }, async (req, reply) => {
    await db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, req.user!.id));
    clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/v1/me', { preHandler: requireSession }, async (req) => ({
    user: req.user,
    orgs: await userOrgs(req.user!.id),
  }));
}
