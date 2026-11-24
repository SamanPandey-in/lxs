import { sql as dsql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { estimateLlmCostUsd } from '../plugins/metrics.js';
import { planFor } from './plans.js';

/**
 * H7 cost caps. Every provider call is reserved here first, against three daily caps (UTC):
 *
 *   global  LLM_GLOBAL_DAILY_CAP           whole platform
 *   org     organizations.llm_daily_cap    else LLM_ORG_DAILY_CAP
 *   project projects.ai_daily_cap          (default 200)
 *
 * The reservation runs under one advisory lock, so concurrent workers cannot overshoot. A
 * refused reservation is counted (`capped_calls`, `last_cap_reason`) and the caller falls
 * back to the template summary. Tokens and estimated cost are added after the call.
 */

export type CapReason = 'global_cap' | 'org_cap' | 'project_cap';

export interface CapState {
  used: number;
  cap: number;
}

/** Pure: the first cap that is reached, widest first, or null when the call may proceed. */
export function evaluateBudget(s: {
  global: CapState;
  org: CapState;
  project: CapState;
}): CapReason | null {
  if (s.global.used >= s.global.cap) return 'global_cap';
  if (s.org.used >= s.org.cap) return 'org_cap';
  if (s.project.used >= s.project.cap) return 'project_cap';
  return null;
}

/**
 * The org's daily cap: its own override, else its plan's default (free = LLM_ORG_DAILY_CAP).
 */
export const orgDailyCap = (override: number | null | undefined, plan?: string | null): number =>
  override ?? planFor(plan).plan.llmDailyCap;

export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
export const utcMonth = (d = new Date()): string => d.toISOString().slice(0, 7);

/** USD x 1e6, rounded up so a tiny call is never free. */
export const costMicros = (model: string, input: number, output: number): number =>
  Math.ceil(estimateLlmCostUsd(model, input, output) * 1_000_000);

export const CAP_MESSAGES: Record<CapReason, string> = {
  global_cap: 'The platform-wide daily AI limit was reached',
  org_cap: "Your organization's daily AI limit was reached",
  project_cap: "This project's daily AI limit was reached",
};

type Reservation = { allowed: true } | { allowed: false; reason: CapReason };

/** Reserve one provider call for `projectId` today, or say which cap refused it. */
export async function reserveLlmCall(projectId: string, now = new Date()): Promise<Reservation> {
  const day = utcDay(now);
  return db.transaction(async (tx) => {
    await tx.execute(dsql`select pg_advisory_xact_lock(hashtextextended('lxs:llm-budget', 0))`);
    const rows = (await tx.execute(dsql`
      select p.org_id::text as org_id, p.ai_daily_cap as project_cap, o.llm_daily_cap as org_cap, o.plan as org_plan,
        (select coalesce(sum(u.calls), 0)::int from llm_usage u where u.day = ${day}) as global_used,
        (select coalesce(sum(u.calls), 0)::int from llm_usage u
          where u.day = ${day} and u.org_id = p.org_id) as org_used,
        (select coalesce(sum(u.calls), 0)::int from llm_usage u
          where u.day = ${day} and u.project_id = p.id) as project_used
      from projects p join organizations o on o.id = p.org_id
      where p.id = ${projectId}::uuid
    `)) as unknown as {
      org_id: string;
      project_cap: number;
      org_cap: number | null;
      org_plan: string | null;
      global_used: number;
      org_used: number;
      project_used: number;
    }[];
    const r = rows[0];
    if (!r) return { allowed: false, reason: 'project_cap' } as const;
    const reason = evaluateBudget({
      global: { used: Number(r.global_used), cap: env.LLM_GLOBAL_DAILY_CAP },
      org: { used: Number(r.org_used), cap: orgDailyCap(r.org_cap, r.org_plan) },
      project: { used: Number(r.project_used), cap: Number(r.project_cap) },
    });
    await tx.execute(dsql`
      insert into llm_usage (project_id, org_id, day, calls, capped_calls, last_cap_reason)
      values (${projectId}::uuid, ${r.org_id}::uuid, ${day}, ${reason ? 0 : 1}, ${reason ? 1 : 0}, ${reason})
      on conflict (project_id, day) do update set
        calls = llm_usage.calls + excluded.calls,
        capped_calls = llm_usage.capped_calls + excluded.capped_calls,
        last_cap_reason = coalesce(excluded.last_cap_reason, llm_usage.last_cap_reason),
        updated_at = now()
    `);
    if (reason) console.warn(`[llm-budget] project ${projectId}: ${reason} reached`);
    return reason ? ({ allowed: false, reason } as const) : ({ allowed: true } as const);
  });
}

/** Add a finished call's tokens and estimated cost to today's row. Never throws. */
export async function recordLlmUsage(
  projectId: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  now = new Date(),
): Promise<void> {
  const input = Math.max(0, Math.round(usage?.inputTokens ?? 0));
  const output = Math.max(0, Math.round(usage?.outputTokens ?? 0));
  if (!input && !output) return;
  const cost = costMicros(model, input, output);
  try {
    await db.execute(dsql`
      insert into llm_usage (project_id, org_id, day, input_tokens, output_tokens, cost_micros)
      select p.id, p.org_id, ${utcDay(now)}, ${input}, ${output}, ${cost}
      from projects p where p.id = ${projectId}::uuid
      on conflict (project_id, day) do update set
        input_tokens = llm_usage.input_tokens + excluded.input_tokens,
        output_tokens = llm_usage.output_tokens + excluded.output_tokens,
        cost_micros = llm_usage.cost_micros + excluded.cost_micros,
        updated_at = now()
    `);
  } catch (err) {
    console.warn('[llm-budget] could not record usage', err instanceof Error ? err.message : err);
  }
}

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  capped_calls: number;
}

