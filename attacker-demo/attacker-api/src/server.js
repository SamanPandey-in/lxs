// server.js — attacker-api (attacker.md §6). Tiny Express(v5)/ESM service
// that performs real attacks against the honeypots (or replays via the
// platform in safe mode) and streams results back to attacker-web.
//
// No persistence, no auth — it's a stage prop. State is in-memory and
// resets on restart.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { checkAllowed, getAllowTargets } from './allowlist.js';
import { sendHttp } from './http-attacker.js';
import { runScenario } from './run-scenario.js';
import { resetAllSessions, sshAction } from './ssh-attacker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, '..', 'scenarios');

const PORT = Number(process.env.PORT || 6060);
const ATTACK_MODE = (process.env.ATTACK_MODE || 'live').toLowerCase(); // live | safe
const TARGET_APP_URL = process.env.TARGET_APP_URL || 'http://localhost:3000';
const TARGET_SSH_HOST = process.env.TARGET_SSH_HOST || 'localhost';
const TARGET_SSH_PORT = Number(process.env.TARGET_SSH_PORT || 22);

function loadScenarios() {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
  const byId = new Map();
  for (const file of files) {
    const def = JSON.parse(readFileSync(join(SCENARIOS_DIR, file), 'utf8'));
    byId.set(def.id, def);
  }
  return byId;
}

let scenarios = loadScenarios();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: ATTACK_MODE,
    targets: {
      app: TARGET_APP_URL,
      ssh: `${TARGET_SSH_HOST}:${TARGET_SSH_PORT}`,
      allow: getAllowTargets(),
    },
  });
});

app.get('/scenarios', (req, res) => {
  res.json(
    [...scenarios.values()].map((s) => ({
      id: s.id,
      name: s.name,
      narration: s.narration,
      stepCount: s.steps.reduce((n, step) => n + (step.repeat || 1), 0),
    })),
  );
});

app.post('/run', async (req, res) => {
  const { scenarioId, mode } = req.body || {};
  const scenario = scenarios.get(scenarioId);
  if (!scenario) {
    res.status(404).json({ error: 'unknown_scenario', scenarioId });
    return;
  }

  const runMode = mode || ATTACK_MODE;

  res.status(200);
  res.setHeader('content-type', 'application/x-ndjson');
  res.setHeader('cache-control', 'no-cache');
  // Flush headers immediately so the UI's fetch-reader starts getting bytes
  // as soon as the first step completes, not when the whole run finishes.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (frame) => {
    res.write(`${JSON.stringify(frame)}\n`);
  };

  try {
    await runScenario(scenario, { mode: runMode, emit });
  } catch (err) {
    emit({
      type: 'step',
      kind: 'error',
      label: 'run-scenario',
      status: 'error',
      detail: err.message,
    });
    emit({ type: 'done', steps: 0, blockedCount: 0, error: err.message });
  } finally {
    res.end();
  }
});

app.post('/http', async (req, res) => {
  const guard = checkAllowed(TARGET_APP_URL);
  if (!guard.ok) {
    res.status(400).json({ error: 'target_not_allowed', ...guard });
    return;
  }
  const { method, path, headers, body } = req.body || {};
  if (!path) {
    res.status(400).json({ error: 'path_required' });
    return;
  }
  const result = await sendHttp({ method, path, headers, body });
  res.json(result);
});

app.post('/ssh', async (req, res) => {
  const guard = checkAllowed(TARGET_SSH_HOST);
  if (!guard.ok) {
    res.status(400).json({ error: 'target_not_allowed', ...guard });
    return;
  }
  const { action, username, password, cmd, sessionId } = req.body || {};
  if (!action) {
    res.status(400).json({ error: 'action_required' });
    return;
  }
  const result = await sshAction({ action, username, password, cmd, sessionId });
  res.json(result);
});

app.post('/reset', (req, res) => {
  resetAllSessions();
  scenarios = loadScenarios();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`attacker-api listening on :${PORT} (mode=${ATTACK_MODE})`);
  // eslint-disable-next-line no-console
  console.log(
    `targets: app=${TARGET_APP_URL} ssh=${TARGET_SSH_HOST}:${TARGET_SSH_PORT} allow=${getAllowTargets().join(',')}`,
  );
});
