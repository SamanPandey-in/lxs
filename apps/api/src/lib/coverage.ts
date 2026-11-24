/**
 * Coverage score: how much of what LXS can see and stop is actually switched on for a project.
 *
 * Deterministic and explainable by construction: a fixed list of checks, each worth a fixed
 * number of points, each pass/fail from facts we can show (the decoy manifest the agent
 * registered, sensor heartbeats, channels, self-test reports, observed traffic). The score is
 * the sum of the points of the checks that pass; every failing check becomes a recommendation
 * saying why it matters, how to fix it, and how many points it adds. No weighting by traffic,
 * no hidden model.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;
export const ALLOWLIST_REVIEW_DAYS = 90;

export const WEB_DECOY = (t: string) => t === 'web' || t.startsWith('web-') || t.startsWith('web_');
export const NETWORK_DECOYS = ['ssh', 'postgres', 'redis'] as const;
const isNetwork = (t: string) => (NETWORK_DECOYS as readonly string[]).includes(t);

export interface CoverageFacts {
  /** Decoy types registered by the project's agents (from the `lxs build` manifest). */
  decoyTypes: string[];
  /** Real (non-sample, non-test) events on web / network decoys in the last 7 days. */
  webHits7d: number;
  networkHits7d: number;
  honeytokens: number;
  sensors: number;
  lastHeartbeatAt: Date | null;
  /** Enabled channels and their last delivery status (null = never sent). */
  channels: { name: string; enabled: boolean; lastStatus: string | null }[];
  /** `mode` from each sensor's manifest; null when the manifest does not say. */
  modes: (string | null)[];
  allowlistSize: number;
  allowlistReviewedAt: Date | null;
  /** Latest self-test report per sensor. */
  selftests: { passed: boolean; at: Date }[];
}

export interface Fix {
  /** A command to run, when the fix is in the CLI. */
  cli?: string;
  /** A line to add to decoy.config.ts, when the fix is configuration. */
  snippet?: string;
  /** A dashboard path, when the fix is a setting. */
  href?: string;
  /** What to do, in one sentence. */
  text: string;
}

export interface CoverageCheck {
  id: string;
  label: string;
  points: number;
  passed: boolean;
  earned: number;
  /** What we saw, in one line. */
  detail: string;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  fix: Fix;
  points: number;
}

export interface CoverageReport {
  score: number;
  max: number;
  checks: CoverageCheck[];
  recommendations: Recommendation[];
  computed_at: string;
}

