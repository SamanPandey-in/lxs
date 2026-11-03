import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DEV_INGEST_KEY, hashPassword, sha256 } from '../lib/crypto.js';
import { db, sql } from './client.js';
import { runMigrations } from './migrate.js';
import { apiKeys, memberships, organizations, projects, users } from './schema.js';

const DEMO_EMAIL = 'demo@lxs.dev';
const DEMO_PASSWORD = 'demo1234';

async function main(): Promise<void> {
  await runMigrations();

  let [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: DEMO_EMAIL,
        username: 'demo-analyst',
        name: 'Demo Analyst',
        passwordHash: await hashPassword(DEMO_PASSWORD),
      })
      .returning();
  }

  let [org] = await db.select().from(organizations).where(eq(organizations.slug, 'acme')).limit(1);
  if (!org)
    [org] = await db.insert(organizations).values({ name: 'Acme Inc.', slug: 'acme' }).returning();

  await db
    .insert(memberships)
    .values({ orgId: org!.id, userId: user!.id, role: 'owner' })
    .onConflictDoNothing();

  let [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, org!.id), eq(projects.slug, 'acme-shop')))
    .limit(1);
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
  }

  // Deterministic well-known DEV ingest key so the agent / simulator can connect before real auth exists.
  const hash = sha256(DEV_INGEST_KEY);
  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!existing) {
    await db.insert(apiKeys).values({
      projectId: project!.id,
      name: 'dev-ingest-key (seed)',
      prefix: DEV_INGEST_KEY.slice(0, 12),
      keyHash: hash,
      createdBy: user!.id,
    });
  }

  console.log('Seed complete.');
  console.log(`  login      : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  org        : ${org!.name} (${org!.id})`);
  console.log(`  project    : ${project!.name} (${project!.id})`);
  console.log(`  ingest key : ${DEV_INGEST_KEY}   <- DEV ONLY, do not use in production`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});
