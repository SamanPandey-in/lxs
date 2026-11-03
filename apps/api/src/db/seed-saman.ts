import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DEV_INGEST_KEY, hashPassword, sha256 } from '../lib/crypto.js';
import { db, sql } from './client.js';
import { runMigrations } from './migrate.js';
import { apiKeys, memberships, organizations, projects, users } from './schema.js';

const USERNAME = 'saman';
const EMAIL = 'saman@mail.com';
const PASSWORD = 'qwertyuiop[]\\';
const ORG_SLUG = 'saman-pandey-s-org-dca704';

async function main(): Promise<void> {
  await runMigrations();

  let [user] = await db.select().from(users).where(eq(users.username, USERNAME)).limit(1);
  if (!user) [user] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: EMAIL,
        username: USERNAME,
        name: 'Saman Pandey',
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
  } else {
    const [emailOwner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EMAIL))
      .limit(1);
    const [usernameOwner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, USERNAME))
      .limit(1);
    if ((emailOwner && emailOwner.id !== user.id) || (usernameOwner && usernameOwner.id !== user.id)) {
      throw new Error('The requested Saman username/email belongs to a different account.');
    }
    [user] = await db
      .update(users)
      .set({
        email: EMAIL,
        username: USERNAME,
        name: 'Saman Pandey',
        passwordHash: await hashPassword(PASSWORD),
      })
      .where(eq(users.id, user.id))
      .returning();
  }

  const membershipsForUser = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, user!.id));
  let org = membershipsForUser.length
    ? (await db.select().from(organizations).where(eq(organizations.id, membershipsForUser[0]!.orgId)).limit(1))[0]
    : undefined;

  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({ name: "Saman Pandey's org", slug: ORG_SLUG })
      .onConflictDoUpdate({ target: organizations.slug, set: { name: "Saman Pandey's org" } })
      .returning();
  }
  await db
    .insert(memberships)
    .values({ orgId: org!.id, userId: user!.id, role: 'owner' })
    .onConflictDoUpdate({
      target: [memberships.orgId, memberships.userId],
      set: { role: 'owner' },
    });

  const keyHash = sha256(DEV_INGEST_KEY);
  const [seedKey] = await db
    .select({ projectId: apiKeys.projectId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  let [project] = seedKey
    ? await db.select().from(projects).where(eq(projects.id, seedKey.projectId)).limit(1)
    : await db.select().from(projects).where(eq(projects.slug, 'acme-shop')).limit(1);
  if (!project) {
    [project] = await db
      .insert(projects)
      .values({
        orgId: org!.id,
        name: 'acme-shop',
        slug: 'acme-shop',
        environment: 'demo',
        passwordSalt: randomBytes(16),
        allowlist: ['10.0.0.0/8'],
      })
      .returning();
  } else if (project.orgId !== org!.id) {
    [project] = await db
      .update(projects)
      .set({ orgId: org!.id })
      .where(eq(projects.id, project.id))
      .returning();
  }

  const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  if (!key) {
    await db.insert(apiKeys).values({
      projectId: project!.id,
      name: 'dev-ingest-key (seed)',
      prefix: DEV_INGEST_KEY.slice(0, 12),
      keyHash,
      createdBy: user!.id,
    });
  } else {
    await db.update(apiKeys).set({ projectId: project!.id }).where(eq(apiKeys.id, key.id));
  }

  console.log(`Saman seed complete: ${USERNAME} (${EMAIL}) owns ${project!.slug} (${project!.id}).`);
  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end().catch(() => {});
  process.exit(1);
});
