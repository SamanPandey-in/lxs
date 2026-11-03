// run-scenario.js — step executor + human/bot pacing + NDJSON streaming
// (attacker.md §4, §6, §7). Shared between live and safe mode; only how
// each step is *performed* differs.

import { sendHttp } from './http-attacker.js';
import { synthesizeSteps, triggerReplay } from './safe-mode.js';
import { closeSession, sshAction } from './ssh-attacker.js';

const SIM_IP_TARGETED = '203.0.113.66'; // documentation-range IP (attacker.md §8)
const SIM_IP_NOISE = '198.51.100.23';

function pacingRangeMs(persona) {
  if (persona === 'human') return [1500, 4000];
  return [50, 300]; // bot / scripted
}

function seededRandom(seed) {
  // tiny deterministic PRNG so "seeded scenarios" (attacker.md §3) are
  // reproducible run to run — good enough for a demo prop.
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function simIpFor(scenario) {
  return scenario.persona === 'human' ? SIM_IP_TARGETED : SIM_IP_NOISE;
}

function labelFor(step) {
  if (step.kind === 'http') return `${step.method} ${step.path}`;
  if (step.kind === 'ssh') {
    if (step.action === 'connect') return 'ssh connect';
    if (step.action === 'login') return `login ${step.username}/${step.password}`;
    if (step.action === 'command') return step.cmd;
  }
  return step.kind;
}

/**
 * Runs `scenario` and calls `emit(frame)` for each step frame plus a final
 * `{type:'done', ...}` frame. `mode` is 'live' or 'safe'.
 */
export async function runScenario(scenario, { mode, emit, signal }) {
  const start = Date.now();
  const rand = seededRandom(scenario.seed || 1);
  const simIp = simIpFor(scenario);
  let blockedCount = 0;
  let index = 0;
  let sessionId = null;

  if (mode === 'safe') {
    await triggerReplay(scenario.id);
    for (const frame of synthesizeSteps(scenario)) {
      const [lo, hi] = pacingRangeMs(scenario.persona);
      await sleep(lo + rand() * (hi - lo), signal);
      if (signal?.aborted) break;
      if (frame.blocked) blockedCount += 1;
      emit({ ...frame, atMs: Date.now() - start });
      index += 1;
    }
    emit({
      type: 'done',
      steps: index,
      blockedCount,
      mode: 'safe',
      ...(signal?.aborted ? { aborted: true } : {}),
    });
    return;
  }

  for (const step of scenario.steps) {
    const repeat = step.repeat || 1;
    for (let i = 0; i < repeat; i += 1) {
      const [lo, hi] = pacingRangeMs(scenario.persona);
      if (signal?.aborted) break;
      if (index > 0) await sleep(lo + rand() * (hi - lo), signal);
      if (signal?.aborted) break;

      let frame;
      try {
        if (step.kind === 'http') {
          // Forward the scenario's headers and body too: the scanner user-agent
          // (R03) and POST login credentials (R04/R06) live there, and dropping
          // them meant live mode sent neither — only the manual console did.
          const result = await sendHttp({
            method: step.method,
            path: step.path,
            headers: step.headers,
            body: step.body,
            simIp,
          });
          const isRealAsset = /\/api\/payments/.test(step.path || '');
          frame = {
            type: 'step',
            index,
            kind: 'http',
            label: labelFor(step),
            status: result.blocked
              ? 'blocked'
              : result.status >= 200 && result.status < 500
                ? 'ok'
                : 'error',
            detail:
              isRealAsset && !result.blocked
                ? `${result.status} REAL ASSET TOUCHED`
                : `${result.status} ${result.isDecoy ? 'decoy' : ''} ${result.note || ''}`.trim(),
            blocked: !!result.blocked,
            realAsset: isRealAsset && !result.blocked,
          };
        } else if (step.kind === 'ssh') {
          if (step.action === 'connect') {
            const result = await sshAction({
              action: 'connect',
              username: 'probe',
              password: 'probe',
              sessionId,
              simIp,
            });
            sessionId = result.sessionId;
            frame = {
              type: 'step',
              index,
              kind: 'ssh',
              label: labelFor(step),
              status: result.refused ? 'refused' : result.ok ? 'ok' : 'fail',
              detail: result.output,
              blocked: result.refused,
            };
          } else if (step.action === 'login') {
            const result = await sshAction({
              action: 'login',
              username: step.username,
              password: step.password,
              sessionId,
              simIp,
            });
            if (result.ok) sessionId = result.sessionId;
            const expectedFail = step.expect === 'fail';
            frame = {
              type: 'step',
              index,
              kind: 'ssh',
              label: labelFor(step),
              status: result.refused
                ? 'refused'
                : result.ok
                  ? 'ok'
                  : expectedFail
                    ? 'fail'
                    : 'error',
              detail: result.output,
              blocked: result.refused,
            };
          } else if (step.action === 'command') {
            const result = await sshAction({ action: 'command', cmd: step.cmd, sessionId, simIp });
            frame = {
              type: 'step',
              index,
              kind: 'ssh',
              label: labelFor(step),
              status: result.refused ? 'refused' : result.ok ? 'ok' : 'error',
              detail: result.output,
              blocked: result.refused,
            };
          }
        }
      } catch (err) {
        frame = {
          type: 'step',
          index,
          kind: step.kind,
          label: labelFor(step),
          status: 'error',
          detail: err.message,
          blocked: false,
        };
      }

      if (frame?.blocked) blockedCount += 1;
      emit({ ...frame, atMs: Date.now() - start });
      index += 1;
    }
  }

  if (sessionId) closeSession(sessionId);
  emit({
    type: 'done',
    steps: index,
    blockedCount,
    mode: 'live',
    ...(signal?.aborted ? { aborted: true } : {}),
  });
}
