/**
 * Replay scenarios (#13). The demo's safe-mode fallback depends on every id the
 * two clients send resolving to a scenario that actually exists and whose events
 * pass ingest validation — a rejected event means the console animates while the
 * dashboard stays empty, which is the failure this guards.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateChain, exploitTypes, tagEvent } from '@lxs/detection';
import { DecoyEvent } from '@lxs/schema';
import { buildReplayEvents, resolveScenario } from '../src/modules/demo.ts';
import { computeUncovered, needsAssessment } from '../src/worker/uncovered.ts';

/** Ids the dashboard button and the attacker console's safe mode actually send. */
const CLIENT_IDS = [
  'targeted',
  'opportunistic',
  'noise',
  'ps-use-case',
  'ps-attacker',
  'sqli',
  'honeytoken',
  'web-bruteforce',
  'web-exploit',
  'exfil-cleanup',
  'dynamic',
];

describe('resolveScenario', () => {
  it('resolves every id the clients send', () => {
    for (const id of CLIENT_IDS) {
      assert.doesNotThrow(() => resolveScenario(id), `${id} must resolve`);
    }
  });

  it('aliases the PS names onto the targeted story', () => {
    assert.equal(resolveScenario('ps-use-case'), 'targeted');
    assert.equal(resolveScenario('ps-attacker'), 'targeted');
  });

  it('keeps sqli and honeytoken as their own scenarios, not targeted', () => {
    assert.equal(resolveScenario('sqli'), 'sqli');
    assert.equal(resolveScenario('honeytoken'), 'honeytoken');
  });

  it('rejects an unknown name instead of substituting targeted', () => {
    assert.throws(
      () => resolveScenario('does-not-exist'),
      (err: { status: number; code: string; details: { accepted: string[] } }) => {
        assert.equal(err.status, 422);
        assert.equal(err.code, 'unknown_scenario');
        // The error has to name what IS accepted, or the next person guesses again.
        assert.deepEqual(err.details.accepted.includes('honeytoken'), true);
        return true;
      },
    );
  });

  it('does not accept inherited object keys', () => {
    // `in` would have let these through and then called a non-scenario.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.throws(() => resolveScenario(key), `${key} must not resolve`);
    }
  });
});

describe('buildReplayEvents', () => {
  it('produces events that pass DecoyEvent validation for every scenario', () => {
    for (const id of CLIENT_IDS) {
      const events = buildReplayEvents(id, '203.0.113.7');
      assert.ok(events.length > 0, `${id} produced no events`);
      for (const [i, ev] of events.entries()) {
        const r = DecoyEvent.safeParse(ev);
        assert.ok(
          r.success,
          `${id}[${i}] rejected: ${r.success ? '' : JSON.stringify(r.error.issues)}`,
        );
      }
    }
  });

  it('backdates the batch so the last event lands at now', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const events = buildReplayEvents('targeted', '203.0.113.7', now);
    const times = events.map((e) => Date.parse(e.timestamp as string));
    assert.equal(times.at(-1), now);
    // Strictly increasing, so the killchain renders in order.
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!);
  });

  it('gives every event the caller ip and one shared session', () => {
    const events = buildReplayEvents('honeytoken', '198.51.100.9');
    assert.ok(events.every((e) => e.src_ip === '198.51.100.9'));
    assert.equal(new Set(events.map((e) => e.session_id)).size, 1);
  });

  it('marks every replayed event simulated', () => {
    for (const id of CLIENT_IDS) {
      assert.ok(
        buildReplayEvents(id, '203.0.113.7').every((e) => e.simulated === true),
        `${id} must be flagged simulated`,
      );
    }
  });
});

