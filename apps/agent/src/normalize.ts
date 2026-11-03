import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { DecoyEvent } from '@lxs/schema';
import type { Logger } from './telemetry.js';
import { deterministicUlid } from './ulid.js';

export interface RawLine {
  source: 'web' | 'ssh' | 'redis' | 'postgres';
  /** Manifest decoy id (web lines carry their own decoy_id; ssh lines take this one). */
  decoyId: string;
  /** Stable key of the file the line came from, plus the byte offset: together the idempotency seed. */
  fileKey: string;
  offset: number;
  text: string;
}

export interface HoneyRead {
  decoyId: string;
  path: string;
  tokenId: string;
}

export interface NormalizeOptions {
  salt: string;
  commonCredsText: string;
  simulated: boolean;
  /** ssh decoy id -> published host port (Cowrie only knows its in-container port 2222). */
  sshPorts: Map<string, number>;
  honeyReads: HoneyRead[];
}

export interface LineNormalizer {
  name: 'package' | 'local';
  normalize(raw: RawLine): DecoyEvent[];
  stats(): Record<string, number>;
}

const MAX_DEPTH = 8;

/** JSON.parse with a nesting-depth limit (BREAKDOWN 7.11). Returns null for anything that is not an object. */
export function safeParse(text: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop() as [unknown, number];
    if (d > MAX_DEPTH) return null;
    if (node && typeof node === 'object')
      for (const c of Object.values(node)) stack.push([c, d + 1]);
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const HONEY_READ_CMD =
  /^\s*(sudo\s+)?(cat|less|more|head|tail|cp|scp|grep|strings|base64|vi|vim|nano|sed|awk|xxd|od|curl|wget)\b|<\s*\S*/;

/** Planted files that were read: emitted as honeytoken.read next to the command.exec that touched them. */
function honeyReadEvents(
  ev: DecoyEvent,
  opts: NormalizeOptions,
  seed: string,
  startIdx: number,
): DecoyEvent[] {
  if (ev.event_type !== 'command.exec' || !ev.command) return [];
  const out: DecoyEvent[] = [];
  let idx = startIdx;
  for (const h of opts.honeyReads) {
    if (h.decoyId !== ev.decoy_id) continue;
    const base = h.path.split('/').pop() ?? h.path;
    if (!ev.command.includes(base) || !HONEY_READ_CMD.test(ev.command)) continue;
    const { command: _c, ...rest } = ev;
    out.push({
      ...rest,
      id: deterministicUlid(Date.parse(ev.timestamp), `${seed}:${idx++}`),
      event_type: 'honeytoken.read',
      honeytoken_id: h.tokenId,
      file_name: h.path.slice(0, 512),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ package-backed normalizer */

type NormalizerModule = typeof import('@lxs/normalizer');

function fromPackage(mod: NormalizerModule, opts: NormalizeOptions): LineNormalizer {
  const ctx = mod.createNormalizerContext({
    commonCredentials: mod.parseCommonCredentials(opts.commonCredsText),
    projectSalt: opts.salt,
    simulated: opts.simulated,
  });
  let parseFailures = 0;
  return {
    name: 'package',
    normalize(raw) {
      const rec = safeParse(raw.text);
      if (!rec) {
        parseFailures++;
        return [];
      }
      const seed = `${raw.fileKey}:${raw.offset}`;
      let n = 0;
      ctx.newId = (t) => deterministicUlid(t, `${seed}:${n}`);
      const events: DecoyEvent[] = [];
      const databaseEvents = normalizeDatabaseLine(raw.source, rec, opts, raw.decoyId, seed);
      if (databaseEvents !== null) return databaseEvents;
      if (raw.source === 'ssh') {
        ctx.sshDecoyId = raw.decoyId;
        const ev = mod.normalizeCowrie(rec, ctx);
        if (ev) {
          const port = opts.sshPorts.get(raw.decoyId);
          if (port !== undefined && ev.dst_service.startsWith('ssh:'))
            ev.dst_service = `ssh:${port}`;
          events.push(ev, ...honeyReadEvents(ev, opts, seed, ++n));
        }
      } else {
        const ev = mod.normalizeWebDecoy(rec, ctx);
        if (ev) events.push(ev);
        const ids = Array.isArray(rec.honeytoken_ids)
          ? rec.honeytoken_ids
          : rec.honeytoken_id
            ? [rec.honeytoken_id]
            : [];
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          n++;
          const h = mod.normalizeWebDecoy({ ...rec, kind: 'honeytoken', honeytoken_id: id }, ctx);
          if (h) events.push(h);
        }
      }
      return events;
    },
    stats: () => ({
      normalizer_accepted: ctx.stats.accepted,
      normalizer_dropped_loopback: ctx.stats.dropped_loopback,
      normalizer_dropped_unmapped: ctx.stats.dropped_unmapped,
      normalizer_dropped_invalid: ctx.stats.dropped_invalid,
      normalizer_parse_failures: parseFailures,
    }),
  };
}

/* ------------------------------------------------------------------ local fallback */

const isLoopbackIp = (ip: string): boolean =>
  ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const maskPw = (pw: string): string => (pw.length <= 2 ? '***' : `${pw[0]}***${pw[pw.length - 1]}`);

function parseCommon(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

const clip = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v !== ''
    ? v.slice(0, n)
    : typeof v === 'number'
      ? String(v).slice(0, n)
      : undefined;

const toPort = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
};

/** Sanitise Redis/Postgres logs before they become platform events. Never retain command arguments or SQL text. */
function normalizeDatabaseLine(
  source: RawLine['source'],
  rec: Record<string, unknown>,
  opts: NormalizeOptions,
  decoyId: string,
  seed: string,
): DecoyEvent[] | null {
  if (source !== 'redis' && source !== 'postgres') return null;
  const timestamp = source === 'redis' ? rec.ts : rec.timestamp;
  const ts = typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
  let ip = '';
  if (source === 'redis') ip = typeof rec.src_ip === 'string' ? rec.src_ip.trim() : '';
  else {
    const remote = typeof rec.remote_host === 'string' ? rec.remote_host : '';
    const candidate = remote.startsWith('[')
      ? remote.slice(1, remote.indexOf(']'))
      : isIP(remote)
        ? remote
        : remote.replace(/:\d+$/, '');
    ip = isIP(candidate) ? candidate : typeof rec.src_ip === 'string' && isIP(rec.src_ip) ? rec.src_ip : '';
  }
  if (!isIP(ip) || isLoopbackIp(ip)) return [];
  const base = {
    id: deterministicUlid(Date.parse(ts), `${seed}:${source}`),
    schema_version: 1 as const,
    count: 1,
    simulated: opts.simulated,
    timestamp: ts,
    sensor: source as 'redis' | 'postgres',
    decoy_id: decoyId,
    is_decoy: true,
    src_ip: ip,
    src_port: toPort(source === 'redis' ? rec.src_port : rec.remote_port),
    dst_service: `${source}:${opts.sshPorts.get(decoyId) ?? (source === 'redis' ? 6379 : 5432)}`,
  };
  if (source === 'redis') {
    const command = typeof rec.command === 'string' ? rec.command.slice(0, 64).toUpperCase() : 'UNKNOWN';
    return [{
      ...base,
      event_type: command === 'AUTH' ? 'auth.attempt' : 'db.command',
      outcome: rec.outcome === 'failure' ? 'failure' : 'success',
      command,
    } as DecoyEvent];
  }
  const message = typeof rec.message === 'string' ? rec.message.slice(0, 2048) : '';
  const failed = /failed|authentication failed|no password supplied/i.test(message);
  const authOk = /connection (authenticated|authorized)/i.test(message);
  const isConnect = /connection (received|authorized|authenticated)|disconnection:/i.test(message);
  const closed = /disconnection:/i.test(message);
  const verb = /statement:|execute /i.test(message)
    ? message.match(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|GRANT|REVOKE)\b/i)?.[1]?.toUpperCase() ?? 'SQL'
    : undefined;
  const eventType = failed || authOk
    ? 'auth.attempt'
    : verb
      ? 'db.command'
      : closed
        ? 'connection.close'
        : isConnect
          ? 'connection.open'
          : null;
  if (!eventType) return [];
  return [{
    ...base,
    event_type: eventType,
    outcome: failed ? 'failure' : 'success',
    username: clip(rec.user, 256),
    ...(verb ? { command: verb } : {}),
  } as DecoyEvent];
}

/**
 * Minimal built-in normalizer used only if `@lxs/normalizer` cannot be loaded. It covers the
 * events the demo needs (logins, commands, downloads, honeytoken reads) with the same field semantics.
 */
export function createLocalNormalizer(opts: NormalizeOptions): LineNormalizer {
  const common = parseCommon(opts.commonCredsText);
  const stats = { accepted: 0, dropped: 0 };
  const pw = (user: string | undefined, p: unknown): Partial<DecoyEvent> => {
    if (typeof p !== 'string' || p === '') return {};
    if (common.has(p) || (user && common.has(`${user}/${p}`)))
      return { password_clear: p.slice(0, 128) };
    return { password_masked: maskPw(p), password_sha256: sha256(opts.salt + p) };
  };
  const mk = (
    seed: string,
    partial: Omit<DecoyEvent, 'id' | 'schema_version' | 'count' | 'simulated'>,
  ): DecoyEvent => {
    stats.accepted++;
    return {
      id: deterministicUlid(Date.parse(partial.timestamp), seed),
      schema_version: 1,
      count: 1,
      simulated: opts.simulated,
      ...partial,
    };
  };
  const ts = (v: unknown): string => {
    const d = typeof v === 'string' ? new Date(v) : new Date();
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
  };

  return {
    name: 'local',
    normalize(raw) {
      const rec = safeParse(raw.text);
      if (!rec) {
        stats.dropped++;
        return [];
      }
      const seed = `${raw.fileKey}:${raw.offset}`;
      if (raw.source === 'web') {
        const ip = clip(rec.ip, 64) ?? '';
        const kind = String(rec.kind ?? '');
        if (
          !isIP(ip) ||
          isLoopbackIp(ip) ||
          ip === '0.0.0.0' ||
          !['login', 'request', 'bait', 'export'].includes(kind)
        ) {
          stats.dropped++;
          return [];
        }
        const path = clip(rec.path, 2048) ?? '/';
        const user = clip(rec.username, 256);
        const common0 = {
          timestamp: ts(rec.ts),
          sensor: 'web' as const,
          decoy_id: clip(rec.decoy_id, 64),
          is_decoy: true,
          src_ip: ip,
          dst_service: `http:${path.split('?')[0]}`.slice(0, 128),
          method: clip(rec.method, 16),
          url: path,
          status_code: typeof rec.status === 'number' ? rec.status : undefined,
          user_agent: clip(rec.ua, 512),
        };
        const events: DecoyEvent[] = [];
        if (kind === 'login') {
          events.push(
            mk(`${seed}:0`, {
              ...common0,
              event_type: 'auth.attempt',
              outcome: rec.accepted === true ? 'success' : 'failure',
              username: user,
              ...pw(user, rec.password),
            }),
          );
        } else if (kind === 'request') {
          events.push(
            mk(`${seed}:0`, {
              ...common0,
              event_type: 'http.request',
              payload: clip(rec.body, 4096),
            }),
          );
        } else {
          events.push(
            mk(`${seed}:0`, {
              ...common0,
              event_type: 'file.download',
              file_name: clip(rec.file, 512),
              file_size: typeof rec.bytes === 'number' ? rec.bytes : undefined,
            }),
          );
          const ids = Array.isArray(rec.honeytoken_ids) ? rec.honeytoken_ids : [];
          ids.forEach((id, i) => {
            if (typeof id === 'string') {
              events.push(
                mk(`${seed}:${i + 1}`, {
                  ...common0,
                  event_type: 'honeytoken.read',
                  honeytoken_id: id.slice(0, 64),
                }),
              );
            }
          });
        }
        return events;
      }

      const databaseEvents = normalizeDatabaseLine(raw.source, rec, opts, raw.decoyId, seed);
      if (databaseEvents !== null) return databaseEvents;

      const id = String(rec.eventid ?? '');
      const ip = clip(rec.src_ip, 64) ?? '';
      if (!isIP(ip) || isLoopbackIp(ip)) {
        stats.dropped++;
        return [];
      }
      const hostPort = opts.sshPorts.get(raw.decoyId) ?? 22;
      const base = {
        timestamp: ts(rec.timestamp),
        sensor: 'ssh' as const,
        decoy_id: raw.decoyId,
        is_decoy: true,
        session_id: clip(rec.session, 100) ? `${raw.decoyId}:${clip(rec.session, 100)}` : undefined,
        src_ip: ip,
        src_port: toPort(rec.src_port),
        dst_service: `ssh:${hostPort}`,
      };
      let ev: DecoyEvent | null = null;
      switch (id) {
        case 'cowrie.session.connect':
          ev = mk(`${seed}:0`, { ...base, event_type: 'connection.open' });
          break;
        case 'cowrie.session.closed':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'connection.close',
            raw: { duration: rec.duration },
          });
          break;
        case 'cowrie.client.version':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'ssh.client',
            client_banner: clip(
              Array.isArray(rec.version) ? rec.version.join(' ') : rec.version,
              256,
            ),
          });
          break;
        case 'cowrie.login.failed':
        case 'cowrie.login.success': {
          const user = clip(rec.username, 256);
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'auth.attempt',
            outcome: id.endsWith('success') ? 'success' : 'failure',
            username: user,
            ...pw(user, rec.password),
          });
          break;
        }
        case 'cowrie.command.input':
        case 'cowrie.command.failed':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'command.exec',
            outcome: id.endsWith('failed') ? 'failure' : 'success',
            command: clip(rec.input, 4096),
          });
          break;
        case 'cowrie.session.file_download':
        case 'cowrie.session.file_download.failed':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'file.download',
            outcome: id.endsWith('failed') ? 'failure' : 'success',
            url: clip(rec.url, 2048),
            file_sha256:
              typeof rec.shasum === 'string' && /^[0-9a-f]{64}$/i.test(rec.shasum)
                ? rec.shasum.toLowerCase()
                : undefined,
          });
          break;
        case 'cowrie.session.file_upload':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'file.upload',
            file_name: clip(rec.filename, 512),
          });
          break;
        case 'cowrie.direct-tcpip.request':
          ev = mk(`${seed}:0`, {
            ...base,
            event_type: 'proxy.attempt',
            dst_service: `tcpip:${clip(rec.dst_ip, 64) ?? 'unknown'}:${toPort(rec.dst_port) ?? 0}`,
          });
          break;
        default:
          stats.dropped++;
          return [];
      }
      return [ev, ...honeyReadEvents(ev, opts, seed, 1)];
    },
    stats: () => ({ normalizer_accepted: stats.accepted, normalizer_dropped: stats.dropped }),
  };
}

