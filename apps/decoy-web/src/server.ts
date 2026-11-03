import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { HoneytokenSet, WebDecoyConfig, WebDecoysFile } from './config.js';
import type { JsonlLogger, LogLine } from './log.js';
import * as tpl from './templates.js';

export interface ServerDeps {
  decoys: WebDecoysFile;
  honeytokens: HoneytokenSet;
  logger: Pick<JsonlLogger, 'write'>;
  now?: () => number;
}

const MAX_BODY = 16 * 1024; // BREAKDOWN 7.11
const SESSION_MS = 30 * 60 * 1000;
const MAX_TRACKED = 5000;

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

  const authed = new Map<string, number>(); // ip -> expiry (sessions are IP-keyed: Cookie never reaches us)
  const attempts = new Map<string, number>(); // `${decoy}|${ip}` -> failed tries
  const bound = <V>(m: Map<string, V>): void => {
    if (m.size > MAX_TRACKED) m.clear();
  };
  const isAuthed = (ip: string): boolean => {
    const exp = authed.get(ip);
    if (exp === undefined) return false;
    if (exp < now()) {
      authed.delete(ip);
      return false;
    }
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

    if (!decoy) {
      return done(send(reply, 404, 'text/html; charset=utf-8', tpl.NOT_FOUND), 404);
    }

    /* ---------------- web-admin ---------------- */
    if (decoy.type === 'web-admin') {
      const mount = decoy.mount;
      const brand = decoy.brand ?? 'Admin Portal';
      const sub = path.slice(mount.length);
      const loginAttempt = method === 'POST' && (sub === '/login' || sub === '');

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
          if (!isAuthed(ip) || decoy.panel === 'none') {
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
        const username = clip(pick(body, ['username', 'user', 'email', 'login']), 256) ?? '';
        const password = clip(pick(body, ['password', 'pass', 'pwd']), 128) ?? '';
        const key = `${decoy.id}|${ip}`;
        const tries = (attempts.get(key) ?? 0) + 1;
        const accepted =
          (decoy.acceptCredentials ?? []).some(([u, p]) => u === username && p === password) ||
          (decoy.acceptAfter !== undefined && tries >= decoy.acceptAfter);
        if (accepted) {
          attempts.delete(key);
          bound(authed);
          authed.set(ip, now() + SESSION_MS);
        } else {
          bound(attempts);
          attempts.set(key, tries);
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
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 400;
    const { path, query } = splitUrl(req.raw.url ?? '/');
    deps.logger.write({
      ts: new Date(now()).toISOString(),
      decoy_id: find(path)?.id ?? '-',
      kind: 'request',
      ip: sanitizeIp(req.headers['x-ds-client-ip']),
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
      .headers({ ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
      .send(status === 413 ? 'Payload Too Large' : 'Bad Request');
  });

  return app;
}
