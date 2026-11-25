import fs from 'node:fs';

export interface WebDecoyConfig {
  id: string;
  type: 'web-admin' | 'web-bait';
  mount: string;
  brand?: string;
  acceptCredentials?: Array<[string, string]>;
  acceptAfter?: number;
  panel?: 'customers' | 'none';
  template?: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin';
  breadcrumbs?: boolean;
  /** Second-order paths (stylesheets, /.git/HEAD, ...) the SDK routes here with this decoy's id. */
  assets?: string[];
}

/** Per-build bait values written by `lxs build` (sdk/lxs/src/generate/bait.ts). */
export interface BaitValues {
  app_key: string;
  hosts: { app: string; db: string };
  postgres: { server: string; dump: string };
  dumped_at: string;
  versions: { nginx: string; apache: string; php: string; wordpress: string; phpmyadmin: string };
  asset_build: string;
  assets_modified: string;
  git: { org: string; branch: string };
}

/** Response-time jitter. `false` (or absent in tests) answers immediately. */
export interface JitterConfig {
  /** Median delay per skin in ms (lognormal). Missing skins use `default`. */
  medianMs?: Partial<Record<'admin' | 'wordpress' | 'phpmyadmin' | 'nginx' | 'asset', number>>;
  default?: number;
  /** Lognormal shape (sigma of the underlying normal). */
  sigma?: number;
  minMs?: number;
  maxMs?: number;
}

export interface WebDecoysFile {
  decoys: WebDecoyConfig[];
  service?: string;
  breadcrumbs?: {
    ssh?: { host: string; port: number; user: string } | null;
    adminMount?: string | null;
  };
  /** Absent in files written before per-build bait; FALLBACK_BAIT is used then. */
  bait?: Partial<BaitValues>;
  /** Response-time jitter; on by default in the container (main.ts), `false` turns it off. */
  jitter?: boolean | JitterConfig;
}

export interface CanaryRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  company: string;
  plan: string;
  card_last4: string;
}

export interface HoneytokenSet {
  tokens: Array<{ id: string; kind: string; value: string; prefix?: string }>;
  credentials: { ssh: { user: string; password: string } };
  canary: { rows: CanaryRow[] };
  /** Per-deployment HMAC key (base64) for per-visitor honeytokens; absent: the static token is served. */
  mint_secret?: string;
}

/**
 * Used when web-decoys.json predates per-build bait. Plausible, but the same everywhere: run
 * `lxs build` to get per-deployment values.
 */
export const FALLBACK_BAIT: BaitValues = {
  app_key: 'base64:q3hT0mVZ8yQb2cJxk6r0WkD1fN4sLp7aGe9uHi5oRtM=',
  hosts: { app: 'web-prod-01', db: 'pg-prod-01' },
  postgres: {
    server: '14.11 (Debian 14.11-1.pgdg120+2)',
    dump: '14.11 (Debian 14.11-1.pgdg120+2)',
  },
  dumped_at: '2026-01-12T02:14:37Z',
  versions: {
    nginx: '1.24.0',
    apache: '2.4.57 (Debian)',
    php: '8.1.27',
    wordpress: '6.4.3',
    phpmyadmin: '5.2.1',
  },
  asset_build: '5c1e9a07',
  assets_modified: 'Tue, 14 Oct 2025 09:41:12 GMT',
  git: { org: 'platform-team', branch: 'main' },
};

/** Field-by-field merge so a partial or older `bait` block never leaves a hole in a template. */
export function resolveBait(b: Partial<BaitValues> | undefined): BaitValues {
  const f = FALLBACK_BAIT;
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v.length > 0 ? v : d);
  return {
    app_key: str(b?.app_key, f.app_key),
    hosts: { app: str(b?.hosts?.app, f.hosts.app), db: str(b?.hosts?.db, f.hosts.db) },
    postgres: {
      server: str(b?.postgres?.server, f.postgres.server),
      dump: str(b?.postgres?.dump, f.postgres.dump),
    },
    dumped_at: str(b?.dumped_at, f.dumped_at),
    versions: {
      nginx: str(b?.versions?.nginx, f.versions.nginx),
      apache: str(b?.versions?.apache, f.versions.apache),
      php: str(b?.versions?.php, f.versions.php),
      wordpress: str(b?.versions?.wordpress, f.versions.wordpress),
      phpmyadmin: str(b?.versions?.phpmyadmin, f.versions.phpmyadmin),
    },
    asset_build: /^[0-9a-f]{6,16}$/.test(String(b?.asset_build))
      ? (b?.asset_build as string)
      : f.asset_build,
    assets_modified: str(b?.assets_modified, f.assets_modified),
    git: { org: str(b?.git?.org, f.git.org), branch: str(b?.git?.branch, f.git.branch) },
  };
}

/** Used when the honeytoken file is not mounted: obviously fake, never registered with the platform. */
export const FALLBACK_HONEYTOKENS: HoneytokenSet = {
  tokens: [],
  credentials: { ssh: { user: 'deploy', password: 'Winter2024!' } },
  canary: {
    rows: [
      {
        id: 1001,
        name: 'Maria Okafor',
        email: 'maria.okafor@example.com',
        phone: '+1-555-0142',
        company: 'Northwind Traders',
        plan: 'growth',
        card_last4: '4242',
      },
      {
        id: 1002,
        name: 'James Nguyen',
        email: 'james.nguyen@example.com',
        phone: '+1-555-0177',
        company: 'Contoso Retail',
        plan: 'starter',
        card_last4: '4242',
      },
      {
        id: 1003,
        name: 'Priya Patel',
        email: 'priya.patel@example.com',
        phone: '+1-555-0118',
        company: 'Fabrikam Goods',
        plan: 'enterprise',
        card_last4: '4242',
      },
    ],
  },
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadDecoys(file: string): WebDecoysFile {
  const j = readJson<WebDecoysFile>(file);
  if (!j || !Array.isArray(j.decoys))
    throw new Error(`ds-web: cannot read decoy config at ${file}`);
  return j;
}

export function loadHoneytokens(file: string): HoneytokenSet {
  const j = readJson<HoneytokenSet>(file);
  if (!j || !Array.isArray(j.tokens) || !j.canary?.rows) return FALLBACK_HONEYTOKENS;
  return j;
}
