/**
 * Compressed ingest bodies (#12). gzip is ~675:1 on repetitive JSON, so the
 * decompressed ceiling and how many decompressions can run at once are what
 * bound an ingest request's cost. Driven through the real content-type parser
 * on a throwaway Fastify instance — no database is touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from '../src/env.ts';
import { gunzipGate, registerJsonParser } from '../src/modules/ingest.ts';

const gzipAsync = promisify(gzip);

/** The parser must be registered on a root instance, as it is in app.ts. */
async function appWithParser(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: env.MAX_BODY_BYTES });
  registerJsonParser(app);
  app.setErrorHandler((err: Error & { status?: number; code?: string }, _req, reply) => {
    void reply
      .status(err.status ?? 500)
      .send({ error: { code: err.code ?? 'internal_error', message: err.message } });
  });
  app.post('/echo', async (req) => ({ got: req.body }));
  await app.ready();
  return app;
}

describe('gzip ingest bodies', () => {
  it('accepts a gzipped JSON body', async () => {
    const app = await appWithParser();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: await gzipAsync(Buffer.from(JSON.stringify({ events: [1, 2, 3] }))),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().got, { events: [1, 2, 3] });
    await app.close();
  });

  it('still accepts an uncompressed JSON body', async () => {
    const app = await appWithParser();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ok: true }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().got, { ok: true });
    await app.close();
  });

  it('reports a corrupt gzip body as bad_encoding', async () => {
    const app = await appWithParser();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: Buffer.from('this is not gzip'),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'bad_encoding');
    await app.close();
  });

  it('reports an over-expanding body as payload_too_large, not bad_encoding', async () => {
    // A zip bomb is a size problem. Calling it "Invalid gzip body" used to send
    // agents hunting a corruption bug that did not exist.
    const app = await appWithParser();
    const tooBig = Buffer.alloc(env.MAX_BODY_BYTES * 4 + 1024, 0x61);
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: await gzipAsync(tooBig),
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, 'payload_too_large');
    await app.close();
  });

  it('refuses a gzip body when too many decompressions are in flight', async () => {
    const app = await appWithParser();
    const before = gunzipGate.inFlight;
    gunzipGate.inFlight = gunzipGate.max; // saturate deterministically
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        payload: await gzipAsync(Buffer.from('{"ok":true}')),
      });
      // 429 rather than 503: the agent retries both identically, but the error
      // handler logs >= 500 at error level with a stack trace, so shedding load
      // under a burst would fill the API log with traces that look like faults.
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().error.code, 'too_many_inflight');
    } finally {
      gunzipGate.inFlight = before;
    }
    await app.close();
  });

  it('releases its slot after a request, including a failed one', async () => {
    const app = await appWithParser();
    const before = gunzipGate.inFlight;
    await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: await gzipAsync(Buffer.from('{"ok":true}')),
    });
    assert.equal(gunzipGate.inFlight, before, 'slot leaked after a successful request');
    await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: Buffer.from('not gzip'),
    });
    assert.equal(gunzipGate.inFlight, before, 'slot leaked after a failed request');
    await app.close();
  });

  it('leaves the gate alone for uncompressed bodies', async () => {
    const app = await appWithParser();
    gunzipGate.inFlight = gunzipGate.max;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ok: true }),
      });
      assert.equal(res.statusCode, 200, 'a plain JSON body must not be gated');
    } finally {
      gunzipGate.inFlight = 0;
    }
    await app.close();
  });
});

describe('JSON body parsing', () => {
  it('treats an empty body as an empty object', async () => {
    const app = await appWithParser();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().got, {});
    await app.close();
  });

  it('rejects malformed JSON as invalid_json', async () => {
    const app = await appWithParser();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"nope"',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid_json');
    await app.close();
  });
});
