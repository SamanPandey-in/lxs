import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DecoyEvent, EventType } from '@lxs/schema';
import { monotonicFactory } from 'ulid';

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

export interface NormalizerStats {
  accepted: number;
  dropped_loopback: number;
  dropped_unmapped: number;
  dropped_invalid: number;
  /** Count per unmapped eventid / kind. */
  unmapped: Record<string, number>;
}

export interface NormalizerContext {
  /** Bare passwords and "user/password" pairs from the bundled common-credentials list. */
  commonCredentials: Set<string>;
  /** Per-project salt for password_sha256. */
  projectSalt: string;
  /** Stable decoy id used for Cowrie events (Cowrie does not know our decoy ids). */
  sshDecoyId: string;
  /** Marks events as simulated. */
  simulated: boolean;
  /** Fallback clock for records without a usable timestamp. */
  now: () => Date;
  /** ULID generator, seeded with the event time. Replaceable in tests. */
  newId: (seedTimeMs: number) => string;
  stats: NormalizerStats;
}

export function createNormalizerContext(opts: {
  commonCredentials: Set<string>;
  projectSalt: string;
  sshDecoyId?: string;
  simulated?: boolean;
  now?: () => Date;
  newId?: (seedTimeMs: number) => string;
}): NormalizerContext {
  const factory = monotonicFactory();
  return {
    commonCredentials: opts.commonCredentials,
    projectSalt: opts.projectSalt,
    sshDecoyId: opts.sshDecoyId ?? 'ssh-cowrie',
    simulated: opts.simulated ?? false,
    now: opts.now ?? (() => new Date()),
    newId: opts.newId ?? ((t) => factory(t)),
    stats: {
      accepted: 0,
      dropped_loopback: 0,
      dropped_unmapped: 0,
      dropped_invalid: 0,
      unmapped: {},
    },
  };
}

/** Parse the text of common-creds.txt (one password or user/password per line, # comments). */
export function parseCommonCredentials(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) out.add(line);
  }
  return out;
}

