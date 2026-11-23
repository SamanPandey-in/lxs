// lib/identity.js: auth-flow and members calls hit the right endpoints, carry the
// session cookie, and surface the API's error code so pages can explain a refusal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFetch, json, networkDown } from "./helpers.mjs";

const net = installFetch();
const { identity, IdentityError, loadMe, getMe, safeNext } = await import("../lib/identity.js");

const last = () => net.calls.at(-1);

test("auth-flow calls post to the identity endpoints with JSON bodies", async () => {
  net.api = () => json(200, { ok: true });
  await identity.verifyEmail("t.1");
  assert.deepEqual(last(), {
    method: "POST",
    path: "/v1/auth/verify-email",
    body: '{"token":"t.1"}',
  });
  await identity.forgotPassword("a@b.co");
  assert.equal(last().path, "/v1/auth/password/forgot");
  assert.deepEqual(JSON.parse(last().body), { email: "a@b.co" });
  await identity.resetPassword("t.2", "longenough");
  assert.deepEqual(JSON.parse(last().body), { token: "t.2", password: "longenough" });
  await identity.acceptInvite("t.3");
  assert.equal(last().path, "/v1/invites/accept");
});

test("member calls address the org and encode ids", async () => {
  net.api = (_p, method) =>
    method === "DELETE" ? new Response(null, { status: 204 }) : json(200, {});
  await identity.members("org/1");
  assert.equal(last().path, "/v1/orgs/org%2F1/members");
  await identity.invite("o", "a@b.co", "viewer");
  assert.deepEqual(JSON.parse(last().body), { email: "a@b.co", role: "viewer" });
  await identity.changeRole("o", "u", "analyst");
  assert.deepEqual(last(), {
    method: "PATCH",
    path: "/v1/orgs/o/members/u",
    body: '{"role":"analyst"}',
  });
  assert.equal(await identity.removeMember("o", "u"), null);
  assert.equal(last().method, "DELETE");
});

test("errors carry the API status and code", async () => {
  net.api = () =>
    json(403, {
      error: { code: "E_EMAIL_UNVERIFIED", message: "Verify your email address first." },
    });
  await assert.rejects(identity.invite("o", "a@b.co", "viewer"), (err) => {
    assert.ok(err instanceof IdentityError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "E_EMAIL_UNVERIFIED");
    assert.match(err.message, /Verify your email/);
    return true;
  });
  net.api = networkDown;
  await assert.rejects(
    identity.verifyEmail("t"),
    (err) => err.code === "network" && err.status === 0,
  );
});

test("loadMe caches /v1/me and retries after a failure", async () => {
  net.api = networkDown;
  await assert.rejects(loadMe());
  net.api = () => json(200, { user: { id: "u1", email_verified: false }, orgs: [] });
  const before = net.calls.length;
  await loadMe();
  await loadMe();
  assert.equal(net.calls.length - before, 1);
  assert.equal(getMe().user.email_verified, false);
});

test("safeNext only follows same-site paths", () => {
  assert.equal(safeNext("/invite/x"), "/invite/x");
  assert.equal(safeNext("//evil.example"), "/onboarding");
  assert.equal(safeNext("https://evil.example"), "/onboarding");
  assert.equal(safeNext(null, "/dashboard"), "/dashboard");
});
