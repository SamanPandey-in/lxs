/** Allowlist helper: pure scoring of real-route sources that look like the owner's own infra. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_SCORE,
  parseCiRanges,
  type SourceStats,
  suggestAllowlist,
  uaMatch,
} from '../src/lib/allowlist-suggest.ts';

const days = (n: number, start = 1) =>
  Array.from({ length: n }, (_, i) => `2026-11-${String(start + i).padStart(2, '0')}`);

const src = (over: Partial<SourceStats>): SourceStats => ({
  ip: '198.51.100.10',
  events: 50,
  dayList: days(1),
  userAgents: [],
  paths: ['app:/checkout'],
  errorRatio: 0,
  lastSeen: '2026-11-20T10:00:00Z',
  touchedDecoy: false,
  flaggedAttacker: false,
  ...over,
});

const run = (sources: SourceStats[], extra: Partial<Parameters<typeof suggestAllowlist>[0]> = {}) =>
  suggestAllowlist({ sources, allowlist: [], blocked: [], ...extra });

describe('suggestAllowlist', () => {
  it('suggests health-check and uptime monitor user agents, with a reason', () => {
    const out = run([
      src({ ip: '34.1.2.3', userAgents: ['kube-probe/1.29'] }),
      src({ ip: '69.162.124.226', userAgents: ['Mozilla/5.0+(compatible; UptimeRobot/2.0)'] }),
    ]);
    assert.equal(out.length, 2);
    const k8s = out.find((s) => s.cidr === '34.1.2.3/32')!;
    assert.equal(k8s.kind, 'health_check');
    assert.match(k8s.reasons[0]!, /Kubernetes probe/);
    const ur = out.find((s) => s.cidr === '69.162.124.226/32')!;
    assert.equal(ur.kind, 'uptime_monitor');
    assert.ok(ur.score >= MIN_SCORE);
  });

  it('suggests sources that only poll health endpoints', () => {
    const out = run([src({ ip: '52.0.0.9', paths: ['app:/healthz', 'http://x/healthz?probe=1'] })]);
    assert.equal(out.length, 0, 'health paths alone (30) stay below the threshold');
    const out2 = run([src({ ip: '52.0.0.9', paths: ['app:/healthz'], dayList: days(10) })]);
    assert.equal(out2.length, 1);
    assert.ok(out2[0]!.reasons.some((r) => /health endpoints/.test(r)));
  });

  it('uses a cached CI range list only when one is provided', () => {
    const s = src({ ip: '4.148.0.20' });
    assert.equal(run([s]).length, 0);
    const out = run([s], { ciRanges: [{ name: 'GitHub Actions', cidrs: ['4.148.0.0/16'] }] });
    assert.equal(out[0]?.kind, 'ci_runner');
    assert.match(out[0]!.reasons[0]!, /cached GitHub Actions address range/);
  });

  it('folds steady benign traffic from one /24 into a single /24 suggestion', () => {
    const out = run([
      src({ ip: '203.0.113.10', dayList: days(3, 1) }),
      src({ ip: '203.0.113.11', dayList: days(3, 4) }),
      src({ ip: '203.0.113.12', dayList: days(2, 7) }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.cidr, '203.0.113.0/24');
    assert.equal(out[0]!.kind, 'benign_subnet');
    assert.equal(out[0]!.sources, 3);
    assert.equal(out[0]!.days, 8);
    assert.match(out[0]!.reasons[0]!, /3 addresses in 203\.0\.113\.0\/24 on 8 different days/);
  });

  it('does not widen to a /24 that holds a decoy toucher, nor on noisy errors', () => {
    const dirty = run([
      src({ ip: '203.0.113.10', dayList: days(5) }),
      src({ ip: '203.0.113.11', dayList: days(5) }),
      src({ ip: '203.0.113.66', touchedDecoy: true }),
    ]);
    assert.ok(!dirty.some((s) => s.cidr === '203.0.113.0/24'));
    const noisy = run([
      src({ ip: '203.0.113.10', dayList: days(5), errorRatio: 0.9 }),
      src({ ip: '203.0.113.11', dayList: days(5), errorRatio: 0.9 }),
    ]);
    assert.equal(noisy.length, 0);
  });

  it('suggests a single source seen on many days', () => {
    const out = run([src({ ip: '192.0.2.200', dayList: days(14) })]);
    assert.equal(out[0]?.cidr, '192.0.2.200/32');
    assert.equal(out[0]?.kind, 'benign_repeat');
    assert.match(out[0]!.reasons[0]!, /14 different days/);
  });

  it('never suggests decoy touchers, flagged attackers, blocked or allowlisted sources', () => {
    const probe = { userAgents: ['kube-probe/1.29'] };
    const out = run(
      [
        src({ ip: '34.1.2.3', ...probe, touchedDecoy: true }),
        src({ ip: '34.1.2.4', ...probe, flaggedAttacker: true }),
        src({ ip: '34.1.2.5', ...probe }),
        src({ ip: '34.1.2.6', ...probe }),
        src({ ip: 'garbage', ...probe }),
      ],
      { blocked: ['34.1.2.5'], allowlist: ['34.1.2.6/32'] },
    );
    assert.deepEqual(out, []);
  });

  it('orders by score and honours the limit', () => {
    const out = run(
      [
        src({ ip: '192.0.2.1', dayList: days(8) }),
        src({ ip: '34.1.2.3', userAgents: ['kube-probe'], dayList: days(8) }),
      ],
      { limit: 1 },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.cidr, '34.1.2.3/32');
  });
});

describe('uaMatch / parseCiRanges', () => {
  it('recognises common monitors and ignores browsers', () => {
    assert.equal(uaMatch(['ELB-HealthChecker/2.0'])?.kind, 'health_check');
    assert.equal(uaMatch(['Pingdom.com_bot_version_1.4'])?.kind, 'uptime_monitor');
    assert.equal(uaMatch(['Mozilla/5.0 (Windows NT 10.0) Chrome/130']), null);
  });

  it('reads GitHub meta, {name,cidrs} and bare arrays', () => {
    assert.deepEqual(parseCiRanges({ actions: ['4.148.0.0/16', 1] }), [
      { name: 'GitHub Actions', cidrs: ['4.148.0.0/16'] },
    ]);
    assert.deepEqual(parseCiRanges({ name: 'Buildkite', cidrs: ['1.2.3.0/24'] }), [
      { name: 'Buildkite', cidrs: ['1.2.3.0/24'] },
    ]);
    assert.deepEqual(parseCiRanges(['1.2.3.0/24'])[0]!.cidrs, ['1.2.3.0/24']);
    assert.deepEqual(parseCiRanges('nope'), []);
  });
});
