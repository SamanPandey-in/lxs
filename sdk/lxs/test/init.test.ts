import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runBuild } from '../src/cli/build.js';
import {
  DEFAULT_ENDPOINT,
  PLACEHOLDER_KEY,
  parseEnvFile,
  runInit,
  upsertEnv,
} from '../src/cli/init.js';
import { PRESET_NAMES, PRESETS } from '../src/presets/index.js';

const KEY = 'ds_live_0123456789abcdefABCDEF0123456789';
const quiet = () => undefined;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A project dir where `import { LXS } from 'lxs'` resolves to this checkout's source. */
function projectWithSdk(service: string): string {
  const dir = tmp('lxs-preset-');
  fs.writeFileSync(
    path.join(dir, 'docker-compose.yml'),
    `services:\n  ${service}:\n    image: ${service}\n`,
  );
  const pkg = path.join(dir, 'node_modules', 'lxs');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'lxs', type: 'module', main: 'index.mjs' }),
  );
  const src = pathToFileURL(path.resolve(import.meta.dirname, '../src/index.ts')).href;
  fs.writeFileSync(path.join(pkg, 'index.mjs'), `export * from ${JSON.stringify(src)};\n`);
  return dir;
}

const envOf = (dir: string) => parseEnvFile(fs.readFileSync(path.join(dir, '.env.lxs'), 'utf8'));

for (const name of PRESET_NAMES) {
  test(`preset ${name} builds and then passes lxs build --check`, async () => {
    const dir = projectWithSdk('web');
    await runInit({
      cwd: dir,
      service: 'web',
      preset: name,
      interactive: false,
      env: {},
      log: quiet,
    });
    const cfg = fs.readFileSync(path.join(dir, 'decoy.config.ts'), 'utf8');
    assert.match(cfg, new RegExp(`preset: ${name}`));
    assert.match(cfg, /service: 'web'/);
    assert.ok(!cfg.includes('ds_live_'), 'no key in the committed config');

    const logs: string[] = [];
    assert.equal(await runBuild({ cwd: dir, log: (m) => logs.push(m) }), 0, logs.join('\n'));
    assert.equal(await runBuild({ cwd: dir, check: true, log: quiet }), 0);
  });
}

