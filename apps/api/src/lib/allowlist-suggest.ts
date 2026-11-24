import { isIP } from 'node:net';
import { ipInCidrs } from './auto-block.js';

/**
 * Allowlist helper: from traffic seen on REAL (non-decoy) routes, suggest sources that look
 * like the owner's own infrastructure (health checks, uptime monitors, CI runners, and
 * steady benign traffic from one /24). Pure and deterministic; every suggestion says why.
 * A source that ever touched a decoy, or is a flagged attacker, is never suggested.
 */

export interface SourceStats {
  ip: string;
  /** Real-route events from this source in the window. */
  events: number;
  /** Distinct UTC days (YYYY-MM-DD) it was seen on. */
  dayList: string[];
  userAgents: string[];
  paths: string[];
  /** Share of responses with status >= 400 (0..1). */
  errorRatio: number;
  lastSeen: string | null;
  touchedDecoy: boolean;
  flaggedAttacker: boolean;
}

export interface CiRangeSet {
  name: string;
  cidrs: string[];
}

export type SuggestionKind =
  | 'health_check'
  | 'uptime_monitor'
  | 'ci_runner'
  | 'benign_repeat'
  | 'benign_subnet';

export interface Suggestion {
  cidr: string;
  kind: SuggestionKind;
  score: number;
  reasons: string[];
  events: number;
  days: number;
  sources: number;
  last_seen: string | null;
  sample_user_agent: string | null;
}

/** [pattern, product, kind]. Matched against the user agent, case-insensitive. */
const UA_PATTERNS: [RegExp, string, 'health_check' | 'uptime_monitor' | 'ci_runner'][] = [
  [/kube-probe/i, 'Kubernetes probe', 'health_check'],
  [/ELB-HealthChecker/i, 'AWS ELB health check', 'health_check'],
  [/Amazon-Route53-Health-Check/i, 'Route 53 health check', 'health_check'],
  [/GoogleHC/i, 'Google Cloud health check', 'health_check'],
  [/Azure Traffic Manager|AlwaysOn/i, 'Azure health probe', 'health_check'],
  [/Consul Health Check/i, 'Consul health check', 'health_check'],
  [/Envoy\/HC|HealthChecker/i, 'load balancer health check', 'health_check'],
  [/nagios|check_http|icinga|zabbix/i, 'Nagios/Icinga/Zabbix check', 'health_check'],
  [/UptimeRobot/i, 'UptimeRobot', 'uptime_monitor'],
  [/Pingdom/i, 'Pingdom', 'uptime_monitor'],
  [/StatusCake/i, 'StatusCake', 'uptime_monitor'],
  [/Better ?Uptime|Better Stack/i, 'Better Stack', 'uptime_monitor'],
  [/Datadog\/Synthetics|DatadogSynthetics/i, 'Datadog Synthetics', 'uptime_monitor'],
  [/Site24x7/i, 'Site24x7', 'uptime_monitor'],
  [/Checkly/i, 'Checkly', 'uptime_monitor'],
  [/NewRelicPinger|New Relic Synthetics/i, 'New Relic Synthetics', 'uptime_monitor'],
  [/Uptime-Kuma/i, 'Uptime Kuma', 'uptime_monitor'],
  [/HetrixTools|Freshping|UptimeTrends|Updown\.io/i, 'uptime monitor', 'uptime_monitor'],
  [/GitHub-Actions|GitHubActions/i, 'GitHub Actions', 'ci_runner'],
  [/GitLab-Runner|gitlab-ci/i, 'GitLab runner', 'ci_runner'],
  [/Buildkite|CircleCI|Jenkins|TeamCity/i, 'CI runner', 'ci_runner'],
];

const HEALTH_PATH =
  /^\/?(?:[\w-]+\/)?(health|healthz|healthcheck|health-check|livez|readyz|ready|ping|status|_status|metrics|up)\/?$/i;

export const MIN_SCORE = 50;
/** Benign repeat: seen on at least this many distinct days. */
export const REPEAT_DAYS = 7;
/** Benign /24: at least this many days across the subnet, from at least two sources. */
export const SUBNET_DAYS = 5;
export const MAX_ERROR_RATIO = 0.2;

const pathOf = (p: string): string => {
  const s = p.replace(/^\w+:/, ''); // "app:/health" -> "/health"
  try {
    return s.startsWith('http') ? new URL(s).pathname : s.split('?')[0]!;
  } catch {
    return s.split('?')[0]!;
  }
};

export function uaMatch(
  uas: string[],
): { product: string; kind: 'health_check' | 'uptime_monitor' | 'ci_runner'; ua: string } | null {
  for (const ua of uas)
    for (const [re, product, kind] of UA_PATTERNS) if (re.test(ua)) return { product, kind, ua };
  return null;
}

const v4Slash24 = (ip: string): string | null => {
  if (isIP(ip) !== 4) return null;
  const o = ip.split('.');
  return `${o[0]}.${o[1]}.${o[2]}.0/24`;
};

const hostCidr = (ip: string): string => `${ip}/${isIP(ip) === 6 ? 128 : 32}`;

