import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { env } from './env.js';
import { agentRoutes } from './modules/agent.js';
import { authRoutes } from './modules/auth.js';
import { demoRoutes } from './modules/demo.js';
import { eventRoutes } from './modules/events.js';
import { incidentRoutes } from './modules/incidents.js';
import { ingestRoutes, registerJsonParser } from './modules/ingest.js';
import { insightRoutes } from './modules/insights.js';
import { notificationRoutes } from './modules/notifications.js';
import { projectRoutes } from './modules/projects.js';
import { responseRoutes } from './modules/response.js';
import { systemRoutes } from './modules/system.js';
import authSession, { isAllowedOrigin } from './plugins/auth-session.js';
import bearerKey from './plugins/bearer-key.js';
import errorHandler from './plugins/error-handler.js';
import rateLimit from './plugins/rate-limit.js';
import { registerStreamRoute } from './plugins/sse.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    genReqId: () => ulid(),
    trustProxy: true,
    bodyLimit: env.MAX_BODY_BYTES,
  });

  await app.register(errorHandler);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'If-None-Match',
      'Last-Event-ID',
      'X-Request-Id',
    ],
    exposedHeaders: ['ETag', 'Retry-After', 'X-Request-Id'],
  });
  await app.register(cookie);
  await app.register(rateLimit);
  await app.register(bearerKey);
  await app.register(authSession);

  registerJsonParser(app);

  app.addHook('onSend', async (req, reply) => {
    void reply.header('X-Request-Id', req.id);
    void reply.header('X-Content-Type-Options', 'nosniff');
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(ingestRoutes);
  await app.register(agentRoutes);
  await app.register(projectRoutes);
  await app.register(eventRoutes);
  await app.register(incidentRoutes);
  await app.register(responseRoutes);
  await app.register(insightRoutes);
  await app.register(notificationRoutes);
  await app.register(demoRoutes);
  await app.register(registerStreamRoute);
  return app;
}
