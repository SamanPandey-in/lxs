import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { env } from '../env.js';
import { getBoss, QUEUES } from '../jobs/queue.js';

/**
 * Prometheus metrics (H, G8). One registry per process; instrumentation sites import the
 * metric objects from here. `GET /metrics` serves the text exposition format.
 *
 * Access: when METRICS_TOKEN is set, a matching `Authorization: Bearer <token>` is required.
 * Without a token the endpoint is open in development/test and absent (404) in production.
 *
 * Worker-side metrics (job duration, detection latency, LLM, notifications) are recorded in
 * the process that runs the worker. ROLE=all exposes everything on one endpoint; a ROLE=worker
 * process has no HTTP server, so its metrics are not scrapeable today (see docs/OPERATIONS.md).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'lxs_process_' });

const SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];

export const ingestRequests = new Counter({
  name: 'lxs_ingest_requests_total',
  help: 'POST /v1/ingest requests by outcome (accepted, quota_exceeded, error)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
export const ingestEvents = new Counter({
  name: 'lxs_ingest_events_total',
  help: 'Ingested events by outcome (accepted, duplicate, rejected, throttled)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
export const ingestBytes = new Counter({
  name: 'lxs_ingest_bytes_total',
  help: 'Ingest envelope bytes (decoded JSON) by request outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const detectionLatency = new Histogram({
  name: 'lxs_detection_latency_seconds',
  help: 'Time from an event being stored (received_at) to its incident being written',
  buckets: SECONDS_BUCKETS,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'lxs_worker_job_duration_seconds',
  help: 'Worker job handler duration by queue and outcome',
  labelNames: ['queue', 'outcome'] as const,
  buckets: SECONDS_BUCKETS,
  registers: [registry],
});

/** Time a worker handler. Records then rethrows, so pg-boss retry semantics are untouched. */
export async function timeJob<T>(queue: string, fn: () => Promise<T>): Promise<T> {
  const end = jobDuration.startTimer({ queue });
  try {
    const out = await fn();
    end({ outcome: 'ok' });
    return out;
  } catch (err) {
    end({ outcome: 'error' });
    throw err;
  }
}

export const llmCalls = new Counter({
  name: 'lxs_llm_calls_total',
  help: 'LLM provider calls by provider, model and outcome (ok, error)',
  labelNames: ['provider', 'model', 'outcome'] as const,
  registers: [registry],
});
export const llmTokens = new Counter({
  name: 'lxs_llm_tokens_total',
  help: 'LLM tokens reported by the provider, by direction (input, output)',
  labelNames: ['provider', 'model', 'direction'] as const,
  registers: [registry],
});
export const llmCost = new Counter({
  name: 'lxs_llm_cost_usd_total',
  help: 'Estimated LLM spend in USD from list prices (0 for models without a known price)',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

/** USD per million tokens [input, output], Anthropic first-party list prices. An estimate, not a bill. */
const PRICES: [RegExp, number, number][] = [
  [/^claude-opus-5-5/, 4, 20],
  [/^claude-opus-(5|4-[678])/, 5, 25],
  [/^claude-sonnet-5/, 2, 10],
  [/^claude-sonnet-4-6/, 3, 15],
  [/^claude-haiku-5-5/, 0.1, 0.5],
  [/^claude-haiku-4-5/, 1, 5],
  [/^claude-fable-5-2/, 8, 40],
  [/^claude-fable-5/, 10, 50],
];

export function estimateLlmCostUsd(model: string, input: number, output: number): number {
  const hit = PRICES.find(([re]) => re.test(model));
  if (!hit) return 0;
  return (input * hit[1] + output * hit[2]) / 1_000_000;
}

export function recordLlmCall(
  provider: string,
  model: string,
  outcome: 'ok' | 'error',
  usage?: { inputTokens?: number; outputTokens?: number },
): void {
  llmCalls.inc({ provider, model, outcome });
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  if (input) llmTokens.inc({ provider, model, direction: 'input' }, input);
  if (output) llmTokens.inc({ provider, model, direction: 'output' }, output);
  const cost = estimateLlmCostUsd(model, input, output);
  if (cost) llmCost.inc({ provider, model }, cost);
}

export const notificationDeliveries = new Counter({
  name: 'lxs_notification_deliveries_total',
  help: 'Alert delivery attempts by channel type and status (ok, failed)',
  labelNames: ['channel_type', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'lxs_http_request_duration_seconds',
  help: 'HTTP request duration by method, route pattern and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

new Gauge({
  name: 'lxs_queue_depth',
  help: 'pg-boss jobs per queue: queued (created or retry) and active. Collected on scrape.',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
  async collect() {
    this.reset();
    const boss = getBoss();
    if (!boss) return;
    await Promise.all(
      Object.values(QUEUES).map(async (q) => {
        try {
          const queued = await boss.getQueueSize(q);
          const upToActive = await boss.getQueueSize(q, { before: 'completed' });
          this.set({ queue: q, state: 'queued' }, queued);
          this.set({ queue: q, state: 'active' }, Math.max(0, upToActive - queued));
        } catch {
          /* queue missing or DB hiccup: skip this series for this scrape */
        }
      }),
    );
  },
});

/** Bearer check against METRICS_TOKEN; constant-time on equal lengths. */
export function metricsAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exposed unless this is production without a token. */
export const metricsEnabled = (nodeEnv: string, token: string | undefined): boolean =>
  !!token || nodeEnv !== 'production';

async function metricsPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpDuration.observe(
      { method: req.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  if (!metricsEnabled(env.NODE_ENV, env.METRICS_TOKEN)) return;
  app.get('/metrics', async (req, reply) => {
    if (!metricsAuthorized(req.headers.authorization, env.METRICS_TOKEN)) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: 'Metrics token required' } });
    }
    const body = await registry.metrics();
    return reply.header('Content-Type', registry.contentType).send(body);
  });
}

export default fp(metricsPlugin, { name: 'metrics' });
