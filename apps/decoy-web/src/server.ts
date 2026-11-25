import { randomBytes, randomInt } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type AssetSkin, assetTable, type StaticAsset, staticHeaders } from './assets.js';
import {
  type BaitValues,
  type HoneytokenSet,
  resolveBait,
  type WebDecoyConfig,
  type WebDecoysFile,
} from './config.js';
import type { Jitter, JitterSkin } from './jitter.js';
import type { JsonlLogger, LogLine } from './log.js';
import { LruTtlMap } from './lru.js';
import { mintToken, parseMintSecret } from './mint.js';
import * as tpl from './templates.js';

export interface ServerDeps {
  decoys: WebDecoysFile;
  honeytokens: HoneytokenSet;
  logger: Pick<JsonlLogger, 'write'>;
  now?: () => number;
  /** Capacity of each per-source state map (default 5000). Exposed for tests. */
  maxTracked?: number;
  /** Response-time jitter (jitter.ts). Absent or null: answer immediately (tests). */
  jitter?: Jitter | null;
  /**
   * Mint a unique API-key honeytoken per visitor session when the honeytoken file carries a mint
   * secret (the default). `false` always serves the static per-deployment token.
   */
  perVisitorTokens?: boolean;
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

/** Kept on non-page responses (429/413/405 text) and the error handler. */
const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/**
 * Response headers per skin. A real product's headers are part of its fingerprint as much as its
 * markup: one strict header set on every decoy page was itself a tell.
 */
function pageHeaders(skin: tpl.Skin, bait: BaitValues, now: number): Record<string, string> {
  switch (skin) {
    case 'admin':
      return {
        'cache-control': 'no-cache, private',
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'",
      };
    case 'wordpress':
      return {
        expires: 'Wed, 11 Jan 1984 05:00:00 GMT',
        'cache-control': 'no-cache, must-revalidate, max-age=0, no-store, private',
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-powered-by': `PHP/${bait.versions.php}`,
      };
    case 'phpmyadmin':
      return {
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        'cache-control':
          'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
        pragma: 'no-cache',
        expires: new Date(now).toUTCString(),
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'",
        'x-powered-by': `PHP/${bait.versions.php}`,
      };
    default:
      return {};
  }
}

type BaitTemplate = NonNullable<WebDecoyConfig['template']>;

/** Directory the template's second-order assets hang off (mirrors sdk/lxs/src/bait-assets.ts). */
function assetBase(template: BaitTemplate, mount: string): string {
  const dir = mount.slice(0, mount.lastIndexOf('/'));
  if (template === 'phpmyadmin') return mount.endsWith('.php') ? dir : mount;
  return dir;
}

const skinOfTemplate = (t: BaitTemplate): tpl.Skin =>
  t === 'wp-login' ? 'wordpress' : t === 'phpmyadmin' ? 'phpmyadmin' : 'nginx';

const assetSkinOf = (t: BaitTemplate): AssetSkin =>
  t === 'wp-login' ? 'wordpress' : t === 'phpmyadmin' ? 'phpmyadmin' : 'git';

export function buildServer(deps: ServerDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const bait = resolveBait(deps.decoys.bait);
  const jitter = deps.jitter ?? null;
  const mintSecret =
    deps.perVisitorTokens === false ? null : parseMintSecret(deps.honeytokens.mint_secret);
  const service = deps.decoys.service ?? 'app';
  const siteName = service.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const env = (): tpl.PageEnv => ({
    bait,
    service,
    now: now(),
    nonce: (n) => randomBytes(n).toString('hex'),
  });
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
    for (const d of decoys) {
      if (d.type === 'web-bait' && Array.isArray(d.assets) && d.assets.includes(path)) return d;
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

  /** Plain responses (throttling, 413, 405 text): immediate, no skin. */
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

  /** Canned responses: the skin's headers, then the body after a realistic delay (jitter.ts). */
  const respond = (
    reply: FastifyReply,
    skin: JitterSkin,
    status: number,
    type: string,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ): FastifyReply => {
    reply.code(status).headers({ 'content-type': type, ...headers });
    const wait = jitter ? jitter.delay(skin) : 0;
    if (wait <= 0) return reply.send(body);
    const t = setTimeout(() => {
      if (!reply.sent) reply.send(body);
    }, wait);
    reply.raw.once('close', () => clearTimeout(t));
    return reply;
  };

  const page = (
    reply: FastifyReply,
    skin: tpl.Skin,
    status: number,
    html: string,
    extra: Record<string, string> = {},
  ): FastifyReply =>
    respond(reply, skin, status, 'text/html; charset=UTF-8', html, {
      ...pageHeaders(skin, bait, now()),
      ...extra,
    });

  const redirect = (reply: FastifyReply, skin: tpl.Skin, location: string): FastifyReply =>
    respond(reply, skin, 302, 'text/html; charset=UTF-8', '', {
      ...pageHeaders(skin, bait, now()),
      location,
    });

  const nginxPage = (reply: FastifyReply, status: 403 | 404 | 405): FastifyReply =>
    respond(reply, 'nginx', status, 'text/html', tpl.nginxError(status, bait), {
      server: `nginx/${bait.versions.nginx}`,
    });

  /** Each product's own 404 (or 403): the WordPress theme, Apache for phpMyAdmin, nginx for files. */
  const errorPage = (
    reply: FastifyReply,
    skin: tpl.Skin,
    status: 403 | 404,
    wpBase = '',
  ): FastifyReply => {
    if (skin === 'admin') return page(reply, 'admin', status, tpl.adminError(status));
    if (skin === 'wordpress' && status === 404)
      return page(reply, 'wordpress', 404, tpl.wp404({ base: wpBase, site: siteName }, env()));
    if (skin === 'phpmyadmin')
      return respond(
        reply,
        'phpmyadmin',
        status,
        'text/html; charset=iso-8859-1',
        tpl.apacheError(status, bait),
      );
    return nginxPage(reply, status);
  };

  const asset = (reply: FastifyReply, a: StaticAsset, method: string): FastifyReply =>
    respond(reply, 'asset', 200, a.type, method === 'HEAD' ? '' : a.body, {
      ...staticHeaders(a.body, bait),
      ...(a.cache ? { 'cache-control': a.cache } : {}),
    });

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
    const hintedDecoy = decoys.find((d) => d.id === hinted);
    const decoyId = decoy?.id ?? hintedDecoy?.id ?? '-';
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
      // Routed here but claimed by no decoy: answer with the hinted decoy's own 404 look.
      const skin: tpl.Skin =
        hintedDecoy?.type === 'web-admin'
          ? 'admin'
          : hintedDecoy?.type === 'web-bait'
            ? skinOfTemplate(hintedDecoy.template ?? 'dotenv')
            : 'nginx';
      return done(errorPage(reply, skin, 404), 404);
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
        if (sub === '' || sub === '/login')
          return done(
            page(
              reply,
              'admin',
              200,
              tpl.loginPage({ brand, mount, action: `${mount}/login` }, env()),
            ),
            200,
          );
        const a = assetTable('admin', bait)[sub];
        if (a) return done(asset(reply, a, method), 200);
        if (sub === '/panel' || sub === '/export' || sub === '/export.csv') {
          if (firstOf(authed, keys) !== true || decoy.panel === 'none') {
            return done(redirect(reply, 'admin', mount), 302);
          }
          const rows = deps.honeytokens.canary.rows;
          if (sub === '/panel') {
            return done(
              page(
                reply,
                'admin',
                200,
                tpl.panelPage({ brand, mount, rows, withExport: true }, env()),
              ),
              200,
            );
          }
          if (sub === '/export') {
            return done(
              page(
                reply,
                'admin',
                200,
                tpl.exportPage({ brand, mount, count: rows.length }, env()),
              ),
              200,
            );
          }
          const csv = tpl.customersCsv(rows);
          return done(
            respond(reply, 'admin', 200, 'text/csv; charset=UTF-8', csv, {
              ...pageHeaders('admin', bait, now()),
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
          return done(redirect(reply, 'admin', `${mount}/panel`), 302, extra);
        }
        return done(
          page(
            reply,
            'admin',
            accepted ? 200 : 401,
            tpl.loginPage({ brand, mount, action: `${mount}/login`, error: !accepted }, env()),
          ),
          accepted ? 200 : 401,
          extra,
        );
      }
      return done(errorPage(reply, 'admin', 404), 404);
    }

    /* ---------------- web-bait ---------------- */
    const template = decoy.template ?? 'dotenv';
    const skin = skinOfTemplate(template);
    const assetsBase = assetBase(template, decoy.mount);

    if (path !== decoy.mount) {
      // A second-order path (sdk/lxs/src/bait-assets.ts). Read-only apart from xmlrpc.php.
      const rel = path.slice(assetsBase.length);
      const isXmlRpc = template === 'wp-login' && rel === '/xmlrpc.php';
      if (method !== 'GET' && method !== 'HEAD' && !isXmlRpc) {
        return done(nginxPage(reply, 405), 405);
      }
      if (template === 'wp-login') {
        if (rel === '/wp-admin') {
          const to = encodeURIComponent(`${assetsBase}/wp-admin/`);
          return done(
            redirect(reply, 'wordpress', `${decoy.mount}?redirect_to=${to}&reauth=1`),
            302,
          );
        }
        if (isXmlRpc) {
          const posted = method === 'POST';
          return done(
            respond(
              reply,
              'wordpress',
              posted ? 200 : 405,
              posted ? 'text/xml; charset=UTF-8' : 'text/plain;charset=UTF-8',
              posted
                ? '<?xml version="1.0" encoding="UTF-8"?>\n<methodResponse>\n  <fault>\n    <value>\n      <struct>\n        <member>\n          <name>faultCode</name>\n          <value><int>-32700</int></value>\n        </member>\n        <member>\n          <name>faultString</name>\n          <value><string>parse error. not well formed</string></value>\n        </member>\n      </struct>\n    </value>\n  </fault>\n</methodResponse>\n'
                : 'XML-RPC server accepts POST requests only.',
              posted ? {} : { allow: 'POST', 'x-powered-by': `PHP/${bait.versions.php}` },
            ),
            posted ? 200 : 405,
          );
        }
        if (rel === '/wp-includes') return done(nginxPage(reply, 403), 403);
      }
      if (template === 'phpmyadmin' && rel === '/index.php') {
        return done(
          page(
            reply,
            'phpmyadmin',
            200,
            tpl.phpmyadminLogin({ base: assetsBase, action: decoy.mount, error: false }, env()),
          ),
          200,
        );
      }
      if (template === 'git-config' && rel === '') return done(nginxPage(reply, 403), 403);
      const a = assetTable(assetSkinOf(template), bait)[rel];
      if (a) return done(asset(reply, a, method), 200);
      return done(errorPage(reply, skin, 404, assetsBase), 404);
    }

    if (template === 'wp-login' || template === 'phpmyadmin') {
      const login = (error: boolean): string =>
        template === 'wp-login'
          ? tpl.wpLogin({ base: assetsBase, action: decoy.mount, error, site: siteName }, env())
          : tpl.phpmyadminLogin({ base: assetsBase, action: decoy.mount, error }, env());
      const cookie =
        template === 'wp-login'
          ? 'wordpress_test_cookie=WP%20Cookie%20check; path=/'
          : `phpMyAdmin=${randomBytes(16).toString('hex')}; path=${assetsBase || ''}/; HttpOnly; SameSite=Strict`;
      if (method === 'POST') {
        const username = clip(pick(body, ['log', 'pma_username', 'username', 'user']), 256) ?? '';
        const password = clip(pick(body, ['pwd', 'pma_password', 'password', 'pass']), 128) ?? '';
        return done(page(reply, skin, 200, login(true), { 'set-cookie': cookie }), 200, {
          kind: 'login',
          username,
          password,
          accepted: false,
        });
      }
      return done(page(reply, skin, 200, login(false), { 'set-cookie': cookie }), 200);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return done(nginxPage(reply, 405), 405);
    }
    const sid = readSessionId(req.headers.cookie);
    const ctx: tpl.BaitContext = {
      decoys: deps.decoys,
      honeytokens: deps.honeytokens,
      bait,
      breadcrumbs: decoy.breadcrumbs !== false,
      used: [],
      minted: [],
      ...(mintSecret ? { mint: (b) => mintToken(mintSecret, b, ip, sid ?? '') } : {}),
    };
    let content: string;
    // nginx's default_type for files without a known extension (.env, .git/config).
    let type = 'application/octet-stream';
    let file = decoy.mount.split('/').pop() || 'file';
    let extraHeaders: Record<string, string> = {};
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
    respond(reply, 'nginx', 200, type, method === 'HEAD' ? '' : content, {
      server: `nginx/${bait.versions.nginx}`,
      ...staticHeaders(content, bait),
      ...extraHeaders,
    });
    done(reply, 200, {
      kind: 'bait',
      file,
      bytes: Buffer.byteLength(content),
      ...(primary ? { honeytoken_id: primary, honeytoken_ids: [...ctx.used] } : {}),
    });
    // One `mint` line per token handed out. ds-agent re-derives the value from the mint id and
    // registers it; the platform maps the id to this visitor so a later use can be attributed.
    for (const m of ctx.minted) {
      deps.logger.write({
        ...base,
        kind: 'mint',
        status: 200,
        honeytoken_id: m.baseId,
        mint_id: m.id,
        ...(sid ? { session_id: sid } : {}),
      });
    }
    return reply;
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
