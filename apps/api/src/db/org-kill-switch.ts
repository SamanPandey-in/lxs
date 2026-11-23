/**
 * Admin org kill switch (H1). There is deliberately no UI or API for this.
 *
 *   pnpm exec tsx --env-file-if-exists=../../.env src/db/org-kill-switch.ts list
 *   pnpm exec tsx --env-file-if-exists=../../.env src/db/org-kill-switch.ts disable <org-slug|org-id> [reason...]
 *   pnpm exec tsx --env-file-if-exists=../../.env src/db/org-kill-switch.ts enable  <org-slug|org-id>
 *
 * Disabling an org: its ingest keys get 403 E_ORG_DISABLED (within the 60 s key
 * cache), its projects answer 403 to members, members whose only orgs are disabled
 * cannot log in, and every member's current session is ended.
 */
import { fileURLToPath } from 'node:url';
import { desc, sql as dsql, eq, inArray, or } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { db, sql } from './client.js';
import { memberships, organizations, users } from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KillSwitchCommand =
  | { cmd: 'list' }
  | { cmd: 'disable'; org: string; reason: string }
  | { cmd: 'enable'; org: string };

export function parseArgs(argv: string[]): KillSwitchCommand | { error: string } {
  const [cmd, org, ...rest] = argv;
  if (cmd === 'list') return { cmd };
  if ((cmd === 'disable' || cmd === 'enable') && org) {
    return cmd === 'disable'
      ? { cmd, org, reason: rest.join(' ').trim() || 'disabled by an administrator' }
      : { cmd, org };
  }
  return {
    error:
      'usage: org-kill-switch.ts list | disable <org-slug|org-id> [reason...] | enable <org-slug|org-id>',
  };
}

async function findOrg(ref: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(
      UUID_RE.test(ref)
        ? or(eq(organizations.id, ref), eq(organizations.slug, ref))
        : eq(organizations.slug, ref),
    )
    .limit(1);
  return org ?? null;
}

async function run(c: KillSwitchCommand): Promise<number> {
  if (c.cmd === 'list') {
    const rows = await db.select().from(organizations).orderBy(desc(organizations.createdAt));
    for (const o of rows)
      console.log(
        `${o.disabledAt ? 'DISABLED' : 'active  '}  ${o.slug.padEnd(32)} ${o.id}${
          o.disabledAt ? `  (${o.disabledAt.toISOString()}: ${o.disabledReason ?? ''})` : ''
        }`,
      );
    return 0;
  }
  const org = await findOrg(c.org);
  if (!org) {
    console.error(`no organization with slug or id "${c.org}"`);
    return 1;
  }
  const disable = c.cmd === 'disable';
  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set(
        disable
          ? { disabledAt: new Date(), disabledReason: c.reason }
          : { disabledAt: null, disabledReason: null },
      )
      .where(eq(organizations.id, org.id));
    if (disable) {
      // End every member's current session; login stays blocked by the flag.
      const members = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.orgId, org.id));
      const ids = members.map((m) => m.userId).filter((id) => UUID_RE.test(id));
      if (ids.length)
        await tx
          .update(users)
          .set({ sessionVersion: dsql`${users.sessionVersion} + 1` })
          .where(inArray(users.id, ids));
    }
    await audit(tx, {
      orgId: org.id,
      actorType: 'system',
      action: disable ? 'org.disable' : 'org.enable',
      targetType: 'organization',
      targetId: org.id,
      metadata: disable ? { reason: c.reason } : {},
    });
  });
  console.log(`${disable ? 'disabled' : 'enabled'} ${org.slug} (${org.id})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const parsed = parseArgs(process.argv.slice(2));
  const done = async (code: number) => {
    await sql.end();
    process.exit(code);
  };
  if ('error' in parsed) {
    console.error(parsed.error);
    void done(2);
  } else {
    run(parsed)
      .then(done)
      .catch(async (err) => {
        console.error(err);
        await done(1);
      });
  }
}
