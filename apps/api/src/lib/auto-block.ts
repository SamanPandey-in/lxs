import { BlockList, isIP } from 'node:net';
import { blockedReason } from './ssrf.js';

/**
 * Auto-block policy: a deterministic, explicit rule ("block when an incident is Critical AND
 * labelled targeted, for 24 h"). Everything here is pure so the decision is unit-tested and
 * auditable. The LLM is never consulted: it explains, it never acts.
 */

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const rank = (s: string): number => SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);

export const MIN_DURATION_HOURS = 1;
export const MAX_DURATION_HOURS = 30 * 24;

export interface AutoBlockPolicy {
  enabled: boolean;
  /** monitor: record "would block", change nothing. enforce: block. */
  mode: 'monitor' | 'enforce';
  minSeverity: string;
  /** Incident label must be one of these. Empty = any label. */
  labels: string[];
  durationHours: number;
  requireRealAssetTouch: boolean;
  /** Allow private/loopback/link-local/CGNAT targets (lab setups). Off by default. */
  allowPrivate: boolean;
}

export const DEFAULT_POLICY: AutoBlockPolicy = {
  enabled: false,
  mode: 'monitor',
  minSeverity: 'critical',
  labels: ['targeted'],
  durationHours: 24,
  requireRealAssetTouch: false,
  allowPrivate: false,
};

export interface AutoBlockIncident {
  id: string;
  number: number;
  status: string;
  severity: string;
  label: string;
  realAssetReached: boolean;
  srcIp: string;
  /** Canned onboarding sample data never triggers anything. */
  sample?: boolean;
}

export interface AutoBlockContext {
  /** Project allowlist (CIDR literals). */
  allowlist: string[];
  /** The platform's own ranges (PLATFORM_IP_RANGES). */
  platformRanges: string[];
  /** An active block already exists for this source. */
  alreadyBlocked: boolean;
  /** The policy already acted (block, would-block or refusal) for this incident, even if undone. */
  alreadyActed: boolean;
  /** A person unblocked this source recently: never fight a human's undo. */
  recentlyUnblockedByHuman: boolean;
}

export type SkipReason =
  | 'disabled'
  | 'sample_data'
  | 'not_open'
  | 'below_severity'
  | 'label_not_matched'
  | 'no_real_asset_touch'
  | 'invalid_ip'
  | 'allowlisted'
  | 'platform_range'
  | 'private_range'
  | 'already_blocked'
  | 'already_acted'
  | 'recently_unblocked';

/** What fired, written to the blocklist row and the audit log. */
export interface AutoBlockRule {
  rule: 'auto_block';
  description: string;
  mode: 'monitor' | 'enforce';
  min_severity: string;
  labels: string[];
  require_real_asset_touch: boolean;
  duration_hours: number;
  incident_id: string;
  incident_number: number;
  matched: { severity: string; label: string; real_asset_reached: boolean };
}

export type AutoBlockDecision =
  | { action: 'block'; durationHours: number; rule: AutoBlockRule }
  | { action: 'would_block'; durationHours: number; rule: AutoBlockRule }
  | { action: 'skip'; reason: SkipReason; detail?: string };

export function describePolicy(p: AutoBlockPolicy): string {
  const parts = [`severity >= ${p.minSeverity}`];
  if (p.labels.length) parts.push(`label in [${p.labels.join(', ')}]`);
  if (p.requireRealAssetTouch) parts.push('touched a real asset');
  const d = p.durationHours % 24 === 0 ? `${p.durationHours / 24} d` : `${p.durationHours} h`;
  return `block when ${parts.join(' AND ')}, for ${d}`;
}

function blockListOf(cidrs: string[]): BlockList {
  const bl = new BlockList();
  for (const raw of cidrs) {
    const c = raw.trim();
    if (!c) continue;
    const [addr, bits] = c.split('/') as [string, string | undefined];
    const fam = isIP(addr);
    if (!fam) continue;
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    const prefix = bits === undefined ? (fam === 4 ? 32 : 128) : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (fam === 4 ? 32 : 128)) continue;
    try {
      bl.addSubnet(addr, prefix, type);
    } catch {
      /* malformed entry: ignore */
    }
  }
  return bl;
}

/** Built matchers per list instance, so a long cached range list is compiled once. */
const built = new WeakMap<string[], BlockList>();

