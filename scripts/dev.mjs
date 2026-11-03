#!/usr/bin/env node
// Dev orchestrator: boots everything a developer needs with one command.
//
//   node scripts/dev.mjs            platform (Postgres) + API + dashboard
//   node scripts/dev.mjs --no-db    assume Postgres is already up
//   node scripts/dev.mjs --attacker also start the attacker demo console
//
// The dashboard and attacker-demo are standalone npm projects outside the pnpm
// workspace, so they are spawned directly rather than through turbo.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// Strip pnpm-specific configs so spawned npm instances do not emit "Unknown env config" warnings
const npmEnv = { ...process.env };
for (const key of [
  'npm_config_npm_globalconfig',
  'npm_config_verify_deps_before_run',
  'npm_config_auto_install_peers',
  'npm_config__jsr_registry',
]) {
  delete npmEnv[key];
}

const children = [];
const palette = ['36', '35', '33', '32', '34'];

function ensureDeps(name, cwd) {
  if (!existsSync(cwd)) return;
  if (!existsSync(join(cwd, 'node_modules'))) {
    console.log(`\x1b[90m> installing dependencies for ${name}...\x1b[0m`);
    const r = spawnSync(npm, ['install'], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: npmEnv,
    });
    if (r.status !== 0) {
      console.log(`\x1b[33m! npm install failed for ${name}. Continuing anyway.\x1b[0m`);
    }
  }
}

function start(name, cmd, cmdArgs, cwd, env = process.env) {
  if (!existsSync(cwd)) {
    console.log(`\x1b[90m- skipping ${name}: ${cwd} does not exist yet\x1b[0m`);
    return;
  }
  const colour = palette[children.length % palette.length];
  const child = spawn(cmd, cmdArgs, { cwd, shell: process.platform === 'win32', env });
  const tag = `\x1b[${colour}m[${name}]\x1b[0m`;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag} exited with ${code}`));
  children.push(child);
}

if (!args.has('--no-db')) {
  const compose = join(root, 'infra/platform/docker-compose.platform.yml');
  if (existsSync(compose)) {
    console.log('\x1b[90m> starting Postgres\x1b[0m');
    const r = spawnSync('docker', ['compose', '-f', compose, 'up', '-d', 'postgres'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) {
      console.log('\x1b[33m! Postgres did not start. Is Docker running? Continuing anyway.\x1b[0m');
    }
    // Ensure containerized API is stopped so local API can bind to port 8080
    spawnSync('docker', ['compose', '-f', compose, 'stop', 'api'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
}

ensureDeps('dashboard', join(root, 'apps/dashboard'));
start('api', pnpm, ['--filter', '@lxs/api', 'dev'], root);
start('dashboard', npm, ['run', 'dev'], join(root, 'apps/dashboard'), npmEnv);

if (args.has('--attacker')) {
  ensureDeps('attacker-api', join(root, 'attacker-demo/attacker-api'));
  ensureDeps('attacker-web', join(root, 'attacker-demo/attacker-web'));
  start('attacker-api', npm, ['start'], join(root, 'attacker-demo/attacker-api'), npmEnv);
  start('attacker-web', npm, ['run', 'dev'], join(root, 'attacker-demo/attacker-web'), npmEnv);
}

console.log(`
\x1b[1mLXS dev\x1b[0m
  API        http://localhost:8080   (/healthz)
  Dashboard  http://localhost:3000
${args.has('--attacker') ? '  Attacker   http://localhost:3002   (api :6060)\n' : ''}  Ctrl-C to stop everything.
`);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) c.kill();
    setTimeout(() => process.exit(0), 500);
  });
}
