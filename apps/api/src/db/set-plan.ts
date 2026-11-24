/**
 * Set an organization's plan (lib/plans.ts). Plans are config, not billing, and there is
 * deliberately no UI or API for this.
 *
 *   pnpm --filter @lxs/api db:set-plan list
 *   pnpm --filter @lxs/api db:set-plan set <org-slug|org-id> <free|team|custom>
 *
 * The new retention applies at the next nightly purge; the caps apply to the next project
 * or key created. Moving to a plan with a shorter retention deletes older events then.
 */
import { fileURLToPath } from 'node:url';
import { desc, eq, or } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { isPlanName, PLAN_NAMES, PLANS, type PlanName, planFor } from '../lib/plans.js';
import { db, sql } from './client.js';
import { organizations } from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SetPlanCommand = { cmd: 'list' } | { cmd: 'set'; org: string; plan: PlanName };

export function parseArgs(argv: string[]): SetPlanCommand | { error: string } {
  const [cmd, org, plan] = argv;
  if (cmd === 'list') return { cmd };
  if (cmd === 'set' && org && plan) {
    if (!isPlanName(plan))
      return { error: `unknown plan "${plan}"; one of ${PLAN_NAMES.join(', ')}` };
    return { cmd, org, plan };
  }
  return {
    error: `usage: set-plan.ts list | set <org-slug|org-id> <${PLAN_NAMES.join('|')}>`,
  };
}

const describe = (name: PlanName) => {
  const p = PLANS[name];
  return `${name} (events ${p.retentionDays} d, raw ${p.rawRetentionDays} d, ${p.maxProjects} projects, ${p.maxKeys} keys)`;
};

async function run(c: SetPlanCommand): Promise<number> {
  if (c.cmd === 'list') {
    for (const n of PLAN_NAMES) console.log(`plan ${describe(n)}`);
    const rows = await db.select().from(organizations).orderBy(desc(organizations.createdAt));
    for (const o of rows)
      console.log(`${planFor(o.plan).name.padEnd(7)} ${o.slug.padEnd(32)} ${o.id}`);
    return 0;
  }
  const [org] = await db
    .select()
    .from(organizations)
    .where(
      UUID_RE.test(c.org)
        ? or(eq(organizations.id, c.org), eq(organizations.slug, c.org))
        : eq(organizations.slug, c.org),
    )
    .limit(1);
  if (!org) {
    console.error(`no organization with slug or id "${c.org}"`);
    return 1;
  }
  const from = planFor(org.plan).name;
  await db.transaction(async (tx) => {
    await tx.update(organizations).set({ plan: c.plan }).where(eq(organizations.id, org.id));
    await audit(tx, {
      orgId: org.id,
      actorType: 'system',
      action: 'org.plan_change',
      targetType: 'organization',
      targetId: org.id,
      metadata: { from, to: c.plan },
    });
  });
  console.log(`${org.slug} (${org.id}): ${from} -> ${describe(c.plan)}`);
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