/** True when `ip` falls inside any of `cidrs`. Malformed entries never match. */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
  const fam = isIP(ip);
  if (!fam || cidrs.length === 0) return false;
  let bl = built.get(cidrs);
  if (!bl) {
    bl = blockListOf(cidrs);
    built.set(cidrs, bl);
  }
  return bl.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Address classes that are refused unless the project allows private targets. */
const PRIVATE_REASONS = new Set([
  'unspecified',
  'private',
  'cgnat',
  'loopback',
  'link-local',
  'unique-local',
  'site-local',
  'ipv4-compatible',
  'nat64-local',
]);

export function privateReason(ip: string): string | null {
  const r = blockedReason(ip);
  return r && PRIVATE_REASONS.has(r) ? r : null;
}

export function parseRanges(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Safety rails shared by every automated or remote block (auto-block and Slack): never the
 * allowlist, never the platform's own ranges, never private space unless allowed.
 */
export function targetGuard(
  ip: string,
  ctx: { allowlist: string[]; platformRanges: string[]; allowPrivate: boolean },
): { ok: true } | { ok: false; reason: SkipReason; detail?: string } {
  if (!isIP(ip)) return { ok: false, reason: 'invalid_ip' };
  if (ipInCidrs(ip, ctx.allowlist)) return { ok: false, reason: 'allowlisted' };
  if (ipInCidrs(ip, ctx.platformRanges)) return { ok: false, reason: 'platform_range' };
  const priv = privateReason(ip);
  if (priv && !ctx.allowPrivate) return { ok: false, reason: 'private_range', detail: priv };
  return { ok: true };
}

/**
 * The auto-block decision. Rules, in order:
 *  1. policy enabled; not sample data; incident open or acknowledged; the policy has not
 *     already acted on this incident (blocked, would-block, or refused: undo is final);
 *  2. severity >= min_severity; label in labels (empty = any); real asset touched if required;
 *  3. target guard (valid IP, not allowlisted, not a platform range, not private unless allowed);
 *  4. not already blocked, not unblocked by a person within the block duration;
 *  5. mode monitor -> would_block, enforce -> block.
 */
export function decideAutoBlock(input: {
  policy: AutoBlockPolicy;
  incident: AutoBlockIncident;
  ctx: AutoBlockContext;
}): AutoBlockDecision {
  const { policy: p, incident: i, ctx } = input;
  if (!p.enabled) return { action: 'skip', reason: 'disabled' };
  if (i.sample) return { action: 'skip', reason: 'sample_data' };
  if (i.status !== 'open' && i.status !== 'acknowledged')
    return { action: 'skip', reason: 'not_open' };
  if (ctx.alreadyActed) return { action: 'skip', reason: 'already_acted' };
  const min = rank(p.minSeverity);
  const sev = rank(i.severity);
  if (sev < 0 || sev < (min < 0 ? rank('critical') : min))
    return { action: 'skip', reason: 'below_severity' };
  if (p.labels.length > 0 && !p.labels.includes(i.label))
    return { action: 'skip', reason: 'label_not_matched' };
  if (p.requireRealAssetTouch && !i.realAssetReached)
    return { action: 'skip', reason: 'no_real_asset_touch' };
  const guard = targetGuard(i.srcIp, {
    allowlist: ctx.allowlist,
    platformRanges: ctx.platformRanges,
    allowPrivate: p.allowPrivate,
  });
  if (!guard.ok)
    return {
      action: 'skip',
      reason: guard.reason,
      ...(guard.detail !== undefined && { detail: guard.detail }),
    };
  if (ctx.alreadyBlocked) return { action: 'skip', reason: 'already_blocked' };
  if (ctx.recentlyUnblockedByHuman) return { action: 'skip', reason: 'recently_unblocked' };

  const durationHours = Math.min(
    MAX_DURATION_HOURS,
    Math.max(MIN_DURATION_HOURS, Math.round(p.durationHours)),
  );
  const rule: AutoBlockRule = {
    rule: 'auto_block',
    description: describePolicy({ ...p, durationHours }),
    mode: p.mode,
    min_severity: p.minSeverity,
    labels: [...p.labels],
    require_real_asset_touch: p.requireRealAssetTouch,
    duration_hours: durationHours,
    incident_id: i.id,
    incident_number: i.number,
    matched: { severity: i.severity, label: i.label, real_asset_reached: i.realAssetReached },
  };
  return p.mode === 'enforce'
    ? { action: 'block', durationHours, rule }
    : { action: 'would_block', durationHours, rule };
}
