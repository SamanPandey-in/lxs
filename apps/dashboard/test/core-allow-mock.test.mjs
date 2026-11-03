// LXS_ALLOW_MOCK=1: reads may use the mock during an outage. Nothing else may.
import assert from "node:assert/strict";
import { test } from "node:test";
import { healthy, installFetch, json, networkDown } from "./helpers.mjs";

const net = installFetch({ allowMock: true });
const { api, isDemo, CoreError } = await import("../lib/core.js");

// Each import is a separate client, so the 8 s outage latch from one test cannot leak into the next.
const fresh = (tag) => import(`../lib/core.js?${tag}`);

test("an outage serves mock reads and sets the demo flag", async () => {
  net.api = networkDown;
  const o = await api.overview();
  assert.ok(o);
  assert.equal(isDemo(), true);
});

test("mutations still go to the API during an outage and fail", async () => {
  net.api = networkDown;
  net.calls.length = 0;
  await assert.rejects(
    api.action("inc_7", { type: "block_ip", params: { ip: "1.2.3.4" } }),
    (e) => e instanceof CoreError && e.status === 0,
  );
  await assert.rejects(api.addBlock(undefined, { ip: "1.2.3.4" }));
  await assert.rejects(api.replay());
  assert.ok(
    net.calls.some((c) => c.method === "POST"),
    "the attempt reached fetch",
  );
});

test("401 and 403 are not outages: they never fall back", async () => {
  for (const [tag, status] of [
    ["a401", 401],
    ["a403", 403],
  ]) {
    const c = await fresh(tag);
    net.api = healthy(() => json(status, { error: { message: "refused" } }));
    await assert.rejects(c.api.overview(), (e) => e.status === status);
    assert.equal(c.isDemo(), false);
  }
});

test("5xx falls back; the API coming back clears the flag", async (t) => {
  const c = await fresh("recover");
  net.api = healthy(() => json(500, {}));
  await c.api.overview();
  assert.equal(c.isDemo(), true);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 9000 });
  net.api = healthy(() => json(200, { real: true }));
  const o = await c.api.overview();
  assert.equal(o.real, true);
  assert.equal(c.isDemo(), false);
});

test("the mock project is not cached: the real one is found as soon as the API is back", async () => {
  const c = await fresh("reproject");
  net.api = networkDown;
  assert.equal(await c.resolveProject(), "prj_acme_shop");
  net.api = healthy();
  assert.equal(await c.resolveProject(), "real-project");
});

test("iocs for an id the mock does not know fails cleanly instead of crashing", async () => {
  const c = await fresh("iocs");
  net.api = networkDown;
  await assert.rejects(
    c.api.iocs(undefined, "11111111-real-uuid"),
    (e) => e instanceof c.CoreError,
  );
});
