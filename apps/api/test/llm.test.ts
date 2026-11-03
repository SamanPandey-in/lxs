/**
 * The adapter against a local stand-in for each provider. Every failure must surface
 * as LlmError, because that is what the narrator turns into a template summary.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  createLlmProvider,
  DEFAULT_ANTHROPIC_MODEL,
  LlmError,
  llmConfigFrom,
} from '../src/lib/llm.ts';

type Reply = { status?: number; body?: unknown; hang?: boolean };

let server: Server;
let base = '';
let reply: Reply = {};
let lastBody: Record<string, unknown> = {};
let lastHeaders: Record<string, unknown> = {};
let hits = 0;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      hits++;
      lastBody = JSON.parse(raw || '{}');
      lastHeaders = req.headers;
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const req = { system: 's', user: 'u', schema: { type: 'object' } };
const anthropic = (timeoutMs = 3000, model = 'claude-opus-5-5') =>
  createLlmProvider({ provider: 'anthropic', apiKey: 'k', model, baseUrl: base, timeoutMs });
const openai = (timeoutMs = 3000) =>
  createLlmProvider({ provider: 'openai', apiKey: 'k', model: 'm', baseUrl: base, timeoutMs });
const message = (text: string, stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason,
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe('llmConfigFrom', () => {
  const base = { LLM_TIMEOUT_MS: 1000 };
  it('is off without a key', () => assert.equal(llmConfigFrom(base), null));
  it('treats the mock key as no key', () =>
    assert.equal(llmConfigFrom({ ...base, LLM_API_KEY: 'mock-llm-api-key-replace-me' }), null));
  it('defaults to anthropic and its model', () => {
    const c = llmConfigFrom({ ...base, LLM_API_KEY: 'real' });
    assert.equal(c?.provider, 'anthropic');
    assert.equal(c?.model, DEFAULT_ANTHROPIC_MODEL);
  });
  it('needs an explicit model for an OpenAI-compatible endpoint', () => {
    assert.equal(llmConfigFrom({ ...base, LLM_API_KEY: 'real', LLM_PROVIDER: 'openai' }), null);
    assert.equal(
      llmConfigFrom({ ...base, LLM_API_KEY: 'real', LLM_PROVIDER: 'openai', LLM_MODEL: 'm' })
        ?.model,
      'm',
    );
  });
  it('refuses an unknown provider', () =>
    assert.equal(llmConfigFrom({ ...base, LLM_API_KEY: 'real', LLM_PROVIDER: 'nope' }), null));
});

describe('anthropic provider', () => {
  it('returns the text and sends no tools', async () => {
    reply = { body: message('{"a":1}') };
    const out = await anthropic().complete(req);
    assert.equal(out.text, '{"a":1}');
    assert.equal(lastBody.tools, undefined);
    assert.deepEqual((lastBody.output_config as { format: unknown }).format, {
      type: 'json_schema',
      schema: req.schema,
    });
  });
  it('opts into refusal fallbacks only on models that accept them', async () => {
    reply = { body: message('{}') };
    await anthropic().complete(req);
    assert.equal(lastBody.fallbacks, 'default');
    assert.match(String(lastHeaders['anthropic-beta']), /server-side-fallback-2026-07-01/);
    await anthropic(3000, 'claude-haiku-5-5').complete(req);
    assert.equal(lastBody.fallbacks, undefined);
  });
  for (const stop of ['refusal', 'max_tokens']) {
    it(`treats stop_reason ${stop} as a failure`, async () => {
      reply = { body: message('{"partial":', stop) };
      await assert.rejects(anthropic().complete(req), LlmError);
    });
  }
  it('fails on a bad key without retrying', async () => {
    reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error' } } };
    hits = 0;
    await assert.rejects(anthropic().complete(req), LlmError);
    assert.equal(hits, 1);
  });
  it('fails on a timeout', async () => {
    reply = { hang: true };
    await assert.rejects(anthropic(100).complete(req), LlmError);
  });
});

describe('openai-compatible provider', () => {
  const completion = (content: string | null, finish_reason = 'stop') => ({
    model: 'served-model',
    choices: [{ message: { content }, finish_reason }],
  });
  it('returns the text with bearer auth', async () => {
    reply = { body: completion('{"a":1}') };
    const out = await openai().complete(req);
    assert.deepEqual(out, { text: '{"a":1}', model: 'served-model' });
    assert.equal(lastHeaders.authorization, 'Bearer k');
    assert.equal(lastBody.tools, undefined);
  });
  it('fails on HTTP errors, truncation and timeouts', async () => {
    reply = { status: 500, body: {} };
    await assert.rejects(openai().complete(req), LlmError);
    reply = { body: completion('{', 'length') };
    await assert.rejects(openai().complete(req), LlmError);
    reply = { hang: true };
    await assert.rejects(openai(100).complete(req), LlmError);
  });
  it('fails when the server is not there', async () => {
    const dead = createLlmProvider({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 1000,
    });
    await assert.rejects(dead.complete(req), LlmError);
  });
});
