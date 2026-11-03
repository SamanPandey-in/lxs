import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../env.js';
import { sha256hex } from '../lib/crypto.js';

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
