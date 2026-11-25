import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecoyEvent } from '@lxs/schema';
import {
  type DetectionContext,
  evaluateChain,
  jitterThresholds,
  PUBLISHED_THRESHOLDS,
  type Thresholds,
} from '../src/index.ts';

const ctx = (thresholds?: Thresholds): DetectionContext => ({
  now: new Date('2026-11-01T12:00:00.000Z'),
  commonCredentials: new Set(['admin']),
  criticalAssets: [],
  ...(thresholds ? { thresholds } : {}),
});

let n = 0;
const fail = (sec: number): DecoyEvent => ({
  id: `01JC8Z4T7Q2W9F0X1M3N5P${String(++n).padStart(4, '0')}`,
  schema_version: 1,
  timestamp: new Date(Date.parse('2026-11-01T10:00:00.000Z') + sec * 1000).toISOString(),
  sensor: 'ssh',
  decoy_id: 'ssh-1',
  is_decoy: true,
  src_ip: '203.0.113.5',
  dst_service: 'ssh:22',
  event_type: 'auth.attempt',
  outcome: 'failure',
  username: 'root',
  count: 1,
  simulated: false,
});

describe('per-deployment threshold jitter', () => {
  it('is off without a seed: exactly the published thresholds', () => {
    assert.deepEqual(jitterThresholds(undefined), PUBLISHED_THRESHOLDS);
    assert.deepEqual(jitterThresholds(''), PUBLISHED_THRESHOLDS);
    assert.deepEqual(jitterThresholds(null), PUBLISHED_THRESHOLDS);
  });

  it('is deterministic per seed, stays within +/-20 %, and differs across seeds', () => {
    const a = jitterThresholds('deploy-a');
    assert.deepEqual(jitterThresholds('deploy-a'), a);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = jitterThresholds(`deploy-${i}`, 0.2);
      seen.add(JSON.stringify(t));
      for (const k of Object.keys(PUBLISHED_THRESHOLDS) as Array<keyof Thresholds>) {
        const base = PUBLISHED_THRESHOLDS[k];
        // Counts round to integers: allow the rounding step on top of the band.
        const slack = Number.isInteger(base) && base < 10 ? 0.5 : 100;
        assert.ok(t[k] >= base * 0.8 - slack && t[k] <= base * 1.2 + slack, `${k}=${t[k]}`);
      }
    }
    assert.ok(seen.size > 40, 'seeds must produce different threshold sets');
    // Windows move off the published round numbers.
    assert.notEqual(a.sweepWindowMs, 60_000);
  });

  it('the published thresholds score exactly as no thresholds at all', () => {
    const events = [0, 5, 10, 15, 20, 25].map(fail);
    const plain = evaluateChain(events, ctx());
    const explicit = evaluateChain(events, ctx({ ...PUBLISHED_THRESHOLDS }));
    assert.deepEqual(explicit, plain);
    assert.ok(plain.detections.some((d) => d.reason === '5 failed logins within 60 s'));
  });

  it('jittered thresholds change when a rule fires, never its points', () => {
    const four = [0, 5, 10, 15].map(fail);
    assert.ok(!evaluateChain(four, ctx()).detections.some((d) => d.rule_id === 'R04'));
    const t = { ...PUBLISHED_THRESHOLDS, bruteforceFailures: 4, bruteforceWindowMs: 52_300 };
    const r04 = evaluateChain(four, ctx(t)).detections.find((d) => d.rule_id === 'R04');
    assert.equal(r04?.points, 10);
    assert.equal(r04?.reason, '4 failed logins within 52.3 s');
  });
});
