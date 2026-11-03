/**
 * End-to-end scenario gate. Drives the simulator against a live API and asserts the
 * resulting incident matches the locked expectations in scenarios.ts.
 *
 *   pnpm platform:up && pnpm db:migrate && pnpm db:seed
 *   pnpm --filter @lxs/api dev
 *   pnpm --filter @lxs/e2e test:api
 *
 * Skips itself (rather than failing) when the API is not reachable, so a plain
 * `pnpm test` on a laptop without Docker stays green.
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { SCENARIOS, type ScenarioName } from './scenarios.js';

const API = process.env.API_URL ?? 'http://localhost:8080';
const KEY = process.env.DS_INGEST_KEY ?? 'ds_dev_0000000000000000000000000000000000000000';
const PROJECT = process.env.DS_PROJECT ?? 'acme-shop';

let apiUp = false;

before(async () => {
  try {
    const r = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(2000) });
    apiUp = r.ok;
  } catch {
    apiUp = false;
  }
  if (!apiUp) console.log(`# API not reachable at ${API} — skipping end-to-end scenarios`);
});

async function runScenario(name: ScenarioName) {
  const r = await fetch(`${API}/v1/projects/${PROJECT}/demo/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ scenario: name, reset: true }),
  });
  assert.ok(r.ok, `replay ${name} returned ${r.status}`);
  // The worker is asynchronous; poll briefly for the incident to settle.
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${API}/v1/projects/${PROJECT}/incidents?limit=5`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { items?: unknown[]; incidents?: unknown[] };
      const items = (body.items ?? body.incidents ?? []) as Array<Record<string, unknown>>;
      if (items.length > 0) return items;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no incident appeared for scenario ${name} within 15s`);
}

describe('scenario gate (BREAKDOWN §12.3)', () => {
  for (const name of Object.keys(SCENARIOS) as ScenarioName[]) {
    if (name === 'block') continue; // covered by the Playwright response spec
    const want = SCENARIOS[name];

    test(`${name}: ${want.drives}`, { skip: !apiUp ? 'API not running' : false }, async () => {
      const incidents = await runScenario(name);
      assert.equal(incidents.length, want.incidents, 'incident count');

      const inc = incidents[0]!;
      if (want.severity) assert.equal(inc.severity, want.severity, 'severity');
      if (want.label) assert.equal(inc.label, want.label, 'label');
      if (want.finalScore !== undefined) assert.equal(inc.score, want.finalScore, 'score');
      if (want.realAssetReached !== undefined) {
        assert.equal(inc.real_asset_reached, want.realAssetReached, 'real_asset_reached');
      }
      if (want.honeytokenUsed !== undefined) {
        assert.equal(inc.honeytoken_used, want.honeytokenUsed, 'honeytoken_used');
      }
      for (const t of want.techniques ?? []) {
        assert.ok(
          (inc.techniques as string[] | undefined)?.includes(t),
          `expected technique ${t} on the incident`,
        );
      }
      for (const s of want.stages ?? []) {
        assert.ok(
          (inc.stages as string[] | undefined)?.includes(s),
          `expected kill-chain stage ${s} on the incident`,
        );
      }
    });
  }
});
