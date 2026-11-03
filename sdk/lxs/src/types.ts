export type WebDecoyType = 'web-admin' | 'web-bait';
export type NetDecoyType = 'ssh' | 'redis' | 'postgres';
export type Path = `/${string}`;

export interface LXSOptions {
  /** Compose service of the app (default 'app'). */
  service?: string;
  /** 'monitor' never blocks, even if the platform asks. Default 'enforce'. */
  mode?: 'monitor' | 'enforce';
  /** Directory holding the web/ and agent/ socket dirs. Default env LXS_RUN_DIR or /run/lxs. */
  runDir?: string;
  /** Trust X-Forwarded-For from these hops: true | 'loopback' | 'uniquelocal' | CIDRs. Default false. */
  trustProxy?: boolean | string[];
  /** CIDRs never reported or blocked (your own scanners and uptime monitors). */
  allowlist?: string[];
  /** Default: env LXS_DISABLED === '1'. */
  disabled?: boolean;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export interface WebAdminOptions {
  id?: string;
  /** Shown on the fake login page. */
  brand?: string;
  /** These credentials "work" and open the fake panel. */
  acceptCredentials?: Array<[user: string, pass: string]>;
  /** Or: accept any credentials after N tries. */
  acceptAfter?: number;
  /** Fake panel with an "Export customers" link. Default 'customers'. */
  panel?: 'customers' | 'none';
}

export type WebBaitTemplate = 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin';

export interface WebBaitOptions {
  id?: string;
  /** Inferred from the path if omitted. */
  template?: WebBaitTemplate;
  /** Plant links to other decoys. Default true. */
  breadcrumbs?: boolean;
}

export interface SshOptions {
  id?: string;
  persona?: 'db-backup' | 'web-server';
  hostname?: string;
  credentials?: 'weak-defaults' | Array<[string, string]>;
  /** SSH version string to present. */
  banner?: string;
}

export interface RedisOptions {
  id?: string;
  seed?: 'finance' | 'sessions';
  requirePassword?: boolean;
}

export interface PostgresOptions {
  id?: string;
  seed?: 'shop' | 'finance';
  requirePassword?: boolean;
}

export interface AssetOptions {
  /** Display name in alerts. Defaults to the pattern. */
  name?: string;
  criticality?: 'normal' | 'critical';
  /** Shorthand for criticality: 'critical'. */
  critical?: boolean;
}

export interface HoneytokenOptions {
  apiKey?: { header: 'authorization' | 'x-api-key'; prefix: string };
  /** Unique fake emails inside decoy exports. Default 5. */
  canaryRows?: number;
}

export interface WebAdminSpec {
  type: 'web-admin';
  id: string;
  mount: Path;
  brand: string;
  acceptCredentials: Array<[string, string]>;
  acceptAfter?: number;
  panel: 'customers' | 'none';
}
export interface WebBaitSpec {
  type: 'web-bait';
  id: string;
  mount: Path;
  template: WebBaitTemplate;
  breadcrumbs: boolean;
}
export interface SshSpec {
  type: 'ssh';
  id: string;
  port: number;
  persona: 'db-backup' | 'web-server';
  hostname: string;
  credentials: 'weak-defaults' | Array<[string, string]>;
  banner?: string;
}
export interface RedisSpec {
  type: 'redis';
  id: string;
  port: number;
  seed: 'finance' | 'sessions';
  requirePassword: boolean;
}
export interface PostgresSpec {
  type: 'postgres';
  id: string;
  port: number;
  seed: 'shop' | 'finance';
  requirePassword: boolean;
}
export type DecoySpec = WebAdminSpec | WebBaitSpec | SshSpec | RedisSpec | PostgresSpec;

export interface AssetSpec {
  pattern: Path;
  name: string;
  criticality: 'normal' | 'critical';
}

export interface HoneytokenSpec {
  apiKey?: { header: 'authorization' | 'x-api-key'; prefix: string };
  canaryRows: number;
}

export interface ResolvedOptions {
  service: string;
  mode: 'monitor' | 'enforce';
  runDir: string;
  trustProxy: boolean | string[];
  allowlist: string[];
  disabled: boolean;
}

export interface ResolvedConfig {
  options: ResolvedOptions;
  decoys: DecoySpec[];
  assets: AssetSpec[];
  honeytokens: HoneytokenSpec | null;
}
