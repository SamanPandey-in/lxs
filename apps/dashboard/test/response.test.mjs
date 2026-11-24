// Settings → Response and blocklist suggestions client: real API paths, pure helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { healthy, installFetch, json } from "./helpers.mjs";

const net = installFetch({ allowMock: false });
const { describePolicy, fmtUsd, mergeAllowlist, policyError, responseApi, usageMeter } =
  await import("../lib/response.js");

test("hits the project's response routes", async () => {
  net.calls.length = 0;
  net.api = healthy(() => json(200, { ok: true }));
  await responseApi.policy();
  await responseApi.savePolicy({ enabled: true });
  await responseApi.undoBlock("b1");
  await responseApi.suggestions();
  await responseApi.llmUsage();
  await responseApi.saveSlackLinks([]);
  const paths = net.calls.map((c) => `${c.method} ${c.path}`);
  for (const p of [
    "GET /v1/projects/real-project/response-policy",
    "PUT /v1/projects/real-project/response-policy",
    "DELETE /v1/projects/real-project/blocklist/b1",
    "GET /v1/projects/real-project/allowlist/suggestions",
    "GET /v1/projects/real-project/llm-usage",
    "PUT /v1/projects/real-project/integrations/slack/user-links",
  ])
    assert.ok(paths.includes(p), p);
});

test("add to allowlist PATCHes the merged list once", async () => {
  net.calls.length = 0;
  net.api = healthy((_path, method, init) => {
    if (method === "GET") return json(200, { id: "real-project", allowlist: ["10.0.0.0/8"] });
    return json(200, { allowlist: JSON.parse(init.body).allowlist });
  });
  const out = await responseApi.addToAllowlist("203.0.113.0/24");
  assert.deepEqual(out, ["10.0.0.0/8", "203.0.113.0/24"]);
  const patch = net.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/v1/projects/real-project");
});

test("mergeAllowlist ignores duplicates, including host /32", () => {
  assert.deepEqual(mergeAllowlist(["1.2.3.4"], "1.2.3.4/32"), ["1.2.3.4"]);
  assert.deepEqual(mergeAllowlist([], "1.2.3.4/32"), ["1.2.3.4/32"]);
});

test("policy preview and validation", () => {
  const p = {
    min_severity: "critical",
    labels: ["targeted"],
    duration_hours: 24,
    require_real_asset_touch: false,
  };
  assert.equal(
    describePolicy(p),
    "Block the source when an incident is Critical or worse AND labelled targeted, for 1 day.",
  );
  assert.match(
    describePolicy({ ...p, duration_hours: 6, labels: [] }),
    /Critical or worse, for 6 hours/,
  );
  assert.equal(policyError(p), null);
  assert.match(policyError({ ...p, duration_hours: 721 }), /30 days/);
});

test("usage meter: tone and cap text", () => {
  const u = (calls, cap, capped_by = null) => ({
    today: { calls, estimated_cost_usd: 0.004, input_tokens: 10, output_tokens: 5 },
    this_month: { estimated_cost_usd: 1.5 },
    caps: { project: { cap }, org: { used: 3, cap: 1000 } },
    capped_by,
  });
  assert.equal(usageMeter(u(10, 200)).tone, "ok");
  assert.equal(usageMeter(u(170, 200)).tone, "warn");
  const m = usageMeter(u(5, 200, "org_cap"));
  assert.equal(m.tone, "bad");
  assert.match(m.cappedText, /Organization/);
  assert.equal(m.costToday, "<$0.01");
  assert.equal(m.costMonth, "$1.50");
  assert.equal(m.tokensToday, 15);
  assert.equal(usageMeter(null), null);
  assert.equal(fmtUsd(0), "$0.00");
});
