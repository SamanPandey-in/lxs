import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDecoys, loadHoneytokens } from './config.js';
import { JsonlLogger } from './log.js';
import { buildServer } from './server.js';

/**
 * ds-web entry point. Listens on a Unix socket ONLY (a named pipe on Windows for local development).
 * There is no TCP listener, no outbound connection and no child process anywhere in this program.
 */
function defaultSocket(): string {
  const runDir = process.env.LXS_RUN_DIR ?? '/run/lxs';
  if (process.platform === 'win32') {
    const h = createHash('sha1').update(runDir).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\lxs-${h}-web`;
  }
  return `${runDir}/web/web.sock`;
}

async function main(): Promise<void> {
  const socketPath = process.env.DS_WEB_SOCKET ?? defaultSocket();
  const configPath = process.env.DS_WEB_CONFIG ?? '/etc/lxs/web-decoys.json';
  const tokensPath = process.env.DS_WEB_HONEYTOKENS ?? '/etc/lxs/honeytokens.json';
  const logDir = process.env.DS_WEB_LOG_DIR ?? '/var/log/lxs';

  const decoys = loadDecoys(configPath);
  const honeytokens = loadHoneytokens(tokensPath);
  const logger = new JsonlLogger({ dir: logDir });
  const app = buildServer({ decoys, honeytokens, logger });

  if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true }); // stale socket from a previous run
  await app.listen({ path: socketPath });
  // Only containers that mount the socket volume can reach it; they run as arbitrary uids, so 0666.
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o666);

  const addr = app.server.address();
  if (addr !== null && typeof addr !== 'string') {
    throw new Error('ds-web refused to start: a TCP listener is not allowed');
  }

  logger.write({
    ts: new Date().toISOString(),
    decoy_id: '-',
    kind: 'start',
    ip: '0.0.0.0',
    method: '-',
    path: path.basename(socketPath),
    req_id: '-',
  });

  const stop = (): void => {
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  // stderr goes to the container log driver, never to the network.
  process.stderr.write(`ds-web: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
