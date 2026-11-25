import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-visitor honeytokens, agent side. ds-web hands each visitor its own API key and logs a `mint`
 * line with the token's id (never its value). The agent re-derives the value from that id with the
 * per-deployment secret in honeytokens.json, then adds sha256(value) -> id to the policy it serves
 * the SDK middleware, exactly like the static token. A forged log line can therefore only register
 * values the secret produces. Derivation must match apps/decoy-web/src/mint.ts (both pin a vector).
 */
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const MINT_ID_RE = /^([A-Za-z0-9_-]{1,50})\.([a-z2-7]{12})$/;

export function mintedValue(secret: Buffer, mintId: string, prefix: string): string {
  const mac = createHmac('sha256', secret).update(`value|${mintId}`).digest();
  let out = '';
  for (let i = 0; i < 32; i++) out += B62[(mac[i] as number) % 62];
  return `${prefix}${out}`;
}

export interface MintKeys {
  secret: Buffer;
  /** Base honeytoken id -> value prefix, for the API-key tokens that can be minted. */
  prefixes: Map<string, string>;
}

/** Read the mint secret and the API-key prefixes from honeytokens.json; null when not minting. */
export function loadMintKeys(file: string): MintKeys | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mint_secret?: unknown;
      tokens?: Array<{ id?: unknown; kind?: unknown; prefix?: unknown }>;
    };
    if (typeof j.mint_secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(j.mint_secret))
      return null;
    const prefixes = new Map<string, string>();
    for (const t of j.tokens ?? []) {
      if (t.kind === 'api_key' && typeof t.id === 'string')
        prefixes.set(t.id, typeof t.prefix === 'string' ? t.prefix : '');
    }
    return { secret: Buffer.from(j.mint_secret, 'base64'), prefixes };
  } catch {
    return null;
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Minted ids the agent has registered, persisted under the state dir so a restart (which resumes
 * tailing after the mint lines) keeps recognising tokens handed out before it. Bounded: the oldest
 * ids fall off first.
 */
export class MintRegistry {
  private readonly ids = new Map<string, number>(); // mint id -> first seen (ms)
  private dirty = false;

  constructor(
    private readonly keys: MintKeys,
    private readonly file: string | null,
    private readonly max = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hash -> id for one mint id, or null if the id is malformed or not ours to mint. */
  resolve(mintId: string): { hash: string; id: string } | null {
    const m = MINT_ID_RE.exec(mintId);
    if (!m) return null;
    const prefix = this.keys.prefixes.get(m[1] as string);
    if (prefix === undefined) return null;
    return { hash: sha256(mintedValue(this.keys.secret, mintId, prefix)), id: mintId };
  }

  /** Register a mint id. Returns the policy entry when it is new, null when known or invalid. */
  add(mintId: string): { hash: string; id: string } | null {
    if (this.ids.has(mintId)) return null;
    const r = this.resolve(mintId);
    if (!r) return null;
    this.ids.set(mintId, this.now());
    while (this.ids.size > this.max) {
      const oldest = this.ids.keys().next().value as string;
      this.ids.delete(oldest);
    }
    this.dirty = true;
    return r;
  }

  /** All registered tokens as sha256 -> id (for the policy snapshot). */
  entries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of this.ids.keys()) {
      const r = this.resolve(id);
      if (r) out[r.hash] = r.id;
    }
    return out;
  }

  get size(): number {
    return this.ids.size;
  }

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { ids?: Array<[string, number]> };
      for (const [id, at] of j.ids ?? []) {
        if (typeof id === 'string' && this.resolve(id)) this.ids.set(id, Number(at) || 0);
      }
      while (this.ids.size > this.max) this.ids.delete(this.ids.keys().next().value as string);
    } catch {
      /* first run, or unreadable: start empty */
    }
  }

  /** Write atomically when something changed. Only ids are stored, never token values. */
  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ids: [...this.ids] }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      /* keep in memory; retry on the next save */
    }
  }
}