/** Prefer the shared package; fall back to the local subset so the agent always builds and runs. */
export async function createNormalizer(
  opts: NormalizeOptions,
  log?: Logger,
): Promise<LineNormalizer> {
  try {
    const mod = await import('@lxs/normalizer');
    if (
      typeof mod.createNormalizerContext === 'function' &&
      typeof mod.normalizeCowrie === 'function'
    ) {
      return fromPackage(mod, opts);
    }
    log?.warn('normalizer package lacks expected exports; using local fallback');
  } catch (e) {
    log?.warn('normalizer package unavailable; using local fallback', {
      error: (e as Error).message,
    });
  }
  return createLocalNormalizer(opts);
}

/* ------------------------------------------------------------------ flood collapsing (BREAKDOWN 7.12) */

interface Bucket {
  minute: number;
  seen: number;
  over: number;
  last?: DecoyEvent;
}

/**
 * After 20 failed logins per minute from one source on one decoy, further failures are collapsed into a single
 * event with `count` = how many were folded in. Successes always pass through untouched.
 */
export class AuthAggregator {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly threshold = 20) {}

  private overflow(key: string, b: Bucket): DecoyEvent | null {
    if (b.over === 0 || !b.last) return null;
    return {
      ...b.last,
      id: deterministicUlid(Date.parse(b.last.timestamp), `agg:${key}:${b.minute}`),
      count: b.over,
    };
  }

  push(ev: DecoyEvent): DecoyEvent[] {
    if (ev.event_type !== 'auth.attempt' || ev.outcome === 'success') return [ev];
    const minute = Math.floor(Date.parse(ev.timestamp) / 60_000);
    const key = `${ev.decoy_id ?? '-'}|${ev.src_ip}`;
    const out: DecoyEvent[] = [];
    let b = this.buckets.get(key);
    if (b && b.minute !== minute) {
      const o = this.overflow(key, b);
      if (o) out.push(o);
      b = undefined;
    }
    if (!b) {
      if (this.buckets.size > 20_000) this.buckets.clear();
      b = { minute, seen: 0, over: 0 };
      this.buckets.set(key, b);
    }
    b.seen++;
    if (b.seen <= this.threshold) out.push(ev);
    else {
      b.over++;
      b.last = ev;
    }
    return out;
  }

  /** Emit overflow for buckets whose minute has passed; call on a timer. */
  flush(nowMs: number = Date.now()): DecoyEvent[] {
    const cur = Math.floor(nowMs / 60_000);
    const out: DecoyEvent[] = [];
    for (const [key, b] of this.buckets) {
      if (b.minute < cur) {
        const o = this.overflow(key, b);
        if (o) out.push(o);
        this.buckets.delete(key);
      }
    }
    return out;
  }
}
