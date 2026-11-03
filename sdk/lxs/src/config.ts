import { z } from 'zod';
import { LXS } from './create.js';
import { LXSConfigError } from './errors.js';
import { parseCidr } from './netutil.js';
import { resolveRunDir } from './socket.js';
import type {
  AssetOptions,
  AssetSpec,
  HoneytokenOptions,
  HoneytokenSpec,
  LXSOptions,
  Path,
  PostgresOptions,
  PostgresSpec,
  RedisOptions,
  RedisSpec,
  ResolvedOptions,
  SshOptions,
  SshSpec,
  WebAdminOptions,
  WebAdminSpec,
  WebBaitOptions,
  WebBaitSpec,
  WebBaitTemplate,
} from './types.js';

/* ------------------------------------------------------------------ zod schemas */

const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'ids are lowercase letters, digits and dashes (max 63)');
const CredPair = z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]);
const CidrList = z.array(z.string()).superRefine((list, ctx) => {
  list.forEach((c, i) => {
    if (!parseCidr(c)) ctx.addIssue({ code: 'custom', message: `invalid CIDR '${c}'`, path: [i] });
  });
});
const TrustProxy = z.union([
  z.boolean(),
  z.array(z.string()).superRefine((list, ctx) => {
    list.forEach((c, i) => {
      if (!['loopback', 'uniquelocal', 'linklocal'].includes(c) && !parseCidr(c)) {
        ctx.addIssue({ code: 'custom', message: `invalid trustProxy entry '${c}'`, path: [i] });
      }
    });
  }),
]);

export const OptionsSchema = z.object({
  service: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'must be a compose service name')
    .default('app'),
  mode: z.enum(['monitor', 'enforce']).default('enforce'),
  runDir: z.string().min(1).optional(),
  trustProxy: TrustProxy.default(false),
  allowlist: CidrList.default([]),
  disabled: z.boolean().optional(),
  logger: z.any().optional(),
});

export const WebAdminSchema = z.object({
  id: IdSchema.optional(),
  brand: z.string().min(1).max(64).optional(),
  acceptCredentials: z.array(CredPair).max(20).optional(),
  acceptAfter: z.number().int().min(1).max(1000).optional(),
  panel: z.enum(['customers', 'none']).optional(),
});

export const WebBaitSchema = z.object({
  id: IdSchema.optional(),
  template: z.enum(['dotenv', 'sql-dump', 'git-config', 'wp-login', 'phpmyadmin']).optional(),
  breadcrumbs: z.boolean().optional(),
});

// Cowrie parses userdb.txt as strict ASCII with ':' separators.
const SshUser = z
  .string()
  .regex(/^[!-~]{1,64}$/, 'ssh usernames: printable ASCII, no spaces')
  .refine((u) => !u.includes(':'), "ssh usernames must not contain ':'");
const SshPass = z.string().regex(/^[ -~]{1,128}$/, 'ssh passwords: printable ASCII');

export const SshSchema = z.object({
  id: IdSchema.optional(),
  persona: z.enum(['db-backup', 'web-server']).optional(),
  hostname: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'hostname: lowercase letters, digits and dashes')
    .optional(),
  credentials: z
    .union([
      z.literal('weak-defaults'),
      z
        .array(z.tuple([SshUser, SshPass]))
        .min(1)
        .max(50),
    ])
    .optional(),
  banner: z
    .string()
    .regex(/^SSH-2\.0-[\x21-\x7e ]{1,80}$/, 'banner must look like SSH-2.0-OpenSSH_8.4p1 Debian-5')
    .optional(),
});

export const RedisSchema = z.object({
  id: IdSchema.optional(),
  seed: z.enum(['finance', 'sessions']).optional(),
  requirePassword: z.boolean().optional(),
});

export const PostgresSchema = z.object({
  id: IdSchema.optional(),
  seed: z.enum(['shop', 'finance']).optional(),
  requirePassword: z.boolean().optional(),
});

export const AssetSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  criticality: z.enum(['normal', 'critical']).optional(),
  critical: z.boolean().optional(),
});

export const HoneytokenSchema = z.object({
  apiKey: z
    .object({
      header: z.enum(['authorization', 'x-api-key']),
      prefix: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/, 'prefix: 2-32 chars of [A-Za-z0-9_-]'),
    })
    .optional(),
  canaryRows: z.number().int().min(0).max(100).optional(),
});

/* ------------------------------------------------------------------ helpers */

