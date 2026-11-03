import type { DecoyEvent, Detection } from '@lxs/schema';
import { and, asc, sql as dsql, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { aiSummaries, attackers, detections, events, incidents, projects } from '../db/schema.js';
import { enqueueNarrate, type ProcessEventsJob } from '../jobs/queue.js';
import { sha256hex } from '../lib/crypto.js';
import { STREAM_CHANNEL, streamPayload } from '../lib/notify.js';
import { compactIncident, type IncidentRow, incidentSummaryCols } from '../lib/serialize.js';
import {
  type ChainResult,
  commonCredentials,
  type DetectionContext,
  loadDetection,
} from './detection.js';
import { buildTemplateSummary } from './narrative.js';
import { llmConfig } from './narrator.js';

const INACTIVITY_MS = 24 * 3600 * 1000;
const MAX_PER_RUN = 5000;
const CHAIN_LIMIT = 5000;

type EventRow = typeof events.$inferSelect;

/** Rebuild the agent-side flat `DecoyEvent` from a stored row. `id` is the DB uuid so evidence links resolve. */
export function toDecoyEvent(r: EventRow): DecoyEvent {
  const f = (r.fields ?? {}) as Record<string, unknown>;
  const { sensor_kind, decoy_key, ...rest } = f;
  return {
    ...rest,
    id: r.id,
    schema_version: 1,
    timestamp: r.occurredAt.toISOString(),
    sensor: (sensor_kind as DecoyEvent['sensor']) ?? 'sdk',
    decoy_id: (decoy_key as string | undefined) ?? undefined,
    is_decoy: r.isDecoy,
    session_id: r.sessionId ?? undefined,
    src_ip: r.srcIp,
    src_port: r.srcPort ?? undefined,
    dst_service: r.dstService,
    event_type: r.eventType as DecoyEvent['event_type'],
    outcome: (r.outcome as DecoyEvent['outcome']) ?? undefined,
    count: r.count,
    simulated: r.simulated,
  } as DecoyEvent;
}

/* ------------------------------ context ---------------------------------- */

const ctxCache = new Map<string, { at: number; criticalAssets: string[] }>();

async function loadCriticalAssets(tx: Tx, projectId: string): Promise<string[]> {
  const hit = ctxCache.get(projectId);
  if (hit && Date.now() - hit.at < 30_000) return hit.criticalAssets;
  const rows = (await tx.execute(dsql`
    select a->>'name' as name, a->>'pattern' as pattern
    from sensors s,
         jsonb_array_elements(case when jsonb_typeof(s.manifest->'assets') = 'array' then s.manifest->'assets' else '[]'::jsonb end) a
    where s.project_id = ${projectId}::uuid and a->>'criticality' = 'critical'
  `)) as unknown as { name: string | null; pattern: string | null }[];
  const list = [
    ...new Set(rows.flatMap((r) => [r.name, r.pattern]).filter((x): x is string => !!x)),
  ];
  ctxCache.set(projectId, { at: Date.now(), criticalAssets: list });
  return list;
}

/* ------------------------------ main -------------------------------------- */

export async function processEvents(
  job: ProcessEventsJob = {},
): Promise<{ processed: number; groups: number }> {
  const filters = [isNull(events.processedAt)];
  if (job.eventIds?.length) filters.push(inArray(events.id, job.eventIds));
  if (job.projectId) filters.push(eq(events.projectId, job.projectId));

  const pending = await db
    .select({ id: events.id, projectId: events.projectId, srcIp: events.srcIp })
    .from(events)
    .where(and(...filters))
    .orderBy(asc(events.occurredAt))
    .limit(MAX_PER_RUN);
  if (pending.length === 0) return { processed: 0, groups: 0 };

  const groups = new Map<string, { projectId: string; srcIp: string; ids: string[] }>();
  for (const p of pending) {
    const k = `${p.projectId}|ip:${p.srcIp}`;
    const g = groups.get(k) ?? { projectId: p.projectId, srcIp: p.srcIp, ids: [] };
    g.ids.push(p.id);
    groups.set(k, g);
  }

  let processed = 0;
  let firstError: unknown;
  for (const g of groups.values()) {
    try {
      const { count, incidentId } = await processGroup(g.projectId, g.srcIp, g.ids);
      processed += count;
      // After commit, so a slow narrator can never hold up or roll back a verdict.
      if (incidentId && llmConfig) await enqueueNarrate(incidentId);
    } catch (err) {
      firstError ??= err;
      console.error('[process-events] group failed', g.projectId, g.srcIp, err);
    }
  }
  if (firstError) throw firstError; // let pg-boss retry; processed rows are already committed
  return { processed, groups: groups.size };
}

async function processGroup(
  projectId: string,
  srcIp: string,
  ids: string[],
): Promise<{ count: number; incidentId: string | null }> {
  const det = await loadDetection();
  const entityKey = `ip:${srcIp}`;

  return db.transaction(async (tx) => {
    // Serialise all work for one source so two batches can never open two incidents.
    await tx.execute(
      dsql`select pg_advisory_xact_lock(hashtextextended(${`${projectId}|${entityKey}`}, 0))`,
    );

    const rows = await tx
      .select()
      .from(events)
      .where(and(inArray(events.id, ids), isNull(events.processedAt)))
      .orderBy(asc(events.occurredAt), asc(events.id));
    if (rows.length === 0) return { count: 0, incidentId: null };

    // Allowlisted sources are stored but never raise incidents.
    const allow = (await tx.execute(
      dsql`select exists(select 1 from projects where id = ${projectId}::uuid and ${srcIp}::inet <<= any(allowlist)) as hit`,
    )) as unknown as { hit: boolean }[];
    if (allow[0]?.hit) {
      await tx
        .update(events)
        .set({ processedAt: dsql`now()`, tags: dsql`array_append(tags, 'allowlisted')` })
        .where(
          inArray(
            events.id,
            rows.map((r) => r.id),
          ),
        );
      return { count: rows.length, incidentId: null };
    }

    const baseCtx: DetectionContext = {
      now: new Date(),
      commonCredentials: commonCredentials(),
      criticalAssets: await loadCriticalAssets(tx, projectId),
    };

    const tagged = rows.map((row) => {
      const ev = toDecoyEvent(row);
      return { row, ev, tag: det.tagEvent(ev, baseCtx) };
    });
    const firstAt = rows[0]!.occurredAt;
    const lastAt = rows[rows.length - 1]!.occurredAt;

    // Do not create an attacker/incident for every source that merely touches a
    // decoy. Keep those events fully searchable and tagged, then promote their
    // retained evidence if that source becomes meaningful within the window.
    const [priorAttacker] = await tx
      .select({ id: attackers.id })
      .from(attackers)
      .where(and(eq(attackers.projectId, projectId), eq(attackers.entityKey, entityKey)))
      .limit(1);
    const activeIncident = priorAttacker
      ? (
          await tx
            .select({ id: incidents.id, lastEventAt: incidents.lastEventAt })
            .from(incidents)
            .where(
              and(
                eq(incidents.projectId, projectId),
                eq(incidents.attackerId, priorAttacker.id),
                inArray(incidents.status, ['open', 'acknowledged']),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    if (
      activeIncident &&
      firstAt.getTime() - activeIncident.lastEventAt.getTime() > INACTIVITY_MS
    ) {
      await tx
        .update(incidents)
        .set({
          status: 'resolved',
          resolvedAt: dsql`now()`,
          resolvedBy: 'system:inactivity',
          updatedAt: dsql`now()`,
        })
        .where(eq(incidents.id, activeIncident.id));
    }
    const currentIncident =
      activeIncident && firstAt.getTime() - activeIncident.lastEventAt.getTime() <= INACTIVITY_MS
        ? activeIncident
        : undefined;
    const priorRows = currentIncident
      ? []
      : await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.projectId, projectId),
              eq(events.srcIp, srcIp),
              notInArray(events.id, ids),
              isNull(events.attackerId),
              isNull(events.incidentId),
              dsql`${events.processedAt} is not null`,
              dsql`${events.occurredAt} >= ${new Date(firstAt.getTime() - INACTIVITY_MS).toISOString()}::timestamptz`,
              dsql`${events.occurredAt} <= ${lastAt.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(dsql`${events.occurredAt} desc`, dsql`${events.id} desc`)
          .limit(CHAIN_LIMIT);
    priorRows.reverse();
    const evidenceRows = [...priorRows, ...rows].slice(-CHAIN_LIMIT);
    const evidenceEvents = evidenceRows.map(toDecoyEvent);

    if (!currentIncident) {
      const initialVerdict = det.evaluateChain(evidenceEvents, baseCtx);
      if (!shouldOpenIndividualIncident(initialVerdict)) {
        const payload = tagged.map((t) => ({
          id: t.row.id,
          tags: [t.tag.category, ...t.tag.ruleHints],
          techs: t.tag.techniques.map((x) => x.id),
          stage: t.tag.stage,
        }));
        await tx.execute(dsql`
          update events e set
            processed_at = now(),
            tags = ARRAY(select jsonb_array_elements_text(t.tags)),
            techniques = ARRAY(select jsonb_array_elements_text(t.techs)),
            stage = t.stage
          from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as t(id uuid, tags jsonb, techs jsonb, stage text)
          where e.id = t.id
        `);
        await tx.execute(
          dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, 'event.new', {
            total: rows.length,
            events: tagged.slice(-50).map((t) => ({
              id: t.row.id,
              event_type: t.row.eventType,
              is_decoy: t.row.isDecoy,
              src_ip: t.row.srcIp,
              dst_service: t.row.dstService,
              decoy_id: t.ev.decoy_id ?? null,
              outcome: t.row.outcome,
              occurred_at: t.row.occurredAt.toISOString(),
              incident_id: null,
              stage: t.tag.stage,
              simulated: t.row.simulated,
            })),
          })})`,
        );
        return { count: rows.length, incidentId: null };
      }
    }

    // Attacker upsert
    const [attacker] = await tx
      .insert(attackers)
      .values({ projectId, entityKey, ip: srcIp, firstSeenAt: firstAt, lastSeenAt: lastAt })
      .onConflictDoUpdate({
        target: [attackers.projectId, attackers.entityKey],
        set: {
          firstSeenAt: dsql`least(${attackers.firstSeenAt}, ${firstAt.toISOString()}::timestamptz)`,
          lastSeenAt: dsql`greatest(${attackers.lastSeenAt}, ${lastAt.toISOString()}::timestamptz)`,
        },
      })
      .returning();
    if (!attacker) throw new Error('attacker upsert failed');

    // Find or open the incident (one active per attacker; 24 h inactivity starts a new one).
    let [incident] = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.projectId, projectId),
          eq(incidents.attackerId, attacker.id),
          inArray(incidents.status, ['open', 'acknowledged']),
        ),
      )
      .limit(1);
    if (incident && firstAt.getTime() - incident.lastEventAt.getTime() > INACTIVITY_MS) {
      await tx
        .update(incidents)
        .set({
          status: 'resolved',
          resolvedAt: dsql`now()`,
          resolvedBy: 'system:inactivity',
          updatedAt: dsql`now()`,
        })
        .where(eq(incidents.id, incident.id));
      incident = undefined;
    }
    let isNew = false;
    if (!incident) {
      const [seq] = await tx
        .update(projects)
        .set({ incidentSeq: dsql`${projects.incidentSeq} + 1` })
        .where(eq(projects.id, projectId))
        .returning({ n: projects.incidentSeq });
      const [created] = await tx
        .insert(incidents)
        .values({
          projectId,
          number: seq!.n,
          attackerId: attacker.id,
          title: `Activity from ${srcIp}`,
          firstEventAt: firstAt,
          lastEventAt: lastAt,
          openedAt: new Date(),
        })
        .returning();
      incident = created!;
      isNew = true;
    }
    const incidentId = incident.id;
    // An AI summary stays up while it is refreshed: dropping back to the template on every
    // batch would flicker during a live attack. The narrator replaces it within one window.
    const hasAiSummary = incident.aiStatus === 'ready';

    // A low-signal source can become significant later. Promote its retained
    // events alongside the triggering batch so the incident timeline and
    // detection evidence cover the complete bounded correlation window.
    if (priorRows.length) {
      await tx
        .update(events)
        .set({ attackerId: attacker.id, incidentId })
        .where(
          inArray(
            events.id,
            priorRows.map((r) => r.id),
          ),
        );
    }

    // Attach events (single statement) with their tags.
    const payload = tagged.map((t) => ({
      id: t.row.id,
      tags: [t.tag.category, ...t.tag.ruleHints],
      techs: t.tag.techniques.map((x) => x.id),
      stage: t.tag.stage,
    }));
    await tx.execute(dsql`
      update events e set
        attacker_id = ${attacker.id}::uuid,
        incident_id = ${incidentId}::uuid,
        processed_at = now(),
        tags = ARRAY(select jsonb_array_elements_text(t.tags)),
        techniques = ARRAY(select jsonb_array_elements_text(t.techs)),
        stage = t.stage
      from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as t(id uuid, tags jsonb, techs jsonb, stage text)
      where e.id = t.id
    `);

    // Evaluate the whole chain (pure, deterministic).
    const chainRows = await tx
      .select()
      .from(events)
      .where(eq(events.incidentId, incidentId))
      .orderBy(asc(events.occurredAt), asc(events.id))
      .limit(CHAIN_LIMIT);
    const existingRows = await tx
      .select()
      .from(detections)
      .where(eq(detections.incidentId, incidentId));
    const existing: Detection[] = existingRows.map((d) => ({
      rule_id: d.ruleId,
      points: d.points,
      reason: d.reason,
      techniques: d.techniques as Detection['techniques'],
      stage: d.stage as Detection['stage'],
      floor: d.floor as Detection['floor'],
      evidence_event_ids: d.evidenceEventIds,
    }));
    const verdict = det.evaluateChain(chainRows.map(toDecoyEvent), {
      ...baseCtx,
      existingDetections: existing,
    });

    // Replace detections.
    await tx.delete(detections).where(eq(detections.incidentId, incidentId));
    const seen = new Set<string>();
    const detRows = verdict.detections
      .filter((d) => {
        const key = `${d.rule_id}|${d.reason}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((d) => ({
        incidentId,
        ruleId: d.rule_id,
        points: d.points,
        reason: d.reason,
        techniques: d.techniques,
        stage: d.stage,
        floor: d.floor,
        evidenceEventIds: d.evidence_event_ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)),
      }));
    if (detRows.length) await tx.insert(detections).values(detRows);

    // Update the incident from the verdict.
    const techIds = new Set<string>();
    for (const d of verdict.detections) for (const t of d.techniques) techIds.add(t.id);
    for (const r of chainRows) for (const t of r.techniques) techIds.add(t);
    const first = chainRows[0]?.occurredAt ?? firstAt;
    const last = chainRows[chainRows.length - 1]?.occurredAt ?? lastAt;
    const eventCount = chainRows.reduce((s, r) => s + r.count, 0);
    const title = makeTitle(srcIp, verdict);
    await tx
      .update(incidents)
      .set({
        score: verdict.score,
        severity: verdict.severity,
        label: verdict.label,
        floor: verdict.floor ?? null,
        stages: verdict.stagesReached,
        techniques: [...techIds],
        realAssetReached: verdict.realAssetReached,
        honeytokenUsed: verdict.honeytokenUsed,
        title,
        eventCount,
        firstEventAt: first,
        lastEventAt: last,
        aiStatus: hasAiSummary ? 'ready' : 'fallback',
        updatedAt: dsql`now()`,
      })
      .where(eq(incidents.id, incidentId));

    if (!hasAiSummary) await upsertFallbackSummary(tx, incidentId, srcIp, verdict, eventCount);

    // Attacker rollup.
    const cadence = verdict.detections.some((d) => d.rule_id === 'R13')
      ? 'human'
      : eventCount >= 5
        ? 'bot'
        : 'unknown';
    await tx.execute(dsql`
      update attackers a set
        event_count = s.n,
        session_count = s.sessions,
        decoys_touched = s.kinds,
        first_seen_at = least(a.first_seen_at, s.first_at),
        last_seen_at = greatest(a.last_seen_at, s.last_at),
        label = ${verdict.label},
        cadence = ${cadence},
        fingerprints = s.fp
      from (
        select coalesce(sum(count), 0)::int as n,
               count(distinct session_id)::int as sessions,
               coalesce(array_agg(distinct fields->>'sensor_kind') filter (where is_decoy and fields->>'sensor_kind' is not null), '{}'::text[]) as kinds,
               min(occurred_at) as first_at, max(occurred_at) as last_at,
               jsonb_build_object(
                 'user_agents', coalesce((select jsonb_agg(x) from (select distinct fields->>'user_agent' as x from events where attacker_id = ${attacker.id}::uuid and fields->>'user_agent' is not null limit 5) q), '[]'::jsonb),
                 'client_banners', coalesce((select jsonb_agg(x) from (select distinct fields->>'client_banner' as x from events where attacker_id = ${attacker.id}::uuid and fields->>'client_banner' is not null limit 5) q), '[]'::jsonb)
               ) as fp
        from events where attacker_id = ${attacker.id}::uuid
      ) s
      where a.id = ${attacker.id}::uuid
    `);

    // Honeytoken first use.
    const tokenIds = [
      ...new Set(
        rows
          .filter((r) => r.eventType === 'honeytoken.use')
          .map((r) => (r.fields as { honeytoken_id?: string }).honeytoken_id)
          .filter((x): x is string => !!x),
      ),
    ];
    if (tokenIds.length) {
      await tx.execute(
        dsql`update honeytokens set first_used_at = now() where project_id = ${projectId}::uuid and first_used_at is null and id in (select jsonb_array_elements_text(${JSON.stringify(tokenIds)}::jsonb))`,
      );
    }

    // Stream: NOTIFY is transactional, listeners only hear it if this commits.
    const [row] = (await tx
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(eq(incidents.id, incidentId))) as IncidentRow[];
    const notify = (type: Parameters<typeof streamPayload>[1], data: unknown) =>
      tx.execute(
        dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, type, data)})`,
      );
    if (row) await notify(isNew ? 'incident.new' : 'incident.updated', compactIncident(row));
    await notify('event.new', {
      total: rows.length,
      events: tagged.slice(-50).map((t) => ({
        id: t.row.id,
        event_type: t.row.eventType,
        is_decoy: t.row.isDecoy,
        src_ip: t.row.srcIp,
        dst_service: t.row.dstService,
        decoy_id: t.ev.decoy_id ?? null,
        outcome: t.row.outcome,
        occurred_at: t.row.occurredAt.toISOString(),
        incident_id: incidentId,
        stage: t.tag.stage,
        simulated: t.row.simulated,
      })),
    });
    await notify('incident.ai', { id: incidentId, status: hasAiSummary ? 'ready' : 'fallback' });

    return { count: rows.length, incidentId };
  });
}

