#!/usr/bin/env node
/**
 * demo.mjs — brings the whole LXS demo up, in order, and checks each step.
 *
 *   node scripts/demo.mjs up        build images, start everything, verify the chain
 *   node scripts/demo.mjs status    what is running and healthy
 *   node scripts/demo.mjs down      stop the containers
 *
 * Flags for `up`:
 *   --dev           serve the dashboard with `next dev` (hot reload, 5-20x slower)
 *   --no-images     skip the Docker image build (they are already built)
 *   --no-sensors    platform + dashboard only, no decoy containers
 *   --no-attacker   skip the attacker console
 *
 * The decoy containers need Docker. Everything else runs on the host.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'examples/acme-shop');
const PLATFORM_COMPOSE = join(ROOT, 'infra/platform/docker-compose.platform.yml');
const API = process.env.API_URL ?? 'http://localhost:8080';
const DEV_KEY = 'ds_dev_0000000000000000000000000000000000000000';
const WIN = process.platform === 'win32';
const npm = WIN ? 'npm.cmd' : 'npm';
const pnpm = WIN ? 'pnpm.cmd' : 'pnpm';

const cmd = process.argv[2] ?? 'up';
const flags = new Set(process.argv.slice(3));

const C = {
  dim: '\x1b[90m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  bad: '\x1b[31m',
  b: '\x1b[1m',
  r: '\x1b[0m',
};
const step = (s) => console.log(`\n${C.b}> ${s}${C.r}`);
const ok = (s) => console.log(`  ${C.ok}OK${C.r}   ${s}`);
const warn = (s) => console.log(`  ${C.warn}WARN${C.r} ${s}`);
const fail = (s) => console.log(`  ${C.bad}FAIL${C.r} ${s}`);
const note = (s) => console.log(`  ${C.dim}${s}${C.r}`);

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, {
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: WIN,
    encoding: 'utf8',
    ...opts,
  });
}

function detach(name, bin, args, cwd, env) {
  const child = spawn(bin, args, {
    cwd,
    shell: WIN,
    detached: !WIN,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  note(`${name} started (pid ${child.pid})`);
}

async function waitFor(label, check, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) {
      ok(`${label} (after ${i}s)`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} did not come up within ${seconds}s`);
  return false;
}

const httpOk = (url, init) =>
  fetch(url, { signal: AbortSignal.timeout(2000), ...init })
    .then((r) => r.ok)
    .catch(() => false);

const auth = { headers: { authorization: `Bearer ${DEV_KEY}` } };

const dockerUp = () => run('docker', ['info'], { quiet: true }).status === 0;

/**
 * Environment for the dashboard. LXS_* are read per request by app/api/config/route.js,
 * so they work the same whether the build happened here or on a CI box. The
 * NEXT_PUBLIC_* twins are the pre-boot defaults baked into the bundle.
 */
const dashEnv = (projectId) => ({
  LXS_API_URL: API,
  LXS_PROJECT_ID: projectId,
  NEXT_PUBLIC_API_URL: API,
});

