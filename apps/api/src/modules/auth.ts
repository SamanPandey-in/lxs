import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memberships, organizations, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { conflict, HttpError } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { clearSession, issueSession, requireSession, userOrgs } from '../plugins/auth-session.js';

const Login = z.object({
  email: z.string().email().max(256),
  password: z.string().min(1).max(256),
});
const Signup = z.object({
  email: z.string().email().max(256),
  password: z.string().min(8).max(256),
  name: z.string().max(128).default(''),
  org_name: z.string().min(1).max(128).optional(),
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
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email.toLowerCase()))
      .limit(1);
    // Always verify something so timing does not reveal whether the account exists.
    const ok = await verifyPassword(
      body.password,
      u?.passwordHash ??
        'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    if (!u || !ok) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    issueSession(reply, u.id);
    return { user: { id: u.id, email: u.email, name: u.name }, orgs: await userOrgs(u.id) };
  });

  app.post('/v1/auth/signup', { config: tight }, async (req, reply) => {
    const body = parse(Signup, req.body);
    const email = body.email.toLowerCase();
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) throw conflict('An account with this email already exists');
    const result = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email, name: body.name, passwordHash: await hashPassword(body.password) })
        .returning({ id: users.id, email: users.email, name: users.name });
      const orgName = body.org_name ?? `${body.name || email.split('@')[0]}'s org`;
      const [org] = await tx
        .insert(organizations)
        .values({ name: orgName, slug: `${slugify(orgName)}-${randomBytes(3).toString('hex')}` })
        .returning({ id: organizations.id });
      await tx.insert(memberships).values({ orgId: org!.id, userId: u!.id, role: 'owner' });
      return u!;
    });
    issueSession(reply, result.id);
    return reply.status(201).send({ user: result, orgs: await userOrgs(result.id) });
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    clearSession(reply);
    return reply.status(204).send();
  });

  app.get('/v1/me', { preHandler: requireSession }, async (req) => ({
    user: req.user,
    orgs: await userOrgs(req.user!.id),
  }));
}
