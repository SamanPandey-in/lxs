import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecoyEvent } from '@lxs/schema';
import type { ChainResult, DetectionContext, EventTag } from './detection-fallback.js';

export type { ChainResult, DetectionContext, EventTag };

export interface DetectionModule {
  tagEvent(event: DecoyEvent, ctx: DetectionContext): EventTag;
  evaluateChain(events: DecoyEvent[], ctx: DetectionContext): ChainResult;
}

let mod: DetectionModule | null = null;
export let detectionSource: 'package' | 'fallback' | 'unloaded' = 'unloaded';

/** Prefer the real `@lxs/detection` package; fall back to the local thin module. */
export async function loadDetection(): Promise<DetectionModule> {
  if (mod) return mod;
  try {
    const spec = '@lxs/detection'; // variable specifier: no compile-time dependency
    const real = (await import(spec)) as Partial<DetectionModule>;
    if (typeof real.tagEvent === 'function' && typeof real.evaluateChain === 'function') {
      mod = real as DetectionModule;
      detectionSource = 'package';
      return mod;
    }
  } catch {
    /* fall through */
  }
  mod = (await import('./detection-fallback.js')) as DetectionModule;
  detectionSource = 'fallback';
  return mod;
}

const BUILTIN_CREDS = [
  'admin',
  'password',
  '123456',
  'root',
  'admin/admin',
  'root/root',
  'root/toor',
  'admin/password',
  'test/test',
];

let creds: Set<string> | null = null;
export function commonCredentials(): Set<string> {
  if (creds) return creds;
  const set = new Set<string>(BUILTIN_CREDS);
  const candidates = [
    process.env.COMMON_CREDS_PATH,
    fileURLToPath(new URL('../../../../data/wordlists/common-creds.txt', import.meta.url)),
    '/app/data/wordlists/common-creds.txt',
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line && !line.startsWith('#')) set.add(line);
      }
      break;
    } catch {
      /* try next */
    }
  }
  creds = set;
  return set;
}
