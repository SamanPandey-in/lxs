// "Reasons to come back": coverage score, milestones, the noise counter and the weekly digest.
// Real API only (no mock fallback): these numbers describe the user's own deployment, so a
// failure is shown as a failure rather than as plausible-looking sample data.
import { resolveProject } from "./core";
import { request } from "./identity";

const e = encodeURIComponent;
const project = async () => `/v1/projects/${e(await resolveProject())}`;

export const retentionApi = {
  /** { score, max, checks[], recommendations[], computed_at } */
  coverage: async () => request(`${await project()}/coverage`),
  /** An owner confirms the allowlist; returns the updated coverage report. */
  allowlistReviewed: async () =>
    request(`${await project()}/coverage/allowlist-reviewed`, { method: "POST", body: {} }),
  /** { items: [{ key, title, description, reached_at, recorded_at, detail }] } */
  milestones: async () => (await request(`${await project()}/milestones`))?.items ?? [],
  /** { window_days, events, incidents, events_total, previous: { events, incidents } } */
  noise: async () => request(`${await project()}/noise`),
  /** { digest, subject, text, html } for the seven days ending now. */
  digestPreview: async () =>
    request(`${await project()}/digest/preview`, { method: "POST", body: {} }),
  digestPrefs: async () => request("/v1/me/digest"),
  setDigestOptOut: async (optOut) =>
    request("/v1/me/digest", { method: "PATCH", body: { opt_out: Boolean(optOut) } }),
  /** Public: the token from the email link is the credential. */
  unsubscribe: async (token) =>
    request("/v1/digest/unsubscribe", { method: "POST", body: { token } }),
};

/** The catalogue, in the order the strip shows it (mirrors apps/api/src/lib/milestones.ts). */
export const MILESTONE_ORDER = [
  { key: "first_catch", title: "First attacker caught" },
  { key: "first_targeted", title: "First targeted attacker" },
  { key: "first_honeytoken_use", title: "First honeytoken use" },
  { key: "first_block", title: "First successful block" },
  { key: "attackers_100", title: "100 attackers caught" },
  { key: "quiet_week", title: "A week with no critical incidents" },
];

/** Every milestone with its state: reached (with dates) or not yet. */
export function milestoneStrip(items = []) {
  const byKey = new Map(items.map((m) => [m.key, m]));
  return MILESTONE_ORDER.map((m) => {
    const hit = byKey.get(m.key);
    return hit
      ? { ...m, ...hit, reached: true }
      : { ...m, reached: false, reached_at: null, recorded_at: null };
  });
}

const DAY = 86_400_000;
/** A milestone is announced only if we noticed it this week and it happened in the last two. */
export const ANNOUNCE_RECORDED_MS = 7 * DAY;
export const ANNOUNCE_REACHED_MS = 14 * DAY;

/**
 * The one milestone worth a banner: newly recorded, recently reached, not dismissed.
 * When several qualify (a first deploy records history at once) only the newest is shown,
 * so the overview never fills with announcements.
 */
export function milestoneToAnnounce(items = [], dismissed = [], now = Date.now()) {
  const seen = new Set(dismissed);
  const fresh = items.filter((m) => {
    const rec = Date.parse(m.recorded_at);
    const at = Date.parse(m.reached_at);
    return (
      !seen.has(m.key) &&
      Number.isFinite(rec) &&
      Number.isFinite(at) &&
      now - rec <= ANNOUNCE_RECORDED_MS &&
      now - at <= ANNOUNCE_REACHED_MS
    );
  });
  fresh.sort((a, b) => Date.parse(b.reached_at) - Date.parse(a.reached_at));
  return fresh[0] ?? null;
}

const DISMISS_KEY = "lxs.milestones.dismissed";
/** Dismissed milestone keys for a project (per browser). Never throws. */
export function readDismissed(projectId) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(DISMISS_KEY) || "{}");
    return Array.isArray(all[projectId]) ? all[projectId] : [];
  } catch {
    return [];
  }
}
export function writeDismissed(projectId, key) {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(DISMISS_KEY) || "{}");
    all[projectId] = [...new Set([...(all[projectId] || []), key])];
    globalThis.localStorage?.setItem(DISMISS_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the banner just comes back next visit */
  }
}

/** The first `n` recommendations (the API already sorts them by points). */
export const topRecommendations = (report, n = 3) => (report?.recommendations ?? []).slice(0, n);

/** Percent change for a delta chip; null when there is nothing to compare against. */
export function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p <= 0) return null;
  return Math.round(((c - p) / p) * 100);
}

/** Share of all events that needed nobody, as a whole percent ("0 %" when there were none). */
export function noiseShare(noise) {
  const total = Number(noise?.events_total) || 0;
  if (!total) return 0;
  return Math.round(((Number(noise?.events) || 0) / total) * 100);
}