interface CheckDef {
  id: string;
  label: string;
  points: number;
  title: string;
  why: string;
  fix: Fix;
  evaluate: (f: CoverageFacts, now: Date) => { passed: boolean; detail: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ago = (d: Date, now: Date) => {
  const m = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

/** The checks, in display order. Points add up to 100. */
export const CHECKS: readonly CheckDef[] = [
  {
    id: 'web_decoy',
    label: 'Web decoy deployed',
    points: 15,
    title: 'Add a web decoy',
    why: 'Most attacks on a web app start with a scan for admin pages and leaked files. A web decoy catches that scan on your own domain, before it finds anything real.',
    fix: {
      snippet: "{ type: 'web-admin', mount: '/admin' }",
      cli: 'lxs build',
      text: 'Add a web-admin or web-bait decoy to decoy.config.ts, then rebuild.',
    },
    evaluate: (f) => {
      const web = f.decoyTypes.filter(WEB_DECOY);
      return web.length
        ? {
            passed: true,
            detail: `${plural(web.length, 'web decoy')}, ${plural(f.webHits7d, 'hit')} in the last 7 days`,
          }
        : { passed: false, detail: 'No web decoy in the registered manifest' };
    },
  },
  {
    id: 'network_decoy',
    label: 'Network decoy deployed (SSH, PostgreSQL or Redis)',
    points: 15,
    title: 'Add a network decoy',
    why: 'Attackers who get past the web tier go for SSH and databases next. A network decoy shows lateral movement that a web decoy cannot see.',
    fix: {
      snippet: "{ type: 'ssh', mount: 2222 }",
      cli: 'lxs build',
      text: 'Add an ssh, postgres or redis decoy to decoy.config.ts, then rebuild.',
    },
    evaluate: (f) => {
      const net = [...new Set(f.decoyTypes.filter(isNetwork))];
      return net.length
        ? {
            passed: true,
            detail: `${net.join(', ')}; ${plural(f.networkHits7d, 'hit')} in the last 7 days`,
          }
        : { passed: false, detail: 'No SSH, PostgreSQL or Redis decoy registered' };
    },
  },
  {
    id: 'honeytokens',
    label: 'Honeytokens planted',
    points: 15,
    title: 'Plant honeytokens',
    why: 'A honeytoken is a fake credential that only an attacker would use. A use is the clearest proof of intent LXS can give, and it raises the incident to targeted.',
    fix: {
      cli: 'lxs build',
      text: 'Declare honeytokens in decoy.config.ts and rebuild; the build plants them in your bait files and the agent registers them.',
    },
    evaluate: (f) =>
      f.honeytokens > 0
        ? { passed: true, detail: `${plural(f.honeytokens, 'honeytoken')} planted` }
        : { passed: false, detail: 'No honeytokens registered' },
  },
  {
    id: 'agent_heartbeat',
    label: 'Agent heartbeat in the last 15 minutes',
    points: 15,
    title: 'Get the agent reporting',
    why: 'Without a live agent, decoy hits are not shipped and blocks are not applied. Everything else on this list depends on it.',
    fix: {
      cli: 'lxs doctor',
      text: 'Start the agent (docker compose up -d), then run lxs doctor to check the key and the connection.',
    },
    evaluate: (f, now) => {
      if (!f.sensors || !f.lastHeartbeatAt)
        return { passed: false, detail: 'No agent has registered yet' };
      const fresh = now.getTime() - f.lastHeartbeatAt.getTime() <= HEARTBEAT_FRESH_MS;
      return {
        passed: fresh,
        detail: `Last heartbeat ${ago(f.lastHeartbeatAt, now)} (${plural(f.sensors, 'sensor')})`,
      };
    },
  },
  {
    id: 'alert_channel',
    label: 'Alert channel configured and healthy',
    points: 15,
    title: 'Connect a healthy alert channel',
    why: 'A critical incident nobody hears about is a missed incident. A channel that has delivered at least once is one you know works.',
    fix: {
      href: '/settings#notifications',
      text: 'Add a Slack or webhook channel in Settings → Notifications and send a test.',
    },
    evaluate: (f) => {
      const on = f.channels.filter((c) => c.enabled);
      if (!on.length) return { passed: false, detail: 'No enabled alert channel' };
      const ok = on.filter((c) => c.lastStatus === 'ok');
      if (ok.length) return { passed: true, detail: `${plural(ok.length, 'channel')} delivering` };
      const failing = on.filter((c) => c.lastStatus === 'failed');
      return {
        passed: false,
        detail: failing.length
          ? `${plural(failing.length, 'channel')} failing (${failing[0]!.name})`
          : `${plural(on.length, 'channel')} never sent; send a test`,
      };
    },
  },
  {
    id: 'enforce_mode',
    label: 'Enforce mode on',
    points: 10,
    title: 'Turn on enforce mode',
    why: 'In monitor mode the SDK reports attackers but never blocks them, so a block from the dashboard does nothing.',
    fix: {
      snippet: "mode: 'enforce'",
      cli: 'lxs build',
      text: 'Set the mode to enforce in decoy.config.ts, then rebuild.',
    },
    evaluate: (f) => {
      if (!f.modes.length) return { passed: false, detail: 'No agent has registered yet' };
      const monitor = f.modes.filter((m) => m === 'monitor').length;
      if (monitor)
        return {
          passed: false,
          detail: `${plural(monitor, 'sensor')} in monitor mode`,
        };
      const unknown = f.modes.filter((m) => m !== 'enforce').length;
      return {
        passed: true,
        detail: unknown
          ? `No sensor in monitor mode (${unknown} did not report a mode; the default is enforce)`
          : `${plural(f.modes.length, 'sensor')} in enforce mode`,
      };
    },
  },
  {
    id: 'selftest',
    label: 'Containment self-test passed',
    points: 10,
    title: 'Run the containment self-test',
    why: 'The self-test proves the decoys cannot reach your network or the internet. A decoy that is not contained is a foothold, not a trap.',
    fix: {
      cli: 'lxs selftest --report',
      text: 'Run the self-test on each host and fix any failing check.',
    },
    evaluate: (f) => {
      if (!f.selftests.length) return { passed: false, detail: 'No self-test report yet' };
      const failed = f.selftests.filter((s) => !s.passed).length;
      return failed
        ? { passed: false, detail: `Latest report failed on ${plural(failed, 'sensor')}` }
        : { passed: true, detail: `Passed on ${plural(f.selftests.length, 'sensor')}` };
    },
  },
  {
    id: 'allowlist_reviewed',
    label: `Allowlist reviewed in the last ${ALLOWLIST_REVIEW_DAYS} days`,
    points: 5,
    title: 'Review the allowlist',
    why: 'Your own scanners and uptime checks belong on the allowlist so they are never blocked; anything else on it is never blocked either. Check it is still right.',
    fix: {
      href: '/settings#allow',
      text: 'Check the allowlist in Settings and confirm it (or save a change).',
    },
    evaluate: (f, now) => {
      const at = f.allowlistReviewedAt;
      const fresh = !!at && now.getTime() - at.getTime() <= ALLOWLIST_REVIEW_DAYS * 86_400_000;
      return {
        passed: fresh,
        detail: at
          ? `${plural(f.allowlistSize, 'entry', 'entries')}, last reviewed ${ago(at, now)}`
          : `${plural(f.allowlistSize, 'entry', 'entries')}, never reviewed`,
      };
    },
  },
];

export const MAX_SCORE = CHECKS.reduce((s, c) => s + c.points, 0);

/** Pure: the score, the breakdown and the recommendations (biggest gain first). */
export function scoreCoverage(f: CoverageFacts, now = new Date()): CoverageReport {
  const checks: CoverageCheck[] = CHECKS.map((c) => {
    const r = c.evaluate(f, now);
    return {
      id: c.id,
      label: c.label,
      points: c.points,
      passed: r.passed,
      earned: r.passed ? c.points : 0,
      detail: r.detail,
    };
  });
  const order = new Map(CHECKS.map((c, i) => [c.id, i]));
  const recommendations = CHECKS.filter((c) => !checks.find((x) => x.id === c.id)!.passed)
    .map((c) => ({ id: c.id, title: c.title, why: c.why, fix: c.fix, points: c.points }))
    .sort((a, b) => b.points - a.points || order.get(a.id)! - order.get(b.id)!);
  return {
    score: checks.reduce((s, c) => s + c.earned, 0),
    max: MAX_SCORE,
    checks,
    recommendations,
    computed_at: now.toISOString(),
  };
}

const date = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const list = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const x = JSON.parse(v) as unknown;
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
};

export function factsFromRow(
  row: Record<string, unknown> | undefined,
  project: { allowlist: string[]; allowlistReviewedAt: Date | null },
): CoverageFacts {
  const r = row ?? {};
  return {
    decoyTypes: list(r.decoy_types).map(String),
    webHits7d: Number(r.web_hits_7d ?? 0),
    networkHits7d: Number(r.network_hits_7d ?? 0),
    honeytokens: Number(r.honeytokens ?? 0),
    sensors: Number(r.sensors ?? 0),
    lastHeartbeatAt: date(r.last_heartbeat_at),
    channels: list(r.channels).map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      return {
        name: String(x.name ?? ''),
        enabled: x.enabled !== false,
        lastStatus: typeof x.last_status === 'string' ? x.last_status : null,
      };
    }),
    modes: list(r.modes).map((m) => (typeof m === 'string' ? m : null)),
    allowlistSize: project.allowlist.length,
    allowlistReviewedAt: date(r.allowlist_reviewed_at) ?? project.allowlistReviewedAt,
    selftests: list(r.selftests)
      .map((s) => (s ?? {}) as Record<string, unknown>)
      .map((s) => ({ passed: s.passed === true, at: date(s.at) ?? new Date(0) })),
  };
}

