import type { Detection, Severity } from '@lxs/schema';

export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** Severity bands: Low < 25, Medium 25-49, High 50-74, Critical >= 75. */
export function severityForScore(score: number): Severity {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Per-rule point caps from the rule table. */
export const RULE_POINT_CAPS: Readonly<Record<string, number>> = { R05: 20, R08: 10 };

export function rawScore(detections: Detection[]): number {
  return detections.reduce((sum, d) => sum + d.points, 0);
}

/** Displayed score is capped at 100. */
export function displayScore(raw: number): number {
  return Math.max(0, Math.min(100, raw));
}

/** The lowest score that still lands in a band. The inverse of severityForScore. */
export function bandFloorScore(s: Severity): number {
  switch (s) {
    case 'critical':
      return 75;
    case 'high':
      return 50;
    case 'medium':
      return 25;
    default:
      return 0;
  }
}

/**
 * A floor raises the displayed score to its band, so score and severity never
 * contradict each other on screen. Without this, R16 alone reads "65 · CRITICAL",
 * which looks like a bug to anyone reading the hero screen.
 * The uncapped sum is still available as `rawScore` for the detections ledger.
 */
export function scoreWithFloor(raw: number, floor: Severity | null): number {
  const capped = displayScore(raw);
  return floor ? Math.max(capped, bandFloorScore(floor)) : capped;
}

/** Highest floor among detections, or null. Floors are sticky because detections are. */
export function highestFloor(detections: Detection[]): Severity | null {
  let best: Severity | null = null;
  for (const d of detections) {
    if (d.floor && (best === null || severityRank(d.floor) > severityRank(best))) best = d.floor;
  }
  return best;
}

/** Floors override points: the final severity is never below the floor. */
export function finalSeverity(score: number, floor: Severity | null): Severity {
  const bySc = severityForScore(score);
  if (floor && severityRank(floor) > severityRank(bySc)) return floor;
  return bySc;
}
