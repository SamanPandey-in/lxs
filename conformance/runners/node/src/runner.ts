// Node conformance runner: drives the real Express / Fastify middleware with each vector, against a
// fake agent (policy) and a fake decoy on the same sockets the real sidecars use (named pipes on
// Windows, Unix sockets elsewhere: see sdk/lxs/src/socket.ts).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Fastify from 'fastify';
import { LXS } from '../../../../sdk/lxs/src/index.js';
import { type FakeAgent, startFakeAgent } from '../../../../sdk/lxs/src/testing.js';

export type Framework = 'express' | 'fastify';
export const FRAMEWORKS: readonly Framework[] = ['express', 'fastify'];

export type HeaderAssertions = Record<string, string | true | null>;

export interface Vector {
  name: string;
  description: string;
  config: {
    mode: 'enforce' | 'monitor';
    trustProxy: false | number | string[];
    allowlist: string[];
    decoys: Array<{ id: string; path: string; prefix: boolean }>;
  };
  policy: { blocklist: string[]; allowlist: string[] };
  request: {
    method: string;
    target: string;
    headers: Array<[string, string]>;
    remoteAddress: string;
    body?: string;
    bodyBytes?: number;
  };
  expect: {
    outcome: 'pass_through' | 'decoy' | 'blocked';
    app?: { headers?: HeaderAssertions };
    decoy?: {
      id: string;
      clientIp: string;
      method?: string;
      target?: string;
      headers?: HeaderAssertions;
    };
    status?: number;
    frameworkMayReject?: boolean;
  };
}

export interface VectorFile {
  file: string;
  category: string;
  vectors: Vector[];
}

export const VECTORS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../vectors',
);

export function loadVectorFiles(dir = VECTORS_DIR): VectorFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Omit<
        VectorFile,
        'file'
      >;
      return { file: f, category: doc.category, vectors: doc.vectors };
    });
}

/** Test-only header carrying the simulated TCP peer address; removed before the middleware runs. */
const REMOTE_HEADER = 'x-conformance-remote-address';

function applyRemoteAddress(req: http.IncomingMessage): void {
  const addr = req.headers[REMOTE_HEADER];
  delete req.headers[REMOTE_HEADER];
  for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
    if (req.rawHeaders[i]?.toLowerCase() === REMOTE_HEADER) req.rawHeaders.splice(i, 2);
  }
  if (typeof addr === 'string') {
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
  }
}

interface SeenByApp {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bodyLength: number;
}

interface App {
  port: number;
  seen: SeenByApp[];
  close(): Promise<void>;
}

