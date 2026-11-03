import type { DecoyEvent, Detection, IncidentLabel, Severity } from '@lxs/schema';
import { tech } from './attack-map.js';
import { stagesFromDetections } from './killchain.js';
import {
  type DecoyFacts,
  type DetectionContext,
  decoyFacts,
  det,
  eventTime,
  runDecoyRules,
  servicePath,
  sortEvents,
} from './rules.js';
import {
  finalSeverity,
  highestFloor,
  RULE_POINT_CAPS,
  rawScore,
  scoreWithFloor,
} from './scoring.js';

export interface ChainResult {
  detections: Detection[];
  score: number;
  severity: Severity;
  label: IncidentLabel;
  stagesReached: ReturnType<typeof stagesFromDetections>;
  realAssetReached: boolean;
  honeytokenUsed: boolean;
  /** Extras for the API / UI. */
  rawScore: number;
  floor: Severity | null;
  preCorrelationLabel: IncidentLabel;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** Rules that are allowed to have fired while an incident is still plain noise. */
const NOISE_RULES = new Set(['R01', 'R02', 'R03', 'R04', 'R05', 'R12', 'R14']);
const ACCESS_RULES = ['R06', 'R07', 'R09', 'R10', 'R11'];

/**
 * Label rules (BREAKDOWN 7.6).
 * Targeted: R13 human cadence; R16; successful login with credentials NOT in the common list;
 *           R12 together with any access; R15 when already targeted.
 * Opportunistic: got in (R06) or executed (R07/R09/R10) with bot cadence and common creds
 *           (and, as a fallback, any further activity beyond R01-R05).
 * Noise: only R01-R05 (plus the R12/R14 behaviour signals) fired; no successful auth; no R13.
 */
export function computeLabel(
  ruleIds: ReadonlySet<string>,
  facts: DecoyFacts,
  opts: { preTargeted?: boolean } = {},
): IncidentLabel {
  const access = facts.hasSuccessLogin || ACCESS_RULES.some((r) => ruleIds.has(r));
  if (
    ruleIds.has('R13') ||
    ruleIds.has('R16') ||
    facts.uncommonSuccessLogin ||
    (ruleIds.has('R12') && access) ||
    (ruleIds.has('R15') && opts.preTargeted)
  ) {
    return 'targeted';
  }
  if (facts.hasSuccessLogin) return 'opportunistic';
  for (const id of ruleIds) if (!NOISE_RULES.has(id)) return 'opportunistic';
  return 'noise';
}

/* -------------------------------------------------------------------------- */
/* Real-asset correlation (R15) and honeytoken (R16)                          */
/* -------------------------------------------------------------------------- */

function globMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1));
  return v === p || v === `${p}/` || v.startsWith(`${p}/`);
}

export function assetLabel(e: DecoyEvent): string {
  return e.asset_name ?? servicePath(e);
}