/** Load the bundled list from disk (the only file I/O in this package). */
export function loadCommonCredentials(path: string): Set<string> {
  return parseCommonCredentials(readFileSync(path, 'utf8'));
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const MAX_COMMAND = 4096;
const MAX_RAW = 4096;

export function isLoopback(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  return v === '::1' || v.startsWith('127.') || v.startsWith('::ffff:127.') || v === 'localhost';
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]+(%\w+)?$/i;

export function isValidIp(ip: string): boolean {
  if (IPV4_RE.test(ip)) return true;
  return ip.includes(':') && IPV6_RE.test(ip);
}

/** "a***n" style mask. Very short passwords are fully masked. */
export function maskPassword(pw: string): string {
  if (pw.length <= 2) return '***';
  return `${pw[0]}***${pw[pw.length - 1]}`;
}

export function saltedSha256(salt: string, value: string): string {
  return createHash('sha256')
    .update(salt + value)
    .digest('hex');
}

export function isCommonPassword(
  username: string | undefined,
  password: string,
  ctx: NormalizerContext,
): boolean {
  if (ctx.commonCredentials.has(password)) return true;
  return username !== undefined && ctx.commonCredentials.has(`${username}/${password}`);
}

/**
 * Password handling (BREAKDOWN 7.13): clear text ONLY when the password is in the common-credentials
 * list; otherwise a mask ("a***n") and sha256(projectSalt + password). Empty passwords store nothing.
 */
export function passwordFields(
  username: string | undefined,
  password: unknown,
  ctx: NormalizerContext,
): Pick<DecoyEvent, 'password_clear' | 'password_masked' | 'password_sha256'> {
  if (typeof password !== 'string' || password === '') return {};
  if (isCommonPassword(username, password, ctx)) return { password_clear: password.slice(0, 128) };
  return {
    password_masked: maskPassword(password),
    password_sha256: saltedSha256(ctx.projectSalt, password),
  };
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v === 'string' && v !== '') return v.slice(0, max);
  if (typeof v === 'number') return String(v).slice(0, max);
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function port(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

function sha256Hex(v: unknown): string | undefined {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined;
}

/** Parse a sensor timestamp; falls back to the injected clock. */
function parseTs(v: unknown, ctx: NormalizerContext): { iso: string; ms: number } {
  const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
  const ok = d && !Number.isNaN(d.getTime()) ? d : ctx.now();
  return { iso: ok.toISOString(), ms: ok.getTime() };
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Original record with secrets removed, capped at 4 KB. */
export function sanitiseRaw(line: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(line)) {
    if (/^(password|pass|passwd|pwd|secret|token|authorization|cookie)$/i.test(k)) continue;
    copy[k] = v;
  }
  const json = JSON.stringify(copy);
  if (json.length <= MAX_RAW) return copy;
  return { truncated: true, original_bytes: json.length, preview: json.slice(0, MAX_RAW - 200) };
}

function drop(ctx: NormalizerContext, kind: 'loopback' | 'invalid'): null {
  if (kind === 'loopback') ctx.stats.dropped_loopback++;
  else ctx.stats.dropped_invalid++;
  return null;
}

function dropUnmapped(ctx: NormalizerContext, key: string): null {
  ctx.stats.dropped_unmapped++;
  ctx.stats.unmapped[key] = (ctx.stats.unmapped[key] ?? 0) + 1;
  return null;
}

function finish(
  ctx: NormalizerContext,
  partial: Omit<DecoyEvent, 'id' | 'schema_version' | 'count' | 'simulated'> & { id?: string },
  ms: number,
): DecoyEvent {
  const { id, ...rest } = partial;
  const ev: DecoyEvent = {
    id: id && ULID_RE.test(id) ? id : ctx.newId(ms),
    schema_version: 1,
    count: 1,
    simulated: ctx.simulated,
    ...rest,
  };
  ctx.stats.accepted++;
  return ev;
}

/** Remove keys whose value is undefined so the event is clean JSON. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* -------------------------------------------------------------------------- */
/* Cowrie                                                                     */
/* -------------------------------------------------------------------------- */

export const COWRIE_EVENT_MAP: Readonly<Record<string, EventType>> = {
  'cowrie.session.connect': 'connection.open',
  'cowrie.client.version': 'ssh.client',
  'cowrie.client.kex': 'ssh.client',
  'cowrie.login.failed': 'auth.attempt',
  'cowrie.login.success': 'auth.attempt',
  'cowrie.command.input': 'command.exec',
  'cowrie.command.failed': 'command.exec',
  'cowrie.session.file_download': 'file.download',
  'cowrie.session.file_download.failed': 'file.download',
  'cowrie.session.file_upload': 'file.upload',
  'cowrie.direct-tcpip.request': 'proxy.attempt',
  'cowrie.session.closed': 'connection.close',
};

export function normalizeCowrie(
  line: Record<string, unknown>,
  ctx: NormalizerContext,
): DecoyEvent | null {
  const eventid = typeof line.eventid === 'string' ? line.eventid : '';
  const eventType = COWRIE_EVENT_MAP[eventid];
  const srcIp = typeof line.src_ip === 'string' ? line.src_ip.trim() : '';
  if (srcIp && isLoopback(srcIp)) return drop(ctx, 'loopback');
  if (!eventType) return dropUnmapped(ctx, eventid || '(missing eventid)');
  if (!srcIp || !isValidIp(srcIp)) return drop(ctx, 'invalid');

  const { iso, ms } = parseTs(line.timestamp, ctx);
  const sessionRaw = str(line.session, 100);
  const dstPort = port(line.dst_port) ?? 22;
  const base = {
    timestamp: iso,
    sensor: 'ssh' as const,
    decoy_id: ctx.sshDecoyId,
    is_decoy: true,
    session_id: sessionRaw ? `${ctx.sshDecoyId}:${sessionRaw}` : undefined,
    src_ip: srcIp,
    src_port: port(line.src_port),
    dst_service: `ssh:${dstPort}`,
    event_type: eventType,
  };

  let extra: Partial<DecoyEvent> = {};
  const raw: Record<string, unknown> = { ...line };

  switch (eventid) {
    case 'cowrie.client.version': {
      const v = Array.isArray(line.version) ? line.version.join(' ') : line.version;
      extra = { client_banner: str(v, 256) };
      break;
    }
    case 'cowrie.client.kex':
      // HASSH stays in raw (A3).
      extra = {};
      break;
    case 'cowrie.login.failed':
    case 'cowrie.login.success': {
      const username = str(line.username, 256);
      extra = {
        outcome: eventid === 'cowrie.login.success' ? 'success' : 'failure',
        username,
        ...passwordFields(username, line.password, ctx),
      };
      break;
    }
    case 'cowrie.command.input':
    case 'cowrie.command.failed':
      extra = {
        outcome: eventid === 'cowrie.command.failed' ? 'failure' : 'success',
        command: str(line.input ?? line.command, MAX_COMMAND),
      };
      break;
    case 'cowrie.session.file_download':
    case 'cowrie.session.file_download.failed':
      extra = {
        outcome: eventid.endsWith('.failed') ? 'failure' : 'success',
        url: str(line.url, 2048),
        file_name: str(line.outfile ?? line.destfile ?? line.filename, 512),
        file_sha256: sha256Hex(line.shasum),
        file_size: (() => {
          const n = num(line.size);
          return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
        })(),
      };
      break;
    case 'cowrie.session.file_upload':
      extra = {
        file_name: str(line.filename ?? line.outfile, 512),
        file_sha256: sha256Hex(line.shasum),
        file_size: (() => {
          const n = num(line.size);
          return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
        })(),
      };
      break;
    case 'cowrie.direct-tcpip.request': {
      const dstIp = str(line.dst_ip, 64) ?? 'unknown';
      const dp = port(line.dst_port) ?? 0;
      base.dst_service = `tcpip:${dstIp}:${dp}`;
      break;
    }
    case 'cowrie.session.closed':
      raw.duration = line.duration;
      break;
    default:
      break;
  }

  return finish(ctx, compact({ ...base, ...extra, raw: sanitiseRaw(raw) }) as never, ms);
}

/* -------------------------------------------------------------------------- */
/* ds-web decoy log line                                                      */
/* -------------------------------------------------------------------------- */

const WEB_KIND_MAP: Readonly<Record<string, EventType>> = {
  login: 'auth.attempt',
  request: 'http.request',
  probe: 'http.request',
  bait: 'file.download',
  download: 'file.download',
  export: 'file.download',
  honeytoken: 'honeytoken.read',
  honeytoken_read: 'honeytoken.read',
};

/**
 * ds-web log line:
 * {"ts","decoy_id","kind":"login","ip","method","path","ua","username","password","accepted","req_id", ...}
 */
export function normalizeWebDecoy(
  line: Record<string, unknown>,
  ctx: NormalizerContext,
): DecoyEvent | null {
  const ip = typeof line.ip === 'string' ? line.ip.trim() : '';
  if (ip && isLoopback(ip)) return drop(ctx, 'loopback');
  const kind = typeof line.kind === 'string' ? line.kind : '';
  const eventType = WEB_KIND_MAP[kind];
  if (!eventType) return dropUnmapped(ctx, `web:${kind || '(missing kind)'}`);
  if (!ip || !isValidIp(ip)) return drop(ctx, 'invalid');

  const { iso, ms } = parseTs(line.ts, ctx);
  const path = str(line.path, 2048) ?? '/';
  const username = str(line.username, 256);
  const status = num(line.status);
  const partial: Record<string, unknown> = {
    id: typeof line.req_id === 'string' ? line.req_id : undefined,
    timestamp: iso,
    sensor: 'web',
    decoy_id: str(line.decoy_id, 64),
    is_decoy: true,
    src_ip: ip,
    src_port: port(line.src_port),
    dst_service: `http:${path.split('?')[0]}`.slice(0, 128),
    event_type: eventType,
    method: str(line.method, 16),
    url: path,
    status_code: status !== undefined && Number.isInteger(status) ? status : undefined,
    user_agent: str(line.ua ?? line.user_agent, 512),
    payload: str(line.body ?? line.payload, 4096),
    session_id: str(line.session_id, 128),
  };

  if (eventType === 'auth.attempt') {
    partial.outcome = line.accepted === true ? 'success' : 'failure';
    partial.username = username;
    Object.assign(partial, passwordFields(username, line.password, ctx));
  } else if (eventType === 'file.download') {
    partial.file_name = str(line.file ?? line.file_name, 512);
    partial.file_sha256 = sha256Hex(line.sha256);
    partial.file_size = (() => {
      const n = num(line.size);
      return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
    })();
  } else if (eventType === 'honeytoken.read') {
    partial.honeytoken_id = str(line.token_id ?? line.honeytoken_id, 64);
  }

  partial.raw = sanitiseRaw(line);
  return finish(ctx, compact(partial) as never, ms);
}

/* -------------------------------------------------------------------------- */
/* Production telemetry (firewall.jsonl / auth.jsonl)                         */
/* -------------------------------------------------------------------------- */

/**
 * firewall.jsonl: {"ts","src_ip","dst_ip","dst_port","proto","action":"allow|deny","asset"?}
 * auth.jsonl:     {"ts","src_ip","user","service","result":"success|failure","asset"?}
 * The record type is taken from `source`/`kind` ("firewall" | "auth") or inferred from its fields.
 */
export function normalizeTelemetry(
  line: Record<string, unknown>,
  ctx: NormalizerContext,
  hint?: 'firewall' | 'auth',
): DecoyEvent | null {
  const ip =
    typeof (line.src_ip ?? line.ip) === 'string' ? String(line.src_ip ?? line.ip).trim() : '';
  if (ip && isLoopback(ip)) return drop(ctx, 'loopback');
  const declared = String(line.source ?? line.kind ?? hint ?? '').toLowerCase();
  const type: 'firewall' | 'auth' | null =
    declared === 'firewall' || declared === 'prod.firewall'
      ? 'firewall'
      : declared === 'auth' || declared === 'prod.auth'
        ? 'auth'
        : 'action' in line || 'dst_port' in line
          ? 'firewall'
          : 'result' in line || 'user' in line || 'username' in line
            ? 'auth'
            : null;
  if (!type) return dropUnmapped(ctx, `telemetry:${declared || '(unknown)'}`);
  if (!ip || !isValidIp(ip)) return drop(ctx, 'invalid');

  const { iso, ms } = parseTs(line.ts ?? line.timestamp, ctx);
  const asset = str(line.asset ?? line.asset_name, 128);

  if (type === 'firewall') {
    const action = String(line.action ?? '').toLowerCase();
    const dstPort = port(line.dst_port);
    return finish(
      ctx,
      compact({
        timestamp: iso,
        sensor: 'prod' as const,
        is_decoy: false,
        src_ip: ip,
        src_port: port(line.src_port),
        dst_service:
          str(line.dst_service, 128) ?? `fw:${str(line.dst_ip, 64) ?? 'unknown'}:${dstPort ?? 0}`,
        event_type: 'prod.firewall' as const,
        outcome:
          action === 'allow' || action === 'accept'
            ? ('success' as const)
            : action
              ? ('failure' as const)
              : ('unknown' as const),
        asset_name: asset,
        raw: sanitiseRaw(line),
      }) as never,
      ms,
    );
  }

  const result = String(line.result ?? line.outcome ?? '').toLowerCase();
  const username = str(line.user ?? line.username, 256);
  return finish(
    ctx,
    compact({
      timestamp: iso,
      sensor: 'prod' as const,
      is_decoy: false,
      src_ip: ip,
      dst_service: str(line.dst_service, 128) ?? `auth:${str(line.service, 100) ?? 'app'}`,
      event_type: 'prod.auth' as const,
      outcome:
        result === 'success'
          ? ('success' as const)
          : result === 'failure' || result === 'failed'
            ? ('failure' as const)
            : ('unknown' as const),
      username,
      user_agent: str(line.ua ?? line.user_agent, 512),
      asset_name: asset,
      raw: sanitiseRaw(line),
    }) as never,
    ms,
  );
}
