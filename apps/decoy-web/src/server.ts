import { randomBytes, randomInt } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { HoneytokenSet, WebDecoyConfig, WebDecoysFile } from './config.js';
import type { JsonlLogger, LogLine } from './log.js';
import { LruTtlMap } from './lru.js';
import * as tpl from './templates.js';

export interface ServerDeps {
  decoys: WebDecoysFile;
  honeytokens: HoneytokenSet;
  logger: Pick<JsonlLogger, 'write'>;
  now?: () => number;
  /** Capacity of each per-source state map (default 5000). Exposed for tests. */
  maxTracked?: number;
}

const MAX_BODY = 16 * 1024; // BREAKDOWN 7.11
const SESSION_MS = 30 * 60 * 1000;
const MAX_TRACKED = 5000;
const STATE_TTL_MS = 30 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_SOURCE = 120;
const MAX_LOGINS_PER_SOURCE = 10;

/** Decoy session cookie. PHP's default name and format (26 chars of [0-9a-v]) to fit the templates;
 * the SDK middleware forwards this one cookie (and only values in this exact format) to the decoy. */
export const SESSION_COOKIE = 'PHPSESSID';
const SID_RE = /^[0-9a-v]{26}$/;
const SID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';
/** acceptAfter N accepts on a per-session attempt drawn from N..N+ACCEPT_AFTER_SPREAD. */
export const ACCEPT_AFTER_SPREAD = 2;

export function newSessionId(): string {
  let s = '';
  for (const b of randomBytes(26)) s += SID_ALPHABET[b & 31];
  return s;
}

/** The decoy session id from a Cookie header, or undefined if absent or not in our format. */
export function readSessionId(cookie: unknown): string | undefined {
  if (typeof cookie !== 'string' || cookie.length > 8192) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    return SID_RE.test(v) ? v : undefined;
  }
  return undefined;
}

interface Attempts {
  tries: number;
  /** Per-session acceptAfter threshold, drawn once when the session's first attempt is recorded. */
  threshold: number;
}

/** Never trust the value for anything but logging; fall back to a sentinel the agent drops. */
export function sanitizeIp(v: unknown): string {
  if (typeof v !== 'string') return '0.0.0.0';
  const s = v.trim();
  if (s.length > 45) return '0.0.0.0';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => Number(p) <= 255)) return s;
  if (/^[0-9a-fA-F:.]+$/.test(s) && s.includes(':') && (s.match(/:/g)?.length ?? 0) >= 2) return s;
  return '0.0.0.0';
}

const clip = (v: unknown, n: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // Stripping control characters out of attacker-controlled input before it is
  // logged is the point (BREAKDOWN 7.11): they must never reach a terminal or
  // a log viewer.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the intent
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return s.length > n ? s.slice(0, n) : s;
};

function splitUrl(url: string): { path: string; query: string } {
  const q = url.indexOf('?');
  let p = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q + 1);
  if (p.includes('%')) {
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep raw */
    }
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return { path: p, query };
}

