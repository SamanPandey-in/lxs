import type { IncidentDetail } from '@lxs/schema';
import { and, asc, desc, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  aiSummaries,
  attackers,
  blocklistEntries,
  detections,
  incidentNotes,
  incidents,
  responseActions,
} from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { publish } from '../lib/notify.js';
import { decodeOffset, LimitQuery, pageOf } from '../lib/pagination.js';
import { parse } from '../lib/parse.js';
import {
  compactIncident,
  type IncidentRow,
  incidentSummaryCols,
  iso,
  toIncidentSummary,
} from '../lib/serialize.js';
import { isUuid, projectAccess, type Role, requireSession } from '../plugins/auth-session.js';
import { queryEvents } from './events.js';

const sevRank = dsql`case ${incidents.severity} when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end`;

export async function loadIncident(req: FastifyRequest, iid: string, min: Role = 'viewer') {
  if (!isUuid(iid)) throw notFound('Incident');
  const [row] = (await db
    .select(incidentSummaryCols)
    .from(incidents)
    .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
    .where(eq(incidents.id, iid))
    .limit(1)) as IncidentRow[];
  if (!row) throw notFound('Incident');
  const access = await projectAccess(req, row.projectId, min);
  return { incident: row, ...access };
}

const ListQuery = z.object({
  status: z.string().optional(), // comma separated
  label: z.string().optional(),
  severity: z.string().optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(['recent', 'severity']).default('recent'),
  limit: LimitQuery,
  cursor: z.string().optional(),
});

