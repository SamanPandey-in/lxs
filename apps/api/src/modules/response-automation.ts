import { readFileSync } from 'node:fs';
import { and, desc, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { blocklistEntries, responseActions, responsePolicies } from '../db/schema.js';
import { env } from '../env.js';
import {
  type CiRangeSet,
  parseCiRanges,
  type SourceStats,
  suggestAllowlist,
} from '../lib/allowlist-suggest.js';
import { audit } from '../lib/audit.js';
import {
  describePolicy,
  MAX_DURATION_HOURS,
  MIN_DURATION_HOURS,
  parseRanges,
  SEVERITIES,
} from '../lib/auto-block.js';
import { llmConfigFrom } from '../lib/llm.js';
import { CAP_MESSAGES, usageReport } from '../lib/llm-budget.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import { projectAccess, requireSession } from '../plugins/auth-session.js';
import { policyFromRow } from '../worker/auto-block.js';

/**
 * Response automation settings: the auto-block policy, allowlist suggestions and the AI usage
 * meter (H7). The Slack app lives in integrations-slack.ts.
 */

const PolicyBody = z.object({
  enabled: z.boolean(),
  mode: z.enum(['monitor', 'enforce']),
  min_severity: z.enum(SEVERITIES),
  labels: z
    .array(z.string().regex(/^[a-z_]{1,32}$/))
    .max(10)
    .default([]),
  duration_hours: z.number().int().min(MIN_DURATION_HOURS).max(MAX_DURATION_HOURS),
  require_real_asset_touch: z.boolean().default(false),
  allow_private: z.boolean().default(false),
});

const policyJson = (p: ReturnType<typeof policyFromRow>) => ({
  enabled: p.enabled,
  mode: p.mode,
  min_severity: p.minSeverity,
  labels: p.labels,
  duration_hours: p.durationHours,
  require_real_asset_touch: p.requireRealAssetTouch,
  allow_private: p.allowPrivate,
});

let ciCache: { file: string; ranges: CiRangeSet[] } | null = null;
/** Cached CI ranges from disk (ALLOWLIST_CI_RANGES_FILE). Never fetched over the network. */
export function cachedCiRanges(): CiRangeSet[] {
  const file = env.ALLOWLIST_CI_RANGES_FILE;
  if (!file) return [];
  if (ciCache?.file === file) return ciCache.ranges;
  let ranges: CiRangeSet[] = [];
  try {
    ranges = parseCiRanges(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    ranges = [];
  }
  ciCache = { file, ranges };
  return ranges;
}

export async function responseAutomationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };

  app.get('/v1/projects/:pid/response-policy', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const [row] = await db
      .select()
      .from(responsePolicies)
      .where(eq(responsePolicies.projectId, project.id))
      .limit(1);
    const policy = policyFromRow(row);
    const blocks = await db
      .select()
      .from(blocklistEntries)
      .where(and(eq(blocklistEntries.projectId, project.id), eq(blocklistEntries.source, 'auto')))
      .orderBy(desc(blocklistEntries.createdAt))
      .limit(20);
    const dry = await db
      .select()
      .from(responseActions)
      .where(
        and(
          eq(responseActions.projectId, project.id),
          inArray(responseActions.type, ['auto_block_dry_run', 'auto_block_refused']),
        ),
      )
      .orderBy(desc(responseActions.requestedAt))
      .limit(20);
    return {
      policy: policyJson(policy),
      description: describePolicy(policy),
      platform_ranges_configured: parseRanges(env.PLATFORM_IP_RANGES).length > 0,
      updated_at: iso(row?.updatedAt ?? null),
      recent_blocks: blocks.map((b) => ({
        id: b.id,
        ip: b.ip,
        incident_id: b.incidentId,
        created_at: iso(b.createdAt),
        expires_at: iso(b.expiresAt),
        removed_at: iso(b.removedAt),
        removed_by: b.removedBy,
        rule: b.rule ?? null,
      })),
      recent_decisions: dry.map((a) => ({
        id: a.id,
        type: a.type === 'auto_block_dry_run' ? 'would_block' : 'refused',
        incident_id: a.incidentId,
        at: iso(a.requestedAt),
        params: a.params,
      })),
    };
  });

  app.put('/v1/projects/:pid/response-policy', auth, async (req) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const b = parse(PolicyBody, req.body);
    const values = {
      enabled: b.enabled,
      mode: b.mode,
      minSeverity: b.min_severity,
      labels: [...new Set(b.labels)],
      durationHours: b.duration_hours,
      requireRealAssetTouch: b.require_real_asset_touch,
      allowPrivate: b.allow_private,
      updatedBy: user.id,
      updatedAt: new Date(),
    };
    const [before] = await db
      .select()
      .from(responsePolicies)
      .where(eq(responsePolicies.projectId, project.id))
      .limit(1);
    if (before)
      await db
        .update(responsePolicies)
        .set(values)
        .where(eq(responsePolicies.projectId, project.id));
    else await db.insert(responsePolicies).values({ projectId: project.id, ...values });
    const policy = policyFromRow({ ...values, projectId: project.id });
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'response.policy.update',
      targetType: 'project',
      targetId: project.id,
      metadata: {
        before: before ? policyJson(policyFromRow(before)) : null,
        after: policyJson(policy),
      },
      req,
    });
    return { policy: policyJson(policy), description: describePolicy(policy) };
  });

  app.get('/v1/projects/:pid/allowlist/suggestions', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'analyst');
    const rows = (await db.execute(dsql`
      select host(e.src_ip) as ip,
        sum(e.count)::int as events,
        array_agg(distinct to_char(e.occurred_at at time zone 'utc', 'YYYY-MM-DD')) as day_list,
        (array_agg(distinct left(e.fields->>'user_agent', 200))
           filter (where e.fields ? 'user_agent'))[1:5] as user_agents,
        (array_agg(distinct left(coalesce(e.fields->>'url', e.dst_service), 200)))[1:10] as paths,
        avg(case when e.fields->>'status_code' ~ '^[0-9]{3}$'
                  and (e.fields->>'status_code')::int >= 400 then 1 else 0 end)::float as error_ratio,
        to_char(max(e.occurred_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_seen,
        exists(select 1 from events d where d.project_id = ${project.id}::uuid
               and d.src_ip = e.src_ip and d.is_decoy
               and d.occurred_at > now() - interval '30 days') as touched_decoy,
        exists(select 1 from attackers a where a.project_id = ${project.id}::uuid
               and a.ip = e.src_ip and a.label <> 'noise') as flagged
      from events e
      where e.project_id = ${project.id}::uuid and not e.is_decoy and not e.simulated
        and e.occurred_at > now() - interval '30 days'
      group by e.src_ip
      order by sum(e.count) desc
      limit 2000
    `)) as unknown as {
      ip: string;
      events: number;
      day_list: string[] | null;
      user_agents: string[] | null;
      paths: string[] | null;
      error_ratio: number | null;
      last_seen: string | null;
      touched_decoy: boolean;
      flagged: boolean;
    }[];
    const blocked = await db
      .select({ ip: blocklistEntries.ip })
      .from(blocklistEntries)
      .where(
        and(
          eq(blocklistEntries.projectId, project.id),
          dsql`${blocklistEntries.removedAt} is null`,
        ),
      );
    const sources: SourceStats[] = rows.map((r) => ({
      ip: r.ip,
      events: Number(r.events ?? 0),
      dayList: r.day_list ?? [],
      userAgents: (r.user_agents ?? []).filter(Boolean),
      paths: (r.paths ?? []).filter(Boolean),
      errorRatio: Number(r.error_ratio ?? 0),
      lastSeen: r.last_seen,
      touchedDecoy: !!r.touched_decoy,
      flaggedAttacker: !!r.flagged,
    }));
    const ci = cachedCiRanges();
    return {
      window_days: 30,
      ci_ranges_loaded: ci.reduce((n, c) => n + c.cidrs.length, 0),
      items: suggestAllowlist({
        sources,
        allowlist: (project.allowlist ?? []).map(String),
        blocked: blocked.map((b) => String(b.ip)),
        ciRanges: ci,
      }),
    };
  });

  app.get('/v1/projects/:pid/llm-usage', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const report = await usageReport(project);
    const cfg = llmConfigFrom(env);
    return {
      llm_configured: !!cfg,
      provider: cfg?.provider ?? null,
      model: cfg?.model ?? null,
      ai_enabled: project.aiEnabled,
      ...report,
      capped_message: report.capped_by ? CAP_MESSAGES[report.capped_by] : null,
      // The estimate uses list prices (plugins/metrics.ts); it is not a bill.
      cost_is_estimate: true,
    };
  });
}
