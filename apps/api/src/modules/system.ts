import { and, count, sql as dsql, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, sql as rawSql } from '../db/client.js';
import { aiSummaries, events, incidents, memberships, projects, sensors } from '../db/schema.js';
import { env } from '../env.js';
import { getBoss } from '../jobs/queue.js';
import { forbidden, HttpError } from '../lib/errors.js';
import { requireSession, userOrgs } from '../plugins/auth-session.js';
import { hub } from '../plugins/sse.js';
import { detectionSource } from '../worker/detection.js';
import { llmConfig } from '../worker/narrator.js';

const startedAt = Date.now();

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/readyz', async () => {
    try {
      await rawSql`select 1`;
    } catch {
      throw new HttpError(503, 'not_ready', 'Database unavailable');
    }
    return { status: 'ready', role: env.ROLE, queue: getBoss() ? 'pg-boss' : 'in-process' };
  });

  app.get('/v1/system', { preHandler: requireSession }, async (req) => {
    const orgs = await userOrgs(req.user!.id);
    if (!orgs.some((o) => o.role === 'owner'))
      throw forbidden('Owner role required', 'insufficient_role');
    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(memberships, eq(memberships.orgId, projects.orgId))
      .where(and(eq(memberships.userId, req.user!.id), eq(memberships.role, 'owner')));
    const projectIds = projectRows.map((p) => p.id);
    const [unprocessed, eventCount, incidentCount, sensorCount] = projectIds.length
      ? await Promise.all([
          db
            .select({ value: count() })
            .from(events)
            .where(and(inArray(events.projectId, projectIds), isNull(events.processedAt))),
          db.select({ value: count() }).from(events).where(inArray(events.projectId, projectIds)),
          db
            .select({ value: count() })
            .from(incidents)
            .where(inArray(incidents.projectId, projectIds)),
          db
            .select({ value: count() })
            .from(sensors)
            .where(and(inArray(sensors.projectId, projectIds), eq(sensors.status, 'online'))),
        ])
      : [[{ value: 0 }], [{ value: 0 }], [{ value: 0 }], [{ value: 0 }]];
    const c = {
      unprocessed_events: Number(unprocessed[0]?.value ?? 0),
      events: Number(eventCount[0]?.value ?? 0),
      incidents: Number(incidentCount[0]?.value ?? 0),
      sensors_online: Number(sensorCount[0]?.value ?? 0),
    };
    // Template rows have provider 'template'; a failed provider call is stored under the provider.
    const [llm] = projectIds.length
      ? await db
          .select({
            calls: dsql<number>`count(*)::int`,
            fallbacks: dsql<number>`(count(*) filter (where ${aiSummaries.isFallback}))::int`,
            p50: dsql<
              number | null
            >`percentile_cont(0.5) within group (order by ${aiSummaries.latencyMs})`,
            p95: dsql<
              number | null
            >`percentile_cont(0.95) within group (order by ${aiSummaries.latencyMs})`,
          })
          .from(aiSummaries)
          .innerJoin(incidents, eq(incidents.id, aiSummaries.incidentId))
          .where(
            and(
              inArray(incidents.projectId, projectIds),
              dsql`${aiSummaries.provider} <> 'template'`,
              dsql`${aiSummaries.createdAt} > now() - interval '24 hours'`,
            ),
          )
      : [];
    const calls = llm?.calls ?? 0;
    const fallbacks = llm?.fallbacks ?? 0;
    return {
      version: '0.1.0',
      role: env.ROLE,
      node: process.version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      queue: getBoss() ? 'pg-boss' : 'in-process',
      detection: detectionSource,
      stream_connections: hub.connections,
      counts: c,
      llm: {
        provider: llmConfig?.provider ?? null,
        model: llmConfig?.model ?? null,
        calls_24h: calls,
        fallbacks_24h: fallbacks,
        success_rate: calls ? (calls - fallbacks) / calls : 0,
        p50_ms: Math.round(Number(llm?.p50 ?? 0)),
        p95_ms: Math.round(Number(llm?.p95 ?? 0)),
      },
      auth: { dev_bypass: env.DEV_AUTH_BYPASS },
    };
  });
}