const Patch = z
  .object({
    status: z.enum(['open', 'acknowledged', 'resolved', 'false_positive']).optional(),
    assignee_id: z.string().max(64).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignee_id !== undefined, {
    message: 'Nothing to update',
  });

const NoteBody = z.object({ body: z.string().trim().min(1).max(4000) });

const csv = (s: string | undefined) =>
  s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };

  app.get('/v1/projects/:pid/incidents', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const q = parse(ListQuery, req.query);
    const offset = decodeOffset(q.cursor);
    const conds = [eq(incidents.projectId, project.id)];
    const st = csv(q.status);
    if (st.length) conds.push(inArray(incidents.status, st));
    const lb = csv(q.label);
    if (lb.length) conds.push(inArray(incidents.label, lb));
    const sv = csv(q.severity);
    if (sv.length) conds.push(inArray(incidents.severity, sv));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(dsql`(${incidents.title} ilike ${like} or host(${attackers.ip}) ilike ${like})`);
    }
    const rows = (await db
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(and(...conds))
      .orderBy(
        ...(q.sort === 'severity'
          ? [desc(sevRank), desc(incidents.score), desc(incidents.lastEventAt)]
          : [desc(incidents.lastEventAt), desc(incidents.id)]),
      )
      .limit(q.limit + 1)
      .offset(offset)) as IncidentRow[];
    const page = pageOf(rows, q.limit, offset);
    return { items: page.items.map(toIncidentSummary), next_cursor: page.next_cursor };
  });

  app.get(
    '/v1/incidents/:iid',
    auth,
    async (req): Promise<IncidentDetail & Record<string, unknown>> => {
      const { incident: r, project } = await loadIncident(req, (req.params as { iid: string }).iid);
      const [dets, ai, [att], notes, actions, blocked] = await Promise.all([
        db
          .select()
          .from(detections)
          .where(eq(detections.incidentId, r.id))
          .orderBy(desc(detections.points), asc(detections.ruleId)),
        db
          .select()
          .from(aiSummaries)
          .where(eq(aiSummaries.incidentId, r.id))
          .orderBy(desc(aiSummaries.createdAt))
          .limit(1),
        db.select().from(attackers).where(eq(attackers.id, r.attackerId)).limit(1),
        db
          .select({ n: dsql<number>`count(*)::int` })
          .from(incidentNotes)
          .where(eq(incidentNotes.incidentId, r.id)),
        db
          .select()
          .from(responseActions)
          .where(eq(responseActions.incidentId, r.id))
          .orderBy(desc(responseActions.requestedAt))
          .limit(20),
        db
          .select({ id: blocklistEntries.id, expiresAt: blocklistEntries.expiresAt })
          .from(blocklistEntries)
          .where(
            and(
              eq(blocklistEntries.projectId, project.id),
              eq(blocklistEntries.ip, r.srcIp),
              dsql`${blocklistEntries.removedAt} is null`,
            ),
          )
          .limit(1),
      ]);
      const techDetails = new Map<string, unknown>();
      for (const d of dets)
        for (const t of d.techniques as { id: string }[])
          if (!techDetails.has(t.id)) techDetails.set(t.id, t);

      const out = (ai[0]?.output ?? null) as IncidentDetail['ai_summary'];
      return {
        ...toIncidentSummary(r),
        attacker_id: r.attackerId,
        detections: dets.map((d) => ({
          rule_id: d.ruleId,
          points: d.points,
          reason: d.reason,
          techniques: d.techniques as IncidentDetail['detections'][number]['techniques'],
          stage: d.stage as IncidentDetail['detections'][number]['stage'],
          floor: d.floor as IncidentDetail['detections'][number]['floor'],
          evidence_event_ids: d.evidenceEventIds,
        })),
        ai_summary: out,
        // extras for the UI
        floor: r.floor,
        opened_at: iso(r.openedAt),
        acknowledged_at: iso(r.acknowledgedAt),
        resolved_at: iso(r.resolvedAt),
        assignee_id: r.assigneeId,
        technique_details: [...techDetails.values()],
        attacker: att
          ? {
              id: att.id,
              ip: att.ip,
              cadence: att.cadence,
              label: att.label,
              decoys_touched: att.decoysTouched,
              event_count: att.eventCount,
              session_count: att.sessionCount,
            }
          : null,
        notes_count: notes[0]?.n ?? 0,
        actions: actions.map((a) => ({
          id: a.id,
          type: a.type,
          params: a.params,
          status: a.status,
          requested_at: iso(a.requestedAt),
          applied_at: iso(a.appliedAt),
        })),
        blocked: blocked.length > 0,
        block_entry_id: blocked[0]?.id ?? null,
      };
    },
  );

  app.patch('/v1/incidents/:iid', auth, async (req) => {
    const {
      incident: r,
      project,
      user,
    } = await loadIncident(req, (req.params as { iid: string }).iid, 'analyst');
    const b = parse(Patch, req.body);
    const set: Record<string, unknown> = { updatedAt: dsql`now()` };
    if (b.status) {
      set.status = b.status;
      if (b.status === 'acknowledged') set.acknowledgedAt = r.acknowledgedAt ?? dsql`now()`;
      if (b.status === 'resolved' || b.status === 'false_positive') {
        set.resolvedAt = dsql`now()`;
        set.resolvedBy = user.id;
        set.acknowledgedAt = r.acknowledgedAt ?? dsql`now()`;
      }
      if (b.status === 'open') {
        set.resolvedAt = null;
        set.resolvedBy = null;
      }
    }
    if (b.assignee_id !== undefined) set.assigneeId = b.assignee_id;
    await db.update(incidents).set(set).where(eq(incidents.id, r.id)); // 23505 (another active incident) -> 409
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'incident.update',
      targetType: 'incident',
      targetId: r.id,
      metadata: b,
      req,
    });
    const [row] = (await db
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(eq(incidents.id, r.id))) as IncidentRow[];
    await publish(project.id, 'incident.updated', compactIncident(row!));
    return toIncidentSummary(row!);
  });

  app.get('/v1/incidents/:iid/events', auth, async (req) => {
    const { incident: r, project } = await loadIncident(req, (req.params as { iid: string }).iid);
    const q = parse(
      z.object({
        cursor: z.string().optional(),
        limit: LimitQuery,
        order: z.enum(['asc', 'desc']).default('asc'),
      }),
      req.query,
    );
    return queryEvents({
      projectId: project.id,
      incidentId: r.id,
      order: q.order,
      by: 'occurred_at',
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  app.get('/v1/incidents/:iid/notes', auth, async (req) => {
    const { incident: r } = await loadIncident(req, (req.params as { iid: string }).iid);
    const rows = await db
      .select()
      .from(incidentNotes)
      .where(eq(incidentNotes.incidentId, r.id))
      .orderBy(asc(incidentNotes.createdAt));
    return {
      items: rows.map((n) => ({
        id: n.id,
        author_id: n.authorId,
        body: n.body,
        created_at: iso(n.createdAt),
      })),
    };
  });

  app.post('/v1/incidents/:iid/notes', auth, async (req, reply) => {
    const {
      incident: r,
      project,
      user,
    } = await loadIncident(req, (req.params as { iid: string }).iid, 'analyst');
    const b = parse(NoteBody, req.body);
    const [n] = await db
      .insert(incidentNotes)
      .values({ incidentId: r.id, authorId: user.id, body: b.body })
      .returning();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'incident.note',
      targetType: 'incident',
      targetId: r.id,
      req,
    });
    return reply
      .status(201)
      .send({ id: n!.id, author_id: n!.authorId, body: n!.body, created_at: iso(n!.createdAt) });
  });
}
