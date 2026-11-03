import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AssetMatcher, type DecoyMatch, DecoyMatcher, pathOnly } from '../matcher.js';
import {
  buildIpPredicate,
  type CidrMatcher,
  isValidIp,
  parseCidr,
  parseIp,
  stripMapped,
} from '../netutil.js';
import { agentSocketPath, webSocketPath } from '../socket.js';
import type { ResolvedConfig } from '../types.js';

export type SignalKind = 'asset.access' | 'asset.blocked' | 'honeytoken.use';

export interface Signal {
  kind: SignalKind;
  ip: string;
  method: string;
  path: string;
  ts: string;
  status?: number;
  asset?: string;
  critical?: boolean;
  token_id?: string;
}

export interface Core {
  /** Hot path. 'handled' means the response is owned by the core; 'pass' means call next(). */
  process(req: IncomingMessage, res: ServerResponse): 'pass' | 'handled';
  close(): void;
  stats(): { queued: number; dropped: number; errors: number; active: boolean };
}

export interface CoreOverrides {
  pollMs?: number;
  flushMs?: number;
  decoyTimeoutMs?: number;
}

type Logger = Pick<Console, 'warn' | 'error'>;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);
/** Credentials of real users never reach the attacker-facing container. */
const STRIPPED_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);
const MAX_PROXY_BODY = 64 * 1024;
const QUEUE_MAX = 1000;

const NOOP: Core = {
  process: () => 'pass',
  close: () => undefined,
  stats: () => ({ queued: 0, dropped: 0, errors: 0, active: false }),
};

function assertSupportedRuntime(): void {
  const g = globalThis as Record<string, unknown>;
  const env = process.env;
  if (
    typeof g.EdgeRuntime !== 'undefined' ||
    env.NEXT_RUNTIME === 'edge' ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.VERCEL ||
    !process.versions?.node
  ) {
    throw new Error(
      'lxs: edge / serverless runtimes are not supported (the middleware needs Unix sockets). ' +
        'Run the app as a container next to the lxs sidecars, or set LXS_DISABLED=1.',
    );
  }
}

interface PolicyState {
  etag?: string;
  blocklist: Set<string>;
  blockCidrs: CidrMatcher[];
  watchlist: Set<string>;
  honeytokens: Map<string, string>;
  allow: ((ip: string) => boolean) | null;
}

const emptyPolicy = (): PolicyState => ({
  blocklist: new Set(),
  blockCidrs: [],
  watchlist: new Set(),
  honeytokens: new Map(),
  allow: null,
});

