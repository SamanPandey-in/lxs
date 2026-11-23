// Settings → Notifications client: real API paths, real /test result, health mapping.
import assert from "node:assert/strict";
import { test } from "node:test";
import { healthy, installFetch, json } from "./helpers.mjs";

const net = installFetch({ allowMock: false });
const { channelHealth, channelsApi, describeTestResult } = await import("../lib/channels.js");

test("list and test hit the project's notification-channels routes", async () => {
  net.calls.length = 0;
  net.api = healthy((_path, method) => {
    if (method === "GET") return json(200, { items: [{ id: "c1", name: "ops" }] });
    return json(200, { ok: false, delivered: false, status: 500, error: "HTTP 500: boom" });
  });
  const items = await channelsApi.list();
  assert.deepEqual(items, [{ id: "c1", name: "ops" }]);
  const r = await channelsApi.test("c1");
  assert.equal(r.delivered, false);
  assert.equal(r.status, 500);
  const paths = net.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.includes("GET /v1/projects/real-project/notification-channels"));
  assert.ok(paths.includes("POST /v1/projects/real-project/notification-channels/c1/test"));
});

test("API errors surface as CoreError with the server message", async () => {
  net.api = healthy(() => json(422, { error: { message: "URL must be public https" } }));
  await assert.rejects(channelsApi.create({ type: "webhook", name: "x", url: "http://10.0.0.1" }), {
    message: "URL must be public https",
    status: 422,
  });
});

test("channel health: green ok, red failed with last error, grey never sent", () => {
  assert.equal(channelHealth({ last_status: "ok" }).tone, "ok");
  assert.deepEqual(channelHealth({ last_status: "failed", last_error: "timeout after 5000 ms" }), {
    tone: "bad",
    label: "Failing",
    detail: "timeout after 5000 ms",
  });
  assert.equal(channelHealth({ last_status: null }).tone, "neutral");
  assert.equal(channelHealth({}).label, "Never sent");
});

test("test result text", () => {
  assert.equal(describeTestResult({ delivered: true, status: 200 }), "Delivered (HTTP 200)");
  assert.equal(
    describeTestResult({
      delivered: false,
      status: null,
      error: "refused: x resolves to a loopback address",
    }),
    "refused: x resolves to a loopback address",
  );
});