/** Score one source; null when it is not a candidate on its own. */
function scoreSource(s: SourceStats, ci: CiRangeSet[]): Suggestion | null {
  const reasons: string[] = [];
  let score = 0;
  let kind: SuggestionKind = 'benign_repeat';
  const ua = uaMatch(s.userAgents);
  if (ua) {
    score += 60;
    kind = ua.kind;
    reasons.push(
      ua.kind === 'ci_runner'
        ? `User agent looks like a CI runner (${ua.product})`
        : `User agent looks like a ${ua.kind === 'health_check' ? 'health check' : 'uptime monitor'} (${ua.product})`,
    );
  }
  const ciHit = ci.find((r) => ipInCidrs(s.ip, r.cidrs));
  if (ciHit) {
    score += 50;
    if (!ua) kind = 'ci_runner';
    reasons.push(`Inside a cached ${ciHit.name} address range`);
  }
  const paths = s.paths.map(pathOf).filter(Boolean);
  if (paths.length > 0 && paths.every((p) => HEALTH_PATH.test(p)) && s.events >= 10) {
    score += 30;
    if (kind === 'benign_repeat') kind = 'health_check';
    reasons.push(`Only requests health endpoints (${[...new Set(paths)].slice(0, 3).join(', ')})`);
  }
  const days = new Set(s.dayList).size;
  if (days >= REPEAT_DAYS && s.errorRatio <= MAX_ERROR_RATIO) {
    score += 30 + 2 * Math.min(days, 30);
    reasons.push(`Seen on ${days} different days with few errors and no decoy contact`);
  }
  if (score < MIN_SCORE) return null;
  return {
    cidr: hostCidr(s.ip),
    kind,
    score: Math.min(100, score),
    reasons,
    events: s.events,
    days,
    sources: 1,
    last_seen: s.lastSeen,
    sample_user_agent: ua?.ua.slice(0, 200) ?? s.userAgents[0]?.slice(0, 200) ?? null,
  };
}

/**
 * Rank allowlist suggestions. Sources already allowlisted, currently blocked, that touched a
 * decoy, or that are flagged attackers are excluded. Benign repeat traffic from several
 * addresses in one IPv4 /24 is folded into a single /24 suggestion.
 */
export function suggestAllowlist(input: {
  sources: SourceStats[];
  allowlist: string[];
  blocked: string[];
  ciRanges?: CiRangeSet[];
  limit?: number;
}): Suggestion[] {
  const ci = input.ciRanges ?? [];
  const blocked = new Set(input.blocked);
  const eligible = input.sources.filter(
    (s) =>
      isIP(s.ip) &&
      !s.touchedDecoy &&
      !s.flaggedAttacker &&
      !blocked.has(s.ip) &&
      !ipInCidrs(s.ip, input.allowlist),
  );

  const out: Suggestion[] = [];
  const singles = new Map<string, Suggestion>();
  for (const s of eligible) {
    const sug = scoreSource(s, ci);
    if (sug) singles.set(s.ip, sug);
  }

  // A /24 of steady, low-error traffic from 2+ sources over SUBNET_DAYS+ days.
  const subnets = new Map<string, SourceStats[]>();
  for (const s of eligible) {
    const net = v4Slash24(s.ip);
    if (net) subnets.set(net, [...(subnets.get(net) ?? []), s]);
  }
  const folded = new Set<string>();
  for (const [net, members] of subnets) {
    if (members.length < 2 || ipInCidrs(net.split('/')[0]!, input.allowlist)) continue;
    const days = new Set(members.flatMap((m) => m.dayList)).size;
    const events = members.reduce((n, m) => n + m.events, 0);
    const errors = members.reduce((n, m) => n + m.errorRatio * m.events, 0) / Math.max(1, events);
    if (days < SUBNET_DAYS || errors > MAX_ERROR_RATIO) continue;
    // Never widen to a /24 that also holds a source we would not trust.
    const all = input.sources.filter((s) => v4Slash24(s.ip) === net);
    if (all.some((s) => s.touchedDecoy || s.flaggedAttacker || blocked.has(s.ip))) continue;
    const reasons = [
      `Benign traffic from ${members.length} addresses in ${net} on ${days} different days, no decoy contact`,
    ];
    for (const m of members) {
      const single = singles.get(m.ip);
      if (single) for (const r of single.reasons) reasons.push(`${m.ip}: ${r}`);
      folded.add(m.ip);
    }
    const lastSeen = members
      .map((m) => m.lastSeen)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
    out.push({
      cidr: net,
      kind: 'benign_subnet',
      score: Math.min(100, 40 + Math.min(days, 30) + Math.min(members.length * 5, 20)),
      reasons: reasons.slice(0, 6),
      events,
      days,
      sources: members.length,
      last_seen: lastSeen ?? null,
      sample_user_agent: members.flatMap((m) => m.userAgents)[0]?.slice(0, 200) ?? null,
    });
  }
  for (const [ip, sug] of singles) if (!folded.has(ip)) out.push(sug);

  return out
    .sort((a, b) => b.score - a.score || b.events - a.events || a.cidr.localeCompare(b.cidr))
    .slice(0, input.limit ?? 20);
}

/** Read a cached CI range list: `{name?, cidrs: []}`, a GitHub meta document, or a bare array. */
export function parseCiRanges(doc: unknown, fallbackName = 'CI runner'): CiRangeSet[] {
  if (Array.isArray(doc))
    return [{ name: fallbackName, cidrs: doc.filter((x): x is string => typeof x === 'string') }];
  if (!doc || typeof doc !== 'object') return [];
  const o = doc as Record<string, unknown>;
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (Array.isArray(o.actions)) return [{ name: 'GitHub Actions', cidrs: strs(o.actions) }];
  if (Array.isArray(o.cidrs))
    return [{ name: typeof o.name === 'string' ? o.name : fallbackName, cidrs: strs(o.cidrs) }];
  return [];
}