function makeClientIp(
  trust: boolean | string[],
  devSim: boolean,
): (req: IncomingMessage) => string {
  const trusted: ((ip: string) => boolean) | null =
    trust === true ? () => true : Array.isArray(trust) ? buildIpPredicate(trust) : null;
  return (req) => {
    const sock = stripMapped(req.socket?.remoteAddress ?? '');
    if (devSim) {
      const h = req.headers['x-ds-sim-ip'];
      if (typeof h === 'string' && isValidIp(h.trim())) return h.trim();
    }
    if (!trusted || !trusted(sock)) return sock;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff !== 'string' || xff.length === 0) return sock;
    const hops = xff.split(',').map((s) => stripMapped(s.trim()));
    for (let i = hops.length - 1; i >= 0; i--) {
      const h = hops[i] as string;
      if (!isValidIp(h)) return sock;
      if (!trusted(h)) return h;
    }
    return hops[0] ?? sock;
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function requestId(): string {
  return Date.now().toString(36) + randomBytes(6).toString('hex');
}

export function createCore(
  cfg: ResolvedConfig,
  logger: Logger = console,
  overrides: CoreOverrides = {},
): Core {
  const { options } = cfg;
  if (options.disabled) return NOOP;
  assertSupportedRuntime();

  const devSim = process.env.LXS_DEV_TRUST_SIM_HEADER === '1';
  if (devSim && process.env.NODE_ENV === 'production') {
    throw new Error('lxs: LXS_DEV_TRUST_SIM_HEADER is refused when NODE_ENV=production.');
  }

  const runDir = options.runDir;
  const webSock = webSocketPath(runDir);
  const agentSock = agentSocketPath(runDir);
  const clientIp = makeClientIp(options.trustProxy, devSim);
  const decoyMatcher = new DecoyMatcher(cfg.decoys);
  const assetMatcher = new AssetMatcher(cfg.assets);
  const staticAllow = buildIpPredicate(options.allowlist);
  const enforce = options.mode === 'enforce';
  const hasWebDecoys = decoyMatcher.size > 0;
  const decoyTimeout = overrides.decoyTimeoutMs ?? 10_000;

  const htCfg = cfg.honeytokens?.apiKey;
  const htHeader = htCfg?.header;
  const htPrefix = htCfg?.prefix ?? '';

  let policy = emptyPolicy();
  let active = process.platform === 'win32' ? true : fs.existsSync(runDir);
  let errors = 0;
  let closed = false;

  const lastWarn = new Map<string, number>();
  const warnOnce = (key: string, msg: string): void => {
    const now = Date.now();
    if (now - (lastWarn.get(key) ?? 0) < 60_000) return;
    lastWarn.set(key, now);
    try {
      logger.warn(`lxs: ${msg}`);
    } catch {
      /* never throw into the app */
    }
  };
  if (!active) {
    warnOnce(
      'norundir',
      `${runDir} not found; middleware is a no-op (run via docker compose with lxs.compose.yml).`,
    );
  }

  /* ---- signals: bounded queue, flushed to the agent socket ---- */
  let queue: Signal[] = [];
  let dropped = 0;
  const push = (s: Signal): void => {
    if (queue.length >= QUEUE_MAX) {
      queue.shift();
      dropped++;
    }
    queue.push(s);
  };

  const rate = new Map<string, number>();
  const rateAllow = (ip: string, path: string, now: number): boolean => {
    const key = `${ip} ${path}`;
    const last = rate.get(key);
    if (last !== undefined && now - last < 60_000) return false;
    if (rate.size > 10_000) {
      for (const [k, t] of rate) if (now - t >= 60_000) rate.delete(k);
      if (rate.size > 10_000) rate.clear();
    }
    rate.set(key, now);
    return true;
  };

  let flushing = false;
  const flush = (): void => {
    if (flushing || !active || (queue.length === 0 && dropped === 0)) return;
    flushing = true;
    const batch = queue.splice(0, 200);
    const dropCount = dropped;
    dropped = 0;
    const body = JSON.stringify({ signals: batch, dropped: dropCount });
    const r = http.request(
      {
        socketPath: agentSock,
        method: 'POST',
        path: '/v1/signals',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 1500,
      },
      (resp) => {
        resp.resume();
        resp.on('end', () => {
          flushing = false;
          if ((resp.statusCode ?? 500) >= 500) requeue(batch, dropCount);
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => {
      flushing = false;
      errors++;
      requeue(batch, dropCount);
      warnOnce(
        'agent',
        'agent socket unreachable; failing open (signals are buffered and retried).',
      );
    });
    r.end(body);
  };
  const requeue = (batch: Signal[], dropCount: number): void => {
    queue = batch.concat(queue);
    dropped += dropCount;
    if (queue.length > QUEUE_MAX) {
      dropped += queue.length - QUEUE_MAX;
      queue = queue.slice(queue.length - QUEUE_MAX);
    }
  };

  /* ---- policy cache: refreshed off the hot path every 2 s with ETags ---- */
  let polling = false;
  const refreshPolicy = (): void => {
    if (polling || closed) return;
    if (!active) {
      if (process.platform !== 'win32' && fs.existsSync(runDir)) active = true;
      else return;
    }
    polling = true;
    const headers: Record<string, string> = {};
    if (policy.etag) headers['if-none-match'] = policy.etag;
    const r = http.request(
      { socketPath: agentSock, method: 'GET', path: '/v1/policy', headers, timeout: 1500 },
      (resp) => {
        if (resp.statusCode === 304) {
          resp.resume();
          resp.on('end', () => {
            polling = false;
          });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        resp.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) resp.destroy();
          else chunks.push(c);
        });
        resp.on('end', () => {
          polling = false;
          if (resp.statusCode !== 200) return;
          try {
            applyPolicy(JSON.parse(Buffer.concat(chunks).toString('utf8')), resp.headers.etag);
          } catch {
            errors++;
          }
        });
        resp.on('error', () => {
          polling = false;
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => {
      polling = false;
      errors++;
      warnOnce('agent', 'agent socket unreachable; failing open (using last known policy).');
    });
    r.end();
  };

  const applyPolicy = (j: unknown, etag: string | undefined): void => {
    const o = (j ?? {}) as Record<string, unknown>;
    const next = emptyPolicy();
    next.etag = etag;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    for (const entry of list(o.blocklist)) {
      if (entry.includes('/')) {
        const m = parseCidr(entry);
        if (m) next.blockCidrs.push(m);
      } else if (parseIp(entry)) next.blocklist.add(stripMapped(entry));
    }
    for (const ip of list(o.watchlist)) if (parseIp(ip)) next.watchlist.add(stripMapped(ip));
    const ht = o.honeytokens;
    if (ht && typeof ht === 'object') {
      for (const [hash, id] of Object.entries(ht as Record<string, unknown>)) {
        if (typeof id === 'string') next.honeytokens.set(hash, id);
      }
    }
    next.allow = buildIpPredicate(list(o.allowlist));
    policy = next;
  };

  const pollTimer = setInterval(refreshPolicy, overrides.pollMs ?? 2000);
  const flushTimer = setInterval(flush, overrides.flushMs ?? 500);
  pollTimer.unref();
  flushTimer.unref();
  refreshPolicy();

  /* ---- decoy proxy over the web socket ---- */
  const proxyToDecoy = (
    req: IncomingMessage,
    res: ServerResponse,
    decoy: DecoyMatch,
    ip: string,
  ): void => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k) || STRIPPED_REQUEST_HEADERS.has(k) || k.startsWith('x-ds-')) continue;
      headers[k] = v;
    }
    headers['x-ds-client-ip'] = ip;
    headers['x-ds-decoy-id'] = decoy.id;
    headers['x-ds-request-id'] = requestId();

    let finished = false;
    const fail = (status: number, body: string): void => {
      if (finished) return;
      finished = true;
      if (!res.headersSent) {
        res.statusCode = status;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(body);
      } else res.destroy();
    };

    const cl = Number(req.headers['content-length'] ?? 0);
    if (cl > MAX_PROXY_BODY) {
      fail(413, 'Payload Too Large');
      return;
    }

    const preq = http.request(
      { socketPath: webSock, method: req.method, path: req.url, headers },
      (pres) => {
        if (finished) {
          pres.resume();
          return;
        }
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(pres.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k) || k === 'transfer-encoding') continue;
          out[k] = v;
        }
        res.writeHead(pres.statusCode ?? 502, out);
        pres.pipe(res);
        pres.on('end', () => {
          finished = true;
        });
        pres.on('error', () => res.destroy());
      },
    );
    preq.setTimeout(decoyTimeout, () => preq.destroy(new Error('timeout')));
    preq.on('error', (err) => {
      errors++;
      warnOnce('decoy', 'decoy socket unreachable; serving a generic 404 for decoy paths.');
      fail(
        err.message === 'timeout' ? 504 : 404,
        err.message === 'timeout' ? 'Gateway Timeout' : 'Not Found',
      );
    });
    let seen = 0;
    req.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_PROXY_BODY) {
        preq.destroy();
        fail(413, 'Payload Too Large');
        req.destroy();
      }
    });
    req.pipe(preq);
  };

  /* ---- hot path ---- */
  return {
    process(req, res) {
      try {
        if (!active) return 'pass';
        const ip = clientIp(req);
        if (staticAllow !== null && staticAllow(ip)) return 'pass';
        if (policy.allow !== null && policy.allow(ip)) return 'pass';

        const url = req.url;
        const path = pathOnly(url);
        const method = req.method ?? 'GET';

        if (
          enforce &&
          (policy.blocklist.has(ip) || (policy.blockCidrs.length > 0 && isBlockedByCidr(ip)))
        ) {
          const now = Date.now();
          if (rateAllow(ip, `blocked ${path}`, now)) {
            push({ kind: 'asset.blocked', ip, method, path, ts: new Date(now).toISOString() });
          }
          res.statusCode = 403;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Forbidden'); // generic body, no product name
          return 'handled';
        }

        if (hasWebDecoys) {
          const decoy = decoyMatcher.match(path);
          if (decoy) {
            proxyToDecoy(req, res, decoy, ip);
            return 'handled'; // never next(): the real app must not see decoy paths
          }
        }

        if (htHeader !== undefined) {
          const raw = req.headers[htHeader];
          if (typeof raw === 'string' && raw.length > 0) {
            const token = candidate(raw, htPrefix);
            if (token !== null) {
              const id = policy.honeytokens.get(sha256(token));
              if (id !== undefined) {
                push({
                  kind: 'honeytoken.use',
                  ip,
                  method,
                  path,
                  ts: new Date().toISOString(),
                  token_id: id,
                });
              }
            }
          }
        }

        if (policy.watchlist.size > 0 && policy.watchlist.has(ip)) {
          const now = Date.now();
          if (rateAllow(ip, path, now)) {
            const asset = assetMatcher.match(path);
            res.once('finish', () => {
              push({
                kind: 'asset.access',
                ip,
                method,
                path,
                ts: new Date().toISOString(),
                status: res.statusCode,
                ...(asset ? { asset: asset.name, critical: asset.criticality === 'critical' } : {}),
              });
            });
          }
        }
        return 'pass';
      } catch (err) {
        errors++;
        warnOnce('hotpath', `request handling error (failing open): ${(err as Error).message}`);
        return 'pass';
      }
    },
    close() {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(flushTimer);
    },
    stats: () => ({ queued: queue.length, dropped, errors, active }),
  };

  function isBlockedByCidr(ip: string): boolean {
    const p = parseIp(ip);
    return p !== null && policy.blockCidrs.some((m) => m(p));
  }
}

/** Only values that look like the planted key format are hashed, so normal users' tokens are never touched. */
function candidate(raw: string, prefix: string): string | null {
  let v = raw.trim();
  const sp = v.indexOf(' ');
  if (sp > 0 && sp < 10) v = v.slice(sp + 1).trim();
  if (prefix && !v.startsWith(prefix)) return null;
  return v.length > 0 && v.length <= 256 ? v : null;
}
