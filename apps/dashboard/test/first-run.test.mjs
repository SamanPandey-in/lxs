// First run: the onboarding test hit and sample-data mode (lib/first-run.js + the api calls).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthy, installFetch, json } from "./helpers.mjs";

const net = installFetch({ allowMock: false });
const { api } = await import("../lib/core.js");
const {
  findTestIncident,
  isSampleIncident,
  isTestIncident,
  replayBadge,
  shouldOfferSample,
  testHitPhase,
  waitForTestIncident,
} = await import("../lib/first-run.js");

describe("replay badges", () => {
  it("labels sample data, test hits, and nothing else", () => {
    assert.equal(replayBadge({ simulated: true, sample: true }).label, "Sample data");
    assert.equal(replayBadge({ simulated: true, sample: false }).label, "Test");
    assert.equal(replayBadge({ simulated: false, sample: false }), null);
    assert.equal(replayBadge({}), null, "older APIs without the flags read as real");
    assert.equal(isSampleIncident({ sample: true }), true);
    assert.equal(isTestIncident({ simulated: true, sample: true }), false);
  });
});

describe("shouldOfferSample", () => {
  it("offers only on a project with no real events and no sample loaded", () => {
    assert.equal(shouldOfferSample({ loaded: false, real_events: 0 }), true);
    assert.equal(shouldOfferSample({ loaded: true, real_events: 0 }), false);
    assert.equal(shouldOfferSample({ loaded: false, real_events: 3 }), false);
    assert.equal(shouldOfferSample(null), false, "unknown status: don't offer");
  });
});

describe("testHitPhase", () => {
  it("walks idle → sending → processing → slow → incident", () => {
    assert.equal(testHitPhase({}), "idle");
    assert.equal(testHitPhase({ sending: true }), "sending");
    assert.equal(testHitPhase({ sent: true, elapsedMs: 1000 }), "processing");
    assert.equal(testHitPhase({ sent: true, elapsedMs: 45000 }), "slow");
    assert.equal(testHitPhase({ sent: true, incident: { id: "i" } }), "incident");
  });
});

describe("waitForTestIncident", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
  };

  it("polls until the incident from the test hit's address appears", async () => {
    const c = clock();
    let calls = 0;
    const ticks = [];
    const found = await waitForTestIncident({
      srcIp: "203.0.113.9",
      fetchIncidents: async () => {
        calls++;
        return calls < 3
          ? [{ id: "old", src_ip: "198.51.100.1" }]
          : [{ id: "new", number: 4, src_ip: "203.0.113.9" }];
      },
      intervalMs: 2000,
      onTick: (t) => ticks.push(t.elapsedMs),
      ...c,
    });
    assert.equal(found.id, "new");
    assert.equal(calls, 3);
    assert.deepEqual(ticks, [0, 2000, 4000]);
  });

  it("survives a failed poll and gives up at the timeout", async () => {
    const c = clock();
    const errors = [];
    const found = await waitForTestIncident({
      srcIp: "203.0.113.9",
      fetchIncidents: async () => {
        throw new Error("flaky");
      },
      intervalMs: 1000,
      timeoutMs: 5000,
      onTick: (t) => t.error && errors.push(t.error.message),
      ...c,
    });
    assert.equal(found, null);
    assert.ok(errors.length >= 5);
  });

  it("stops when aborted", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const found = await waitForTestIncident({
      srcIp: "203.0.113.9",
      fetchIncidents: async () => {
        calls++;
        ctrl.abort();
        return [];
      },
      signal: ctrl.signal,
      sleep: async () => {},
    });
    assert.equal(found, null);
    assert.equal(calls, 1);
  });

  it("findTestIncident matches on the source address only", () => {
    assert.equal(findTestIncident([{ src_ip: "1.1.1.1" }], "203.0.113.9"), null);
    assert.equal(findTestIncident(null, "203.0.113.9"), null);
    assert.equal(findTestIncident([{ src_ip: "1.1.1.1" }], ""), null);
  });
});

describe("first-run api calls", () => {
  it("hit the project-scoped demo routes with the right methods", async () => {
    net.calls.length = 0;
    net.api = healthy((path, method) => {
      if (path.endsWith("/demo/test-hit") && method === "POST")
        return json(202, { test: true, src_ip: "203.0.113.9", accepted: 8 });
      if (path.endsWith("/demo/sample-data") && method === "GET")
        return json(200, { loaded: true, sample_events: 30, sample_incidents: 3, real_events: 0 });
      if (path.endsWith("/demo/sample-data") && method === "POST")
        return json(202, { sample: true, accepted: 30 });
      if (path.endsWith("/demo/sample-data") && method === "DELETE")
        return json(200, { deleted: { events: 30, incidents: 3, attackers: 4 } });
      return json(404, { error: { message: "nope" } });
    });
    assert.equal((await api.testHit()).src_ip, "203.0.113.9");
    assert.equal((await api.sampleStatus()).loaded, true);
    assert.equal((await api.loadSample()).accepted, 30);
    assert.equal((await api.clearSample()).deleted.incidents, 3);
    const hits = net.calls
      .filter((c) => c.path.includes("/demo/"))
      .map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(hits, [
      "POST /v1/projects/real-project/demo/test-hit",
      "GET /v1/projects/real-project/demo/sample-data",
      "POST /v1/projects/real-project/demo/sample-data",
      "DELETE /v1/projects/real-project/demo/sample-data",
    ]);
  });
});
