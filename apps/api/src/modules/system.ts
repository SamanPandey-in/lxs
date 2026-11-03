import { sql as dsql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, sql as rawSql } from '../db/client.js';
import { env } from '../env.js';
import { getBoss } from '../jobs/queue.js';
import { forbidden, HttpError } from '../lib/errors.js';
import { projectAccess, requireSession, userOrgs } from '../plugins/auth-session.js';
import { hub } from '../plugins/sse.js';
import { detectionSource } from '../worker/detection.js';

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
    const [c] = (await db.execute(dsql`
      select (select count(*) from events where processed_at is null)::int as unprocessed_events,
             (select count(*) from events)::int as events,
             (select count(*) from incidents)::int as incidents,
             (select count(*) from sensors where status = 'online')::int as sensors_online
    `)) as unknown as Record<string, number>[];
    return {
      version: '0.1.0',
      role: env.ROLE,
      node: process.version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      queue: getBoss() ? 'pg-boss' : 'in-process',
      detection: detectionSource,
      stream_connections: hub.connections,
      counts: c,
      auth: { dev_bypass: env.DEV_AUTH_BYPASS },
    };
  });

  void projectAccess;
}
