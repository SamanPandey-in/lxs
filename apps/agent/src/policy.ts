import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import type { PlatformClient } from './platform.js';
import type { Counters, Logger } from './telemetry.js';

export interface BlockEntry {
  ip: string;
  expiresAt: number | null;
}

export interface RemotePolicy {
  version: number;
  blocklist: BlockEntry[];
  watchlist: string[];
  allowlist: string[];
  pollIntervalSeconds?: number;
}

export interface PolicySnapshot {
  version: number;
  blocklist: string[];
  watchlist: string[];
  allowlist: string[];
  /** sha256(token) -> honeytoken id. Plaintext tokens never leave the agent. */
  honeytokens: Record<string, string>;
  /** Local revision: bumps on any change (remote policy or locally seen watch IP). Used as the SDK's ETag. */
  revision: number;
}

const isIpOrCidr = (s: string): boolean => {
  const [addr = '', bits] = s.split('/');
  return isIP(addr) !== 0 && (bits === undefined || /^\d{1,3}$/.test(bits));
};

/** Tolerant parser: accepts both the schema package shape and the BREAKDOWN example shape. */
export function parseRemotePolicy(j: unknown): RemotePolicy | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const version = Number(o.policy_version ?? o.version ?? 0);
  const ttl = Number(o.block_ttl_seconds ?? 0);
  const blocklist: BlockEntry[] = [];
  for (const e of Array.isArray(o.blocklist) ? o.blocklist : []) {
    const ip = typeof e === 'string' ? e : (e as { ip?: unknown })?.ip;
    if (typeof ip !== 'string' || !isIpOrCidr(ip)) continue;
    const exp =
      typeof e === 'object' && e !== null ? (e as { expires_at?: unknown }).expires_at : undefined;
    const expiresAt =
      typeof exp === 'string' && !Number.isNaN(Date.parse(exp))
        ? Date.parse(exp)
        : ttl > 0
          ? Date.now() + ttl * 1000
          : null;
    blocklist.push({ ip, expiresAt });
  }
  const wl = o.watchlist;
  const wlIps = Array.isArray(wl)
    ? wl
    : Array.isArray((wl as { ips?: unknown })?.ips)
      ? (wl as { ips: unknown[] }).ips
      : [];
  const poll = Number(o.poll_interval_seconds);
  return {
    version: Number.isFinite(version) ? version : 0,
    blocklist,
    watchlist: wlIps.filter((x): x is string => typeof x === 'string' && isIpOrCidr(x)),
    allowlist: (Array.isArray(o.allowlist) ? o.allowlist : []).filter(
      (x): x is string => typeof x === 'string' && isIpOrCidr(x),
    ),
    pollIntervalSeconds: Number.isFinite(poll) && poll > 0 ? poll : undefined,
  };
}

/** Read honeytokens.json (mounted read-only) and keep only hashes. */
export function loadHoneytokenHashes(file: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      tokens?: Array<{ id: string; kind: string; value: string }>;
    };
    const out: Record<string, string> = {};
    for (const t of j.tokens ?? []) {
      if (t.kind === 'api_key' && typeof t.value === 'string')
        out[createHash('sha256').update(t.value).digest('hex')] = t.id;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * In-memory policy. The remote part comes from the pull-only poll; the local part is every source this agent
 * has just seen on a decoy (so a real-asset touch seconds later is caught before the platform round-trips).
 */
export class PolicyStore {
  private remote: RemotePolicy = { version: 0, blocklist: [], watchlist: [], allowlist: [] };
  private readonly local = new Map<string, number>(); // ip -> expiry
  private rev = 1;

  constructor(
    private readonly honeytokens: Record<string, string>,
    private readonly localWatchTtlMs = 24 * 3600 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get appliedVersion(): number {
    return this.remote.version;
  }

  update(next: RemotePolicy): void {
    this.remote = next;
    this.rev++;
  }

  addLocalWatch(ip: string): void {
    if (isIP(ip) === 0) return;
    const had = this.local.has(ip);
    this.local.set(ip, this.now() + this.localWatchTtlMs);
    if (this.local.size > 50_000) this.prune();
    if (!had) this.rev++;
  }

  private prune(): void {
    const t = this.now();
    for (const [ip, exp] of this.local) if (exp < t) this.local.delete(ip);
  }

  snapshot(): PolicySnapshot {
    const t = this.now();
    this.prune();
    const watch = new Set([...this.remote.watchlist, ...this.local.keys()]);
    return {
      version: this.remote.version,
      blocklist: this.remote.blocklist
        .filter((b) => b.expiresAt === null || b.expiresAt > t)
        .map((b) => b.ip),
      watchlist: [...watch],
      allowlist: this.remote.allowlist,
      honeytokens: this.honeytokens,
      revision: this.rev,
    };
  }
}

export interface PollerOptions {
  client: Pick<PlatformClient, 'policy'>;
  store: PolicyStore;
  intervalSeconds: number;
  counters: Counters;
  log?: Logger;
}

/** Pull-only: the platform never dials in. ETag keeps the common case to a 304. */
export class PolicyPoller {
  private timer: NodeJS.Timeout | null = null;
  private etag: string | undefined;
  private interval: number;
  private running = false;
  private failures = 0;

  constructor(private readonly o: PollerOptions) {
    this.interval = o.intervalSeconds;
  }

  async pollOnce(): Promise<void> {
    const r = await this.o.client.policy(this.etag);
    if (r.status === 304) {
      this.failures = 0;
      return;
    }
    if (r.status === 200) {
      const parsed = parseRemotePolicy(r.body);
      if (parsed) {
        this.etag = r.etag;
        const changed = parsed.version !== this.o.store.appliedVersion;
        this.o.store.update(parsed);
        this.failures = 0;
        if (parsed.pollIntervalSeconds) this.interval = parsed.pollIntervalSeconds;
        this.o.counters.inc('policy_updates');
        if (changed)
          this.o.log?.info('policy updated', {
            version: parsed.version,
            blocked: parsed.blocklist.length,
          });
        return;
      }
    }
    this.failures++;
    this.o.counters.inc('policy_poll_failures');
    this.o.log?.warn('policy poll failed; keeping last known policy', { status: r.status });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      await this.pollOnce().catch(() => undefined);
      const delay = Math.min(60, this.interval * (1 + Math.min(this.failures, 4))) * 1000;
      if (this.running) this.timer = setTimeout(tick, delay);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