export function isCriticalAsset(e: DecoyEvent, ctx: DetectionContext): boolean {
  for (const raw of ctx.criticalAssets) {
    const c = raw.trim();
    if (!c) continue;
    if (e.asset_name && e.asset_name.toLowerCase() === c.toLowerCase()) return true;
    if (c.startsWith('/')) {
      if (globMatch(c, servicePath(e))) return true;
      if (e.url && globMatch(c, e.url.split('?')[0] ?? '')) return true;
    } else if (e.dst_service.toLowerCase() === c.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** A real-asset touch: SDK asset.access, or telemetry (prod.auth / prod.firewall that was not denied). */
export function isRealAssetTouch(e: DecoyEvent): boolean {
  if (e.is_decoy) return false;
  if (e.event_type === 'asset.access' || e.event_type === 'prod.auth') return true;
  if (e.event_type === 'prod.firewall') return e.outcome !== 'failure';
  return false;
}

const LABEL_WORD: Record<IncidentLabel, string> = {
  noise: 'Noise-level',
  opportunistic: 'Opportunistic',
  targeted: 'Targeted',
};

function runCorrelationRules(
  sorted: DecoyEvent[],
  ctx: DetectionContext,
  preLabel: IncidentLabel,
): Detection[] {
  const out: Detection[] = [];
  const touches = sorted.filter(isRealAssetTouch);
  const firstTouch = touches[0];
  if (firstTouch) {
    const critical = isCriticalAsset(firstTouch, ctx);
    const base = preLabel === 'targeted' ? 40 : preLabel === 'opportunistic' ? 20 : 10;
    const floor: Severity | null =
      preLabel === 'targeted' ? 'critical' : preLabel === 'opportunistic' ? 'high' : null;
    const credsUsed = firstTouch.event_type === 'prod.auth' && firstTouch.outcome === 'success';
    out.push(
      det(
        'R15',
        base + (critical ? 10 : 0),
        `${LABEL_WORD[preLabel]} source touched real asset ${assetLabel(firstTouch)}${critical ? ' (critical)' : ''}`,
        credsUsed ? [tech('T1078', 0.6)] : [],
        [firstTouch.id],
        { stage: null, floor },
      ),
    );
    if (!critical) {
      const crit = touches.find((e) => isCriticalAsset(e, ctx));
      if (crit) {
        out.push(
          det('R15', 10, `Critical asset touched: ${assetLabel(crit)}`, [], [crit.id], {
            stage: null,
            floor: null,
          }),
        );
      }
    }
  }

  const tokenUses = sorted.filter((e) => e.event_type === 'honeytoken.use');
  if (tokenUses.length) {
    const ids = [...new Set(tokenUses.map((e) => e.honeytoken_id).filter((x): x is string => !!x))];
    out.push(
      det(
        'R16',
        50,
        `Honeytoken used${ids.length ? ` (${ids.join(', ')})` : ''}`,
        [tech('T1078', 0.95), tech('T1552.001', 0.95)],
        tokenUses.map((e) => e.id),
        { floor: 'critical' },
      ),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Merging with existing detections (sticky once-only rules + floors)         */
/* -------------------------------------------------------------------------- */

/** Identity of a detection for de-duplication across re-evaluations. */
export function detectionKey(d: Detection): string {
  switch (d.rule_id) {
    case 'R05':
    case 'R08':
    case 'R14':
      return `${d.rule_id}|${d.reason}`;
    case 'R15':
      return d.reason.startsWith('Critical asset touched') ? `R15|crit|${d.reason}` : 'R15';
    default:
      return d.rule_id;
  }
}

function mergeDetections(existing: Detection[], computed: Detection[]): Detection[] {
  const out: Detection[] = [];
  const seen = new Set<string>();
  const capUsed: Record<string, number> = {};
  const push = (d: Detection, force: boolean) => {
    const key = detectionKey(d);
    if (seen.has(key)) return;
    const cap = RULE_POINT_CAPS[d.rule_id];
    if (cap !== undefined && !force) {
      const used = capUsed[d.rule_id] ?? 0;
      if (used + d.points > cap) return;
    }
    seen.add(key);
    capUsed[d.rule_id] = (capUsed[d.rule_id] ?? 0) + d.points;
    out.push(d);
  };
  for (const d of existing) push(d, true);
  for (const d of computed) push(d, false);
  return out;
}

/* -------------------------------------------------------------------------- */
/* evaluateChain                                                              */
/* -------------------------------------------------------------------------- */

export function evaluateChain(events: DecoyEvent[], ctx: DetectionContext): ChainResult {
  const sorted = sortEvents(events);
  const existing = ctx.existingDetections ?? [];
  const facts = decoyFacts(sorted, ctx);

  // Pass 1: decoy activity only.
  const decoyDetections = runDecoyRules(sorted, ctx);

  // Pre-correlation label: what the source did on the decoys BEFORE its first real-asset touch.
  const firstTouch = sorted.find(isRealAssetTouch);
  const preEvents = firstTouch
    ? sorted.filter((e) => eventTime(e) <= eventTime(firstTouch) && e !== firstTouch)
    : sorted;
  const preRuns = firstTouch ? runDecoyRules(preEvents, ctx) : decoyDetections;
  const preIds = new Set<string>(preRuns.map((d) => d.rule_id));
  for (const d of existing) if (d.rule_id !== 'R15' && d.rule_id !== 'R16') preIds.add(d.rule_id);
  const preLabel = computeLabel(preIds, decoyFacts(preEvents, ctx));

  // Pass 2: correlation and honeytoken rules.
  const correlation = runCorrelationRules(sorted, ctx, preLabel);

  const detections = mergeDetections(existing, [...decoyDetections, ...correlation]);
  const raw = rawScore(detections);
  const floor = highestFloor(detections);
  // A floor lifts the displayed score into its band as well as the severity, so the
  // two never disagree on screen. `rawScore` keeps the honest uncapped sum.
  const score = scoreWithFloor(raw, floor);
  const severity = finalSeverity(score, floor);

  const allIds = new Set(detections.map((d) => d.rule_id));
  const label = computeLabel(allIds, facts, { preTargeted: preLabel === 'targeted' });

  return {
    detections,
    score,
    severity,
    label,
    stagesReached: stagesFromDetections(detections),
    realAssetReached: allIds.has('R15'),
    honeytokenUsed: allIds.has('R16'),
    rawScore: raw,
    floor,
    preCorrelationLabel: preLabel,
  };
}
