import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

interface PgErr {
  code?: string;
  cause?: PgErr;
}

function pgCode(err: unknown): PgErr | undefined {
  let e = err as PgErr | undefined;
  for (let i = 0; e && i < 4; i++, e = e.cause) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
  }
  return undefined;
}

/** §8.10 error envelope: { error: { code, message, details, request_id } } — never echoes secrets. */
export default fp(async function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, req, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    const e = err as { statusCode?: number; code?: string; message?: string };
    const pg = pgCode(err);

    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err instanceof ZodError) {
      status = 422;
      code = 'validation_failed';
      message = 'Request validation failed';
      details = err.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (pg && ['22P02', '22P03', '22007', '22008', '22023'].includes(pg.code ?? '')) {
      status = 422;
      code = 'invalid_value';
      message = 'A value has an invalid format';
    } else if (pg?.code === '23505') {
      status = 409;
      code = 'conflict';
      message = 'Resource already exists';
    } else if (
      pg &&
      ['08000', '08001', '08003', '08004', '08006', '57P01', '53300'].includes(pg.code ?? '')
    ) {
      status = 503;
      code = 'unavailable';
      message = 'Storage unavailable';
    } else if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      code =
        status === 429
          ? 'rate_limited'
          : status === 413
            ? 'payload_too_large'
            : (e.code ?? 'bad_request').toLowerCase().replace(/^fst_err_/, '');
      message = e.message ?? 'Bad request';
    }

    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({
      error: { code, message, ...(details !== undefined ? { details } : {}), request_id: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${req.method} ${req.url.split('?')[0]} not found`,
        request_id: req.id,
      },
    });
  });
});
