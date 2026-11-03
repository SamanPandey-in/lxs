// Measure API read latency (p50/p95) and end-to-end detection latency.
const API = 'http://localhost:8080';
const KEY = 'ds_dev_0000000000000000000000000000000000000000';
const PID = process.argv[2];
const auth = { headers: { authorization: `Bearer ${KEY}` } };

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function timeIt(url, n = 12) {
  const ms = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await fetch(url, auth);
    const body = await r.text();
    ms.push(performance.now() - t);
    bytes = body.length;
    if (!r.ok) return { err: r.status };
  }
  return { p50: pct(ms, 50), p95: pct(ms, 95), max: Math.max(...ms), kb: bytes / 1024 };
}

const endpoints = [
  ['healthz', `${API}/healthz`],
  ['overview', `${API}/v1/projects/${PID}/overview`],
  ['incidents?limit=25', `${API}/v1/projects/${PID}/incidents?limit=25`],
  ['events?limit=50', `${API}/v1/projects/${PID}/events?limit=50`],
  ['events?limit=200', `${API}/v1/projects/${PID}/events?limit=200`],
  ['attackers', `${API}/v1/projects/${PID}/attackers`],
  ['decoys', `${API}/v1/projects/${PID}/decoys`],
  ['attack-matrix', `${API}/v1/projects/${PID}/attack-matrix`],
  ['audit?limit=50', `${API}/v1/projects/${PID}/audit?limit=50`],
  ['agent/policy', `${API}/v1/agent/policy`],
];

console.log('endpoint                 p50       p95       max      size');
console.log('------------------------------------------------------------');
for (const [name, url] of endpoints) {
  const r = await timeIt(url);
  if (r.err) {
    console.log(`${name.padEnd(22)} HTTP ${r.err}`);
    continue;
  }
  const flag = r.p95 > 300 ? '  <-- SLOW' : r.p95 > 120 ? '  <-- warm' : '';
  console.log(
    `${name.padEnd(22)} ${r.p50.toFixed(0).padStart(6)}ms ${r.p95.toFixed(0).padStart(7)}ms ` +
      `${r.max.toFixed(0).padStart(7)}ms ${r.kb.toFixed(0).padStart(6)}kb${flag}`,
  );
}

// ---- end-to-end: how long from POST /v1/ingest to the incident reflecting it?
function ulid() {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  for (let i = 0; i < 26; i++) s += A[Math.floor(Math.random() * 32)];
  return s;
}

const srcIp = `198.51.100.${40 + Math.floor(Math.random() * 100)}`;
const ev = (type, extra = {}) => ({
  id: ulid(),
  schema_version: 1,
  timestamp: new Date().toISOString(),
  sensor: 'ssh',
  decoy_id: 'ssh-db-backup-01',
  is_decoy: true,
  session_id: `perf:${srcIp}`,
  src_ip: srcIp,
  src_port: 51544,
  dst_service: 'ssh:22',
  event_type: type,
  count: 1,
  simulated: true,
  ...extra,
});

console.log('\nend-to-end detection latency (ingest -> incident visible)');
const t0 = performance.now();
const res = await fetch(`${API}/v1/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    events: [
      ev('connection.open'),
      ev('auth.attempt', { outcome: 'failure', username: 'root', password_clear: 'root' }),
      ev('auth.attempt', { outcome: 'success', username: 'admin', password_clear: 'admin' }),
      ev('command.exec', { command: 'ls -la', outcome: 'success' }),
    ],
  }),
});
const ingestMs = performance.now() - t0;
console.log(`  POST /v1/ingest returned ${res.status} in ${ingestMs.toFixed(0)} ms`);

let found = null;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const r = await fetch(`${API}/v1/projects/${PID}/incidents?limit=50`, auth);
  if (r.ok) {
    const items = (await r.json()).items ?? [];
    const hit = items.find((i) => i.src_ip === srcIp);
    if (hit) {
      found = { ms: performance.now() - t0, inc: hit };
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 100));
}

if (found) {
  console.log(
    `  incident visible after ${found.ms.toFixed(0)} ms ` +
      `(score ${found.inc.score}, ${found.inc.event_count} events)`,
  );
} else {
  console.log('  incident never appeared within 60 s');
}