/** True when the Postgres container actually publishes 5432 to the host. */
function hostPortBound() {
  const r = run('docker', ['compose', '-f', PLATFORM_COMPOSE, 'port', 'postgres', '5432'], {
    quiet: true,
  });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

async function resolveProject() {
  if (process.env.LXS_PROJECT_ID) return process.env.LXS_PROJECT_ID;
  const r = await fetch(`${API}/v1/projects`, auth).catch(() => null);
  if (!r?.ok) return null;
  const body = await r.json();
  const list = body.items ?? body.projects ?? [];
  return (list.find((p) => p.slug === 'acme-shop') ?? list[0])?.id ?? null;
}

// ------------------------------------------------------------------ up

async function up() {
  console.log(`${C.b}LXS demo${C.r}`);

  step('Checking Docker');
  if (!dockerUp()) {
    fail('Docker is not running. Start Docker Desktop, then re-run.');
    process.exit(1);
  }
  ok('docker daemon reachable');

  step('Starting Postgres');
  run('docker', ['compose', '-f', PLATFORM_COMPOSE, 'up', '-d', 'postgres']);
  // Readiness means "reachable from the host on the published port", not just
  // "the container is running". A container that lost its port binding (a stale
  // stack held 5432 when it first started) is healthy inside and useless outside,
  // so check the binding and recreate once if it is missing.
  const pgUser = process.env.POSTGRES_USER ?? 'lxs';
  const pgReachable = () =>
    run(
      'docker',
      ['compose', '-f', PLATFORM_COMPOSE, 'exec', '-T', 'postgres', 'pg_isready', '-U', pgUser],
      {
        quiet: true,
      },
    ).status === 0 && hostPortBound();
  if (!(await waitFor('Postgres accepting connections', async () => pgReachable(), 45))) {
    warn('recreating the Postgres container (its host port is probably not published)');
    run('docker', ['compose', '-f', PLATFORM_COMPOSE, 'up', '-d', '--force-recreate', 'postgres']);
    if (!(await waitFor('Postgres accepting connections', async () => pgReachable(), 60))) {
      fail('Postgres never became reachable on 5432 — is another container holding the port?');
      note('check: docker ps --filter publish=5432');
      process.exit(1);
    }
  }

  step('Migrating and seeding');
  if (!existsSync(join(ROOT, '.env'))) {
    writeFileSync(join(ROOT, '.env'), readFileSync(join(ROOT, '.env.example'), 'utf8'));
    note('.env created from .env.example');
  }
  run(pnpm, ['--filter', '@lxs/api', 'db:migrate'], { cwd: ROOT });
  run(pnpm, ['--filter', '@lxs/api', 'db:seed'], { cwd: ROOT });

  step('Starting the platform API');
  if (!(await httpOk(`${API}/healthz`))) {
    detach('api', pnpm, ['--filter', '@lxs/api', 'dev'], ROOT);
  }
  if (!(await waitFor(`API ready at ${API}`, () => httpOk(`${API}/readyz`), 60))) process.exit(1);

  const projectId = await resolveProject();
  if (!projectId) {
    fail('could not resolve the acme-shop project — did the seed run?');
    process.exit(1);
  }
  ok(`project acme-shop = ${projectId}`);

  // The dashboard is served from a PRODUCTION build by default. `next dev` compiles
  // each route the first time it is opened, which costs 0.6-2.6 s per screen — in
  // front of whoever is watching. Production serves the same screens in 120-290 ms.
  // Pass --dev when you are actually editing the dashboard and want hot reload.
  const dashDir = join(ROOT, 'apps/dashboard');
  const devMode = flags.has('--dev');

  if (!(await httpOk('http://localhost:3000'))) {
    if (devMode) {
      step('Starting the SOC dashboard (dev mode — slower, hot reload)');
      detach('dashboard', npm, ['run', 'dev'], dashDir, dashEnv(projectId));
    } else {
      step('Building the SOC dashboard');
      if (!existsSync(join(dashDir, 'node_modules'))) {
        note('npm install in apps/dashboard');
        run(npm, ['install'], { cwd: dashDir, quiet: true });
      }
      if (
        run(npm, ['run', 'build'], { cwd: dashDir, env: { ...process.env, ...dashEnv(projectId) } })
          .status !== 0
      ) {
        fail('dashboard build failed — falling back to dev mode');
        detach('dashboard', npm, ['run', 'dev'], dashDir, dashEnv(projectId));
      } else {
        ok('production build ready');
        step('Starting the SOC dashboard');
        detach('dashboard', npm, ['run', 'start'], dashDir, dashEnv(projectId));
      }
    }
  } else {
    step('Starting the SOC dashboard');
    note('something is already serving :3000 — leaving it alone');
  }
  await waitFor('Dashboard at http://localhost:3000', () => httpOk('http://localhost:3000'), 180);

  if (!flags.has('--no-sensors')) await sensors(projectId);
  if (!flags.has('--no-attacker')) await attacker();

  banner(projectId);
}

// ------------------------------------------------------------- sensors

async function sensors(projectId) {
  step('Building the decoy images');
  if (flags.has('--no-images')) {
    note('skipped (--no-images)');
  } else {
    const images = [
      ['images/agent.Dockerfile', 'lxs/agent:0.1.0'],
      ['images/decoy-web.Dockerfile', 'lxs/decoy-web:0.1.0'],
      ['images/cowrie-personas.Dockerfile', 'lxs/cowrie-personas:0.1.0'],
    ];
    for (const [file, tag] of images) {
      note(`building ${tag}`);
      if (run('docker', ['build', '-f', file, '-t', tag, '.'], { cwd: ROOT }).status !== 0) {
        fail(`image build failed: ${tag}`);
        note('the platform and dashboard are still up — drive the demo with `pnpm demo:simulate`');
        return;
      }
    }
    ok('three images built');
  }

  step('Generating the decoy stack from decoy.config.ts');
  const envFile = join(EXAMPLE, '.env.lxs');
  if (existsSync(envFile)) {
    note('.env.lxs already exists, left alone');
  } else {
    writeFileSync(
      envFile,
      '# generated by scripts/demo.mjs — DEV ONLY\n' +
        `LXS_INGEST_KEY=${DEV_KEY}\n` +
        // From inside a container, the host API is host.docker.internal on Docker Desktop.
        `LXS_ENDPOINT=${process.env.LXS_ENDPOINT ?? 'http://host.docker.internal:8080'}\n`,
    );
    ok('.env.lxs written with the dev key');
  }
  if (run('npx', ['lxs', 'build'], { cwd: EXAMPLE }).status !== 0) {
    fail('`lxs build` failed');
    return;
  }

  step('Starting the shop app and its decoys');
  const composeEnv = {
    ...process.env,
    // Local demo only: lets the attacker console choose its source IP.
    // The SDK refuses to honour it when NODE_ENV=production.
    DS_DEV_SIM: '1',
    LXS_AGENT_IMAGE: 'lxs/agent:0.1.0',
    LXS_WEB_IMAGE: 'lxs/decoy-web:0.1.0',
    LXS_COWRIE_IMAGE: 'lxs/cowrie-personas:0.1.0',
  };
  const r = run(
    'docker',
    ['compose', '-f', 'docker-compose.yml', '-f', 'lxs.compose.yml', 'up', '-d', '--build'],
    { cwd: EXAMPLE, env: composeEnv },
  );
  if (r.status !== 0) {
    fail('the decoy stack did not start — see the compose output above');
    note('the platform and dashboard are still up — drive the demo with `pnpm demo:simulate`');
    return;
  }
  await waitFor('Shop app at http://localhost:3001', () => httpOk('http://localhost:3001'), 90);

  step('Thin-slice check: does a decoy hit reach the platform?');
  await fetch('http://localhost:3001/.env').catch(() => {});
  const landed = await waitFor(
    'decoy event stored',
    async () => {
      const res = await fetch(`${API}/v1/projects/${projectId}/events?limit=10`, auth).catch(
        () => null,
      );
      if (!res?.ok) return false;
      const body = await res.json();
      return (body.items ?? []).some((e) => e.is_decoy);
    },
    45,
  );
  if (!landed) {
    warn('no decoy event arrived — check `docker compose logs ds-agent` in examples/acme-shop');
  }
}

// ------------------------------------------------------------ attacker

async function attacker() {
  step('Starting the attacker console');
  const api = join(ROOT, 'attacker-demo/attacker-api');
  const web = join(ROOT, 'attacker-demo/attacker-web');

  for (const dir of [api, web]) {
    if (!existsSync(join(dir, 'node_modules'))) {
      note(`npm install in ${dir.replace(ROOT, '.')}`);
      run(npm, ['install'], { cwd: dir, quiet: true });
    }
  }

  if (!(await httpOk('http://localhost:6060/health'))) {
    detach('attacker-api', npm, ['start'], api, {
      ATTACK_MODE: 'live',
      TARGET_APP_URL: 'http://localhost:3001',
      TARGET_SSH_HOST: 'localhost',
      TARGET_SSH_PORT: '22',
      ALLOW_TARGETS: 'localhost,127.0.0.1',
      PLATFORM_URL: API,
      PLATFORM_KEY: DEV_KEY,
    });
  }
  await waitFor(
    'attacker-api at http://localhost:6060',
    () => httpOk('http://localhost:6060/health'),
    45,
  );

  if (!(await httpOk('http://localhost:3002'))) {
    detach('attacker-web', npm, ['run', 'dev'], web, {
      NEXT_PUBLIC_ATTACKER_API_URL: 'http://localhost:6060',
    });
  }
  await waitFor(
    'attacker console at http://localhost:3002',
    () => httpOk('http://localhost:3002'),
    120,
  );
}

// -------------------------------------------------------------- status

async function status() {
  console.log(`${C.b}LXS demo — status${C.r}\n`);
  const checks = [
    [
      'Postgres',
      async () =>
        (
          run('docker', ['compose', '-f', PLATFORM_COMPOSE, 'ps', '-q', 'postgres'], {
            quiet: true,
          }).stdout ?? ''
        ).trim().length > 0,
    ],
    ['Platform API       :8080', () => httpOk(`${API}/readyz`)],
    ['SOC dashboard      :3000', () => httpOk('http://localhost:3000')],
    ['Shop app + decoys  :3001', () => httpOk('http://localhost:3001')],
    ['Attacker API       :6060', () => httpOk('http://localhost:6060/health')],
    ['Attacker console   :3002', () => httpOk('http://localhost:3002')],
  ];
  for (const [label, check] of checks) {
    if (await check()) ok(label);
    else warn(`${label} — not running`);
  }

  const pid = await resolveProject();
  if (!pid) return;
  const r = await fetch(`${API}/v1/projects/${pid}/incidents?limit=100`, auth).catch(() => null);
  if (!r?.ok) return;
  const items = (await r.json()).items ?? [];
  const by = (s) => items.filter((i) => i.severity === s).length;
  console.log(
    `\n  incidents: ${items.length} total · ${by('critical')} critical · ${by('high')} high · ` +
      `${by('medium')} medium · ${by('low')} low`,
  );
}

// ---------------------------------------------------------------- down

function down() {
  step('Stopping the decoy stack');
  run('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'lxs.compose.yml', 'down'], {
    cwd: EXAMPLE,
  });
  step('Stopping Postgres');
  run('docker', ['compose', '-f', PLATFORM_COMPOSE, 'down']);
  note(
    'The API, dashboard and attacker console were started detached — close their windows or kill those node processes.',
  );
}

function banner(projectId) {
  console.log(`
${C.b}Everything is up.${C.r}

  SOC dashboard       ${C.b}http://localhost:3000${C.r}
  Attacker console    ${C.b}http://localhost:3002${C.r}
  Shop (the real app) http://localhost:3001
  Platform API        ${API}   ·  project ${projectId}

${C.b}The three-beat demo${C.r}  (docs/DEMO-SCRIPT.md has the words)
  1. Attacker console -> Run ${C.b}noise${C.r}         dashboard labels it Noise, suppressed, nobody paged
  2. Attacker console -> Run ${C.b}ps-attacker${C.r}   one incident climbs Low -> ... -> CRITICAL
  3. Dashboard -> ${C.b}Block source${C.r}             the next attacker request is refused

  No containers? Drive the same chain from the simulator:
    ${C.b}pnpm demo:simulate${C.r}
`);
}

switch (cmd) {
  case 'up':
    await up();
    break;
  case 'status':
    await status();
    break;
  case 'down':
    down();
    break;
  default:
    console.log('usage: node scripts/demo.mjs [up|status|down]');
    process.exit(2);
}
