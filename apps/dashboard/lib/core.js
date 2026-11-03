// Fetch client for the LXS platform API (/v1). Falls back to lib/mock.js automatically
// when the API is unreachable (network failure, 5xx, 401/403, or an unknown project), and flips the
// global "demo data" flag so the topbar can show a badge. When the API is up, real data wins.
import { getApiUrl, loadConfig } from "./config";
import { PROJECT_ID as MOCK_PROJECT, mock, TECHNIQUES } from "./mock";

/** The API base. A getter, not a constant: the real value arrives from /api/config
 *  at runtime, so one production build can run against any host. */
export const coreUrl = () => getApiUrl();
export const PROJECT = MOCK_PROJECT; // pre-boot placeholder; resolveProject() finds the live id

export class CoreError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "CoreError";
    this.status = status;
    this.body = body;
  }
}

/* ───────── demo flag (external store) ───────── */
let demo = false;
let downUntil = 0;
const demoSubs = new Set();
export const isDemo = () => demo;
export function subscribeDemo(fn) {
  demoSubs.add(fn);
  return () => demoSubs.delete(fn);
}
function setDemo(v) {
  if (demo === v) return;
  demo = v;
  demoSubs.forEach((f) => f());
}

const e = encodeURIComponent;

/** Never throws on HTTP status — only on network failure / timeout. */
async function raw(path, { method = "GET", body, timeout = 2500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${coreUrl()}${path}`, {
      method,
      credentials: "include",
      signal: ctrl.signal,
      headers:
        body !== undefined
          ? { "Content-Type": "application/json", Accept: "application/json" }
          : { Accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Throws CoreError on non-2xx. */
async function strict(path, opts) {
  const r = await raw(path, opts);
  if (!r.ok)
    throw new CoreError(
      r.data?.error?.message || `HTTP ${r.status} on ${path}`,
      r.status,
      r.data,
      path,
    );
  return r.data;
}

function shouldFallback(err, path) {
  if (!(err instanceof CoreError)) return true; // network failure / abort / CORS
  if (err.status >= 500 || err.status === 401 || err.status === 403) return true;
  // unknown project, or a mock id (inc_*/att_*) asked of a real API: keep the demo coherent
  if (
    err.status === 404 &&
    (/\/projects\//.test(path || "") ||
      demo ||
      /\/(incidents|attackers)\/(inc|att)_/.test(path || ""))
  )
    return true;
  return false;
}

/** Try the real API; on unreachable fall back to the mock producer. */
async function call(path, opts, fallback) {
  if (Date.now() < downUntil) {
    setDemo(true);
    return fallback();
  }
  try {
    const out = await strict(path, opts);
    setDemo(false);
    return out;
  } catch (err) {
    if (shouldFallback(err, path)) {
      downUntil = Date.now() + 8000;
      setDemo(true);
      return fallback();
    }
    throw err;
  }
}

export const list = (d) =>
  Array.isArray(d)
    ? d
    : (d?.items ??
      d?.data ??
      d?.incidents ??
      d?.events ??
      d?.attackers ??
      d?.decoys ??
      d?.entries ??
      d?.rows ??
      []);

// Tolerate the slightly different incident-detail envelope in docs/06-backend.md
function normIncident(i) {
  if (!i || typeof i !== "object") return i;
  const out = { ...i };
  // API extras: technique_details [{id,name,tactic,description}] feed the ATT&CK tooltips
  const reg = (t) => {
    if (t?.id && !TECHNIQUES[t.id])
      TECHNIQUES[t.id] = {
        name: t.name || t.id,
        tactic: t.tactic || "",
        desc: t.description || t.desc || "",
        count: 0,
      };
  };
  (out.technique_details || []).forEach(reg);
  (out.detections || []).forEach((d) => (d.techniques || []).forEach(reg));
  if (Array.isArray(out.techniques)) out.techniques.forEach((t) => typeof t === "object" && reg(t));
  if (!out.attacker_id && out.attacker?.id) out.attacker_id = out.attacker.id;
  if (!out.ai_summary && out.ai) {
    out.ai_summary = out.ai.summary
      ? {
          headline: String(out.ai.summary).split(". ")[0],
          what_happened: out.ai.summary,
          why_it_matters: "",
          recommended_actions: (out.ai.recommended_actions || []).map((a) =>
            typeof a === "string" ? a : `${a.action}: ${a.reason}`,
          ),
          is_fallback: !!out.ai.is_fallback,
        }
      : null;
    out.ai_status = out.ai_status || out.ai.status;
  }
  if (out.techniques?.length && typeof out.techniques[0] === "object")
    out.techniqueObjects = out.techniques;
  out.techniques = (out.techniques || []).map((t) => (typeof t === "string" ? t : t.id));
  return out;
}

function normMatrix(m) {
  if (m?.tactics) return m;
  const cells = list(m);
  const by = new Map();
  cells.forEach((c) => {
    const t = c.tactic || "Other";
    if (!by.has(t)) by.set(t, []);
    by.get(t).push({
      id: c.id || c.technique_id,
      name: c.name,
      count: c.count ?? c.hits ?? 0,
      incidents: c.incidents ?? 0,
    });
  });
  return { tactics: [...by.entries()].map(([tactic, techniques]) => ({ tactic, techniques })) };
}

export const api = {
  overview: (pid = PROJECT) =>
    call(`/v1/projects/${e(pid)}/overview`, undefined, () => mock.overview()),
  incidents: async (pid = PROJECT, q = "?limit=200") =>
    list(await call(`/v1/projects/${e(pid)}/incidents${q}`, undefined, () => mock.incidents())).map(
      normIncident,
    ),
  incident: async (iid) => {
    const r = await call(`/v1/incidents/${e(iid)}`, undefined, () => mock.incident(iid));
    if (!r) throw new CoreError("Incident not found", 404);
    return normIncident(r);
  },
  incidentEvents: async (iid) =>
    list(await call(`/v1/incidents/${e(iid)}/events`, undefined, () => mock.incidentEvents(iid))),
  patchIncident: (iid, body) =>
    call(`/v1/incidents/${e(iid)}`, { method: "PATCH", body }, () => mock.patchIncident(iid, body)),
  bulkResolveNoise: async (ids) => {
    if (isDemo()) return mock.bulkResolveNoise();
    await Promise.all(
      ids.map((id) =>
        strict(`/v1/incidents/${e(id)}`, { method: "PATCH", body: { status: "resolved" } }),
      ),
    );
    return ids.length;
  },
  action: (iid, body) =>
    call(`/v1/incidents/${e(iid)}/actions`, { method: "POST", body }, () => mock.action(iid, body)),
  note: (iid, body) =>
    call(`/v1/incidents/${e(iid)}/notes`, { method: "POST", body }, () => ({ ok: true })),
  attackers: async (pid = PROJECT, q = "") =>
    list(await call(`/v1/projects/${e(pid)}/attackers${q}`, undefined, () => mock.attackers())),
  attacker: async (aid) => {
    const r = await call(`/v1/attackers/${e(aid)}`, undefined, () => mock.attacker(aid));
    if (!r) throw new CoreError("Attacker not found", 404);
    return r;
  },
  events: async (pid = PROJECT, q = "?limit=200") =>
    list(await call(`/v1/projects/${e(pid)}/events${q}`, undefined, () => mock.events())),
  attackMatrix: async (pid = PROJECT) =>
    normMatrix(
      await call(`/v1/projects/${e(pid)}/attack-matrix`, undefined, () => mock.attackMatrix()),
    ),
  decoys: async (pid = PROJECT) =>
    list(await call(`/v1/projects/${e(pid)}/decoys`, undefined, () => mock.decoys())),
  containment: (pid = PROJECT) =>
    call(`/v1/projects/${e(pid)}/containment`, undefined, () => mock.containment()),
  blocklist: async (pid = PROJECT) =>
    list(await call(`/v1/projects/${e(pid)}/blocklist`, undefined, () => mock.blocklist())),
  addBlock: (pid = PROJECT, body) =>
    call(`/v1/projects/${e(pid)}/blocklist`, { method: "POST", body }, () => mock.addBlock(body)),
  unblock: (pid = PROJECT, bid) =>
    call(`/v1/projects/${e(pid)}/blocklist/${e(bid)}`, { method: "DELETE" }, () =>
      mock.unblock(bid),
    ),
  audit: async (pid = PROJECT, q = "?limit=200") =>
    list(await call(`/v1/projects/${e(pid)}/audit${q}`, undefined, () => mock.audit())),
  settings: (pid = PROJECT) => call(`/v1/projects/${e(pid)}`, undefined, () => mock.settings()),
  onboarding: (pid = PROJECT) =>
    call(`/v1/projects/${e(pid)}/onboarding`, undefined, () => mock.onboarding()),
  replay: (pid = PROJECT, body = { scenario: "ps-use-case" }) =>
    call(`/v1/projects/${e(pid)}/demo/replay`, { method: "POST", body }, () => mock.replay()),
  system: () => call("/v1/system", undefined, () => mock.system()),
  retryJob: (id) =>
    isDemo() ? mock.retryJob(id) : strict(`/v1/system/jobs/${e(id)}/retry`, { method: "POST" }),
  iocsUrl: (pid, iid, fmt) =>
    `${coreUrl()}/v1/projects/${e(pid)}/iocs?incident=${e(iid)}&format=${e(fmt)}`,
  iocs: async (pid = PROJECT, iid, fmt = "json") => {
    if (isDemo()) return mock.iocs(iid, fmt);
    const r = await raw(`/v1/projects/${e(pid)}/iocs?incident=${e(iid)}&format=${e(fmt)}`);
    if (!r.ok) return mock.iocs(iid, fmt);
    return r.data;
  },
};

export const streamUrl = (pid = PROJECT) => `${coreUrl()}/v1/stream?project=${e(pid)}`;

/* ───────── project discovery ─────────
   A project pinned in runtime config wins. Otherwise GET /v1/projects (the API runs with
   DEV_AUTH_BYPASS in dev) and take `acme-shop`, else the first one. If the API is
   unreachable we fall back to the mock project id and the demo badge appears. */
let projectPromise = null;
let projectAt = 0;
export function resolveProject() {
  if (projectPromise && Date.now() - projectAt < 30000) return projectPromise;
  projectAt = Date.now();
  // Runtime config first: it may pin a project explicitly, and it carries the API
  // URL that the /v1/projects lookup below depends on.
  projectPromise = loadConfig()
    .then((cfg) => (cfg.projectId ? { ok: true, pinned: cfg.projectId } : raw("/v1/projects")))
    .then((r) => {
      if (r.pinned) {
        projectAt = Date.now() + 3600e3;
        return r.pinned;
      }
      const items = r.ok ? list(r.data) : [];
      const p =
        items.find((x) => x.slug === "acme-shop") ||
        items.find((x) => x.environment === "demo") ||
        items[0];
      if (p?.id) {
        projectAt = Date.now() + 3600e3;
        return p.id;
      }
      return MOCK_PROJECT;
    })
    .catch(() => MOCK_PROJECT);
  return projectPromise;
}

// Every project-scoped call resolves the live project id first and ignores the caller-supplied one.
[
  "overview",
  "incidents",
  "attackers",
  "events",
  "attackMatrix",
  "decoys",
  "containment",
  "blocklist",
  "addBlock",
  "unblock",
  "audit",
  "settings",
  "onboarding",
  "replay",
  "iocs",
].forEach((k) => {
  const orig = api[k];
  api[k] = async (_pid, ...rest) => orig(await resolveProject(), ...rest);
});

/* ───────── real-API shape normalizers (idempotent: mock data passes through unchanged) ───────── */
const titleCase = (s) =>
  String(s || "")
    .split(/[-_ ]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(s || ""));

function normDecoy(d) {
  if (d.name) return d;
  const key = d.decoy_key || d.id;
  return {
    ...d,
    id: key,
    name: titleCase(key),
    service: d.service || `${d.type}${d.mount ? `:${d.mount}` : ""}`,
    persona: d.persona || d.type,
    status: d.status === "online" ? "online" : d.status === "offline" ? "offline" : "stale",
    agent_version: d.agent_version || d.sensor?.version || "—",
    policy_version: d.policy_version ?? "—",
    events_24h: d.events_24h ?? 0,
  };
}

function normAttacker(a) {
  const fp = { ...(a.fingerprints || {}) };
  if (!fp.client_banner && fp.client_banners?.length) fp.client_banner = fp.client_banners[0];
  return {
    ...a,
    fingerprints: fp,
    decoys_touched: a.decoys_touched || [],
    real_assets_touched: a.real_assets_touched || [],
    incident_ids: a.incident_ids || (a.incidents || []).map((i) => i.id),
  };
}

function normBlock(b) {
  const expired = b.removed_at || (b.expires_at && new Date(b.expires_at) < new Date());
  return {
    ...b,
    reason: b.reason || "No reason given",
    status: b.status || (expired ? "expired" : "applied"),
    applied_sensors: b.applied_sensors ?? null,
    total_sensors: b.total_sensors ?? null,
    incident_number: b.incident_number ?? null,
    created_by: isUuid(b.created_by) ? "analyst" : b.created_by || "system",
  };
}

function normAudit(r) {
  if (r.at) return r;
  const md = r.metadata || {};
  const actor =
    r.actor ||
    (r.actor_type === "system"
      ? "system"
      : md.actor || (isUuid(r.actor_id) ? "analyst" : r.actor_id) || "analyst");
  const target =
    md.ip || (r.target_type ? `${r.target_type} ${String(r.target_id || "").slice(0, 8)}` : "—");
  return {
    ...r,
    at: r.created_at,
    actor,
    action: String(r.action || "").replace(/^response\./, ""),
    target,
    metadata: md,
  };
}

function normContainment(c) {
  if (!c || c.containers) return c;
  const latest = c.latest || [];
  const checksOf = (r) =>
    (r.checks || []).map((k) => ({
      name: k.name,
      status: k.passed ? "pass" : "fail",
      detail: k.detail || "",
    }));
  const containers = latest.flatMap((r) => {
    const names = Object.keys(r.declared_posture || {});
    const run = { status: r.passed ? "pass" : "fail", run_at: r.created_at, checks: checksOf(r) };
    const mk = (name, p = {}) => ({
      decoy_id: name,
      container: name,
      declared: {
        network_mode: p.network || p.network_mode || "—",
        read_only: p.read_only ?? p.readOnly ?? null,
        cap_drop: p.cap_drop || p.capDrop || "—",
        user: p.user || "—",
        mem_limit: p.mem_limit || p.memory || "—",
        pids_limit: p.pids_limit ?? "—",
        no_new_privileges: p.no_new_privileges ?? null,
      },
      selftest: run,
    });
    return names.length
      ? names.map((n) => mk(n, r.declared_posture[n]))
      : [mk(r.hostname || "sensor")];
  });
  const all = latest.flatMap(checksOf);
  return {
    status: c.passed ? "pass" : "fail",
    passed: all.filter((k) => k.status === "pass").length,
    total: all.length,
    last_run_at: latest[0]?.created_at || null,
    command: "npx lxs selftest --report",
    containers,
  };
}

function normMatrix2(m) {
  if (m?.tactics) return m;
  const rows = list(m?.techniques ? m.techniques : m);
  const norm = rows.map((r) => ({
    id: r.id || r.technique_id,
    name: r.name,
    tactic: titleCase(r.tactic),
    count: r.count ?? r.incidents ?? 0,
    incidents: r.incidents ?? 0,
  }));
  norm.forEach((r) => {
    if (r.id && !TECHNIQUES[r.id])
      TECHNIQUES[r.id] = { name: r.name, tactic: r.tactic, desc: "", count: 0 };
  });
  const order = [
    "Reconnaissance",
    "Initial Access",
    "Execution",
    "Persistence",
    "Defense Evasion",
    "Credential Access",
    "Discovery",
    "Collection",
    "Command And Control",
    "Exfiltration",
  ];
  const by = new Map(order.map((t) => [t, []]));
  norm.forEach((r) => {
    if (!by.has(r.tactic)) by.set(r.tactic, []);
    {
      const ex = by.get(r.tactic).find((z) => z.id === r.id);
      if (ex) ex.count += r.count;
      else by.get(r.tactic).push(r);
    }
  });
  return {
    tactics: [...by.entries()]
      .map(([tactic, techniques]) => ({ tactic: tactic.replace("And", "and"), techniques }))
      .filter((t) => t.techniques.length),
  };
}

const wrap = (name, fn) => {
  const o = api[name];
  api[name] = async (...a) => fn(await o(...a));
};
wrap("decoys", (r) => r.map(normDecoy));
wrap("attackers", (r) => r.map(normAttacker));
wrap("attacker", normAttacker);
wrap("blocklist", (r) => r.map(normBlock));
wrap("audit", (r) => r.map(normAudit));
wrap("containment", normContainment);
wrap("attackMatrix", normMatrix2);
wrap("onboarding", (o) => ({
  ...o,
  steps: (o.steps || []).map((s) => ({ ...s, key: s.key || s.id })),
}));

// Settings: project row + keys + notification channels merged into one view-model.
{
  const base = api.settings;
  api.settings = async (...a) => {
    const s = await base(...a);
    if (s.keys || isDemo()) return s;
    const pid = await resolveProject();
    const [keys, ch] = await Promise.all([
      raw(`/v1/projects/${e(pid)}/keys`).catch(() => null),
      raw(`/v1/projects/${e(pid)}/notification-channels`).catch(() => null),
    ]);
    return {
      project: { id: s.id, name: s.name },
      keys: (keys?.ok ? list(keys.data) : []).filter((k) => !k.revoked_at),
      channels: (ch?.ok ? list(ch.data) : []).map((c) => ({
        ...c,
        label: c.label || c.name || c.type,
        target: c.target || c.url || "",
        min_severity: c.min_severity || "high",
      })),
      allowlist: s.allowlist || [],
      retention_days: s.retention_days ?? 30,
      ai_narration: s.ai_enabled ?? true,
      credential_capture: s.credential_capture || "masked",
    };
  };
}

// System: map the real /v1/system payload onto the view-model the System page renders.
{
  const base = api.system;
  api.system = async () => {
    const s = await base();
    if (s.ingest_rate_per_min != null) return s;
    const c = s.counts || {};
    return {
      version: s.version,
      uptime_seconds: s.uptime_s || 0,
      ingest_rate_per_min: 0,
      queue_depth: c.unprocessed_events || 0,
      stream_connections: s.stream_connections || 0,
      events_24h: c.events || 0,
      failed_jobs: s.failed_jobs || [],
      llm: s.llm || {
        model: "—",
        success_rate: 0,
        p50_ms: 0,
        p95_ms: 0,
        calls_24h: 0,
        fallbacks_24h: 0,
      },
      agents: s.agents || [],
      ingest_series: s.ingest_series || [],
    };
  };
}