/**
 * Facts for one project. An allowlist counts as reviewed when an owner confirmed it
 * (`projects.allowlist_reviewed_at`) or saved a change to it (audit `project.update`).
 */
export async function loadCoverageFacts(project: {
  id: string;
  allowlist: string[];
  allowlistReviewedAt: Date | null;
}): Promise<CoverageFacts> {
  const pid = project.id;
  const rows = (await db.execute(dsql`
    select
      (select coalesce(json_agg(distinct d.type), '[]'::json) from decoys d where d.project_id = ${pid}::uuid) as decoy_types,
      (select coalesce(sum(e.count), 0)::int from events e join decoys d on d.id = e.decoy_id
        where e.project_id = ${pid}::uuid and e.received_at > now() - interval '7 days'
          and not e.sample and not e.simulated and d.type like 'web%') as web_hits_7d,
      (select coalesce(sum(e.count), 0)::int from events e join decoys d on d.id = e.decoy_id
        where e.project_id = ${pid}::uuid and e.received_at > now() - interval '7 days'
          and not e.sample and not e.simulated and d.type in ('ssh', 'postgres', 'redis')) as network_hits_7d,
      (select count(*)::int from honeytokens h where h.project_id = ${pid}::uuid) as honeytokens,
      (select count(*)::int from sensors s where s.project_id = ${pid}::uuid) as sensors,
      (select max(s.last_seen_at) from sensors s where s.project_id = ${pid}::uuid) as last_heartbeat_at,
      (select coalesce(json_agg(s.manifest->>'mode'), '[]'::json) from sensors s where s.project_id = ${pid}::uuid) as modes,
      (select coalesce(json_agg(json_build_object('name', c.name, 'enabled', c.enabled, 'last_status', c.last_status)), '[]'::json)
        from notification_channels c where c.project_id = ${pid}::uuid) as channels,
      (select coalesce(json_agg(json_build_object('passed', r.passed, 'at', r.created_at)), '[]'::json) from (
        select distinct on (c.sensor_id) c.passed, c.created_at from containment_reports c
        where c.project_id = ${pid}::uuid order by c.sensor_id, c.created_at desc) r) as selftests,
      greatest(
        (select p.allowlist_reviewed_at from projects p where p.id = ${pid}::uuid),
        (select max(a.created_at) from audit_logs a where a.project_id = ${pid}::uuid
          and a.action = 'project.update' and a.metadata->'fields' ? 'allowlist')) as allowlist_reviewed_at
  `)) as unknown as Record<string, unknown>[];
  return factsFromRow(rows[0], project);
}
