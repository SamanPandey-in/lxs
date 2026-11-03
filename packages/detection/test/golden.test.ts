import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DecoyEvent } from '@lxs/schema';
import {
  buildScenario,
  type ScenarioEvent,
  type ScenarioName,
} from '../../../apps/simulator/src/scenarios.ts';
import {
  type DetectionContext,
  evaluateChain,
  parseCommonCredentials,
  tagEvent,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const credsText = readFileSync(join(here, '../../../data/wordlists/common-creds.txt'), 'utf8');

const BASE = new Date('2026-11-01T10:41:00.000Z');

function makeCtx(over: Partial<DetectionContext> = {}): DetectionContext {
  return {
    now: new Date('2026-11-01T12:00:00.000Z'),
    commonCredentials: parseCommonCredentials(credsText),
    criticalAssets: ['Payments API'],
    ...over,
  };
}

function scenario(name: ScenarioName): ScenarioEvent[] {
  let n = 0;
  return buildScenario(name, {
    base: BASE,
    makeId: () => `01JC8Z4T7Q2W9F0X1M3N5P${String(++n).padStart(4, '0')}`,
  });
}

/** Evaluate the scenario prefix up to and including `step`. */
function upToStep(sc: ScenarioEvent[], step: number): DecoyEvent[] {
  return sc.filter((s) => s.step <= step).map((s) => s.event);
}

function sev(score: number) {
  return score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
}

describe('worked example: PS targeted scenario (BREAKDOWN 7.6)', () => {
  const sc = scenario('ps-attacker');
  const ctx = makeCtx();
  const running: number[] = [];
  const results = [1, 2, 3, 4, 5, 6, 7].map((step) => {
    const r = evaluateChain(upToStep(sc, step), ctx);
    running.push(r.score);
    return r;
  });

  it('running score is 5 -> 10 -> 20 -> 45 -> 50 -> 60 -> 70', () => {
    assert.deepEqual(running, [5, 10, 20, 45, 50, 60, 70]);
  });

  it('severity climbs Low -> Low -> Low -> Medium -> High -> High -> High', () => {
    assert.deepEqual(
      results.map((r) => r.severity),
      ['low', 'low', 'low', 'medium', 'high', 'high', 'high'],
    );
  });

  it('fires the documented rule at each step', () => {
    const ruleIdsAt = (i: number) =>
      results[i]?.detections.filter((d) => d.points > 0).map((d) => d.rule_id);
    assert.deepEqual(ruleIdsAt(0), ['R01']);
    assert.deepEqual(ruleIdsAt(1), ['R01', 'R02']);
    assert.deepEqual(ruleIdsAt(2), ['R01', 'R02', 'R04']);
    assert.deepEqual(ruleIdsAt(3), ['R01', 'R02', 'R04', 'R06']);
    assert.deepEqual(ruleIdsAt(4), ['R01', 'R02', 'R04', 'R06', 'R07']);
    assert.deepEqual(ruleIdsAt(5), ['R01', 'R02', 'R04', 'R06', 'R07', 'R08', 'R08']);
    assert.deepEqual(ruleIdsAt(6), ['R01', 'R02', 'R04', 'R06', 'R07', 'R08', 'R08', 'R11']);
  });

  it('label is Targeted via R13 human cadence once 3 commands have run', () => {
    const r5 = results[4];
    assert.ok(r5?.detections.some((d) => d.rule_id === 'R13'));
    assert.equal(r5?.label, 'targeted');
    // Before the commands there is no human-cadence evidence.
    assert.ok(!results[2]?.detections.some((d) => d.rule_id === 'R13'));
  });

  it('R12 and R13 award zero points', () => {
    const last = results[6];
    for (const id of ['R12', 'R13']) {
      const d = last?.detections.find((x) => x.rule_id === id);
      assert.ok(d, `${id} should have fired`);
      assert.equal(d?.points, 0);
    }
  });

  it('R18 is tag-only (0 points) and puts the chain in the exfiltration stage', () => {
    const r7 = results[6];
    const r18 = r7?.detections.find((d) => d.rule_id === 'R18');
    assert.equal(r18?.points, 0);
    assert.deepEqual(r7?.stagesReached, [
      'recon',
      'initial_access',
      'execution',
      'discovery',
      'collection',
      'exfiltration',
    ]);
  });

  it('real-asset hit: R15 targeted +40 +10, floor Critical, 120 clamped to 100', () => {
    const r = evaluateChain(upToStep(sc, 8), ctx);
    const r15 = r.detections.find((d) => d.rule_id === 'R15');
    assert.ok(r15);
    assert.equal(r15?.points, 50);
    assert.equal(r15?.floor, 'critical');
    assert.equal(r.rawScore, 120);
    assert.equal(r.score, 100);
    assert.equal(r.severity, 'critical');
    assert.equal(r.label, 'targeted');
    assert.equal(r.preCorrelationLabel, 'targeted');
    assert.equal(r.realAssetReached, true);
    assert.equal(r.honeytokenUsed, false);
  });

  it('optional honeytoken use: R16 +50, still Critical at 100', () => {
    const r = evaluateChain(upToStep(sc, 9), ctx);
    assert.ok(r.detections.some((d) => d.rule_id === 'R16'));
    assert.equal(r.score, 100);
    assert.equal(r.severity, 'critical');
    assert.equal(r.honeytokenUsed, true);
    assert.equal(r.realAssetReached, true);
  });

  it('a non-critical real asset gives +40 (targeted) with the Critical floor but no +10', () => {
    const r = evaluateChain(upToStep(sc, 8), makeCtx({ criticalAssets: [] }));
    assert.equal(r.detections.find((d) => d.rule_id === 'R15')?.points, 40);
    assert.equal(r.severity, 'critical');
  });
});

describe('noise scenario', () => {
  it('R01 5 + R02 5 + R03 3 + R04 10 = 23, Low, noise', () => {
    const r = evaluateChain(
      scenario('noise').map((s) => s.event),
      makeCtx(),
    );
    assert.equal(r.score, 23);
    assert.equal(r.severity, 'low');
    assert.equal(r.label, 'noise');
    assert.deepEqual(
      r.detections.map((d) => `${d.rule_id}:${d.points}`),
      ['R01:5', 'R02:5', 'R03:3', 'R04:10'],
    );
    assert.equal(r.realAssetReached, false);
  });
});

describe('opportunistic bot', () => {
  it('5 + 10 + 25 + 5 + 5 + 15 = 65, High, opportunistic', () => {
    const r = evaluateChain(
      scenario('opportunistic').map((s) => s.event),
      makeCtx(),
    );
    assert.equal(r.score, 65);
    assert.equal(r.severity, 'high');
    assert.equal(r.label, 'opportunistic');
    assert.deepEqual(
      r.detections.map((d) => `${d.rule_id}:${d.points}`),
      ['R01:5', 'R04:10', 'R06:25', 'R07:5', 'R08:5', 'R09:15'],
    );
  });

  it('a scripted bot that then touches a real asset: R15 opportunistic +20, floor High', () => {
    const events = scenario('opportunistic').map((s) => s.event);
    const touch: DecoyEvent = {
      ...(events[0] as DecoyEvent),
      id: '01JC8Z4T7Q2W9F0X1M3N5PZZZZ',
      timestamp: '2026-11-01T10:41:30.000Z',
      sensor: 'sdk',
      is_decoy: false,
      dst_service: 'app:/api/products',
      event_type: 'asset.access',
      asset_name: 'Product catalogue',
    };
    const r = evaluateChain([...events, touch], makeCtx());
    const r15 = r.detections.find((d) => d.rule_id === 'R15');
    assert.equal(r15?.points, 20);
    assert.equal(r15?.floor, 'high');
    assert.equal(r.preCorrelationLabel, 'opportunistic');
    assert.equal(r.label, 'opportunistic');
    assert.equal(r.score, 85);
    assert.equal(r.severity, 'critical'); // 85 >= 75 by points alone
  });

  it('a noise source touching a non-critical real asset gets +10 and no floor', () => {
    const events = scenario('noise').map((s) => s.event);
    const touch: DecoyEvent = {
      ...(events[0] as DecoyEvent),
      id: '01JC8Z4T7Q2W9F0X1M3N5PYYYY',
      timestamp: '2026-11-01T10:41:20.000Z',
      sensor: 'sdk',
      is_decoy: false,
      dst_service: 'app:/healthz',
      event_type: 'asset.access',
      asset_name: 'Health',
    };
    const r = evaluateChain([...events, touch], makeCtx());
    const r15 = r.detections.find((d) => d.rule_id === 'R15');
    assert.equal(r15?.points, 10);
    assert.equal(r15?.floor, null);
    assert.equal(r.preCorrelationLabel, 'noise');
    assert.equal(r.score, 33);
    assert.equal(r.severity, 'medium');
  });
});

describe('honeytoken scenario', () => {
  it('R16 fires: Critical, label targeted', () => {
    const r = evaluateChain(
      scenario('honeytoken').map((s) => s.event),
      makeCtx(),
    );
    const r16 = r.detections.find((d) => d.rule_id === 'R16');
    assert.equal(r16?.points, 50);
    assert.equal(r16?.floor, 'critical');
    assert.equal(r.severity, 'critical');
    assert.equal(r.label, 'targeted');
    assert.equal(r.honeytokenUsed, true);
    // The points sum to 65, but the Critical floor lifts the displayed score into
    // the Critical band so the hero screen never reads "65 · CRITICAL".
    assert.equal(r.rawScore, 65);
    assert.equal(r.score, 75);
    assert.ok(r.stagesReached.includes('exfiltration'));
  });
});

describe('sqli scenario and caps', () => {
  it('R05 is capped at 20 points even with four exploit types', () => {
    const r = evaluateChain(
      scenario('sqli').map((s) => s.event),
      makeCtx(),
    );
    const r05 = r.detections.filter((d) => d.rule_id === 'R05');
    assert.equal(r05.length, 2);
    assert.equal(
      r05.reduce((s, d) => s + d.points, 0),
      20,
    );
    assert.equal(r.label, 'noise');
    assert.equal(r.score, 33);
    assert.equal(r.severity, 'medium');
  });

  it('R08 is capped at 10 points', () => {
    const base = scenario('ps-attacker')
      .filter((s) => s.step <= 4)
      .map((s) => s.event);
    const mk = (i: number, command: string): DecoyEvent => ({
      ...(base[0] as DecoyEvent),
      id: `01JC8Z4T7Q2W9F0X1M3N5PC${String(i).padStart(3, '0')}`,
      timestamp: new Date(BASE.getTime() + 70_000 + i * 2_000).toISOString(),
      event_type: 'command.exec',
      command,
    });
    const r = evaluateChain(
      [...base, mk(1, 'whoami'), mk(2, 'id'), mk(3, 'ps aux'), mk(4, 'pwd')],
      makeCtx(),
    );
    assert.equal(
      r.detections.filter((d) => d.rule_id === 'R08').reduce((s, d) => s + d.points, 0),
      10,
    );
  });
});

describe('other rules', () => {
  const ps = scenario('ps-attacker');
  const base = ps.filter((s) => s.step <= 4).map((s) => s.event);
  const cmd = (i: number, command: string): DecoyEvent => ({
    ...(base[0] as DecoyEvent),
    id: `01JC8Z4T7Q2W9F0X1M3N5PD${String(i).padStart(3, '0')}`,
    timestamp: new Date(BASE.getTime() + 70_000 + i * 2_000).toISOString(),
    event_type: 'command.exec',
    command,
    session_id: 'ssh-db-backup-01:7f3a',
  });
  const ruleIds = (events: DecoyEvent[]) =>
    evaluateChain(events, makeCtx()).detections.map((d) => d.rule_id);

  it('R10 persistence (+20), R17 evasion (+10), R19 forwarding (+10)', () => {
    const r = evaluateChain(
      [
        ...base,
        cmd(1, 'crontab -l'),
        cmd(2, 'history -c'),
        {
          ...cmd(3, ''),
          event_type: 'proxy.attempt',
          command: undefined,
          dst_service: 'tcpip:10.0.0.5:3306',
        },
      ],
      makeCtx(),
    );
    const pts = (id: string) => r.detections.find((d) => d.rule_id === id)?.points;
    assert.equal(pts('R10'), 20);
    assert.equal(pts('R17'), 10);
    assert.equal(pts('R19'), 10);
    assert.ok(
      r.detections.find((d) => d.rule_id === 'R19')?.techniques.some((t) => t.id === 'T1090'),
    );
  });

  it('R14 revisit after > 10 min idle (+5)', () => {
    const later: DecoyEvent = {
      ...(base[0] as DecoyEvent),
      id: '01JC8Z4T7Q2W9F0X1M3N5PR001',
      timestamp: new Date(BASE.getTime() + 20 * 60_000).toISOString(),
      event_type: 'connection.open',
    };
    const r = evaluateChain([...base, later], makeCtx());
    assert.equal(r.detections.find((d) => d.rule_id === 'R14')?.points, 5);
    assert.ok(!ruleIds(base).includes('R14'));
  });

  it('uncommon credentials: no R06 points but the label is targeted', () => {
    const logins = base.map((e) =>
      e.outcome === 'success' ? { ...e, password_clear: undefined, password_masked: 'S***9' } : e,
    );
    const r = evaluateChain(logins, makeCtx());
    assert.ok(!r.detections.some((d) => d.rule_id === 'R06'));
    assert.equal(r.label, 'targeted');
  });

  it('metronome-paced commands are not human (no R13)', () => {
    const cmds = [1, 2, 3, 4].map((i) => ({
      ...cmd(i, `echo ${i}`),
      timestamp: new Date(BASE.getTime() + 70_000 + i * 2_000).toISOString(),
    }));
    assert.ok(!ruleIds([base[0] as DecoyEvent, ...cmds]).includes('R13'));
  });
});

describe('stickiness, determinism and purity', () => {
  const sc = scenario('ps-attacker');

  it('floors and once-only rules are sticky across re-evaluation', () => {
    const full = evaluateChain(upToStep(sc, 8), makeCtx());
    // Re-evaluate later with only a trailing slice of events: nothing earned is lost.
    const tail = sc.filter((s) => s.step >= 8).map((s) => s.event);
    const again = evaluateChain(tail, makeCtx({ existingDetections: full.detections }));
    assert.equal(again.severity, 'critical');
    assert.equal(again.score, 100);
    assert.equal(again.realAssetReached, true);
    assert.equal(again.detections.filter((d) => d.rule_id === 'R15').length, 1);
    assert.equal(again.detections.filter((d) => d.rule_id === 'R01').length, 1);
  });

  it('re-evaluating with its own output as existingDetections does not double count', () => {
    const events = upToStep(sc, 7);
    const first = evaluateChain(events, makeCtx());
    const second = evaluateChain(events, makeCtx({ existingDetections: first.detections }));
    assert.equal(second.score, first.score);
    assert.deepEqual(
      second.detections.map((d) => d.rule_id),
      first.detections.map((d) => d.rule_id),
    );
  });

  it('is deterministic and does not mutate its input', () => {
    const events = upToStep(sc, 9);
    const snapshot = JSON.stringify(events);
    const a = evaluateChain(events, makeCtx());
    const b = evaluateChain([...events].reverse(), makeCtx()); // input order does not matter
    assert.equal(JSON.stringify(events), snapshot);
    assert.deepEqual(a, b);
  });

  it('severity bands: Low < 25, Medium 25-49, High 50-74, Critical >= 75', () => {
    assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 100].map(sev), [
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });
});

describe('tagEvent', () => {
  const ctx = makeCtx();
  const ps = scenario('ps-attacker');
  const find = (label: string) => (ps.find((s) => s.label === label) as ScenarioEvent).event;

  it('tags the SSH connect as recon / T1595', () => {
    const t = tagEvent(find('Connects to the SSH decoy'), ctx);
    assert.equal(t.category, 'recon');
    assert.equal(t.stage, 'recon');
    assert.deepEqual(t.ruleHints, ['R01']);
    assert.deepEqual(
      t.techniques.map((x) => x.id),
      ['T1595'],
    );
  });

  it('tags a default-credential login as R06 / T1078.001 / initial_access', () => {
    const t = tagEvent(find('Logs in with admin/admin'), ctx);
    assert.equal(t.stage, 'initial_access');
    assert.ok(t.ruleHints.includes('R06'));
    assert.ok(t.techniques.some((x) => x.id === 'T1078.001'));
  });

  it('tags discovery and collection commands', () => {
    const d = tagEvent(find('uname -a'), ctx);
    assert.equal(d.stage, 'discovery');
    assert.ok(d.techniques.some((x) => x.id === 'T1082'));
    const c = tagEvent(find('cat customer_data.csv'), ctx);
    assert.equal(c.stage, 'collection');
    assert.ok(c.ruleHints.includes('R11') && c.ruleHints.includes('R18'));
    assert.ok(c.techniques.some((x) => x.id === 'T1005'));
  });

  it('tags a real-asset hit as correlation / R15 and honeytoken use as R16', () => {
    assert.deepEqual(tagEvent(find('Calls the real /api/payments'), ctx).ruleHints, ['R15']);
    const h = tagEvent(find('Uses the honeytoken key from acme.json'), ctx);
    assert.deepEqual(h.ruleHints, ['R16']);
    assert.equal(h.stage, 'exfiltration');
  });
});
