// lib/retention.js: coverage, milestones, noise and digest calls hit the project routes;
// the milestone banner logic announces at most one fresh milestone; channel digest toggle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { healthy, installFetch, json } from "./helpers.mjs";

const net = installFetch({ allowMock: false });
const {
  milestoneStrip,
  milestoneToAnnounce,
  noiseShare,
  pctChange,
  readDismissed,
  retentionApi,
  topRecommendations,
  writeDismissed,
  MILESTONE_ORDER,
} = await import("../lib/retention.js");
const { channelsApi } = await import("../lib/channels.js");

const calls = () => net.calls.map((c) => `${c.method} ${c.path}`);

test("retention calls use the project's routes and the caller's digest preference", async () => {
  net.calls.length = 0;
  net.api = healthy((path) => {
    if (path.endsWith("/milestones")) return json(200, { items: [{ key: "first_catch" }] });
    return json(200, { score: 40, max: 100, recommendations: [], opt_out: false });
  });
  assert.equal((await retentionApi.coverage()).score, 40);
  assert.deepEqual(await retentionApi.milestones(), [{ key: "first_catch" }]);
  await retentionApi.noise();
  await retentionApi.digestPreview();
  await retentionApi.allowlistReviewed();
  await retentionApi.digestPrefs();
  await retentionApi.setDigestOptOut(true);
  await retentionApi.unsubscribe("tok");
  const c = calls();
  for (const want of [
    "GET /v1/projects/real-project/coverage",
    "GET /v1/projects/real-project/milestones",
    "GET /v1/projects/real-project/noise",
    "POST /v1/projects/real-project/digest/preview",
    "POST /v1/projects/real-project/coverage/allowlist-reviewed",
    "GET /v1/me/digest",
    "PATCH /v1/me/digest",
    "POST /v1/digest/unsubscribe",
  ])
    assert.ok(c.includes(want), `missing ${want} in ${c.join(", ")}`);
  const patch = net.calls.find((x) => x.method === "PATCH");
  assert.equal(patch.body, '{"opt_out":true}');
});

test("a refused unsubscribe surfaces the API message", async () => {
  net.api = healthy(() =>
    json(422, {
      error: {
        code: "validation_failed",
        message: "This unsubscribe link is invalid or has expired",
      },
    }),
  );
  await assert.rejects(retentionApi.unsubscribe("bad"), {
    message: "This unsubscribe link is invalid or has expired",
    status: 422,
  });
});

test("channel digest toggle PATCHes the channel", async () => {
  net.calls.length = 0;
  net.api = healthy(() => json(200, { id: "c1", digest: true }));
  const r = await channelsApi.update("c1", { digest: true });
  assert.equal(r.digest, true);
  assert.deepEqual(net.calls.at(-1), {
    method: "PATCH",
    path: "/v1/projects/real-project/notification-channels/c1",
    body: '{"digest":true}',
  });
});

const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

test("milestone strip lists every milestone in order, reached or not", () => {
  const strip = milestoneStrip([
    { key: "first_block", reached_at: daysAgo(1), recorded_at: daysAgo(1) },
  ]);
  assert.deepEqual(
    strip.map((m) => m.key),
    MILESTONE_ORDER.map((m) => m.key),
  );
  assert.equal(strip.find((m) => m.key === "first_block").reached, true);
  assert.equal(strip.filter((m) => m.reached).length, 1);
});

test("announce only the newest fresh milestone that was not dismissed", () => {
  const items = [
    { key: "first_catch", reached_at: daysAgo(200), recorded_at: daysAgo(0) }, // history on first deploy
    { key: "first_targeted", reached_at: daysAgo(3), recorded_at: daysAgo(3) },
    { key: "first_block", reached_at: daysAgo(1), recorded_at: daysAgo(1) },
    { key: "quiet_week", reached_at: daysAgo(2), recorded_at: daysAgo(9) }, // noticed too long ago
  ];
  assert.equal(milestoneToAnnounce(items, [], NOW).key, "first_block");
  assert.equal(milestoneToAnnounce(items, ["first_block"], NOW).key, "first_targeted");
  assert.equal(milestoneToAnnounce(items, ["first_block", "first_targeted"], NOW), null);
  assert.equal(milestoneToAnnounce([], [], NOW), null);
  assert.equal(
    milestoneToAnnounce([{ key: "x", reached_at: "nope", recorded_at: "nope" }], [], NOW),
    null,
  );
});

test("dismissals persist per project and survive blocked storage", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  writeDismissed("p1", "first_catch");
  writeDismissed("p1", "first_catch");
  writeDismissed("p2", "first_block");
  assert.deepEqual(readDismissed("p1"), ["first_catch"]);
  assert.deepEqual(readDismissed("p2"), ["first_block"]);
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(readDismissed("p1"), []);
  writeDismissed("p1", "x"); // does not throw
  delete globalThis.localStorage;
});

test("numbers: top recommendations, percent change and noise share", () => {
  const report = { recommendations: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] };
  assert.deepEqual(
    topRecommendations(report).map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(topRecommendations(null), []);
  assert.equal(pctChange(150, 100), 50);
  assert.equal(pctChange(5, 0), null);
  assert.equal(noiseShare({ events: 1204, events_total: 1500 }), 80);
  assert.equal(noiseShare({ events: 0, events_total: 0 }), 0);
});
