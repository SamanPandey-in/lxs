// safe-mode.js — replay via the platform's deterministic replay endpoint
// (attacker.md §3 / §6). Used when ATTACK_MODE=safe, or as the "flip to
// safe mid-demo" backup. Posts the scenario id to the platform and then
// streams synthetic step results derived from the scenario definition so
// the console UI still animates the same way live mode does.

const PLATFORM_URL = process.env.PLATFORM_URL || '';
const PLATFORM_PROJECT_ID = process.env.PLATFORM_PROJECT_ID || '';
// PLATFORM_KEY is accepted as an alias for PLATFORM_DEMO_TOKEN (both appear
// across the two spec docs/tasking) — either works.
const PLATFORM_DEMO_TOKEN = process.env.PLATFORM_DEMO_TOKEN || process.env.PLATFORM_KEY || '';

/**
 * Tells the platform to replay a recorded version of this scenario through
 * the real ingest pipeline. Best-effort: if the platform call fails, we
 * still return so the console can keep animating synthetic steps — safe
 * mode's whole point is "no live network dependency", and that includes
 * tolerating the platform being slow to answer the kickoff call.
 */
export async function triggerReplay(scenarioId) {
  if (!PLATFORM_URL || !PLATFORM_PROJECT_ID) {
    return { ok: false, reason: 'safe_mode_not_configured' };
  }
  try {
    const url = `${PLATFORM_URL.replace(/\/$/, '')}/v1/projects/${PLATFORM_PROJECT_ID}/demo/replay`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(PLATFORM_DEMO_TOKEN ? { authorization: `Bearer ${PLATFORM_DEMO_TOKEN}` } : {}),
      },
      body: JSON.stringify({ scenarioId }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: 'replay_request_failed', error: err.message };
  }
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
 * Builds the same shape of step frames run-scenario.js would emit live, but
 * without touching any real target — used in safe mode after kicking off
 * the platform replay.
 */
export function* synthesizeSteps(scenario) {
  let index = 0;
  for (const step of scenario.steps) {
    const repeat = step.repeat || 1;
    for (let i = 0; i < repeat; i += 1) {
      const isRealAsset = step.kind === 'http' && /\/api\/payments/.test(step.path || '');
      yield {
        type: 'step',
        index,
        kind: step.kind,
        label: labelFor(step),
        status: step.expect === 'fail' ? 'fail' : 'ok',
        detail: isRealAsset
          ? '200 REAL ASSET TOUCHED (replayed)'
          : step.note || `${step.kind} replayed`,
        blocked: false,
        realAsset: isRealAsset,
      };
      index += 1;
    }
  }
}
