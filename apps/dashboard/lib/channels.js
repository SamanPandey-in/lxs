// Notification channels (Settings → Notifications). Real API only: channels are
// configuration, so there is no mock fallback and a failure is shown as a failure.
import { loadConfig } from "./config";
import { CoreError, coreUrl, resolveProject } from "./core";

const e = encodeURIComponent;
const TIMEOUT_MS = 20_000; // /test waits for a real delivery (5 s timeout server-side)

async function request(path, { method = "GET", body } = {}) {
  await loadConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${coreUrl()}${path}`, {
      method,
      credentials: "include",
      signal: ctrl.signal,
      cache: "no-store",
      headers:
        body !== undefined
          ? { "Content-Type": "application/json", Accept: "application/json" }
          : { Accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const out = new CoreError(
      ctrl.signal.aborted ? "No response from the API" : `Could not reach the API at ${coreUrl()}`,
      0,
    );
    out.cause = err;
    throw out;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok)
    throw new CoreError(data?.error?.message || `HTTP ${res.status} on ${path}`, res.status, data);
  return data;
}

const base = async () => `/v1/projects/${e(await resolveProject())}/notification-channels`;

export const channelsApi = {
  list: async () => (await request(await base()))?.items ?? [],
  /** Returns the channel; generic webhooks also carry `signing_secret` (shown once). */
  create: async (body) => request(await base(), { method: "POST", body }),
  remove: async (id) => request(`${await base()}/${e(id)}`, { method: "DELETE" }),
  /** Change flags on a channel: `{ digest }` (weekly digest opt-in) and/or `{ enabled }`. */
  update: async (id, body) => request(`${await base()}/${e(id)}`, { method: "PATCH", body }),
  /** { delivered, status, error } from a real test message. */
  test: async (id) => request(`${await base()}/${e(id)}/test`, { method: "POST" }),
};

/** Health shown next to a channel: green ok, red failed (with the last error), grey never sent. */
export function channelHealth(c) {
  if (c?.last_status === "ok") return { tone: "ok", label: "Healthy", detail: null };
  if (c?.last_status === "failed")
    return { tone: "bad", label: "Failing", detail: c.last_error || "Last delivery failed" };
  return { tone: "neutral", label: "Never sent", detail: null };
}

/** One-line description of a /test result for a toast. */
export function describeTestResult(r) {
  if (r?.delivered) return `Delivered${r.status ? ` (HTTP ${r.status})` : ""}`;
  return r?.error || (r?.status ? `HTTP ${r.status}` : "Not delivered");
}