function parseBody(contentType: string | undefined, raw: unknown): Record<string, string> {
  if (!(raw instanceof Buffer) || raw.length === 0) return {};
  const text = raw.toString('utf8');
  const ct = (contentType ?? '').toLowerCase();
  try {
    if (ct.includes('json')) {
      const j: unknown = JSON.parse(text);
      const out: Record<string, string> = {};
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
        }
      }
      return out;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

const pick = (b: Record<string, string>, names: string[]): string | undefined => {
  for (const n of names) if (b[n] !== undefined) return b[n];
  return undefined;
};

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: MAX_BODY,
    routerOptions: { maxParamLength: 200 },
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
    forceCloseConnections: true,
  });

  // Every body is read as an opaque buffer and parsed (as data) only on login routes.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) =>
    done(null, body),
  );

  const decoys = deps.decoys.decoys;
  const find = (path: string): WebDecoyConfig | undefined => {
    for (const d of decoys) {
      if (path === d.mount) return d;
      if (d.type === 'web-admin' && path.startsWith(`${d.mount}/`)) return d;
    }
    return undefined;
  };

  // LRU-bounded: a flood of new sources only evicts the least recently seen entries, never live state
  // wholesale. Session state (authed, attempts) is keyed on decoy + SDK-derived client IP + the decoy
  // session cookie when the client keeps it (IP alone otherwise). Rate limits stay keyed on decoy + IP
  // so rotating cookies cannot buy more requests.
  const maxTracked = deps.maxTracked ?? MAX_TRACKED;
  const authed = new LruTtlMap<true>(maxTracked, now);
  const attempts = new LruTtlMap<Attempts>(maxTracked, now);
  const requests = new LruTtlMap<number>(maxTracked, now);
  const logins = new LruTtlMap<number>(maxTracked, now);
  /** Primary key first, then the IP-only key a cookie-less first request wrote its state under. */
  const sessionKeys = (decoyId: string, ip: string, sid: string | undefined): string[] =>
    sid ? [`${decoyId}|${ip}|${sid}`, `${decoyId}|${ip}`] : [`${decoyId}|${ip}`];
  const firstOf = <V>(map: LruTtlMap<V>, keys: string[]): V | undefined => {
    for (const k of keys) {
      const v = map.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const consumeRequest = (decoyId: string, ip: string): boolean => {
    const key = `${decoyId}|${ip}`;
    const count = requests.get(key) ?? 0;
    if (count >= MAX_REQUESTS_PER_SOURCE) return false;
    requests.set(key, count + 1, REQUEST_WINDOW_MS);
    return true;
  };

  const send = (
    reply: FastifyReply,
    status: number,
    type: string,
    body: string,
    extra?: Record<string, string>,
  ): FastifyReply => {
    reply.code(status).headers({ ...SECURITY_HEADERS, 'content-type': type, ...extra });
    return reply.send(body);
  };

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const ip = sanitizeIp(req.headers['x-ds-client-ip']);
    const reqId =
      clip(req.headers['x-ds-request-id'] as string | undefined, 64) ??
      randomBytes(8).toString('hex');
    const { path, query } = splitUrl(req.raw.url ?? '/');
    const method = req.method;
    const decoy = find(path);
    // Only trust the decoy id the SDK attached if it is one we declared; otherwise use the path match.
    const hinted = clip(req.headers['x-ds-decoy-id'] as string | undefined, 64);
    const decoyId = decoy?.id ?? (decoys.some((d) => d.id === hinted) ? (hinted as string) : '-');
    const base: LogLine = {
      ts: new Date(now()).toISOString(),
      decoy_id: decoyId,
      kind: 'request',
      ip,
      method,
      path: clip(path, 512) ?? '/',
      ...(query ? { query: clip(query, 1024) } : {}),
      ua: clip(req.headers['user-agent'], 512),
      req_id: reqId,
    };
    const body = parseBody(req.headers['content-type'], req.body);
    const bodyExcerpt =
      req.body instanceof Buffer && req.body.length > 0
        ? clip(req.body.toString('utf8'), 1024)
        : undefined;
    const done = (
      reply2: FastifyReply,
      status: number,
      extra: Partial<LogLine> = {},
    ): FastifyReply => {
      deps.logger.write({
        ...base,
        status,
        ...(bodyExcerpt && !('username' in extra) ? { body: bodyExcerpt } : {}),
        ...extra,
      });
      return reply2;
    };

    // Bound request volume by the SDK-derived source IP and decoy. Fastify proxy trust stays off;
    // the decoy is reachable only through the Unix socket and the SDK replaces this header.
    if (decoy && !consumeRequest(decoy.id, ip)) {
      return done(
        send(reply, 429, 'text/plain; charset=utf-8', 'Too Many Requests', {
          'retry-after': '60',
        }),
        429,
      );
    }

    if (!decoy) {
      return done(send(reply, 404, 'text/html; charset=utf-8', tpl.NOT_FOUND), 404);
    }

    /* ---------------- web-admin ---------------- */
    if (decoy.type === 'web-admin') {
      const mount = decoy.mount;
      const brand = decoy.brand ?? 'Admin Portal';
      const sub = path.slice(mount.length);
      const loginAttempt = method === 'POST' && (sub === '/login' || sub === '');
      const sid = readSessionId(req.headers.cookie);
      const keys = sessionKeys(decoy.id, ip, sid);
      if (!sid) {
        reply.header(
          'set-cookie',
          `${SESSION_COOKIE}=${newSessionId()}; path=${mount}; HttpOnly; SameSite=Lax`,
        );
      }

      if (method === 'GET' || method === 'HEAD') {
        if (sub === '')
          return done(
            send(
              reply,
              200,
              'text/html; charset=utf-8',
              tpl.loginPage({ brand, action: `${mount}/login` }),
            ),
            200,
          );
        if (sub === '/login')
          return done(
            send(
              reply,
              200,
              'text/html; charset=utf-8',
              tpl.loginPage({ brand, action: `${mount}/login` }),
            ),
            200,
          );
        if (sub === '/panel' || sub === '/export' || sub === '/export.csv') {
          if (firstOf(authed, keys) !== true || decoy.panel === 'none') {
            return done(
              reply
                .code(302)
                .headers({ ...SECURITY_HEADERS, location: mount })
                .send(''),
              302,
            );
          }
          const rows = deps.honeytokens.canary.rows;
          if (sub === '/panel') {
            return done(
              send(
                reply,
                200,
                'text/html; charset=utf-8',
                tpl.panelPage({ brand, mount, rows, withExport: true }),
              ),
              200,
            );
          }
          if (sub === '/export') {
            return done(
              send(
                reply,
                200,
                'text/html; charset=utf-8',
                tpl.exportPage({ brand, mount, count: rows.length }),
              ),
              200,
            );
          }
          const csv = tpl.customersCsv(rows);
          return done(
            send(reply, 200, 'text/csv; charset=utf-8', csv, {
              'content-disposition': 'attachment; filename="customers.csv"',
            }),
            200,
            { kind: 'export', file: 'customers.csv', bytes: Buffer.byteLength(csv) },
          );
        }
      }

      if (loginAttempt) {
        const sourceKey = `${decoy.id}|${ip}`;
        const loginCount = logins.get(sourceKey) ?? 0;
        if (loginCount >= MAX_LOGINS_PER_SOURCE) {
          return done(
            send(reply, 429, 'text/plain; charset=utf-8', 'Too Many Requests', {
              'retry-after': '60',
            }),
            429,
          );
        }
        logins.set(sourceKey, loginCount + 1, REQUEST_WINDOW_MS);
        const username = clip(pick(body, ['username', 'user', 'email', 'login']), 256) ?? '';
        const password = clip(pick(body, ['password', 'pass', 'pwd']), 128) ?? '';
        const prev = firstOf(attempts, keys);
        const tries = (prev?.tries ?? 0) + 1;
        // Randomised per session so a scanner cannot learn the exact threshold; never below N.
        const threshold =
          prev?.threshold ??
          (decoy.acceptAfter !== undefined
            ? decoy.acceptAfter + randomInt(0, ACCEPT_AFTER_SPREAD + 1)
            : Number.POSITIVE_INFINITY);
        const accepted =
          (decoy.acceptCredentials ?? []).some(([u, p]) => u === username && p === password) ||
          tries >= threshold;
        const primary = keys[0] as string;
        if (accepted) {
          authed.set(primary, true, SESSION_MS);
          for (const k of keys) attempts.delete(k);
        } else {
          attempts.set(primary, { tries, threshold }, STATE_TTL_MS);
        }
        const extra: Partial<LogLine> = { kind: 'login', username, password, accepted };
        if (accepted && decoy.panel !== 'none') {
          return done(
            reply
              .code(302)
              .headers({ ...SECURITY_HEADERS, location: `${mount}/panel` })
              .send(''),
            302,
            extra,
          );
        }
        return done(
          send(
            reply,
            accepted ? 200 : 401,
            'text/html; charset=utf-8',
            tpl.loginPage({ brand, action: `${mount}/login`, error: !accepted }),
          ),
          accepted ? 200 : 401,
          extra,
        );
      }
      return done(send(reply, 404, 'text/html; charset=utf-8', tpl.NOT_FOUND), 404);
    }

    /* ---------------- web-bait ---------------- */
    const template = decoy.template ?? 'dotenv';
    if (template === 'wp-login' || template === 'phpmyadmin') {
      if (method === 'POST') {
        const username = clip(pick(body, ['log', 'pma_username', 'username', 'user']), 256) ?? '';
        const password = clip(pick(body, ['pwd', 'pma_password', 'password', 'pass']), 128) ?? '';
        const html =
          template === 'wp-login'
            ? tpl.wpLogin(decoy.mount, true)
            : tpl.phpmyadminLogin(decoy.mount, true);
        return done(send(reply, 200, 'text/html; charset=utf-8', html), 200, {
          kind: 'login',
          username,
          password,
          accepted: false,
        });
      }
      const html =
        template === 'wp-login'
          ? tpl.wpLogin(decoy.mount, false)
          : tpl.phpmyadminLogin(decoy.mount, false);
      return done(send(reply, 200, 'text/html; charset=utf-8', html), 200);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return done(
        send(reply, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { allow: 'GET, HEAD' }),
        405,
      );
    }
    const ctx: tpl.BaitContext = {
      decoys: deps.decoys,
      honeytokens: deps.honeytokens,
      breadcrumbs: decoy.breadcrumbs !== false,
      used: [],
    };
    let content: string;
    let type = 'text/plain; charset=utf-8';
    let file = decoy.mount.split('/').pop() || 'file';
    let extraHeaders: Record<string, string> | undefined;
    if (template === 'sql-dump') {
      content = tpl.sqlDump(ctx);
      type = 'application/sql; charset=utf-8';
      extraHeaders = {
        'content-disposition': `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      };
    } else if (template === 'git-config') {
      content = tpl.gitConfig(ctx);
      file = 'config';
    } else {
      content = tpl.dotenv(ctx);
    }
    const apiId = deps.honeytokens.tokens.find(
      (t) => t.kind === 'api_key' && ctx.used.includes(t.id),
    )?.id;
    const primary = apiId ?? ctx.used[0];
    return done(send(reply, 200, type, content, extraHeaders), 200, {
      kind: 'bait',
      file,
      bytes: Buffer.byteLength(content),
      ...(primary ? { honeytoken_id: primary, honeytoken_ids: [...ctx.used] } : {}),
    });
  });

  // Oversized or malformed requests still produce a log line and a generic response.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const { path, query } = splitUrl(req.raw.url ?? '/');
    const decoy = find(path);
    const ip = sanitizeIp(req.headers['x-ds-client-ip']);
    const limited = decoy !== undefined && !consumeRequest(decoy.id, ip);
    const status = limited
      ? 429
      : err.statusCode && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 400;
    deps.logger.write({
      ts: new Date(now()).toISOString(),
      decoy_id: decoy?.id ?? '-',
      kind: 'request',
      ip,
      method: req.method,
      path: clip(path, 512) ?? '/',
      ...(query ? { query: clip(query, 1024) } : {}),
      ua: clip(req.headers['user-agent'], 512),
      req_id:
        clip(req.headers['x-ds-request-id'] as string | undefined, 64) ??
        randomBytes(8).toString('hex'),
      status,
    });
    reply
      .code(status)
      .headers({
        ...SECURITY_HEADERS,
        'content-type': 'text/plain; charset=utf-8',
        ...(limited ? { 'retry-after': '60' } : {}),
      })
      .send(limited ? 'Too Many Requests' : status === 413 ? 'Payload Too Large' : 'Bad Request');
  });

  return app;
}
