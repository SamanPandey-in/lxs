import type { JitterConfig } from './config.js';

/**
 * Response-time jitter for canned responses. A real PHP login page or an nginx static file never
 * answers in under a millisecond with a flat distribution; a lognormal around a per-product median
 * (a long right tail, the occasional slow response) is what scanners see from real servers.
 */
export type JitterSkin = 'admin' | 'wordpress' | 'phpmyadmin' | 'nginx' | 'asset';

export interface Jitter {
  /** Milliseconds to wait before sending a response rendered with this skin. */
  delay(skin: JitterSkin): number;
}

/** Medians picked to sit in the 40-80 ms band typical of a small PHP/nginx host. */
export const DEFAULT_MEDIANS: Record<JitterSkin, number> = {
  admin: 70,
  wordpress: 80,
  phpmyadmin: 65,
  nginx: 40,
  asset: 30,
};
export const DEFAULT_SIGMA = 0.45;
export const DEFAULT_MIN_MS = 4;
export const DEFAULT_MAX_MS = 600;

/** Standard normal sample (Box-Muller) from a uniform source. */
function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sampleLognormal(
  median: number,
  sigma: number,
  min: number,
  max: number,
  rand: () => number = Math.random,
): number {
  const d = median * Math.exp(sigma * gaussian(rand));
  return Math.round(Math.min(max, Math.max(min, d)));
}

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** `false`/`undefined` -> null (no delay). `true` -> defaults. An object overrides the defaults. */
export function createJitter(
  cfg: boolean | JitterConfig | undefined,
  rand: () => number = Math.random,
): Jitter | null {
  if (!cfg) return null;
  const o: JitterConfig = cfg === true ? {} : cfg;
  const maxMs = num(o.maxMs, DEFAULT_MAX_MS, 0, 5000);
  const minMs = num(o.minMs, DEFAULT_MIN_MS, 0, maxMs);
  const sigma = num(o.sigma, DEFAULT_SIGMA, 0, 2);
  const fallback = num(o.default, Number.NaN, 0, 5000);
  const medians = { ...DEFAULT_MEDIANS };
  for (const k of Object.keys(medians) as JitterSkin[]) {
    medians[k] = num(o.medianMs?.[k], Number.isNaN(fallback) ? medians[k] : fallback, 0, 5000);
  }
  return {
    delay: (skin) =>
      medians[skin] <= 0 ? 0 : sampleLognormal(medians[skin], sigma, minMs, maxMs, rand),
  };
}
