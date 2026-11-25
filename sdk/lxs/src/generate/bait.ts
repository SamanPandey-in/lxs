import { createHash, randomBytes } from 'node:crypto';
import type { ResolvedConfig } from '../types.js';

/**
 * Per-build bait values: the version banners, keys, hostnames and timestamps ds-web prints into its
 * canned pages and bait files. Every value is drawn from a seeded generator, so a fixed seed always
 * renders byte-identical output (`lxs build --check` stays stable) while two deployments with
 * different seeds look like two different servers. The seed is recorded in .lxs/manifest.json and
 * only changes with `lxs build --reseed`.
 *
 * Nothing here is a secret: these values end up in the committed .lxs/web-decoys.json. Honeytoken
 * plaintext (API key, DB password) stays in .lxs/secrets/ and is drawn from crypto randomness.
 */
export interface BaitSeed {
  /** 32 hex characters. */
  seed: string;
  /** UTC date (YYYY-MM-DD) the seed was created; timestamps are drawn from the weeks before it. */
  epoch: string;
}

export interface BaitValues {
  /** Laravel-style `base64:` key: 32 random bytes. */
  app_key: string;
  /** Short host names that appear in banners and comments. */
  hosts: { app: string; db: string };
  /** `pg_dump` banner: server and client version strings. */
  postgres: { server: string; dump: string };
  /** When the "nightly" dump started (ISO, UTC). */
  dumped_at: string;
  /** Server software banners used by the per-template 404 pages and assets. */
  versions: { nginx: string; apache: string; php: string; wordpress: string; phpmyadmin: string };
  /** Cache-busting hash in the admin console's asset file names. */
  asset_build: string;
  /** Last-Modified for static assets (RFC 7231 date). */
  assets_modified: string;
  /** Git remote organisation and default branch in /.git/config. */
  git: { org: string; branch: string };
}

/** Deterministic byte stream: sha256(seed | label | counter). Small and dependency-free. */
export class SeededRandom {
  private buf: Buffer = Buffer.alloc(0);
  private counter = 0;

  constructor(
    private readonly seed: string,
    private readonly label = 'bait',
  ) {}

  bytes(n: number): Buffer {
    while (this.buf.length < n) {
      const block = createHash('sha256')
        .update(`${this.seed}|${this.label}|${this.counter++}`)
        .digest();
      this.buf = Buffer.concat([this.buf, block]);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  /** Integer in [lo, hi). */
  int(lo: number, hi: number): number {
    const span = hi - lo;
    return lo + (this.bytes(4).readUInt32BE(0) % span);
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length)] as T;
  }

  hex(n: number): string {
    return this.bytes(Math.ceil(n / 2))
      .toString('hex')
      .slice(0, n);
  }
}

/** Realistic, current-ish banner sets. Server and pg_dump client usually match on a backup host. */
const POSTGRES = [
  '12.18 (Ubuntu 12.18-0ubuntu0.20.04.1)',
  '13.14 (Debian 13.14-1.pgdg110+1)',
  '14.10 (Ubuntu 14.10-0ubuntu0.22.04.1)',
  '14.11 (Debian 14.11-1.pgdg120+2)',
  '15.5 (Debian 15.5-1.pgdg120+1)',
  '15.6 (Ubuntu 15.6-1.pgdg22.04+1)',
  '16.2 (Debian 16.2-1.pgdg120+2)',
] as const;
const NGINX = ['1.18.0', '1.22.1', '1.24.0', '1.25.3'] as const;
const APACHE = ['2.4.52 (Ubuntu)', '2.4.57 (Debian)', '2.4.58 (Ubuntu)'] as const;
const PHP = ['7.4.33', '8.0.30', '8.1.27', '8.2.15'] as const;
const WORDPRESS = ['6.2.4', '6.3.2', '6.4.2', '6.4.3'] as const;
const PHPMYADMIN = ['5.1.4', '5.2.0', '5.2.1'] as const;
const APP_HOSTS = ['web-prod-01', 'web-prod-03', 'app-02', 'api-prod-1', 'shop-web-2'] as const;
const DB_HOSTS = ['pg-prod-01', 'db-main-02', 'pgsql-primary', 'db01-prod', 'postgres-02'] as const;
const GIT_ORGS = ['platform-team', 'eng-internal', 'backend', 'ops-infra', 'product-eng'] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');
const httpDate = (d: Date): string =>
  `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;

/** A fresh seed (used on first build and on `--reseed`). */
export function newBaitSeed(now: Date = new Date()): BaitSeed {
  return { seed: randomBytes(16).toString('hex'), epoch: now.toISOString().slice(0, 10) };
}

/** Stable default for pure callers that pass no seed (tests, programmatic use). */
export function defaultBaitSeed(cfg: ResolvedConfig): BaitSeed {
  return {
    seed: createHash('sha256').update(`lxs-bait|${cfg.options.service}`).digest('hex').slice(0, 32),
    epoch: '2026-01-01',
  };
}

export function parseBaitSeed(v: unknown): BaitSeed | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.seed === 'string' &&
    /^[0-9a-f]{32}$/.test(o.seed) &&
    typeof o.epoch === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.epoch)
    ? { seed: o.seed, epoch: o.epoch }
    : null;
}

export function generateBait(cfg: ResolvedConfig, s: BaitSeed): BaitValues {
  const r = new SeededRandom(s.seed, `bait|${cfg.options.service}`);
  const epoch = Date.parse(`${s.epoch}T00:00:00Z`);
  // The nightly dump ran 2-20 days before the seed was made, at 01:00-03:59 UTC.
  const dumped = new Date(
    epoch - r.int(2, 21) * 86_400_000 + r.int(1, 4) * 3_600_000 + r.int(0, 3600) * 1000,
  );
  // Assets were last deployed a while before that.
  const modified = new Date(epoch - r.int(20, 120) * 86_400_000 + r.int(0, 86_400) * 1000);
  const pg = r.pick(POSTGRES);
  return {
    app_key: `base64:${r.bytes(32).toString('base64')}`,
    hosts: { app: r.pick(APP_HOSTS), db: r.pick(DB_HOSTS) },
    postgres: { server: pg, dump: pg },
    dumped_at: dumped.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    versions: {
      nginx: r.pick(NGINX),
      apache: r.pick(APACHE),
      php: r.pick(PHP),
      wordpress: r.pick(WORDPRESS),
      phpmyadmin: r.pick(PHPMYADMIN),
    },
    asset_build: r.hex(8),
    assets_modified: httpDate(modified),
    git: { org: r.pick(GIT_ORGS), branch: r.pick(['main', 'main', 'master'] as const) },
  };
}
