import { sql as dsql, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { attackers, incidents, projects, responseActions, responsePolicies } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import {
  type AutoBlockDecision,
  type AutoBlockPolicy,
  DEFAULT_POLICY,
  decideAutoBlock,
  parseRanges,
} from '../lib/auto-block.js';
import { STREAM_CHANNEL, streamPayload } from '../lib/notify.js';
import { blockIp } from '../modules/response.js';

/** The actor recorded for automated blocks (blocklist created_by, response_actions.requested_by). */
export const AUTO_BLOCK_ACTOR = 'system:auto-block';

/** Guard refusals are worth one audit line per incident: "the rule matched, but…". */
const RECORDED_REFUSALS = new Set(['allowlisted', 'platform_range', 'private_range', 'invalid_ip']);

export function policyFromRow(
  row: typeof responsePolicies.$inferSelect | undefined | null,
): AutoBlockPolicy {
  if (!row) return { ...DEFAULT_POLICY };
  return {
    enabled: row.enabled,
    mode: row.mode === 'enforce' ? 'enforce' : 'monitor',
    minSeverity: row.minSeverity,
    labels: row.labels ?? [],
    durationHours: row.durationHours,
    requireRealAssetTouch: row.requireRealAssetTouch,
    allowPrivate: row.allowPrivate,
  };
}

/**
 * The auto-block job: evaluate the project's policy for one incident and, when it matches,
 * block through the same path a manual block uses (`blockIp`), as the system actor, with the
 * rule recorded. In monitor mode it records "would block" and changes nothing.
 */
export async function autoBlockIncident(incidentId: string): Promise<AutoBlockDecision | null> {
  const [row] = await db
    .select({ incident: incidents, ip: attackers.ip, project: projects })
    .from(incidents)
    .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
    .innerJoin(projects, eq(projects.id, incidents.projectId))
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!row) return null;
  const { incident, project } = row;
  const ip = String(row.ip);

  const [pol] = await db
    .select()
    .from(responsePolicies)
    .where(eq(responsePolicies.projectId, project.id))
    .limit(1);
  const policy = policyFromRow(pol);
  if (!policy.enabled) return { action: 'skip', reason: 'disabled' };

  const flags = (await db.execute(dsql`
    select
      exists(select 1 from events e where e.incident_id = ${incident.id}::uuid and e.sample) as sample,
      (exists(select 1 from blocklist_entries b
               where b.incident_id = ${incident.id}::uuid and b.source = 'auto')
       or exists(select 1 from response_actions r
               where r.incident_id = ${incident.id}::uuid
                 and r.type in ('auto_block_dry_run', 'auto_block_refused'))) as acted,
      exists(select 1 from blocklist_entries b
             where b.project_id = ${project.id}::uuid and b.ip = ${ip}::inet
               and b.removed_at is null) as blocked,
      exists(select 1 from blocklist_entries b
             where b.project_id = ${project.id}::uuid and b.ip = ${ip}::inet
               and b.removed_at > now() - make_interval(hours => ${policy.durationHours}::int)
               and b.removed_by is not null and b.removed_by not like 'system:%') as unblocked
  `)) as unknown as { sample: boolean; acted: boolean; blocked: boolean; unblocked: boolean }[];
  const f = flags[0] ?? { sample: false, acted: false, blocked: false, unblocked: false };

  const decision = decideAutoBlock({
    policy,
    incident: {
      id: incident.id,
      number: incident.number,
      status: incident.status,
      severity: incident.severity,
      label: incident.label,
      realAssetReached: incident.realAssetReached,
      srcIp: ip,
      sample: !!f.sample,
    },
    ctx: {
      allowlist: (project.allowlist ?? []).map(String),
      platformRanges: parseRanges(env.PLATFORM_IP_RANGES),
      alreadyActed: !!f.acted,
      alreadyBlocked: !!f.blocked,
      recentlyUnblockedByHuman: !!f.unblocked,
    },
  });

  if (decision.action === 'block') {
    await blockIp(
      { project, user: { id: AUTO_BLOCK_ACTOR } },
      {
        ip,
        durationHours: decision.durationHours,
        reason: `Auto-block: ${decision.rule.description} (incident #${incident.number})`,
        incidentId: incident.id,
      },
      undefined,
      { source: 'auto', rule: { ...decision.rule }, actorType: 'system' },
    );
    await db.execute(
      dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(project.id, 'incident.updated', { id: incident.id, blocked: true, auto: true })})`,
    );
    return decision;
  }

  if (decision.action === 'would_block' || RECORDED_REFUSALS.has(decision.reason)) {
    const dry = decision.action === 'would_block';
    await db.transaction(async (tx) => {
      const [action] = await tx
        .insert(responseActions)
        .values({
          projectId: project.id,
          incidentId: incident.id,
          type: dry ? 'auto_block_dry_run' : 'auto_block_refused',
          params: dry
            ? { ip, rule: decision.rule }
            : { ip, reason: decision.reason, detail: decision.detail ?? null },
          status: 'completed',
          requestedBy: AUTO_BLOCK_ACTOR,
          appliedAt: new Date(),
        })
        .returning({ id: responseActions.id });
      await audit(tx, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'system',
        actorId: AUTO_BLOCK_ACTOR,
        action: dry ? 'response.auto_block.would_block' : 'response.auto_block.refused',
        targetType: 'incident',
        targetId: incident.id,
        metadata: dry
          ? { ip, mode: 'monitor', rule: decision.rule, response_action_id: action?.id ?? null }
          : { ip, reason: decision.reason, detail: decision.detail ?? null },
      });
    });
  }
  return decision;
}
