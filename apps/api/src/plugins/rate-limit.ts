import rateLimit from '@fastify/rate-limit';
import { sql as dsql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { sha256hex } from '../lib/crypto.js';

export interface IngestQuotaInput {
  projectId: string;
  sensorId: string | null;
  eventCount: number;
  byteCount: number;
}

export type IngestQuotaResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number; scope: 'project' | 'sensor' };

export function buildIngestQuotaScopes(
  projectId: string,
  sensorId: string | null,
  activeSensors = 1,
) {
  const fairShareEvents = Math.max(
    1,
    Math.floor(env.INGEST_PROJECT_EVENTS_PER_MIN / activeSensors),
  );
  const fairShareBytes = Math.max(1, Math.floor(env.INGEST_PROJECT_BYTES_PER_MIN / activeSensors));
  return [
    {
      scopeKey: `project:${projectId}`,
      scope: 'project' as const,
      maxEvents: env.INGEST_PROJECT_EVENTS_PER_MIN,
      maxBytes: env.INGEST_PROJECT_BYTES_PER_MIN,
    },
    ...(sensorId
      ? [
          {
            scopeKey: `sensor:${sensorId}`,
            scope: 'sensor' as const,
            maxEvents: Math.min(env.INGEST_SENSOR_EVENTS_PER_MIN, fairShareEvents),
            maxBytes: Math.min(env.INGEST_SENSOR_BYTES_PER_MIN, fairShareBytes),
          },
        ]
      : []),
  ];
}

export function exceedsIngestQuota(
  currentEvents: number,
  currentBytes: number,
  addEvents: number,
  addBytes: number,
  maxEvents: number,
  maxBytes: number,
): boolean {
  return currentEvents + addEvents > maxEvents || currentBytes + addBytes > maxBytes;
}

/**
 * Reserve a fixed one-minute budget in Postgres. Transactional upserts make the
 * project and sensor budgets shared and race-safe across API replicas. A
 * rejected sensor reservation rolls back the project reservation as well.
 */
export async function reserveIngestQuota(input: IngestQuotaInput): Promise<IngestQuotaResult> {
  const activeRows = (await db.execute(dsql`
    SELECT GREATEST(1, COUNT(*)::int) AS active_sensors
    FROM sensors
    WHERE project_id = ${input.projectId}::uuid
      AND status = 'online'
      AND last_seen_at >= now() - interval '2 minutes'
  `)) as unknown as { active_sensors: number }[];
  const activeSensors = Number(activeRows[0]?.active_sensors ?? 1);
  const limits = buildIngestQuotaScopes(input.projectId, input.sensorId, activeSensors);

  const retryAfter = async () => {
    const rows = (await db.execute(dsql`
      SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (date_trunc('minute', now()) + interval '1 minute' - now())))::int) AS retry_after
    `)) as unknown as { retry_after: number }[];
    return Number(rows[0]?.retry_after ?? 60);
  };
  const tooLarge = limits.find((limit) =>
    exceedsIngestQuota(0, 0, input.eventCount, input.byteCount, limit.maxEvents, limit.maxBytes),
  );
  if (tooLarge) return { allowed: false, retryAfter: await retryAfter(), scope: tooLarge.scope };

  class QuotaExceeded extends Error {
    constructor(readonly scope: 'project' | 'sensor') {
      super('ingest quota exceeded');
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const limit of limits) {
        const reserved = await tx.execute(dsql`
          INSERT INTO ingest_usage (scope_key, project_id, window_start, requests, events, bytes)
          VALUES (${limit.scopeKey}, ${input.projectId}::uuid, date_trunc('minute', now()), 1, ${input.eventCount}, ${input.byteCount})
          ON CONFLICT (scope_key) DO UPDATE SET
            window_start = CASE
              WHEN ingest_usage.window_start < date_trunc('minute', now()) THEN date_trunc('minute', now())
              ELSE ingest_usage.window_start
            END,
            requests = CASE WHEN ingest_usage.window_start < date_trunc('minute', now()) THEN 1 ELSE ingest_usage.requests + 1 END,
            events = CASE WHEN ingest_usage.window_start < date_trunc('minute', now()) THEN ${input.eventCount} ELSE ingest_usage.events + ${input.eventCount} END,
            bytes = CASE WHEN ingest_usage.window_start < date_trunc('minute', now()) THEN ${input.byteCount} ELSE ingest_usage.bytes + ${input.byteCount} END
          WHERE ingest_usage.window_start < date_trunc('minute', now())
             OR (ingest_usage.events + ${input.eventCount} <= ${limit.maxEvents}
                 AND ingest_usage.bytes + ${input.byteCount} <= ${limit.maxBytes})
          RETURNING scope_key
        `);
        if (reserved.length === 0) throw new QuotaExceeded(limit.scope);
      }
      // Usage has one row per extant project/sensor scope; prune orphaned old
      // sensor rows for this project so deleted sensors cannot accumulate keys.
      await tx.execute(dsql`
        DELETE FROM ingest_usage
        WHERE project_id = ${input.projectId}::uuid
          AND window_start < date_trunc('minute', now()) - interval '1 hour'
      `);
    });
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof QuotaExceeded)) throw error;
    return { allowed: false, retryAfter: await retryAfter(), scope: error.scope };
  }
}

/** Return a failed storage reservation in the same fixed window, without touching other scopes. */
export async function releaseIngestQuota(input: IngestQuotaInput): Promise<void> {
  const limits = buildIngestQuotaScopes(input.projectId, input.sensorId);
  await db.transaction(async (tx) => {
    for (const limit of limits) {
      await tx.execute(dsql`
        UPDATE ingest_usage SET
          requests = GREATEST(0, requests - 1),
          events = GREATEST(0, events - ${input.eventCount}),
          bytes = GREATEST(0, bytes - ${input.byteCount})
        WHERE scope_key = ${limit.scopeKey}
          AND window_start = date_trunc('minute', now())
      `);
    }
  });
}

/** Route-level config for machine endpoints: limited per key, not per IP. */
export const ingestRateLimit = {
  rateLimit: {
    max: env.INGEST_RATE_PER_MIN,
    timeWindow: '1 minute',
    keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => {
      const auth = req.headers.authorization;
      return typeof auth === 'string' ? `key:${sha256hex(auth).slice(0, 16)}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req: unknown, ctx: { max: number; after: string }) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Ingest limit is ${ctx.max} requests per minute for this key. Retry in ${ctx.after}.`,
    }),
  },
};

export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: true,
    max: env.API_RATE_PER_MIN,
    timeWindow: '1 minute',
    // Health probes stay exempt so monitoring cannot be rate-limited out.
    // /v1/stream used to be exempt too, which left SSE reconnects uncapped on
    // top of there being no connection ceiling; it is now subject to the normal
    // per-IP limit, which a dashboard reconnecting with backoff never reaches.
    allowList: (req) => {
      const url = req.url;
      return url.startsWith('/healthz') || url.startsWith('/readyz');
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Retry in ${ctx.after}.`,
    }),
  });
});
