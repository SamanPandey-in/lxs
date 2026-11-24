// lib/data.js: data-handling calls hit the right endpoints with the right bodies, errors
// keep the API code, and hashed credentials render as "(hashed)" instead of a blank.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFetch, json } from "./helpers.mjs";

const net = installFetch();
const { dataApi, apiHref, formatBytes, passwordText, credentialText } = await import(
  "../lib/data.js"
);

const last = () => net.calls.at(-1);

test("export, delete and restore calls address the project and encode ids", async () => {
  net.api = () => json(200, { ok: true });
  await dataApi.requestExport("p/1");
  assert.deepEqual(last(), { method: "POST", path: "/v1/projects/p%2F1/export", body: "{}" });
  await dataApi.exports("p1");
  assert.equal(last().path, "/v1/projects/p1/exports");
  await dataApi.summary("p1");
  assert.equal(last().path, "/v1/projects/p1/data");
  await dataApi.deleteProject("p1", "acme-shop");
  assert.deepEqual(last(), {
    method: "DELETE",
    path: "/v1/projects/p1",
    body: '{"confirm":"acme-shop"}',
  });
  await dataApi.restoreProject("p1");
  assert.equal(last().path, "/v1/projects/p1/restore");
  await dataApi.deletedProjects("o1");
  assert.equal(last().path, "/v1/orgs/o1/deleted-projects");
  await dataApi.deleteAccount("pw");
  assert.deepEqual(last(), { method: "DELETE", path: "/v1/me", body: '{"password":"pw"}' });
});

test("a last-owner refusal surfaces its code", async () => {
  net.api = () =>
    json(409, { error: { code: "E_LAST_OWNER", message: "You are the only owner of Acme" } });
  await assert.rejects(dataApi.deleteAccount("pw"), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, "E_LAST_OWNER");
    return true;
  });
});

test("download links are absolute API URLs", async () => {
  net.api = () => json(200, {});
  await dataApi.summary("p1"); // loads config (apiUrl)
  assert.equal(apiHref("/v1/x/download"), "http://api.test/v1/x/download");
});

test("credentials: masked, hashed, or hidden; never undefined", () => {
  assert.equal(passwordText({ password_masked: "a***n" }), "a***n");
  assert.equal(passwordText({ password_hash: "sha256:ab", password_length: 8 }), "(hashed)");
  assert.equal(passwordText({}), "•••");
  assert.equal(passwordText(undefined), "•••");
  assert.equal(credentialText({ username: "root", password_hash: "sha256:ab" }), "root / (hashed)");
  assert.equal(credentialText({}), "? / •••");
});

test("sizes are human-readable", () => {
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(50 * 1024 * 1024), "50 MB");
});
