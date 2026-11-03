import { and, asc, eq, ne, sql as dsql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiSummaries, attackers, detections, events, incidents, projects } from '../db/schema.js';
import { STREAM_CHANNEL, streamPayload } from '../lib/notify.js';
import { llmProvider } from './narrator.js';
import { commonCredentials, loadDetection } from './detection.js';
import { computeUncovered, needsAssessment, uncoveredFingerprint } from './uncovered.js';
import { AiAssessment, buildPrompt, clampAssessment, OUTPUT_SCHEMA, PROMPT_VERSION } from './prompt.js';
import { toDecoyEvent } from './process-events.js';

const MAX_EVENTS = 5000;

export async function assessIncident(incidentId: string): Promise<'skipped' | 'cached' | 'generated' | 'capped' | 'failed'> {
  if (!llmProvider) return 'skipped';
  const [data] = await db.select({ incident: incidents, projectAi: projects.aiEnabled, dailyCap: projects.aiDailyCap })
    .from(incidents).innerJoin(projects, eq(projects.id, incidents.projectId))
    .innerJoin(attackers, eq(attackers.id, incidents.attackerId)).where(eq(incidents.id, incidentId)).limit(1);
  if (!data) return 'skipped';
  const { incident } = data;
  if (!data.projectAi) {
    await updateStatus(incident.projectId, incidentId, 'fallback');
    return 'skipped';
  }
  const [evRows, detRows] = await Promise.all([
    db.select().from(events).where(eq(events.incidentId, incidentId)).orderBy(asc(events.occurredAt)).limit(MAX_EVENTS),
    db.select().from(detections).where(eq(detections.incidentId, incidentId)),
  ]);
  const det = await loadDetection();
  const ctx = { now: new Date(), commonCredentials: commonCredentials(), criticalAssets: [] };
  const tagged = evRows.map((row) => {
    const event = toDecoyEvent(row);
    return { event, tag: det.tagEvent(event, ctx) };
  });
  const uncovered = computeUncovered(tagged, detRows.flatMap((d) => d.evidenceEventIds));
  const allEvents = evRows.map(toDecoyEvent);
  if (!needsAssessment({ aiEnabled: data.projectAi, label: incident.label, uncovered, events: allEvents })) {
    await updateStatus(incident.projectId, incidentId, 'fallback');
    return 'skipped';
  }

  const fingerprint = uncoveredFingerprint(uncovered, incident.label);
  const [hit] = await db.select().from(aiSummaries).where(and(
    dsql`${aiSummaries.fingerprint} like ${`${fingerprint}:%`}`,
    eq(aiSummaries.promptVersion, PROMPT_VERSION), eq(aiSummaries.isFallback, false),
  )).limit(1);
  if (hit) {
    await storeAssessment(incident.projectId, incidentId, `${fingerprint}:${incidentId}`, hit.output, null, hit.model, hit.provider);
    return 'cached';
  }

  const [count] = await db.select({ n: dsql<number>`count(*)::int` }).from(aiSummaries)
    .innerJoin(incidents, eq(incidents.id, aiSummaries.incidentId))
    .where(and(eq(incidents.projectId, incident.projectId), ne(aiSummaries.provider, 'template'),
      dsql`${aiSummaries.isFallback} = false`,
      dsql`${aiSummaries.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`));
  if ((count?.n ?? 0) >= data.dailyCap) {
    console.warn(`[assess-incident] project ${incident.projectId}: daily AI cap reached`);
    await updateStatus(incident.projectId, incidentId, 'fallback');
    return 'capped';
  }

  await updateStatus(incident.projectId, incidentId, 'generating');
  const prompt = buildPrompt({
    incidentId, label: incident.label, severity: incident.severity, score: incident.score,
    stages: incident.stages, eventCount: incident.eventCount,
    firedRules: detRows.map((d) => ({ rule_id: d.ruleId, reason: d.reason })), uncovered,
  });
  const started = Date.now();
  try {
    const reply = await llmProvider.complete({ system: prompt.system, user: prompt.user, schema: OUTPUT_SCHEMA });
    const parsed = clampAssessment(JSON.parse(reply.text));
    const output = { ...parsed, assessment: true };
    await storeAssessment(incident.projectId, incidentId, `${fingerprint}:${incidentId}`, output, Date.now() - started, reply.model);
    return 'generated';
  } catch (err) {
    console.warn(`[assess-incident] incident ${incidentId}: assessment failed`, err instanceof Error ? err.message : err);
    await updateStatus(incident.projectId, incidentId, 'error');
    return 'failed';
  }
}

async function storeAssessment(projectId: string, incidentId: string, fingerprint: string, output: unknown, latencyMs: number | null, model = llmProvider?.model ?? 'unknown', provider = llmProvider?.name ?? 'unknown'): Promise<void> {
  const candidate = output && typeof output === 'object' ? { ...output as Record<string, unknown> } : output;
  if (candidate && typeof candidate === 'object') delete (candidate as Record<string, unknown>).assessment;
  const validated = AiAssessment.parse(candidate);
  const marked = { ...validated, assessment: true };
  await db.transaction(async (tx) => {
    await tx.insert(aiSummaries).values({ incidentId, fingerprint, promptVersion: PROMPT_VERSION, output: marked,
      isFallback: false, provider, model, latencyMs })
      .onConflictDoUpdate({ target: [aiSummaries.fingerprint, aiSummaries.promptVersion], set: {
        incidentId, output: marked, isFallback: false, provider, model, latencyMs, createdAt: dsql`now()`,
      } });
    await tx.update(incidents).set({ aiStatus: 'ready', updatedAt: dsql`now()` }).where(eq(incidents.id, incidentId));
    await tx.execute(dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, 'incident.ai', { id: incidentId, status: 'ready', kind: 'assessment' })})`);
    await tx.execute(dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, 'incident.ai_ready', { id: incidentId })})`);
  });
}

async function updateStatus(projectId: string, incidentId: string, status: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(incidents).set({ aiStatus: status, updatedAt: dsql`now()` }).where(eq(incidents.id, incidentId));
    await tx.execute(dsql`select pg_notify(${STREAM_CHANNEL}, ${streamPayload(projectId, 'incident.ai', { id: incidentId, status })})`);
  });
}
