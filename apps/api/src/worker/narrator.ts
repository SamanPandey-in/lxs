import { and, desc, sql as dsql, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiSummaries, attackers, detections, events, incidents, projects } from '../db/schema.js';
import { env } from '../env.js';
import { createLlmProvider, type LlmConfig, type LlmProvider, llmConfigFrom } from '../lib/llm.js';
import { STREAM_CHANNEL, streamPayload } from '../lib/notify.js';
import { compactIncident, type IncidentRow, incidentSummaryCols } from '../lib/serialize.js';
import {
  buildFactSheet,
  buildTemplateSummary,
  buildUserPrompt,
  type FactEvent,
  factSheetFingerprint,
  OUTPUT_JSON_SCHEMA,
  PROMPT_VERSION,
  parseLlmOutput,
  type SummaryOutput,
  SYSTEM_PROMPT,
} from './narrative.js';

const MAX_EVENTS = 2000;

export const llmConfig: LlmConfig | null = llmConfigFrom(env);
export const llmProvider: LlmProvider | null = llmConfig ? createLlmProvider(llmConfig) : null;

export type NarrateOutcome = 'skipped' | 'cached' | 'generated' | 'capped' | 'failed';

/**
 * The narrate-incident job. Runs after the deterministic pipeline has committed, so a
 * slow or failing provider can never delay or alter a verdict. Provider failures end in
 * a template row, not a thrown error: only a database problem should make the queue retry.
 */
export async function narrateIncident(incidentId: string): Promise<NarrateOutcome> {
  if (!llmProvider) return 'skipped';

  const [row] = await db
    .select({
      incident: incidents,
      ip: attackers.ip,
      aiEnabled: projects.aiEnabled,
    })
    .from(incidents)
    .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
    .innerJoin(projects, eq(projects.id, incidents.projectId))
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!row?.aiEnabled) return 'skipped';
  const { incident, ip } = row;

  const [dets, evRows] = await Promise.all([
    db.select().from(detections).where(eq(detections.incidentId, incidentId)),
    db
      .select()
      .from(events)
      .where(eq(events.incidentId, incidentId))
      .orderBy(desc(events.occurredAt))
      .limit(MAX_EVENTS),
  ]);
  const sheet = buildFactSheet(
    {
      number: incident.number,
      source_ip: ip,
      severity: incident.severity,
      label: incident.label,
      score: incident.score,
      stages: incident.stages,
      techniques: incident.techniques,
      real_asset_reached: incident.realAssetReached,
      honeytoken_used: incident.honeytokenUsed,
      event_count: incident.eventCount,
    },
    dets.map((d) => ({
      ruleId: d.ruleId,
      points: d.points,
      reason: d.reason,
      stage: d.stage,
      evidenceEventIds: d.evidenceEventIds,
    })),
    evRows.reverse().map(
      (e): FactEvent => ({
        id: e.id,
        eventType: e.eventType,
        dstService: e.dstService,
        isDecoy: e.isDecoy,
        outcome: e.outcome,
        count: e.count,
        fields: (e.fields ?? {}) as Record<string, unknown>,
      }),
    ),
  );
  const fingerprint = factSheetFingerprint(incidentId, sheet);
  const template = () =>
    buildTemplateSummary({
      ip,
      severity: incident.severity,
      label: incident.label,
      stages: incident.stages,
      eventCount: incident.eventCount,
      realAssetReached: incident.realAssetReached,
      honeytokenUsed: incident.honeytokenUsed,
      detections: dets.map((d) => ({
        rule_id: d.ruleId,
        points: d.points,
        reason: d.reason,
        floor: d.floor,
      })),
    });

  const store = (
    output: SummaryOutput,
    meta: { provider: string; model: string; latencyMs?: number },
  ) => saveSummary(incident.projectId, incidentId, fingerprint, output, meta, !output.is_fallback);

  // Same facts as an earlier good answer: reuse it rather than pay again.
  const [hit] = await db
    .select()
    .from(aiSummaries)
    .where(
      and(
        eq(aiSummaries.fingerprint, fingerprint),
        eq(aiSummaries.promptVersion, PROMPT_VERSION),
        eq(aiSummaries.isFallback, false),
      ),
    )
    .limit(1);
  if (hit) {
    await store(hit.output as SummaryOutput, { provider: hit.provider, model: hit.model });
    return 'cached';
  }

  if (await overDailyCap(incident.projectId)) {
    await store(template(), { provider: 'template', model: 'daily-cap' });
    return 'capped';
  }

  const llm = llmProvider;
  const started = Date.now();
  try {
    const reply = await llm.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(sheet),
      schema: OUTPUT_JSON_SCHEMA,
    });
    await store(parseLlmOutput(reply.text), {
      provider: llm.name,
      model: reply.model,
      latencyMs: Date.now() - started,
    });
    return 'generated';
  } catch (err) {
    console.warn(
      `[narrator] incident ${incidentId}: falling back to template:`,
      err instanceof Error ? err.message : err,
    );
    // Attributed to the provider, so the System page counts it as a failed call.
    await store(template(), {
      provider: llm.name,
      model: llm.model,
      latencyMs: Date.now() - started,
    });
    return 'failed';
  }
}

/** Calls this UTC day, failures included: a failed call can still be a billed one. */
async function overDailyCap(projectId: string): Promise<boolean> {
  const [c] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(aiSummaries)
    .innerJoin(incidents, eq(incidents.id, aiSummaries.incidentId))
    .where(
      and(
        eq(incidents.projectId, projectId),
        ne(aiSummaries.provider, 'template'),
        dsql`${aiSummaries.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
      ),
    );
  return (c?.n ?? 0) >= env.LLM_DAILY_CAP;
}

async function saveSummary(
  projectId: string,
  incidentId: string,
  fingerprint: string,
  output: SummaryOutput,
  meta: { provider: string; model: string; latencyMs?: number },
  ready: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The upsert bumps created_at: the incident page shows whichever row is newest.
    await tx
      .insert(aiSummaries)
      .values({
        incidentId,
        fingerprint,
        promptVersion: PROMPT_VERSION,
        output,
        isFallback: output.is_fallback,
        provider: meta.provider,
        model: meta.model,
        latencyMs: meta.latencyMs ?? null,
      })
      .onConflictDoUpdate({
        target: [aiSummaries.fingerprint, aiSummaries.promptVersion],
        set: {
          output,
          isFallback: output.is_fallback,
          provider: meta.provider,
          model: meta.model,
          latencyMs: meta.latencyMs ?? null,
          createdAt: dsql`now()`,
        },
      });
    const status = ready ? 'ready' : 'fallback';
    await tx.update(incidents).set({
      aiStatus: dsql`case when ${incidents.aiStatus} = 'generating' then 'generating' else ${status} end`,
    }).where(eq(incidents.id, incidentId));
    const [row] = (await tx
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(eq(incidents.id, incidentId))) as IncidentRow[];
    const notify = (type: Parameters<typeof streamPayload>[1], data: unknown) =>
      tx.execute(
        dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, type, data)})`,
      );
    if (row) await notify('incident.updated', compactIncident(row));
    await notify('incident.ai', { id: incidentId, status: row?.aiStatus ?? status });
  });
}
