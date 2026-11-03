import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecoyEvent } from '@lxs/schema';
import { computeUncovered, needsAssessment, uncoveredFingerprint } from '../src/worker/uncovered.ts';

const ev = (overrides: Partial<DecoyEvent> = {}): DecoyEvent => ({
  id: '01J00000000000000000000000', schema_version: 1, timestamp: new Date().toISOString(), sensor: 'ssh',
  is_decoy: true, src_ip: '203.0.113.8', dst_service: 'ssh:22', event_type: 'command.exec', outcome: 'success',
  command: 'cowsay hello', count: 1, simulated: false, ...overrides,
});
const tag = (ruleHints: string[] = [], techniques: { id: string }[] = []) => ({ category: 'session', stage: null, ruleHints, techniques });

describe('uncovered activity selection', () => {
  it('requires both no rule hints and no ATT&CK mapping', () => {
    assert.deepEqual(computeUncovered([
      { event: ev(), tag: tag() },
      { event: ev({ id: '01J00000000000000000000001' }), tag: tag(['R06']) },
      { event: ev({ id: '01J00000000000000000000002' }), tag: tag([], [{ id: 'T1595' }]) },
    ]).map((x) => x.id), ['01J00000000000000000000000']);
  });

  it('does not treat synthetic per-command R07 tags as a fired rule', () => {
    const command = ev();
    const tags = [{ event: command, tag: tag(['R07'], [{ id: 'T1059.004' }]) }];
    assert.deepEqual(computeUncovered(tags).map((e) => e.id), [command.id]);
    assert.deepEqual(computeUncovered(tags, [command.id]), []);
  });

  it('gates on enabled project, non-noise verdict, material activity, and successful auth', () => {
    const cmd = ev();
    const login = ev({ id: '01J00000000000000000000001', event_type: 'auth.attempt', outcome: 'success' });
    const input = { aiEnabled: true, label: 'opportunistic', uncovered: [cmd], events: [login] };
    assert.equal(needsAssessment(input), true);
    assert.equal(needsAssessment({ ...input, aiEnabled: false }), false);
    assert.equal(needsAssessment({ ...input, label: 'noise' }), false);
    assert.equal(needsAssessment({ ...input, events: [cmd] }), false);
    assert.equal(needsAssessment({ ...input, uncovered: [ev({ event_type: 'http.request' })] }), false);
    assert.equal(needsAssessment({
      ...input,
      uncovered: [0, 1, 2].map((i) => ev({ id: `01J0000000000000000000000${i}`, event_type: 'http.request' })),
    }), true);
  });

  it('fingerprints sorted uncovered behaviour independent of source ids', () => {
    const a = ev();
    const b = ev({ id: '01J00000000000000000000001', command: 'fortune' });
    assert.equal(uncoveredFingerprint([a, b], 'opportunistic'), uncoveredFingerprint([b, a], 'opportunistic'));
  });
});