function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: string,
  label: string,
  hint?: string,
): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join('.') || '(value)'} ${i.message}`).join('; ');
  throw new LXSConfigError(code, `${label}: ${msg}.`, hint);
}

export const RESERVED_PATHS = ['/', '/robots.txt', '/favicon.ico'];

export function validateWebMount(path: unknown): Path {
  if (typeof path !== 'string') {
    throw new LXSConfigError(
      'E_MOUNT_TYPE',
      `web decoys mount on a path (string starting with '/'), got ${typeof path}.`,
      "Use a number only for network decoys: t.create('ssh', 22).",
    );
  }
  if (!path.startsWith('/')) {
    throw new LXSConfigError(
      'E_MOUNT_INVALID',
      `'${path}' must be an absolute path.`,
      "Start it with '/'.",
    );
  }
  if (/[?#*\s]/.test(path) || path.includes('..') || path.includes('//')) {
    throw new LXSConfigError(
      'E_MOUNT_INVALID',
      `'${path}' must not contain query strings, wildcards, whitespace, '..' or '//'.`,
      'Web decoys match exact paths (web-admin also covers its sub-paths).',
    );
  }
  if (path.length > 200)
    throw new LXSConfigError('E_MOUNT_INVALID', 'path is longer than 200 characters.');
  if (path.length > 1 && path.endsWith('/')) {
    throw new LXSConfigError('E_MOUNT_INVALID', `'${path}' must not end with '/'.`);
  }
  if (RESERVED_PATHS.includes(path) || path.startsWith('/health')) {
    throw new LXSConfigError(
      'E_MOUNT_RESERVED',
      `'${path}' is reserved (/, /robots.txt, /favicon.ico, /health*) and cannot be a decoy.`,
      'Pick a path an attacker would probe, for example /admin or /.env.',
    );
  }
  return path as Path;
}

export function validatePort(port: unknown): number {
  if (typeof port !== 'number') {
    throw new LXSConfigError(
      'E_PORT_TYPE',
      `network decoys bind a host port (number), got ${typeof port}.`,
      "Use a path only for web decoys: t.create('web-admin', '/admin').",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LXSConfigError('E_PORT_RANGE', `port ${port} is outside 1-65535.`);
  }
  return port;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'root'
  );
}

export function inferTemplate(path: string): WebBaitTemplate | undefined {
  const p = path.toLowerCase();
  if (/(^|\/)\.env([._-][a-z0-9]+)?$/.test(p)) return 'dotenv';
  if (p.endsWith('/.git/config')) return 'git-config';
  if (p.includes('wp-login')) return 'wp-login';
  if (p.includes('phpmyadmin') || p.includes('pma')) return 'phpmyadmin';
  if (p.endsWith('.sql') || p.endsWith('.sql.gz') || p.includes('dump') || p.includes('backup'))
    return 'sql-dump';
  return undefined;
}

export function resolveOptions(input: LXSOptions = {}): ResolvedOptions {
  const o = parseOrThrow(OptionsSchema, input, 'E_OPTIONS', 'invalid LXS options');
  return {
    service: o.service,
    mode: o.mode,
    runDir: resolveRunDir(o.runDir),
    trustProxy: o.trustProxy,
    allowlist: o.allowlist,
    disabled: o.disabled ?? process.env.LXS_DISABLED === '1',
  };
}

export function resolveWebAdmin(path: unknown, opts: WebAdminOptions | undefined): WebAdminSpec {
  const mount = validateWebMount(path);
  const o = parseOrThrow(WebAdminSchema, opts, 'E_OPTIONS', `web-admin ${mount}`);
  return {
    type: 'web-admin',
    id: o.id ?? `web-admin-${slugify(mount)}`,
    mount,
    brand: o.brand ?? 'Admin Portal',
    acceptCredentials: o.acceptCredentials ?? (o.acceptAfter ? [] : [['admin', 'admin']]),
    ...(o.acceptAfter ? { acceptAfter: o.acceptAfter } : {}),
    panel: o.panel ?? 'customers',
  };
}

export function resolveWebBait(path: unknown, opts: WebBaitOptions | undefined): WebBaitSpec {
  const mount = validateWebMount(path);
  const o = parseOrThrow(WebBaitSchema, opts, 'E_OPTIONS', `web-bait ${mount}`);
  const template = o.template ?? inferTemplate(mount);
  if (!template) {
    throw new LXSConfigError(
      'E_TEMPLATE_UNKNOWN',
      `cannot infer a bait template from '${mount}'.`,
      "Pass template: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin'.",
    );
  }
  return {
    type: 'web-bait',
    id: o.id ?? `web-bait-${slugify(mount)}`,
    mount,
    template,
    breadcrumbs: o.breadcrumbs ?? true,
  };
}

export function resolveSsh(port: unknown, opts: SshOptions | undefined): SshSpec {
  const p = validatePort(port);
  const o = parseOrThrow(SshSchema, opts, 'E_OPTIONS', `ssh :${p}`);
  const persona = o.persona ?? 'db-backup';
  const hostname = o.hostname ?? (persona === 'db-backup' ? 'db-backup-01' : 'web-01');
  return {
    type: 'ssh',
    id: o.id ?? `ssh-${hostname}`,
    port: p,
    persona,
    hostname,
    credentials: o.credentials ?? 'weak-defaults',
    ...(o.banner ? { banner: o.banner } : {}),
  };
}

export function resolveRedis(port: unknown, opts: RedisOptions | undefined): RedisSpec {
  const p = validatePort(port);
  const o = parseOrThrow(RedisSchema, opts, 'E_OPTIONS', `redis :${p}`);
  return {
    type: 'redis',
    id: o.id ?? `redis-${p}`,
    port: p,
    seed: o.seed ?? 'finance',
    requirePassword: o.requirePassword ?? false,
  };
}

export function resolvePostgres(port: unknown, opts: PostgresOptions | undefined): PostgresSpec {
  const p = validatePort(port);
  const o = parseOrThrow(PostgresSchema, opts, 'E_OPTIONS', `postgres :${p}`);
  return { type: 'postgres', id: o.id ?? `postgres-${p}`, port: p, seed: o.seed ?? 'shop', requirePassword: o.requirePassword ?? true };
}

export function resolveAsset(pattern: unknown, opts: AssetOptions | undefined): AssetSpec {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || /[?#\s]/.test(pattern)) {
    throw new LXSConfigError(
      'E_ASSET_PATTERN',
      `asset pattern '${String(pattern)}' must be an absolute path.`,
      "Example: '/api/payments/*'.",
    );
  }
  const star = pattern.indexOf('*');
  if (star >= 0 && !(pattern.endsWith('/*') && star === pattern.length - 1)) {
    throw new LXSConfigError(
      'E_ASSET_PATTERN',
      `'${pattern}': '*' is only allowed as a trailing '/*'.`,
    );
  }
  const o = parseOrThrow(AssetSchema, opts, 'E_OPTIONS', `asset ${pattern}`);
  return {
    pattern: pattern as Path,
    name: o.name ?? pattern.replace(/\/\*$/, ''),
    criticality: o.criticality ?? (o.critical ? 'critical' : 'normal'),
  };
}

export function resolveHoneytokens(opts: HoneytokenOptions | undefined): HoneytokenSpec {
  const o = parseOrThrow(HoneytokenSchema, opts, 'E_OPTIONS', 'honeytokens');
  return { ...(o.apiKey ? { apiKey: o.apiKey } : {}), canaryRows: o.canaryRows ?? 5 };
}

/* ------------------------------------------------------------------ defineConfig */

export type DeclarativeDecoy =
  | ({ type: 'web-admin'; path: Path } & WebAdminOptions)
  | ({ type: 'web-bait'; path: Path } & WebBaitOptions)
  | ({ type: 'ssh'; port: number } & SshOptions)
  | ({ type: 'redis'; port: number } & RedisOptions)
  | ({ type: 'postgres'; port: number } & PostgresOptions);

export interface DeclarativeConfig extends LXSOptions {
  decoys?: DeclarativeDecoy[];
  assets?: Array<{ pattern: Path } & AssetOptions>;
  honeytokens?: HoneytokenOptions | true;
}

/** Declarative alternative to the fluent API. Returns the same LXS instance `new LXS()` would. */
export function defineConfig(config: DeclarativeConfig): LXS {
  const { decoys = [], assets = [], honeytokens, ...options } = config;
  const t = new LXS(options);
  for (const d of decoys) {
    switch (d.type) {
      case 'web-admin': {
        const { type: _t, path, ...rest } = d;
        t.create('web-admin', path, rest);
        break;
      }
      case 'web-bait': {
        const { type: _t, path, ...rest } = d;
        t.create('web-bait', path, rest);
        break;
      }
      case 'ssh': {
        const { type: _t, port, ...rest } = d;
        t.create('ssh', port, rest);
        break;
      }
      case 'redis': {
        const { type: _t, port, ...rest } = d;
        t.create('redis', port, rest);
        break;
      }
      case 'postgres': {
        const { type: _t, port, ...rest } = d;
        t.create('postgres', port, rest);
        break;
      }
      default:
        throw new LXSConfigError(
          'E_TYPE_UNKNOWN',
          `unknown decoy type '${String((d as { type?: string }).type)}'.`,
        );
    }
  }
  for (const { pattern, ...rest } of assets) t.asset(pattern, rest);
  if (honeytokens) t.honeytokens(honeytokens === true ? {} : honeytokens);
  return t;
}