test('every preset declares at least one web and one network decoy', () => {
  for (const name of PRESET_NAMES) {
    const text = PRESETS[name].render('app');
    assert.match(text, /t\.create\('web-(admin|bait)'/, name);
    assert.match(text, /t\.create\('(ssh|redis|postgres)', \d+/, name);
  }
});

test('init rejects an unknown preset by listing the real ones', async () => {
  await assert.rejects(
    runInit({
      cwd: tmp('lxs-init-'),
      service: 'app',
      preset: 'drupal',
      interactive: false,
      env: {},
      log: quiet,
    }),
    /E_PRESET_UNKNOWN.*shop, saas-api, wordpress/,
  );
});

test('init defaults the endpoint to the hosted URL and writes a placeholder key when non-interactive', async () => {
  const dir = tmp('lxs-init-');
  await runInit({ cwd: dir, service: 'app', interactive: false, env: {}, log: quiet });
  const env = envOf(dir);
  assert.equal(env.get('LXS_ENDPOINT'), DEFAULT_ENDPOINT);
  assert.equal(env.get('LXS_INGEST_KEY'), PLACEHOLDER_KEY);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.env\.lxs$/m);
});

test('--endpoint beats env LXS_ENDPOINT, which beats the default; trailing slashes go', async () => {
  const a = tmp('lxs-init-');
  await runInit({
    cwd: a,
    service: 'app',
    endpoint: 'https://soc.example.test/',
    interactive: false,
    env: { LXS_ENDPOINT: 'https://env.example.test' },
    log: quiet,
  });
  assert.equal(envOf(a).get('LXS_ENDPOINT'), 'https://soc.example.test');

  const b = tmp('lxs-init-');
  await runInit({
    cwd: b,
    service: 'app',
    interactive: false,
    env: { LXS_ENDPOINT: 'http://localhost:4000' },
    log: quiet,
  });
  assert.equal(envOf(b).get('LXS_ENDPOINT'), 'http://localhost:4000');

  await assert.rejects(
    runInit({
      cwd: tmp('lxs-init-'),
      service: 'app',
      endpoint: 'ftp://x',
      interactive: false,
      env: {},
      log: quiet,
    }),
    /E_ENDPOINT_INVALID/,
  );
});

test('the prompted key goes to .env.lxs only and is never logged', async () => {
  const dir = tmp('lxs-init-');
  const logs: string[] = [];
  let asked = 0;
  await runInit({
    cwd: dir,
    service: 'app',
    preset: 'shop',
    interactive: true,
    promptKey: async () => {
      asked++;
      return `  ${KEY}  `;
    },
    env: {},
    log: (m) => logs.push(m),
  });
  assert.equal(asked, 1);
  assert.equal(envOf(dir).get('LXS_INGEST_KEY'), KEY);
  assert.ok(!logs.join('\n').includes(KEY), 'key leaked into the log');
  assert.ok(!logs.join('\n').includes(KEY.slice(8, 20)), 'part of the key leaked into the log');
  assert.ok(!fs.readFileSync(path.join(dir, 'decoy.config.ts'), 'utf8').includes(KEY));
  assert.ok(!fs.readFileSync(path.join(dir, '.env.lxs.example'), 'utf8').includes(KEY));
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(dir, '.env.lxs')).mode & 0o777, 0o600);

  // A second run neither asks again nor drops the key.
  await runInit({
    cwd: dir,
    service: 'app',
    interactive: true,
    promptKey: async () => {
      asked++;
      return '';
    },
    env: {},
    log: quiet,
  });
  assert.equal(asked, 1);
  assert.equal(envOf(dir).get('LXS_INGEST_KEY'), KEY);
});

test('--key works non-interactively, replaces the placeholder and keeps other lines', async () => {
  const dir = tmp('lxs-init-');
  fs.writeFileSync(
    path.join(dir, '.env.lxs'),
    `# mine\nLXS_INGEST_KEY=${PLACEHOLDER_KEY}\nLXS_ENDPOINT=https://self.example.test\nOTHER=1\n`,
  );
  await runInit({ cwd: dir, service: 'app', key: KEY, interactive: false, env: {}, log: quiet });
  const text = fs.readFileSync(path.join(dir, '.env.lxs'), 'utf8');
  const env = parseEnvFile(text);
  assert.equal(env.get('LXS_INGEST_KEY'), KEY);
  assert.equal(env.get('LXS_ENDPOINT'), 'https://self.example.test', 'existing endpoint kept');
  assert.equal(env.get('OTHER'), '1');
  assert.match(text, /^# mine$/m);
});

test('a skipped prompt leaves the placeholder; a malformed key is refused', async () => {
  const dir = tmp('lxs-init-');
  await runInit({
    cwd: dir,
    service: 'app',
    interactive: true,
    promptKey: async () => '',
    env: {},
    log: quiet,
  });
  assert.equal(envOf(dir).get('LXS_INGEST_KEY'), PLACEHOLDER_KEY);
  await assert.rejects(
    runInit({ cwd: dir, service: 'app', key: 'hunter2', interactive: false, env: {}, log: quiet }),
    /E_KEY_FORMAT/,
  );
});

test('upsertEnv and parseEnvFile round-trip', () => {
  let t = 'A=1\nexport B="two"\n';
  t = upsertEnv(t, 'B', '3');
  t = upsertEnv(t, 'C', '4');
  const env = parseEnvFile(t);
  assert.deepEqual(
    [...env],
    [
      ['A', '1'],
      ['B', '3'],
      ['C', '4'],
    ],
  );
});