export interface UsageReport {
  day: string;
  month: string;
  today: UsageTotals;
  this_month: UsageTotals;
  caps: {
    project: { cap: number; used: number; remaining: number };
    org: { cap: number; used: number; remaining: number; source: 'org_override' | 'default' };
    /** Other tenants' usage is not disclosed: only whether the platform limit is reached. */
    global: { reached: boolean };
  };
  /** The cap that applies right now, or null when calls may proceed. */
  capped_by: CapReason | null;
  last_cap_reason: CapReason | null;
}

const toTotals = (r: Record<string, unknown> | undefined): UsageTotals => ({
  calls: Number(r?.calls ?? 0),
  input_tokens: Number(r?.input_tokens ?? 0),
  output_tokens: Number(r?.output_tokens ?? 0),
  estimated_cost_usd: Math.round(Number(r?.cost_micros ?? 0)) / 1_000_000,
  capped_calls: Number(r?.capped_calls ?? 0),
});

/** Pure: shape the numbers the llm-usage route returns. */
export function buildUsageReport(input: {
  now: Date;
  today: Record<string, unknown> | undefined;
  month: Record<string, unknown> | undefined;
  projectCap: number;
  orgOverride: number | null;
  orgPlan?: string | null;
  orgUsed: number;
  globalUsed: number;
  lastCapReason: string | null;
}): UsageReport {
  const today = toTotals(input.today);
  const orgCap = orgDailyCap(input.orgOverride, input.orgPlan);
  const project = {
    cap: input.projectCap,
    used: today.calls,
    remaining: Math.max(0, input.projectCap - today.calls),
  };
  const org = {
    cap: orgCap,
    used: input.orgUsed,
    remaining: Math.max(0, orgCap - input.orgUsed),
    source: input.orgOverride == null ? ('default' as const) : ('org_override' as const),
  };
  const globalReached = input.globalUsed >= env.LLM_GLOBAL_DAILY_CAP;
  const cappedBy = evaluateBudget({
    global: { used: input.globalUsed, cap: env.LLM_GLOBAL_DAILY_CAP },
    org: { used: org.used, cap: org.cap },
    project: { used: project.used, cap: project.cap },
  });
  const last = input.lastCapReason;
  return {
    day: utcDay(input.now),
    month: utcMonth(input.now),
    today,
    this_month: toTotals(input.month),
    caps: { project, org, global: { reached: globalReached } },
    capped_by: cappedBy,
    last_cap_reason:
      last === 'global_cap' || last === 'org_cap' || last === 'project_cap' ? last : null,
  };
}

export async function usageReport(
  project: { id: string; orgId: string; aiDailyCap: number },
  now = new Date(),
): Promise<UsageReport> {
  const day = utcDay(now);
  const month = utcMonth(now);
  const rows = (await db.execute(dsql`
    select
      (select row_to_json(t) from (
         select calls, input_tokens, output_tokens, cost_micros, capped_calls, last_cap_reason
         from llm_usage where project_id = ${project.id}::uuid and day = ${day}) t) as today,
      (select row_to_json(m) from (
         select coalesce(sum(calls), 0) as calls, coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(cost_micros), 0) as cost_micros,
                coalesce(sum(capped_calls), 0) as capped_calls
         from llm_usage where project_id = ${project.id}::uuid and day like ${`${month}-%`}) m) as month,
      (select coalesce(sum(calls), 0)::int from llm_usage
        where org_id = ${project.orgId}::uuid and day = ${day}) as org_used,
      (select coalesce(sum(calls), 0)::int from llm_usage where day = ${day}) as global_used,
      (select llm_daily_cap from organizations where id = ${project.orgId}::uuid) as org_override,
      (select plan from organizations where id = ${project.orgId}::uuid) as org_plan
  `)) as unknown as {
    today: Record<string, unknown> | null;
    month: Record<string, unknown> | null;
    org_used: number;
    global_used: number;
    org_override: number | null;
    org_plan: string | null;
  }[];
  const r = rows[0];
  return buildUsageReport({
    now,
    today: r?.today ?? undefined,
    month: r?.month ?? undefined,
    projectCap: project.aiDailyCap,
    orgOverride: r?.org_override ?? null,
    orgPlan: r?.org_plan ?? null,
    orgUsed: Number(r?.org_used ?? 0),
    globalUsed: Number(r?.global_used ?? 0),
    lastCapReason: (r?.today?.last_cap_reason as string | undefined) ?? null,
  });
}
