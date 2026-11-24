import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { env } from '../env.js';

/**
 * Plans are plain config, not billing. An org's `plan` column picks one; set it with
 * `pnpm --filter @lxs/api db:set-plan`. `free` takes its numbers from the environment so a
 * self-hosted deployment can tune its defaults; the others are fixed here.
 *
 *   retentionDays     events older than this are deleted (a project may choose less)
 *   rawRetentionDays  the original sensor record (`events.raw`) is dropped after this
 *   maxProjects       live projects per org (soft-deleted ones do not count)
 *   maxKeys           active ingest keys per org
 */
export const PLAN_NAMES = ['free', 'team', 'custom'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export interface Plan {
  retentionDays: number;
  rawRetentionDays: number;
  maxProjects: number;
  maxKeys: number;
  /** Default LLM calls per org per UTC day (an org's own `llm_daily_cap` overrides it). */
  llmDailyCap: number;
}

export const PLANS: Readonly<Record<PlanName, Readonly<Plan>>> = Object.freeze({
  // Getters, so the free plan always reflects the current env (tests adjust it at runtime).
  free: Object.freeze({
    get retentionDays() {
      return env.RETENTION_DAYS;
    },
    get rawRetentionDays() {
      return env.RAW_RETENTION_DAYS;
    },
    get maxProjects() {
      return env.MAX_PROJECTS_PER_ORG;
    },
    get maxKeys() {
      return env.MAX_KEYS_PER_ORG;
    },
    get llmDailyCap() {
      return env.LLM_ORG_DAILY_CAP;
    },
  }),
  team: {
    retentionDays: 90,
    rawRetentionDays: 14,
    maxProjects: 25,
    maxKeys: 100,
    llmDailyCap: 5000,
  },
  custom: {
    retentionDays: 365,
    rawRetentionDays: 30,
    maxProjects: 1000,
    maxKeys: 5000,
    llmDailyCap: 20000,
  },
});

export const isPlanName = (v: unknown): v is PlanName =>
  typeof v === 'string' && (PLAN_NAMES as readonly string[]).includes(v);

/** The plan for a stored name; anything unknown (a typo in a manual UPDATE) is treated as free. */
export function planFor(name: string | null | undefined): { name: PlanName; plan: Plan } {
  const n: PlanName = isPlanName(name) ? name : 'free';
  return { name: n, plan: PLANS[n] };
}

/** The org's plan, read inside the caller's transaction when there is one. */
export async function orgPlan(dbx: DbOrTx, orgId: string): Promise<{ name: PlanName; plan: Plan }> {
  const [row] = await dbx
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return planFor(row?.plan);
}

/** Effective event retention for a project: its own setting, capped by the plan. */
export const effectiveRetentionDays = (projectDays: number, plan: Plan): number =>
  Math.min(projectDays, plan.retentionDays);

export const planJson = (name: PlanName, plan: Plan) => ({
  name,
  retention_days: plan.retentionDays,
  raw_retention_days: plan.rawRetentionDays,
  max_projects: plan.maxProjects,
  max_keys: plan.maxKeys,
});
