import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findConfig, loadShield, loadYamlConfig, runBuild } from '../src/cli/build.js';
import { lxsJsonSchema } from '../src/file-schema.js';
import { generateAll } from '../src/generate/index.js';
import { loadLxsYaml } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.join(here, '..');
const acmeTs = path.join(sdkRoot, '..', '..', 'examples', 'acme-shop', 'decoy.config.ts');
const acmeYaml = path.join(here, 'fixtures', 'acme-shop.lxs.yaml');
const quiet = (): undefined => undefined;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A project dir with a compose file and the required .gitignore entries. */
function project(files: Record<string, string>): string {
  const dir = tmp('lxs-yaml-');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  shop:\n    image: shop\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env.lxs\n.lxs/secrets/\n');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** The acme-shop TS config, rewired to import this package's source instead of the built 'lxs'. */
function acmeTsCopy(dir: string): string {
  const src = pathToImport(path.join(sdkRoot, 'src', 'index.ts'));
  const text = fs.readFileSync(acmeTs, 'utf8').replace("from 'lxs'", `from '${src}'`);
  const file = path.join(dir, 'decoy.config.ts');
  fs.writeFileSync(file, text);
  return file;
}

function pathToImport(p: string): string {
  return p.split(path.sep).join('/');
}

const MINIMAL = 'service: shop\ndecoys:\n  - type: web-bait\n    path: /.env\n';

test('the committed JSON Schema matches the zod schema (run `pnpm --filter lxs schema` if this fails)', () => {
  const committed = JSON.parse(
    fs.readFileSync(path.join(sdkRoot, 'schema', 'lxs.schema.json'), 'utf8'),
  ) as unknown;
  assert.deepEqual(committed, JSON.parse(JSON.stringify(lxsJsonSchema())));
});

test('acme-shop as decoy.config.ts and as lxs.yaml produce byte-identical build output', async () => {
  const dir = tmp('lxs-acme-');
  const ts = await loadShield(acmeTsCopy(dir));
  const yaml = await loadShield(acmeYaml);
  assert.deepEqual(yaml.resolve(), ts.resolve());

  const a = generateAll(ts.resolve());
  const b = generateAll(yaml.resolve(), { existingHoneytokens: a.honeytokens });
  assert.deepEqual([...b.committed.keys()].sort(), [...a.committed.keys()].sort());
  for (const [file, content] of a.committed) {
    assert.equal(b.committed.get(file), content, `${file} differs`);
  }
  assert.ok(a.committed.has('lxs.compose.yml'));
  assert.ok(a.committed.has('.lxs/manifest.json'));
});

test('lxs build runs end to end from lxs.yaml, and lxs.yml is detected too', async () => {
  for (const name of ['lxs.yaml', 'lxs.yml']) {
    const dir = project({ [name]: fs.readFileSync(acmeYaml, 'utf8') });
    const logs: string[] = [];
    assert.equal(await runBuild({ cwd: dir, log: (m) => logs.push(m) }), 0);
    assert.ok(fs.existsSync(path.join(dir, 'lxs.compose.yml')));
    assert.ok(fs.existsSync(path.join(dir, '.lxs', 'manifest.json')));
    assert.match(logs.join('\n'), /6 decoys: web-admin \/admin/);
    assert.equal(await runBuild({ cwd: dir, check: true, log: quiet }), 0);
  }
});

test('config discovery: decoy.config.ts first, lxs.yaml as fallback, ambiguity refused', () => {
  const ts = 'export default {};\n';
  const onlyYaml = project({ 'lxs.yaml': MINIMAL });
  assert.equal(path.basename(findConfig(onlyYaml)), 'lxs.yaml');

  const onlyTs = project({ 'decoy.config.ts': ts });
  assert.equal(path.basename(findConfig(onlyTs)), 'decoy.config.ts');

  const both = project({ 'decoy.config.ts': ts, 'lxs.yaml': MINIMAL });
  assert.throws(() => findConfig(both), /E_CONFIG_AMBIGUOUS|more than one config/);
  assert.equal(path.basename(findConfig(both, 'lxs.yaml')), 'lxs.yaml');
  assert.equal(path.basename(findConfig(both, 'decoy.config.ts')), 'decoy.config.ts');

  const twoYaml = project({ 'lxs.yaml': MINIMAL, 'lxs.yml': MINIMAL });
  assert.throws(() => findConfig(twoYaml), /more than one config/);

  const none = project({});
  assert.throws(() => findConfig(none), /no decoy\.config\.ts or lxs\.yaml/);
});

test('--config lxs.yaml builds even when a decoy.config.ts sits next to it', async () => {
  const dir = project({ 'decoy.config.ts': 'export default {};\n', 'lxs.yaml': MINIMAL });
  await assert.rejects(runBuild({ cwd: dir, log: quiet }), /more than one config/);
  assert.equal(await runBuild({ cwd: dir, config: 'lxs.yaml', log: quiet }), 0);
});

test('lxs.yaml is validated: unknown keys, wrong types and bad values are refused', () => {
  const bad: Array<[string, RegExp]> = [
    ['servce: shop\n', /Unrecognized key|servce/],
    ['decoys:\n  - type: web-bait\n    path: /.env\n    templte: dotenv\n', /templte/],
    ['decoys:\n  - type: telnet\n    port: 23\n', /decoys\.0/],
    ['decoys:\n  - type: ssh\n    port: "22"\n', /decoys\.0\.port/],
    ['mode: block\n', /mode/],
    ['trustProxy: true\n', /trustProxy/],
    ['allowlist: [0.0.0.0/0]\n', /matches every address/],
    ['decoys: [ {type: web-bait, path: /\n', /not valid YAML/],
    // Passes the shape check, then fails the same defineConfig() validation a TS config gets.
    ['decoys:\n  - type: web-bait\n    path: /health\n', /reserved/],
    ['decoys:\n  - type: web-bait\n    path: /nothing-to-infer\n', /cannot infer a bait template/],
  ];
  for (const [text, re] of bad) {
    assert.throws(() => loadYamlConfig(text), re, text);
  }
});

test('lxs.yaml accepts the $schema key and honeytokens: true', () => {
  const t = loadYamlConfig(
    `$schema: ./node_modules/lxs/schema/lxs.schema.json\n${MINIMAL}honeytokens: true\n`,
  );
  const cfg = t.resolve();
  assert.equal(cfg.options.service, 'shop');
  assert.equal(cfg.honeytokens?.canaryRows, 5);
  assert.equal(cfg.decoys[0]?.id, 'web-bait-env');
});

test('apps can mount the middleware straight from lxs.yaml', () => {
  const t = loadLxsYaml(acmeYaml);
  assert.equal(typeof t.express(), 'function');
  assert.deepEqual(
    t.decoys.map((d) => d.id),
    [
      'web-admin-admin',
      'web-bait-env',
      'web-bait-backup-sql',
      'ssh-db-backup-01',
      'redis-6380',
      'postgres-5433',
    ],
  );
  t.close();
});