describe('scenario fidelity', () => {
  it('sqli carries payloads the exploit rules actually recognise', () => {
    const events = buildReplayEvents('sqli', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const found = new Set(events.flatMap((e) => exploitTypes(e)));
    // The narration promises SQLi and traversal; R05 scores once per family.
    assert.ok(found.has('sqli'), 'no sqli signature matched');
    assert.ok(found.has('traversal'), 'no traversal signature matched');
  });

  it('honeytoken ends on a real-asset token use, which is what forces Critical', () => {
    const events = buildReplayEvents('honeytoken', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const use = events.find((e) => e.event_type === 'honeytoken.use');
    assert.ok(use, 'honeytoken scenario must contain a honeytoken.use event');
    // R16 only fires for a token used off-decoy, and needs an id to report.
    assert.equal(use.is_decoy, false);
    assert.ok(use.honeytoken_id);
  });

  it('noise stays on decoys so it cannot score a real-asset touch', () => {
    const events = buildReplayEvents('noise', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    assert.ok(events.every((e) => e.is_decoy === true));
  });

  it('web-bruteforce has the failed-login burst and default-cred success R04/R06 need', () => {
    const events = buildReplayEvents('web-bruteforce', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const fails = events.filter((e) => e.event_type === 'auth.attempt' && e.outcome === 'failure');
    // R04 needs >= 5 failures inside 60 s; the scenario spreads them two seconds apart.
    assert.ok(fails.length >= 5, `expected >= 5 failed logins, got ${fails.length}`);
    const span = Date.parse(fails.at(-1)!.timestamp) - Date.parse(fails[0]!.timestamp);
    assert.ok(span <= 60_000, `failures span ${span} ms, must be <= 60 s for R04`);
    const win = events.find(
      (e) => e.event_type === 'auth.attempt' && e.outcome === 'success' && e.password_clear === 'admin',
    );
    assert.ok(win, 'web-bruteforce must end on a default-credential success for R06');
  });

  it('web-exploit carries the XSS signature that distinguishes it from sqli', () => {
    const events = buildReplayEvents('web-exploit', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const found = new Set(events.flatMap((e) => exploitTypes(e)));
    // All four families are present; XSS is the one sqli never carries.
    assert.ok(found.has('xss'), 'no XSS signature matched');
    assert.ok(found.has('cmdi'), 'no command-injection signature matched');
    assert.ok(found.has('traversal'), 'no traversal signature matched');
  });

  it('exfil-cleanup contains the transfer and history-clearing commands R09/R17 need', () => {
    const events = buildReplayEvents('exfil-cleanup', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const cmds = events.filter((e) => e.event_type === 'command.exec').map((e) => e.command ?? '');
    assert.ok(cmds.some((c) => /^curl\b/.test(c)), 'no curl transfer command for R09');
    assert.ok(cmds.some((c) => /history\s+-c|bash_history/.test(c)), 'no history/log clearing for R17');
  });

  it('dynamic keeps its post-login commands outside the deterministic rule mappings', () => {
    const events = buildReplayEvents('dynamic', '203.0.113.7').map((e) => DecoyEvent.parse(e));
    const ctx = { now: new Date(), commonCredentials: new Set(['admin', 'admin/admin']), criticalAssets: [] };
    const commands = events.filter((e) => e.event_type === 'command.exec');
    assert.equal(commands.length, 2);
    for (const command of commands) {
      const tag = tagEvent(command, ctx);
      assert.ok(tag.ruleHints.includes('R07'));
      assert.ok(tag.techniques.some((t) => t.id === 'T1059.004'));
    }
    const login = events.find((e) => e.event_type === 'auth.attempt' && e.outcome === 'success')!;
    const verdict = evaluateChain(events, ctx);
    assert.ok(tagEvent(login, ctx).ruleHints.includes('R06'));
    assert.notEqual(verdict.label, 'noise');
    assert.notEqual(verdict.severity, 'critical');
    const uncovered = computeUncovered(
      events.map((event) => ({ event, tag: tagEvent(event, ctx) })),
      verdict.detections.flatMap((d) => d.evidence_event_ids),
    );
    assert.deepEqual(uncovered.map((e) => e.command).filter(Boolean), ['cowsay deployment window', './inventory-probe --format compact']);
    assert.equal(needsAssessment({ aiEnabled: true, label: verdict.label, uncovered, events }), true);
  });
});
