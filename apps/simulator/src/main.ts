#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { DecoyEvent } from '@lxs/schema';
import { monotonicFactory } from 'ulid';
import {
  buildScenario,
  DEFAULT_SRC_IP,
  isScenarioName,
  SCENARIO_NAMES,
  type ScenarioEvent,
  type ScenarioName,
} from './scenarios.js';

const USAGE = `LXS simulator - replays synthetic attacks into POST /v1/ingest

Usage:
  node dist/main.js --scenario <name> --url <base-url> --key <ingest-key> [--speed 1] [--dry-run]

Options:
  --scenario  ${SCENARIO_NAMES.join(' | ')} | all     (required)
  --url       Platform base URL, e.g. http://localhost:8080   (default: http://localhost:8080)
  --key       Ingest key sent as "Authorization: Bearer <key>"  (or env DS_INGEST_KEY)
  --speed     Time multiplier; 2 = twice as fast, 0 = no waiting   (default: 1)
  --src-ip    Override the attacker source IP
  --sensor-id Sensor id sent in the batch                         (default: simulator-01)
  --dry-run   Print the events as JSON and exit (nothing is sent)
  --help      Show this help

Pacing is realistic: the targeted scenario ('ps-attacker') uses human gaps (>= 1.5 s, variable),
bot scenarios use tight scripted gaps, so the engine's cadence rules (R13) actually fire.
`;

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function post(
  url: string,
  key: string,
  sensorId: string,
  events: DecoyEvent[],
): Promise<void> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/v1/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'user-agent': 'lxs-simulator/0.1.0',
    },
    body: JSON.stringify({ sensor_id: sensorId, events }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  process.stdout.write(
    `  sent ${events.length} event(s): HTTP ${res.status} ${text.slice(0, 120)}\n`,
  );
}

/** Group events that are due within `windowMs` of each other into one POST (tight bot bursts). */
function batches(events: ScenarioEvent[], windowMs: number): ScenarioEvent[][] {
  const out: ScenarioEvent[][] = [];
  for (const e of events) {
    const cur = out[out.length - 1];
    if (cur && e.offsetMs - (cur[0] as ScenarioEvent).offsetMs <= windowMs) cur.push(e);
    else out.push([e]);
  }
  return out;
}

async function run(
  name: ScenarioName,
  opts: { url: string; key: string; speed: number; srcIp?: string; sensorId: string },
): Promise<void> {
  const makeId = monotonicFactory();
  const base = new Date();
  const events = buildScenario(name, {
    base,
    srcIp: opts.srcIp,
    makeId: () => makeId(base.getTime()),
  });
  const ip = opts.srcIp ?? DEFAULT_SRC_IP[name];
  process.stdout.write(
    `scenario ${name}: ${events.length} events from ${ip} (speed x${opts.speed})\n`,
  );

  const start = Date.now();
  for (const group of batches(events, opts.speed > 0 ? 100 * opts.speed : 0)) {
    const first = group[0] as ScenarioEvent;
    if (opts.speed > 0) {
      const due = start + first.offsetMs / opts.speed;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
    process.stdout.write(
      `[t+${(first.offsetMs / 1000).toFixed(1)}s] ${group.map((g) => g.label).join(' | ')}\n`,
    );
    await post(
      opts.url,
      opts.key,
      opts.sensorId,
      group.map((g) => g.event),
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      url: { type: 'string', default: 'http://localhost:8080' },
      key: { type: 'string' },
      speed: { type: 'string', default: '1' },
      'src-ip': { type: 'string' },
      'sensor-id': { type: 'string', default: 'simulator-01' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const scenario = values.scenario;
  if (!scenario) fail('--scenario is required');
  const names: ScenarioName[] =
    scenario === 'all'
      ? [...SCENARIO_NAMES]
      : isScenarioName(scenario)
        ? [scenario]
        : fail(`unknown scenario "${scenario}"`);
  const speed = Number(values.speed);
  if (!Number.isFinite(speed) || speed < 0) fail('--speed must be a number >= 0');

  if (values['dry-run']) {
    const makeId = monotonicFactory();
    const base = new Date();
    const all = names.flatMap((n) =>
      buildScenario(n, { base, srcIp: values['src-ip'], makeId: () => makeId(base.getTime()) }).map(
        (s) => s.event,
      ),
    );
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return;
  }

  const key = values.key ?? process.env.DS_INGEST_KEY;
  if (!key) fail('--key (or DS_INGEST_KEY) is required unless --dry-run');
  for (const n of names) {
    await run(n, {
      url: values.url as string,
      key,
      speed,
      srcIp: values['src-ip'],
      sensorId: values['sensor-id'] as string,
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
