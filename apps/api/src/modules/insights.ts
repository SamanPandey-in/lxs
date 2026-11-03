import type { AttackerProfile } from '@lxs/schema';
import { and, desc, sql as dsql, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, sql as rawSql } from '../db/client.js';
import { attackers, auditLogs, incidents } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { decodeOffset, LimitQuery, pageOf } from '../lib/pagination.js';
import { parse } from '../lib/parse.js';
import { type IncidentRow, incidentSummaryCols, iso, toIncidentSummary } from '../lib/serialize.js';
import { isUuid, projectAccess, requireSession } from '../plugins/auth-session.js';

type AttackerRow = typeof attackers.$inferSelect;
const attackerJson = (a: AttackerRow): AttackerProfile => ({
  id: a.id,
  entity_key: a.entityKey,
  ip: a.ip,
  label: a.label as AttackerProfile['label'],
  cadence: a.cadence as AttackerProfile['cadence'],
  first_seen_at: iso(a.firstSeenAt)!,
  last_seen_at: iso(a.lastSeenAt)!,
  event_count: a.eventCount,
  session_count: a.sessionCount,
  decoys_touched: a.decoysTouched,
  fingerprints: a.fingerprints as Record<string, unknown>,
});

export async function insightRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };
  const Page = z.object({ limit: LimitQuery, cursor: z.string().optional() });

  app.get('/v1/projects/:pid/attackers', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const q = parse(
      Page.extend({ label: z.enum(['noise', 'opportunistic', 'targeted']).optional() }),
      req.query,
    );
    const offset = decodeOffset(q.cursor);
    const rows = await db
      .select()
      .from(attackers)
      .where(
        and(
          eq(attackers.projectId, project.id),
          q.label ? eq(attackers.label, q.label) : undefined,
        ),
      )
      .orderBy(desc(attackers.lastSeenAt), desc(attackers.id))
      .limit(q.limit + 1)
      .offset(offset);
    const page = pageOf(rows, q.limit, offset);
    return { items: page.items.map(attackerJson), next_cursor: page.next_cursor };
  });

  app.get('/v1/attackers/:aid', auth, async (req) => {
    const { aid } = req.params as { aid: string };
    if (!isUuid(aid)) throw notFound('Attacker');
    const [a] = await db.select().from(attackers).where(eq(attackers.id, aid)).limit(1);
    if (!a) throw notFound('Attacker');
    await projectAccess(req, a.projectId);
    const incs = (await db
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(eq(incidents.attackerId, a.id))
      .orderBy(desc(incidents.lastEventAt))
      .limit(50)) as IncidentRow[];
    const timeline = (await rawSql`
      select event_type, count(*)::int as n, min(occurred_at) as first_at, max(occurred_at) as last_at
      from events where attacker_id = ${a.id}::uuid group by event_type order by min(occurred_at)
    `) as unknown as { event_type: string; n: number; first_at: Date; last_at: Date }[];
    return {
      ...attackerJson(a),
      incidents: incs.map(toIncidentSummary),
      activity: timeline.map((t) => ({
        event_type: t.event_type,
        count: t.n,
        first_at: iso(t.first_at),
        last_at: iso(t.last_at),
      })),
    };
  });

  /** ATT&CK heatmap data: techniques aggregated from the detections ledger. */
  app.get('/v1/projects/:pid/attack-matrix', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const rows = (await rawSql`
      select t->>'id' as technique_id, max(t->>'name') as name, max(t->>'tactic') as tactic,
             count(distinct d.incident_id)::int as incidents, max((t->>'confidence')::float8) as max_confidence
      from detections d
      join incidents i on i.id = d.incident_id
      cross join lateral jsonb_array_elements(d.techniques) t
      where i.project_id = ${project.id}::uuid
      group by t->>'id'
      order by count(distinct d.incident_id) desc, t->>'id'
    `) as unknown as {
      technique_id: string;
      name: string;
      tactic: string;
      incidents: number;
      max_confidence: number;
    }[];
    const tactics = new Map<string, typeof rows>();
    for (const r of rows) tactics.set(r.tactic, [...(tactics.get(r.tactic) ?? []), r]);
    return {
      techniques: rows,
      tactics: [...tactics.entries()].map(([tactic, techniques]) => ({ tactic, techniques })),
    };
  });

  app.get('/v1/projects/:pid/decoys', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const rows = (await rawSql`
      select d.id, d.decoy_key, d.type, d.mount, d.persona, d.declared_posture, d.status, d.last_event_at, d.last_heartbeat_at,
             s.id as sensor_id, s.hostname, s.status as sensor_status,
             (select coalesce(sum(count),0)::int from events e where e.decoy_id = d.id and e.received_at > now() - interval '24 hours') as events_24h
      from decoys d join sensors s on s.id = d.sensor_id
      where d.project_id = ${project.id}::uuid order by d.type, d.decoy_key
    `) as unknown as Record<string, unknown>[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        decoy_key: r.decoy_key,
        type: r.type,
        mount: r.mount,
        persona: r.persona,
        declared_posture: r.declared_posture,
        status: r.status,
        last_event_at: iso(r.last_event_at as Date | null),
        last_heartbeat_at: iso(r.last_heartbeat_at as Date | null),
        sensor: { id: r.sensor_id, hostname: r.hostname, status: r.sensor_status },
        events_24h: r.events_24h,
      })),
    };
  });

  app.get('/v1/projects/:pid/containment', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const reports = (await rawSql`
      select distinct on (c.sensor_id) c.id, c.sensor_id, c.passed, c.checks, c.created_at, s.hostname, s.manifest->'posture' as posture
      from containment_reports c left join sensors s on s.id = c.sensor_id
      where c.project_id = ${project.id}::uuid order by c.sensor_id, c.created_at desc
    `) as unknown as {
      id: string;
      sensor_id: string | null;
      passed: boolean;
      checks: unknown;
      created_at: Date;
      hostname: string | null;
      posture: unknown;
    }[];
    const history = (await rawSql`
      select id, passed, created_at from containment_reports where project_id = ${project.id}::uuid order by created_at desc limit 20
    `) as unknown as { id: string; passed: boolean; created_at: Date }[];
    return {
      passed: reports.length > 0 && reports.every((r) => r.passed),
      latest: reports.map((r) => ({
        id: r.id,
        sensor_id: r.sensor_id,
        hostname: r.hostname,
        passed: r.passed,
        checks: r.checks,
        declared_posture: r.posture,
        created_at: iso(r.created_at),
      })),
      history: history.map((h) => ({ id: h.id, passed: h.passed, created_at: iso(h.created_at) })),
    };
  });

  app.get('/v1/projects/:pid/audit', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const q = parse(Page, req.query);
    const offset = decodeOffset(q.cursor);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, project.id))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(q.limit + 1)
      .offset(offset);
    const page = pageOf(rows, q.limit, offset);
    return {
      items: page.items.map((a) => ({
        id: a.id,
        actor_type: a.actorType,
        actor_id: a.actorId,
        action: a.action,
        target_type: a.targetType,
        target_id: a.targetId,
        metadata: a.metadata,
        ip: a.ip,
        created_at: iso(a.createdAt),
      })),
      next_cursor: page.next_cursor,
    };
  });

  void dsql;
}
