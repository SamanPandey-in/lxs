/**
 * Prometheus metrics (stream H): access control, the scrape format, and the LLM cost estimate.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import metrics, {
  estimateLlmCostUsd,
  ingestEvents,
  metricsAuthorized,
  metricsEnabled,
  recordLlmCall,
  registry,
} from '../src/plugins/metrics.ts';

describe('metrics access', () => {
  it('is open without a token outside production and off in production', () => {
    assert.equal(metricsEnabled('development', undefined), true);
    assert.equal(metricsEnabled('test', undefined), true);
    assert.equal(metricsEnabled('production', undefined), false);
    assert.equal(metricsEnabled('production', 'a-long-metrics-token'), true);
  });

  it('requires the exact bearer token when one is configured', () => {
    const t = 'a-long-metrics-token';
    assert.equal(metricsAuthorized(undefined, undefined), true);
    assert.equal(metricsAuthorized(`Bearer ${t}`, t), true);
    assert.equal(metricsAuthorized(`bearer ${t}`, t), true);
    assert.equal(metricsAuthorized(undefined, t), false);
    assert.equal(metricsAuthorized('Bearer wrong', t), false);
    assert.equal(metricsAuthorized(`Bearer ${t}x`, t), false);
    assert.equal(metricsAuthorized(t, t), false);
  });
});

describe('GET /metrics', () => {
  it('serves the text exposition format with route-pattern HTTP timings', async () => {
    const app = Fastify();
    await app.register(metrics);
    app.get('/v1/things/:id', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/v1/things/123' });
    ingestEvents.inc({ outcome: 'accepted' }, 3);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/plain/);
    const body = res.body;
    for (const name of [
      'lxs_ingest_requests_total',
      'lxs_ingest_events_total',
      'lxs_ingest_bytes_total',
      'lxs_queue_depth',
      'lxs_detection_latency_seconds',
      'lxs_worker_job_duration_seconds',
      'lxs_llm_calls_total',
      'lxs_llm_tokens_total',
      'lxs_llm_cost_usd_total',
      'lxs_notification_deliveries_total',
      'lxs_http_request_duration_seconds',
    ])
      assert.match(body, new RegExp(`# TYPE ${name} `), `${name} missing`);
    // The route pattern, never the concrete URL (unbounded label cardinality).
    assert.match(body, /route="\/v1\/things\/:id"/);
    assert.doesNotMatch(body, /route="\/v1\/things\/123"/);
    assert.match(body, /lxs_ingest_events_total\{outcome="accepted"\} 3/);
    await app.close();
  });
});

describe('LLM cost estimate', () => {
  it('prices known models per million tokens and leaves unknown ones at zero', () => {
    assert.equal(estimateLlmCostUsd('claude-opus-5-5', 1_000_000, 1_000_000), 24);
    assert.equal(estimateLlmCostUsd('claude-sonnet-5-5', 500_000, 100_000), 2);
    assert.equal(estimateLlmCostUsd('some-local-model', 1_000_000, 1_000_000), 0);
  });

  it('counts calls, tokens and cost', async () => {
    recordLlmCall('anthropic', 'claude-haiku-5-5', 'ok', {
      inputTokens: 2_000_000,
      outputTokens: 0,
    });
    recordLlmCall('anthropic', 'claude-haiku-5-5', 'error');
    const text = await registry.metrics();
    assert.match(
      text,
      /lxs_llm_calls_total\{provider="anthropic",model="claude-haiku-5-5",outcome="ok"\} 1/,
    );
    assert.match(
      text,
      /lxs_llm_tokens_total\{provider="anthropic",model="claude-haiku-5-5",direction="input"\} 2000000/,
    );
    assert.match(
      text,
      /lxs_llm_cost_usd_total\{provider="anthropic",model="claude-haiku-5-5"\} 0\.2/,
    );
  });
});
