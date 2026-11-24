// Serves the benchmark app twice with Express: bare and behind the LXS middleware (the built
// sdk/lxs/dist). Prints "ready <bareAddr> <lxsAddr>" and runs until killed. Uses the same policy
// and decoys as conformance/bench/go/setup.go. Needs `pnpm install` and `pnpm --filter ./sdk/lxs build`.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
// Express is a dependency of the Node conformance runner; resolve it from there.
const require = createRequire(path.join(root, 'conformance/runners/node/package.json'));
const express = require('express');
const { LXS } = await import(new URL(`file:///${path.join(root, 'sdk/lxs/dist/index.js')}`).href);
const { startFakeAgent } = await import(
  new URL(`file:///${path.join(root, 'sdk/lxs/dist/testing.js')}`).href
);

const blocklist = [];
for (let i = 0; i < 1000; i++) blocklist.push(`198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`);
for (let i = 0; i < 50; i++) blocklist.push(`100.64.${i}.0/24`);
const allowlist = ['192.0.2.0/24', '2001:db8::/32'];

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-bench-'));
const agent = await startFakeAgent({ runDir, fakeDecoy: true, blocklist, allowlist });
const t = new LXS({ runDir, logger: { warn() {}, error() {} } });
t.create('web-admin', '/admin');
t.create('web-bait', '/.env');

const handler = (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"products":[{"id":1,"name":"widget"}],"page":2}');
};

const listen = (app) =>
  new Promise((resolve) => {
    const s = http.createServer(app);
    s.keepAliveTimeout = 60_000;
    s.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${s.address().port}`));
  });

const bare = express();
bare.get('/api/products', handler);
const withLxs = express();
withLxs.use(t.express());
withLxs.get('/api/products', handler);

while (agent.policyServed === 0) await new Promise((r) => setTimeout(r, 5));
console.log(`ready ${await listen(bare)} ${await listen(withLxs)}`);

const stop = async () => {
  t.close();
  await agent.close();
  fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