/**
 * Noise-only decoy touches remain events, not incidents. Strong outcomes,
 * medium-or-higher scoring, and substantive detector rules still get an
 * individual source incident. R01 alone is the generic decoy-touch signal.
 */
export function shouldOpenIndividualIncident(verdict: ChainResult): boolean {
  return (
    verdict.realAssetReached ||
    verdict.honeytokenUsed ||
    verdict.floor !== null ||
    verdict.score >= 25 ||
    verdict.label === 'targeted' ||
    verdict.detections.some((d) => d.rule_id !== 'R01' && d.points >= 10)
  );
}

function makeTitle(ip: string, v: ChainResult): string {
  const label =
    v.label === 'targeted'
      ? 'Targeted'
      : v.label === 'opportunistic'
        ? 'Opportunistic'
        : 'Noise-level';
  if (v.honeytokenUsed) return `${label} source ${ip} used a honeytoken`;
  if (v.realAssetReached) return `${label} source ${ip} reached a real asset`;
  const last = v.stagesReached[v.stagesReached.length - 1];
  return last
    ? `${label} activity from ${ip}: ${last.replace('_', ' ')}`
    : `${label} activity from ${ip}`;
}

/** The instant summary every incident gets. The narrator job then replaces it if an LLM answers. */
async function upsertFallbackSummary(
  tx: Tx,
  incidentId: string,
  ip: string,
  v: ChainResult,
  eventCount: number,
): Promise<void> {
  const output = buildTemplateSummary({
    ip,
    severity: v.severity,
    label: v.label,
    stages: v.stagesReached,
    eventCount,
    realAssetReached: v.realAssetReached,
    honeytokenUsed: v.honeytokenUsed,
    detections: v.detections,
  });
  const fingerprint = sha256hex(
    JSON.stringify({
      incidentId,
      rules: v.detections.map((d) => [d.rule_id, d.points, d.reason]),
      s: v.score,
      l: v.label,
      c: eventCount,
    }),
  );
  await tx
    .insert(aiSummaries)
    .values({
      incidentId,
      fingerprint,
      promptVersion: 'fallback-1',
      output,
      isFallback: true,
      provider: 'template',
      model: 'none',
    })
    .onConflictDoNothing();
}
