import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Signal } from './middleware/core.js';
import { agentSocketPath, webSocketPath } from './socket.js';

export interface FakeAgentOptions {
  /** Directory that will contain web/ and agent/ socket dirs. Pass it as `runDir` to LXS. */
  runDir: string;
  blocklist?: string[];
  watchlist?: string[];
  allowlist?: string[];
  /** sha256(token) -> honeytoken id */
  honeytokens?: Record<string, string>;
  /** Also start a fake decoy on the web socket that answers 200 and echoes the headers it received. */
  fakeDecoy?: boolean;
}

export interface FakeAgent {
  runDir: string;
  /** Signals the middleware posted. */
  signals: Signal[];
  /** Request headers each decoy request arrived with (to assert Cookie/Authorization are stripped). */
  decoyRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  setPolicy(
    p: Partial<Pick<FakeAgentOptions, 'blocklist' | 'watchlist' | 'allowlist' | 'honeytokens'>>,
  ): void;
  close(): Promise<void>;
}

function listen(server: http.Server, sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve());
  });
}

/**
 * A fake ds-agent (and optionally ds-web) on the same socket paths the real ones use, so app teams can
 * mount the middleware in tests and assert on what it reports.
 */
export async function startFakeAgent(opts: FakeAgentOptions): Promise<FakeAgent> {
  fs.mkdirSync(path.join(opts.runDir, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(opts.runDir, 'web'), { recursive: true });
  const agentSock = agentSocketPath(opts.runDir);
  const webSock = webSocketPath(opts.runDir);
  if (process.platform !== 'win32') {
    for (const s of [agentSock, webSock]) fs.rmSync(s, { force: true });
  }

  const policy = {
    blocklist: opts.blocklist ?? [],
    watchlist: opts.watchlist ?? [],
    allowlist: opts.allowlist ?? [],
    honeytokens: opts.honeytokens ?? {},
  };
  let version = 1;
  const signals: Signal[] = [];
  const decoyRequests: FakeAgent['decoyRequests'] = [];

  const agent = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/policy') {
      const etag = `"pv-${version}"`;
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json', etag });
      return res.end(JSON.stringify({ version, ...policy }));
    }
    if (req.method === 'POST' && req.url === '/v1/signals') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { signals?: Signal[] };
          signals.push(...(body.signals ?? []));
        } catch {
          /* ignore */
        }
        res.statusCode = 202;
        res.end('{}');
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await listen(agent, agentSock);

  let decoy: http.Server | null = null;
  if (opts.fakeDecoy) {
    decoy = http.createServer((req, res) => {
      decoyRequests.push({ url: req.url ?? '', headers: req.headers });
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('decoy');
    });
    await listen(decoy, webSock);
  }

  return {
    runDir: opts.runDir,
    signals,
    decoyRequests,
    setPolicy(p) {
      Object.assign(policy, p);
      version++;
    },
    async close() {
      await new Promise<void>((r) => agent.close(() => r()));
      if (decoy) await new Promise<void>((r) => decoy?.close(() => r()));
    },
  };
}
