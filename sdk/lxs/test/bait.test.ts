import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { companionPaths } from '../src/bait-assets.js';
import { runBuild } from '../src/cli/build.js';
import { generateBait, parseBaitSeed } from '../src/generate/bait.js';
import { generateHoneytokens, realisticDbPassword } from '../src/generate/honeytokens.js';
import { generateAll } from '../src/generate/index.js';
import { LXS } from '../src/index.js';
import { DecoyMatcher } from '../src/matcher.js';

const SEED = { seed: '0123456789abcdef0123456789abcdef', epoch: '2026-11-01' };
const demo = () =>
  new LXS({ service: 'shop' })
    .create('web-admin', '/admin', { brand: 'Acme Shop' })
    .create('web-bait', '/.env')
    .create('web-bait', '/backup.sql')
    .create('web-bait', '/wp-login.php')
    .honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });

test('bait values are deterministic per seed and differ across seeds', () => {
  const cfg = demo().resolve();
  const a = generateBait(cfg, SEED);
  assert.deepEqual(generateBait(cfg, SEED), a);
  const b = generateBait(cfg, { ...SEED, seed: 'f'.repeat(32) });
  assert.notEqual(a.app_key, b.app_key);
  assert.equal(Buffer.from(a.app_key.replace(/^base64:/, ''), 'base64').length, 32);
  assert.match(a.postgres.server, /^1[2-6]\.\d+ \((Debian|Ubuntu) /);
  assert.ok(Date.parse(a.dumped_at) < Date.parse('2026-11-01T00:00:00Z'));
  assert.ok(Date.parse(a.dumped_at) > Date.parse('2026-10-01T00:00:00Z'));
});

test('generated output is byte-stable for a fixed seed and carries the seed in the manifest', () => {
  const cfg = demo().resolve();
  const g1 = generateAll(cfg, { baitSeed: SEED });
  const g2 = generateAll(cfg, { baitSeed: SEED, existingHoneytokens: g1.honeytokens });
  for (const [f, c] of g1.committed) assert.equal(g2.committed.get(f), c, f);
  const manifest = JSON.parse(g1.committed.get('.lxs/manifest.json') as string);
  assert.deepEqual(parseBaitSeed(manifest.bait), SEED);
  const web = JSON.parse(g1.committed.get('.lxs/web-decoys.json') as string);
  assert.equal(web.bait.app_key, g1.bait.app_key);
  const wp = web.decoys.find((d: { mount: string }) => d.mount === '/wp-login.php');
  assert.ok(wp.assets.includes('/wp-includes/css/buttons.min.css'));
  // Honeytoken plaintext and the mint secret stay in the secrets file only.
  for (const c of g1.committed.values())
    assert.ok(!c.includes(g1.honeytokens.mint_secret as string));
});

test('honeytokens gain a reusable mint secret and a realistic DB password', () => {
  const cfg = demo().resolve();
  const a = generateHoneytokens(cfg, null);
  assert.match(a.mint_secret as string, /^[A-Za-z0-9+/]{43}=$/);
  const b = generateHoneytokens(cfg, a);
  assert.equal(b.mint_secret, a.mint_secret);
  assert.deepEqual(b.tokens, a.tokens, 'DB URL (with an encoded password) round-trips');
  for (let i = 0; i < 50; i++) {
    const p = realisticDbPassword();
    assert.ok(p.length >= 12 && p.length <= 24, p);
  }
  // An older secrets file without a mint secret still parses and gets one on the next build.
  const { mint_secret: _x, ...old } = a;
  assert.match(generateHoneytokens(cfg, old).mint_secret as string, /=$/);
});

test('second-order paths route to the bait decoy; declared decoys and admin mounts win', () => {
  assert.deepEqual(companionPaths('dotenv', '/.env'), []);
  assert.ok(companionPaths('git-config', '/.git/config').includes('/.git/HEAD'));
  assert.ok(companionPaths('phpmyadmin', '/phpmyadmin').includes('/phpmyadmin/index.php'));
  const cfg = new LXS({ service: 'shop' })
    .create('web-bait', '/wp-login.php')
    .create('web-bait', '/readme.html', { template: 'dotenv' })
    .create('web-admin', '/wp-admin', { brand: 'X' })
    .resolve();
  const m = new DecoyMatcher(cfg.decoys);
  const wp = cfg.decoys.find((d) => d.mount === '/wp-login.php');
  assert.equal(m.match('/wp-includes/css/buttons.min.css')?.id, wp?.id);
  assert.equal(m.match('/xmlrpc.php')?.id, wp?.id);
  assert.notEqual(m.match('/readme.html')?.id, wp?.id, 'declared decoy keeps its path');
  assert.notEqual(m.match('/wp-admin/css/login.min.css')?.id, wp?.id, 'admin prefix wins');
  assert.equal(m.match('/wp-includes/other.css'), undefined);
});

test('build keeps the seed (--check stays green) and --reseed draws a new one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-bait-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  shop:\n    image: x\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env.lxs\n.lxs/secrets/\n');
  fs.writeFileSync(
    path.join(dir, 'decoy.config.mjs'),
    "export default { service: 'shop', decoys: [{ type: 'web-bait', path: '/.env' }] };",
  );
  const log = () => undefined;
  assert.equal(await runBuild({ cwd: dir, log }), 0);
  const seedOf = () =>
    JSON.parse(fs.readFileSync(path.join(dir, '.lxs/manifest.json'), 'utf8')).bait.seed;
  const first = seedOf();
  assert.equal(await runBuild({ cwd: dir, log }), 0);
  assert.equal(seedOf(), first);
  assert.equal(await runBuild({ cwd: dir, check: true, log }), 0);
  assert.equal(await runBuild({ cwd: dir, reseed: true, log }), 0);
  assert.notEqual(seedOf(), first);
  assert.equal(await runBuild({ cwd: dir, check: true, log }), 0);
});
