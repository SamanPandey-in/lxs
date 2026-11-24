// In-process cost of the Node middleware on a non-decoy route (the counterpart of
// conformance/bench/go BenchmarkWithLXS): calls the Express middleware directly on a minimal
// request object, no network. Prints ns per call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { LXS } = await import(new URL(`file:///${path.join(root, 'sdk/lxs/dist/index.js')}`).href);
const { startFakeAgent } = await import(
  new URL(`file:///${path.join(root, 'sdk/lxs/dist/testing.js')}`).href
);

const blocklist = [];
for (let i = 0; i < 1000; i++) blocklist.push(`198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`);
for (let i = 0; i < 50; i++) blocklist.push(`100.64.${i}.0/24`);
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-bench-'));
const agent = await startFakeAgent({
  runDir,
  blocklist,
  allowlist: ['192.0.2.0/24', '2001:db8::/32'],
});
const t = new LXS({ runDir, logger: { warn() {}, error() {} } });
t.create('web-admin', '/admin');
t.create('web-bait', '/.env');
const mw = t.express();
while (agent.policyServed === 0) await new Promise((r) => setTimeout(r, 5));
await new Promise((r) => setTimeout(r, 30));

const socket = { remoteAddress: '203.0.113.7' };
const res = {};
const mkReq = () => ({
  method: 'GET',
  url: '/api/products?page=2',
  socket,
  headers: { host: 'bench', 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
  rawHeaders: ['Host', 'bench', 'User-Agent', 'Mozilla/5.0', 'Accept', 'application/json'],
});
const noop = () => {};
const time = (fn, n) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  return Number(process.hrtime.bigint() - t0) / n;
};
const N = 2_000_000;
time(() => mkReq(), N); // warm up
time(() => mw(mkReq(), res, noop), N);
const base = time(() => mkReq(), N);
const withMw = time(() => mw(mkReq(), res, noop), N);
console.log(JSON.stringify({ baseline_ns: base, with_lxs_ns: withMw, overhead_ns: withMw - base }));
t.close();
await agent.close();
fs.rmSync(runDir, { recursive: true, force: true });
