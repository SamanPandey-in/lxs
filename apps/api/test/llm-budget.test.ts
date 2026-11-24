/** H7 cost caps: pure budget evaluation and the usage report the Settings meter reads. */
process.env.LLM_GLOBAL_DAILY_CAP = '100';
process.env.LLM_ORG_DAILY_CAP = '50';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildUsageReport, costMicros, evaluateBudget, orgDailyCap, utcDay, utcMonth } =
  await import('../src/lib/llm-budget.ts');

describe('evaluateBudget', () => {
  const ok = { used: 0, cap: 10 };
  it('lets a call through under every cap', () => {
    assert.equal(evaluateBudget({ global: ok, org: ok, project: ok }), null);
  });
  it('reports the widest cap reached first', () => {
    const full = { used: 10, cap: 10 };
    assert.equal(evaluateBudget({ global: full, org: full, project: full }), 'global_cap');
    assert.equal(evaluateBudget({ global: ok, org: full, project: full }), 'org_cap');
    assert.equal(evaluateBudget({ global: ok, org: ok, project: full }), 'project_cap');
  });
  it('a zero cap refuses every call', () => {
    assert.equal(
      evaluateBudget({ global: { used: 0, cap: 0 }, org: ok, project: ok }),
      'global_cap',
    );
  });
});

describe('caps and costs', () => {
  it('org cap: the org override wins, else the env default (plan TODO)', () => {
    assert.equal(orgDailyCap(null), 50);
    assert.equal(orgDailyCap(7), 7);
    assert.equal(orgDailyCap(null, 'team'), 5000);
    assert.equal(orgDailyCap(null, 'custom'), 20000);
    assert.equal(orgDailyCap(9, 'team'), 9);
    assert.equal(orgDailyCap(null, 'unknown-plan'), 50);
  });
  it('estimates cost in micro-dollars from the metrics price table', () => {
    // claude-opus-5-5: $4 in / $20 out per million tokens.
    assert.equal(costMicros('claude-opus-5-5', 1_000_000, 0), 4_000_000);
    assert.equal(costMicros('claude-opus-5-5', 1000, 1000), 24_000);
    assert.equal(costMicros('unknown-model', 1000, 1000), 0);
  });
  it('formats UTC day and month keys', () => {
    const d = new Date('2026-11-24T23:59:00Z');
    assert.equal(utcDay(d), '2026-11-24');
    assert.equal(utcMonth(d), '2026-11');
  });
});

describe('buildUsageReport', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  it('shapes today, month, caps and remaining', () => {
    const r = buildUsageReport({
      now,
      today: {
        calls: 12,
        input_tokens: 3000,
        output_tokens: 900,
        cost_micros: 30_000,
        capped_calls: 2,
        last_cap_reason: 'project_cap',
      },
      month: { calls: 40, input_tokens: 9000, output_tokens: 2000, cost_micros: 90_000 },
      projectCap: 12,
      orgOverride: null,
      orgUsed: 20,
      globalUsed: 30,
      lastCapReason: 'project_cap',
    });
    assert.equal(r.day, '2026-11-24');
    assert.equal(r.month, '2026-11');
    assert.deepEqual(r.today, {
      calls: 12,
      input_tokens: 3000,
      output_tokens: 900,
      estimated_cost_usd: 0.03,
      capped_calls: 2,
    });
    assert.equal(r.this_month.calls, 40);
    assert.equal(r.this_month.estimated_cost_usd, 0.09);
    assert.deepEqual(r.caps.project, { cap: 12, used: 12, remaining: 0 });
    assert.deepEqual(r.caps.org, { cap: 50, used: 20, remaining: 30, source: 'default' });
    assert.deepEqual(r.caps.global, { reached: false });
    assert.equal(r.capped_by, 'project_cap');
    assert.equal(r.last_cap_reason, 'project_cap');
  });
  it('never discloses platform-wide usage, only whether the limit is reached', () => {
    const r = buildUsageReport({
      now,
      today: undefined,
      month: undefined,
      projectCap: 200,
      orgOverride: 500,
      orgUsed: 0,
      globalUsed: 100,
      lastCapReason: 'bogus',
    });
    assert.deepEqual(r.caps.global, { reached: true });
    assert.equal(r.capped_by, 'global_cap');
    assert.equal(r.caps.org.source, 'org_override');
    assert.equal(r.today.calls, 0);
    assert.equal(r.last_cap_reason, null);
    assert.ok(!JSON.stringify(r).includes('100'));
  });
});
