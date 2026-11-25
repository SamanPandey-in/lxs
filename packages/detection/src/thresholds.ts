/**
 * Detection thresholds. The published values (BREAKDOWN 7.6, docs) are what every deployment uses by
 * default, and what the golden tests and the demo are locked to. A deployment can opt in to a
 * per-deployment jitter so an attacker who has read the repository cannot pace a brute force or a
 * sweep just under the published numbers: each threshold moves by up to +/-pct from a seed.
 *
 * Opt-in only: no seed, no jitter. Points and severity bands are never jittered, so a given set of
 * detections always scores the same.
 */
export interface Thresholds {
  /** R02: distinct decoys/paths ... */
  sweepDistinct: number;
  /** ... within this window. */
  sweepWindowMs: number;
  /** R04: failed logins ... */
  bruteforceFailures: number;
  /** ... within this window. */
  bruteforceWindowMs: number;
  /** R07: commands in one session. */
  sessionCommands: number;
  /** R13: median gap between interactive commands for human cadence. */
  humanMedianGapMs: number;
  /** R14: idle gap that counts as a revisit. */
  revisitIdleMs: number;
}

export const PUBLISHED_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  sweepDistinct: 3,
  sweepWindowMs: 60_000,
  bruteforceFailures: 5,
  bruteforceWindowMs: 60_000,
  sessionCommands: 3,
  humanMedianGapMs: 1_500,
  revisitIdleMs: 10 * 60_000,
});

/** Lower bounds so a jittered count never degenerates (a "sweep" of one path, one failed login). */
const FLOORS: Readonly<Thresholds> = Object.freeze({
  sweepDistinct: 2,
  sweepWindowMs: 10_000,
  bruteforceFailures: 3,
  bruteforceWindowMs: 10_000,
  sessionCommands: 2,
  humanMedianGapMs: 500,
  revisitIdleMs: 60_000,
});

export const DEFAULT_JITTER_PCT = 0.15;

/** FNV-1a with a murmur3 finaliser: a pure, platform-independent 32-bit draw (no node:crypto). */
function draw(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

/**
 * Thresholds for one deployment. `seed` unset or empty: exactly PUBLISHED_THRESHOLDS. Otherwise
 * each value is scaled by a factor in [1 - pct, 1 + pct] drawn from a hash of (seed, name); counts are
 * rounded and nothing drops below its floor. `pct` is clamped to [0.10, 0.20].
 */
export function jitterThresholds(
  seed: string | undefined | null,
  pct: number = DEFAULT_JITTER_PCT,
): Thresholds {
  if (!seed) return { ...PUBLISHED_THRESHOLDS };
  const p = Math.min(0.2, Math.max(0.1, Number.isFinite(pct) ? pct : DEFAULT_JITTER_PCT));
  const out = { ...PUBLISHED_THRESHOLDS };
  for (const key of Object.keys(out) as Array<keyof Thresholds>) {
    const u = draw(`${seed}|${key}`); // [0, 1]
    const factor = 1 - p + 2 * p * u;
    const base = PUBLISHED_THRESHOLDS[key];
    const isCount =
      key === 'sweepDistinct' || key === 'bruteforceFailures' || key === 'sessionCommands';
    // Counts round to the nearest integer (so a small count such as 3 only moves on a draw near
    // the edge of the band); windows round to 100 ms.
    const v = isCount ? Math.round(base * factor) : Math.round((base * factor) / 100) * 100;
    out[key] = Math.max(FLOORS[key], v);
  }
  return out;
}