async function startExpress(t: LXS): Promise<App> {
  const seen: SeenByApp[] = [];
  const app = express();
  app.use(t.express());
  app.use((req, res) => {
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, bodyLength: n });
      res.end('app');
    });
  });
  const server = http.createServer((req, res) => {
    applyRemoteAddress(req);
    app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function startFastify(t: LXS): Promise<App> {
  const seen: SeenByApp[] = [];
  const app = Fastify({
    logger: false,
    serverFactory: (handler) =>
      http.createServer((req, res) => {
        applyRemoteAddress(req);
        handler(req, res);
      }),
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1 << 20 }, (_req, body, done) =>
    done(null, body),
  );
  await app.register(t.fastify());
  app.setNotFoundHandler(async (request, reply) => {
    const body = request.body as Buffer | undefined;
    seen.push({
      method: request.method,
      url: request.raw.url ?? '',
      headers: { ...request.headers },
      bodyLength: body?.length ?? 0,
    });
    return reply.send('app');
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    port: (app.server.address() as net.AddressInfo).port,
    seen,
    close: () => app.close(),
  };
}

/** Writes the request byte-for-byte (duplicate headers, odd targets) and returns the status code. */
function send(port: number, v: Vector): Promise<number> {
  const r = v.request;
  const body =
    r.bodyBytes !== undefined
      ? Buffer.alloc(r.bodyBytes, 'a')
      : r.body !== undefined
        ? Buffer.from(r.body, 'utf8')
        : null;
  const lines = [`${r.method} ${r.target} HTTP/1.1`];
  if (!r.headers.some(([k]) => k.toLowerCase() === 'host')) lines.push('Host: conformance.test');
  for (const [k, val] of r.headers) lines.push(`${k}: ${val}`);
  lines.push(`${REMOTE_HEADER}: ${r.remoteAddress}`);
  lines.push('Connection: close');
  if (body) lines.push(`Content-Length: ${body.length}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');

  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let status: number | null = null;
    const finish = (err?: Error): void => {
      if (status !== null) resolve(status);
      else reject(err ?? new Error(`no HTTP status line in response: ${JSON.stringify(buf)}`));
    };
    sock.setEncoding('latin1');
    sock.on('data', (d: string) => {
      buf += d;
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m && status === null) status = Number(m[1]);
    });
    sock.on('end', () => finish());
    sock.on('close', () => finish());
    sock.on('error', (e) => finish(e)); // a reset after a 413 is fine once the status arrived
    sock.write(body ? Buffer.concat([head, body]) : head);
  });
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the first policy poll');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const quietLogger = { warn: () => undefined, error: () => undefined };

function buildLXS(v: Vector, runDir: string): LXS {
  const t = new LXS({
    runDir,
    mode: v.config.mode,
    trustProxy: v.config.trustProxy,
    allowlist: v.config.allowlist,
    logger: quietLogger,
  });
  for (const d of v.config.decoys) {
    const p = d.path as `/${string}`;
    if (d.prefix) t.create('web-admin', p, { id: d.id });
    else t.create('web-bait', p, { id: d.id, template: 'dotenv' });
  }
  return t;
}

function checkHeaders(
  where: string,
  actual: http.IncomingHttpHeaders,
  expected: HeaderAssertions | undefined,
  problems: string[],
): void {
  for (const [name, want] of Object.entries(expected ?? {})) {
    const got = actual[name];
    const text = Array.isArray(got) ? got.join(', ') : got;
    if (want === null) {
      if (got !== undefined) problems.push(`${where} header ${name}: expected absent, got ${text}`);
    } else if (want === true) {
      if (text === undefined || text === '')
        problems.push(`${where} header ${name}: expected present`);
    } else if (text !== want) {
      problems.push(
        `${where} header ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(text)}`,
      );
    }
  }
}

/** Runs one vector against one framework; returns a list of mismatches (empty = pass). */
export async function runVector(v: Vector, framework: Framework): Promise<string[]> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-conf-'));
  const agent: FakeAgent = await startFakeAgent({
    runDir,
    fakeDecoy: true,
    blocklist: v.policy.blocklist,
    allowlist: v.policy.allowlist,
  });
  const t = buildLXS(v, runDir);
  let app: App | null = null;
  try {
    app = framework === 'express' ? await startExpress(t) : await startFastify(t);
    await waitFor(() => agent.policyServed > 0, 3000);
    await new Promise((r) => setTimeout(r, 30)); // let the client side parse and apply it

    const status = await send(app.port, v);
    // The app or decoy records the request before answering, but give stragglers a tick.
    await new Promise((r) => setImmediate(r));

    const problems: string[] = [];
    const e = v.expect;
    const appHits = app.seen.length;
    const decoyHits = agent.decoyRequests.length;
    if (e.frameworkMayReject && status === 400 && appHits === 0 && decoyHits === 0) return [];
    if (e.outcome === 'pass_through') {
      if (appHits !== 1 || decoyHits !== 0 || status !== 200) {
        problems.push(
          `expected pass_through, got status ${status} (app hits ${appHits}, decoy hits ${decoyHits})`,
        );
      } else checkHeaders('app', (app.seen[0] as SeenByApp).headers, e.app?.headers, problems);
    } else if (e.outcome === 'decoy') {
      const d = agent.decoyRequests[0];
      if (!d || appHits !== 0 || decoyHits !== 1 || status !== 200) {
        problems.push(
          `expected decoy, got status ${status} (app hits ${appHits}, decoy hits ${decoyHits})`,
        );
      } else {
        const want = e.decoy;
        if (!want) throw new Error(`${v.name}: decoy outcome without expect.decoy`);
        checkHeaders(
          'decoy',
          d.headers,
          {
            'x-ds-decoy-id': want.id,
            'x-ds-client-ip': want.clientIp,
            'x-ds-request-id': true,
            ...want.headers,
          },
          problems,
        );
        if (want.method !== undefined && d.method !== want.method)
          problems.push(`decoy method: expected ${want.method}, got ${d.method}`);
        if (want.target !== undefined && d.url !== want.target)
          problems.push(`decoy target: expected ${want.target}, got ${d.url}`);
      }
    } else if (status !== e.status || appHits !== 0 || decoyHits !== 0) {
      problems.push(
        `expected blocked ${e.status}, got status ${status} (app hits ${appHits}, decoy hits ${decoyHits})`,
      );
    }
    return problems;
  } finally {
    t.close();
    await app?.close();
    await agent.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}
