import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import type { DecoyEvent } from '@lxs/schema';
import { z } from 'zod';
import type { PolicyStore } from './policy.js';
import type { Counters, Logger } from './telemetry.js';
import { ulid } from './ulid.js';

/**
 * The only door the SDK middleware has into the agent. Versioned (/v1), served on a Unix socket in the
 * ds_agent_sock volume, which is never mounted into ds-web: an attacker with code execution in a decoy has no
 * route to it.
 */
export function agentSocketPath(runDir: string): string {
  if (process.platform === 'win32') {
    const h = createHash('sha1').update(runDir).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\lxs-${h}-agent`;
  }
  return `${runDir}/agent/agent.sock`;
}

const MAX_BODY = 256 * 1024;

export const SignalSchema = z.object({
  kind: z.enum(['asset.access', 'asset.blocked', 'honeytoken.use']),
  ip: z.string().max(64),
  method: z.string().max(16).default('GET'),
  path: z.string().max(2048),
  ts: z.string().optional(),
  status: z.number().int().optional(),
  asset: z.string().max(128).optional(),
  critical: z.boolean().optional(),
  token_id: z.string().max(64).optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

const SignalsBody = z.object({
  signals: z.array(SignalSchema).max(500),
  dropped: z.number().int().nonnegative().optional(),
});
const SelftestBody = z.object({
  passed: z.boolean(),
  checks: z
    .array(
      z.object({
        name: z.string().max(256),
        passed: z.boolean(),
        detail: z.string().max(512).optional(),
      }),
    )
    .max(200),
});

/** SDK signal -> DecoyEvent (sensor 'sdk', is_decoy false: these are about the real app). */
export function signalToEvent(s: Signal, simulated: boolean): DecoyEvent | null {
  if (isIP(s.ip) === 0) return null;
  const d = s.ts ? new Date(s.ts) : new Date();
  const ts = Number.isNaN(d.getTime()) ? new Date() : d;
  const base: DecoyEvent = {
    id: ulid(ts.getTime()),
    schema_version: 1,
    timestamp: ts.toISOString(),
    sensor: 'sdk',
    is_decoy: false,
    src_ip: s.ip,
    dst_service: `app:${s.path.split('?')[0]}`.slice(0, 128),
    event_type: s.kind,
    method: s.method.slice(0, 16),
    url: s.path.slice(0, 2048),
    count: 1,
    simulated,
  };
  if (s.status !== undefined) base.status_code = s.status;
  if (s.asset) base.asset_name = s.asset;
  if (s.token_id) base.honeytoken_id = s.token_id;
  if (s.kind === 'asset.blocked') base.outcome = 'failure';
  if (s.critical !== undefined) base.raw = { critical: s.critical };
  return base;
}

export interface LocalApiOptions {
  runDir: string;
  policy: PolicyStore;
  counters: Counters;
  simulated: boolean;
  onEvent: (ev: DecoyEvent) => void;
  onSelftest: (report: z.infer<typeof SelftestBody>) => Promise<boolean>;
  log?: Logger;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createLocalApi(o: LocalApiOptions): {
  server: http.Server;
  start(): Promise<string>;
  stop(): Promise<void>;
} {
  const sock = agentSocketPath(o.runDir);
  const json = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...extra,
    });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && url === '/healthz') return json(res, 200, { ok: true });

      if (req.method === 'GET' && url === '/v1/policy') {
        const snap = o.policy.snapshot();
        const etag = `"${snap.revision}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag });
          return res.end();
        }
        return json(res, 200, snap, { etag });
      }

      if (req.method === 'POST' && url === '/v1/signals') {
        const raw = await readBody(req);
        if (raw === null) return json(res, 413, { error: 'too large' });
        let parsed: z.infer<typeof SignalsBody>;
        try {
          parsed = SignalsBody.parse(JSON.parse(raw));
        } catch {
          return json(res, 400, { error: 'invalid body' });
        }
        let accepted = 0;
        for (const s of parsed.signals) {
          const ev = signalToEvent(s, o.simulated);
          if (ev) {
            o.onEvent(ev);
            accepted++;
          }
        }
        if (parsed.dropped) o.counters.inc('sdk_signals_dropped', parsed.dropped);
        o.counters.inc('sdk_signals', accepted);
        return json(res, 202, { accepted });
      }

      if (req.method === 'POST' && url === '/v1/selftest-report') {
        const raw = await readBody(req);
        if (raw === null) return json(res, 413, { error: 'too large' });
        let parsed: z.infer<typeof SelftestBody>;
        try {
          parsed = SelftestBody.parse(JSON.parse(raw));
        } catch {
          return json(res, 400, { error: 'invalid body' });
        }
        const ok = await o.onSelftest(parsed);
        return json(res, ok ? 202 : 502, { forwarded: ok });
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      o.log?.error('local api error', { error: (e as Error).message });
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;

  return {
    server,
    async start() {
      if (process.platform !== 'win32') {
        fs.mkdirSync(path.dirname(sock), { recursive: true });
        fs.rmSync(sock, { force: true });
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sock, () => resolve());
      });
      if (process.platform !== 'win32') fs.chmodSync(sock, 0o666); // only containers that mount the volume can reach it
      return sock;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
