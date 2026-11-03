// Default configuration: no LXS_ALLOW_MOCK. The dashboard must never show invented data.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { hang, healthy, installFetch, json, networkDown } from "./helpers.mjs";

const net = installFetch({ allowMock: false });
const { api, CoreError, getApiProblem, isDemo } = await import("../lib/core.js");

afterEach(() => {
  assert.equal(isDemo(), false, "demo mode must never engage without LXS_ALLOW_MOCK");
});

const READS = [
  ["overview", () => api.overview()],
  ["incidents", () => api.incidents()],
  ["incident", () => api.incident("inc_7")],
  ["incidentEvents", () => api.incidentEvents("inc_7")],
  ["attackers", () => api.attackers()],
  ["attacker", () => api.attacker("att_1")],
  ["events", () => api.events()],
  ["attackMatrix", () => api.attackMatrix()],
  ["decoys", () => api.decoys()],
  ["containment", () => api.containment()],
  ["blocklist", () => api.blocklist()],
  ["audit", () => api.audit()],
  ["settings", () => api.settings()],
  ["onboarding", () => api.onboarding()],
  ["system", () => api.system()],
  ["iocs", () => api.iocs(undefined, "inc_7")],
];

const MUTATIONS = [
  ["action", () => api.action("i1", { type: "block_ip", params: { ip: "1.2.3.4" } })],
  ["patchIncident", () => api.patchIncident("i1", { status: "resolved" })],
  ["note", () => api.note("i1", { body: "x" })],
  ["addBlock", () => api.addBlock(undefined, { ip: "1.2.3.4" })],
  ["unblock", () => api.unblock(undefined, "b1")],
  ["replay", () => api.replay()],
  ["retryJob", () => api.retryJob("j1")],
  ["bulkResolveNoise", () => api.bulkResolveNoise(["i1"])],
];

const FAILURES = [
  ["500", () => json(500, { error: { message: "boom" } }), 500],
  ["401", () => json(401, { error: { message: "no session" } }), 401],
  ["403", () => json(403, { error: { message: "no role" } }), 403],
  ["network", networkDown, 0],
];

for (const [fname, respond, status] of FAILURES) {
  for (const [name, run] of READS) {
    test(`read ${name} rejects on ${fname}`, async () => {
      net.api = healthy(respond);
      await assert.rejects(run, (e) => e instanceof CoreError && e.status === status);
    });
  }
  for (const [name, run] of MUTATIONS) {
    test(`mutation ${name} rejects on ${fname}`, async () => {
      net.api = healthy(respond);
      await assert.rejects(run, (e) => e instanceof CoreError && e.status === status);
    });
  }
}

test("mutations reach the API once, unmodified, and return its answer", async () => {
  for (const [name, run] of MUTATIONS) {
    net.calls.length = 0;
    net.api = healthy(() => json(202, { action_id: "real" }));
    const out = await run();
    const sent = net.calls.filter((c) => c.method !== "GET");
    assert.equal(sent.length, 1, name);
    if (name !== "bulkResolveNoise") assert.equal(out.action_id, "real", name);
  }
});

test("a successful-looking mock can no longer exist: mock has no mutations", async () => {
  const { mock } = await import("../lib/mock.js");
  for (const k of ["action", "addBlock", "unblock", "patchIncident", "replay", "retryJob"])
    assert.equal(mock[k], undefined, k);
});

test("partial bulk resolve reports how many landed", async () => {
  net.api = healthy((path) => (path.endsWith("/bad") ? json(500, {}) : json(200, {})));
  await assert.rejects(api.bulkResolveNoise(["ok1", "ok2", "bad"]), /Resolved 2 of 3/);
});

test("project discovery failure is not cached: recovery is immediate", async () => {
  // Fresh module state, so discovery has not already succeeded in an earlier test.
  const fresh = await import("../lib/core.js?discovery");
  net.api = () => json(503, {});
  await assert.rejects(fresh.resolveProject(), (e) => e.status === 503);
  net.api = healthy();
  assert.equal(await fresh.resolveProject(), "real-project");
});

test("an account with no projects is an error, not the mock project", async () => {
  const fresh = await import("../lib/core.js?empty");
  net.api = () => json(200, { items: [] });
  await assert.rejects(fresh.resolveProject(), /no projects/);
});

test("the banner reports failures, ranks them, and clears on recovery", async () => {
  // A fresh client: earlier tests deliberately leave failures on other paths.
  const { api, getApiProblem } = await import("../lib/core.js?banner");
  net.api = healthy(() => json(500, { error: { message: "boom" } }));
  await assert.rejects(api.overview());
  assert.equal(getApiProblem().kind, "server");

  net.api = healthy(() => json(401, { error: { message: "no session" } }));
  await assert.rejects(api.audit());
  assert.equal(getApiProblem().kind, "session", "401 outranks 500");

  net.api = healthy();
  await api.overview();
  await api.audit();
  assert.equal(getApiProblem(), null);
});

test("a 409 from a healthy API raises no banner", async () => {
  const { api, getApiProblem } = await import("../lib/core.js?conflict");
  net.api = healthy(() => json(409, { error: { message: "allowlisted" } }));
  await assert.rejects(api.addBlock(undefined, { ip: "10.0.0.1" }), /allowlisted/);
  assert.equal(getApiProblem(), null);
});

test("settings: keys 403 means none, keys 500 is a failure", async () => {
  const settings = (keys) =>
    healthy((path) => (path.endsWith("/keys") ? keys() : json(200, { id: "p", name: "P" })));
  net.api = settings(() => json(403, {}));
  assert.deepEqual((await api.settings()).keys, []);
  net.api = settings(() => json(500, {}));
  await assert.rejects(api.settings(), (e) => e.status === 500);
  net.api = healthy();
  await api.overview();
});

test("timeouts: reads 8 s, slow reads 15 s, mutations 20 s and say the outcome is unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  net.api = healthy(hang);
  const after = async (promise, ms) => {
    let settled;
    promise.catch((e) => {
      settled = e;
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(ms - 1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, undefined, `still waiting just before ${ms} ms`);
    t.mock.timers.tick(1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled?.status, 0);
    assert.equal(settled?.timedOut, true);
    return settled;
  };
  await after(api.decoys(), 8_000);
  await after(api.overview(), 15_000);
  const e = await after(api.addBlock(undefined, { ip: "1.2.3.4" }), 20_000);
  assert.match(e.message, /may still have been applied/);
});
