// The demo's most visible latency: an attack chain arrives, how long until the
// incident has settled on its final score? This is the "score climbing" moment.
const API = 'http://localhost:8080';
const KEY = 'ds_dev_0000000000000000000000000000000000000000';
const PID = process.argv[2];
const auth = { headers: { authorization: `Bearer ${KEY}` } };

const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from({ length: 26 }, () => A[(Math.random() * 32) | 0]).join('');

const ip = `203.0.113.${150 + ((Math.random() * 50) | 0)}`;
const base = {
  schema_version: 1,
  sensor: 'ssh',
  decoy_id: 'ssh-db-backup-01',
  is_decoy: true,
  session_id: `burst:${ip}`,
  src_ip: ip,
  src_port: 51544,
  dst_service: 'ssh:22',
  count: 1,
  simulated: true,
};
const ev = (event_type, extra = {}) => ({
  ...base,
  id: ulid(),
  timestamp: new Date().toISOString(),
  event_type,
  ...extra,
});

// The ps-attacker chain, delivered as one burst (what a replay or a fast attacker looks like).
const events = [
  ev('connection.open'),
  ev('ssh.client', { client_banner: 'SSH-2.0-OpenSSH_9.6p1' }),
  ...[1, 2, 3, 4, 5].map(() =>
    ev('auth.attempt', { outcome: 'failure', username: 'root', password_clear: 'root' }),
  ),
  ev('auth.attempt', { outcome: 'success', username: 'admin', password_clear: 'admin' }),
  ev('command.exec', { command: 'ls -la', outcome: 'success' }),
  ev('command.exec', { command: 'uname -a', outcome: 'success' }),
  ev('command.exec', { command: 'cat /srv/exports/customer_data.csv', outcome: 'success' }),
  ev('asset.access', {
    is_decoy: false,
    sensor: 'sdk',
    dst_service: 'app:/api/payments',
    asset_name: 'Payments API',
  }),
];

const t0 = performance.now();
const r = await fetch(`${API}/v1/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ events }),
});
console.log(
  `ingest ${r.status} in ${(performance.now() - t0).toFixed(0)} ms (${events.length} events)`,
);

let last = null;
let settledAt = null;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const res = await fetch(`${API}/v1/projects/${PID}/incidents?limit=50`, auth);
  if (res.ok) {
    const hit = ((await res.json()).items ?? []).find((i) => i.src_ip === ip);
    if (hit) {
      const sig = `${hit.score}/${hit.severity}/${hit.event_count}`;
      if (sig !== last) {
        console.log(
          `  +${(performance.now() - t0).toFixed(0).padStart(6)} ms  score ${String(hit.score).padStart(3)}  ` +
            `${hit.severity.padEnd(8)} ${hit.event_count} events`,
        );
        last = sig;
        settledAt = performance.now();
      } else if (settledAt && performance.now() - settledAt > 6000) break;
    }
  }
  await new Promise((r) => setTimeout(r, 120));
}
console.log(`\nsettled ${((settledAt - t0) / 1000).toFixed(2)} s after ingest`);
