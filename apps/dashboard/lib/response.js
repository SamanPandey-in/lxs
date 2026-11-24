// Response automation client: auto-block policy, Slack app, allowlist suggestions, AI usage.
// Real API only (configuration, like lib/channels.js): a failure is shown as a failure.
import { loadConfig } from "./config";
import { CoreError, coreUrl, resolveProject } from "./core";

const e = encodeURIComponent;
const TIMEOUT_MS = 20_000;

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

const project = async () => `/v1/projects/${e(await resolveProject())}`;

export const responseApi = {
  policy: async () => request(`${await project()}/response-policy`),
  savePolicy: async (body) =>
    request(`${await project()}/response-policy`, { method: "PUT", body }),
  /** One-click undo of an auto-block: the same audited unblock as the blocklist page. */
  undoBlock: async (blockId) =>
    request(`${await project()}/blocklist/${e(blockId)}`, { method: "DELETE" }),
  slack: async () => request(`${await project()}/integrations/slack`),
  saveSlack: async (body) =>
    request(`${await project()}/integrations/slack`, { method: "PUT", body }),
  removeSlack: async () => request(`${await project()}/integrations/slack`, { method: "DELETE" }),
  saveSlackLinks: async (links) =>
    request(`${await project()}/integrations/slack/user-links`, {
      method: "PUT",
      body: { links },
    }),
  suggestions: async () => request(`${await project()}/allowlist/suggestions`),
  llmUsage: async () => request(`${await project()}/llm-usage`),
  /** Append a CIDR to the project allowlist (owner). Returns the new allowlist. */
  addToAllowlist: async (cidr) => {
    const base = await project();
    const p = await request(base);
    const current = p?.allowlist || [];
    const next = mergeAllowlist(current, cidr);
    if (next.length === current.length) return current;
    const saved = await request(base, { method: "PATCH", body: { allowlist: next } });
    return saved?.allowlist ?? next;
  },
};

/* ───────── pure helpers (unit-tested) ───────── */

const hostForm = (c) => String(c).replace(/\/(32|128)$/, "");

/** Add `cidr` unless an equal entry (ignoring a host /32 or /128) is already there. */
export function mergeAllowlist(list, cidr) {
  const want = hostForm(cidr.trim());
  if (!want) return list;
  return list.some((c) => hostForm(c) === want) ? list : [...list, cidr.trim()];
}

export const DURATION_OPTIONS = [
  { value: "1", label: "1 hour" },
  { value: "6", label: "6 hours" },
  { value: "24", label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
];

/** "block when severity >= critical AND label in [targeted], for 24 h" for the panel preview. */
export function describePolicy(p) {
  const sev = { low: "Low", medium: "Medium", high: "High", critical: "Critical" }[p.min_severity];
  const parts = [`${sev || p.min_severity} or worse`];
  if (p.labels?.length) parts.push(`labelled ${p.labels.join(" or ")}`);
  if (p.require_real_asset_touch) parts.push("touched a real asset");
  const h = Number(p.duration_hours);
  const dur =
    h % 24 === 0 ? `${h / 24} ${h === 24 ? "day" : "days"}` : `${h} ${h === 1 ? "hour" : "hours"}`;
  return `Block the source when an incident is ${parts.join(" AND ")}, for ${dur}.`;
}

/** Validation for the policy form; null when valid. */
export function policyError(p) {
  const h = Number(p.duration_hours);
  if (!Number.isInteger(h) || h < 1 || h > 720) return "Duration must be 1 hour to 30 days.";
  if (!["low", "medium", "high", "critical"].includes(p.min_severity))
    return "Pick a minimum severity.";
  return null;
}

const CAP_TEXT = {
  global_cap: "Platform-wide daily AI limit reached",
  org_cap: "Organization daily AI limit reached",
  project_cap: "Project daily AI limit reached",
};

/** Meter state for the AI usage panel. */
export function usageMeter(u) {
  if (!u) return null;
  const cap = u.caps?.project?.cap ?? 0;
  const used = u.today?.calls ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
  const capped = u.capped_by || null;
  return {
    used,
    cap,
    pct,
    remaining: Math.max(0, cap - used),
    tone: capped || pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok",
    capped,
    cappedText: capped ? CAP_TEXT[capped] || capped : null,
    orgUsed: u.caps?.org?.used ?? 0,
    orgCap: u.caps?.org?.cap ?? 0,
    costToday: fmtUsd(u.today?.estimated_cost_usd ?? 0),
    costMonth: fmtUsd(u.this_month?.estimated_cost_usd ?? 0),
    tokensToday: (u.today?.input_tokens ?? 0) + (u.today?.output_tokens ?? 0),
    fallbacksToday: u.today?.capped_calls ?? 0,
  };
}

export function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

export const SUGGESTION_KIND = {
  health_check: "Health check",
  uptime_monitor: "Uptime monitor",
  ci_runner: "CI runner",
  benign_repeat: "Repeat visitor",
  benign_subnet: "Benign /24",
};
