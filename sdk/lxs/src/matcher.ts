import type { AssetSpec, DecoySpec, Path } from './types.js';

/** Path without the query string, percent-decoded once, trailing slash removed. */
export function pathOnly(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  let p = q < 0 ? url : url.slice(0, q);
  if (p.indexOf('%') >= 0) {
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep raw */
    }
  }
  if (p.length > 1 && p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1);
  return p;
}

export interface DecoyMatch {
  id: string;
  mount: Path;
}

/** Precompiled: one Map lookup for exact mounts, a tiny prefix scan for web-admin sub-paths. */
export class DecoyMatcher {
  private readonly exact = new Map<string, DecoyMatch>();
  private readonly prefixes: Array<DecoyMatch & { pre: string }> = [];

  constructor(decoys: readonly DecoySpec[]) {
    for (const d of decoys) {
      if (d.type === 'web-bait') this.exact.set(d.mount, { id: d.id, mount: d.mount });
      if (d.type === 'web-admin') {
        this.exact.set(d.mount, { id: d.id, mount: d.mount });
        this.prefixes.push({ id: d.id, mount: d.mount, pre: d.mount + '/' });
      }
    }
  }

  get size(): number {
    return this.exact.size;
  }

  match(path: string): DecoyMatch | undefined {
    const hit = this.exact.get(path);
    if (hit) return hit;
    for (const p of this.prefixes) if (path.startsWith(p.pre)) return p;
    return undefined;
  }
}

/** Longest-pattern-wins. A pattern ending in /* matches the subtree and the bare path; a bare pattern matches itself and sub-routes. */
export class AssetMatcher {
  private readonly assets: Array<{ base: string; spec: AssetSpec }>;

  constructor(assets: readonly AssetSpec[]) {
    this.assets = assets
      .map((spec) => ({
        base: spec.pattern.endsWith('/*') ? spec.pattern.slice(0, -2) : spec.pattern,
        spec,
      }))
      .sort((a, b) => b.base.length - a.base.length);
  }

  match(path: string): AssetSpec | undefined {
    for (const a of this.assets) {
      if (path === a.base || path.startsWith(a.base + '/')) return a.spec;
    }
    return undefined;
  }
}
