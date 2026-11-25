import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadMintKeys, MintRegistry, mintedValue } from '../src/mint.js';
import { createLocalNormalizer, createNormalizer } from '../src/normalize.js';
import { PolicyStore } from '../src/policy.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const opts = {
  salt: 'salt',
  commonCredsText: 'admin\n',
  simulated: false,
  sshPorts: new Map<string, number>(),
  honeyReads: [],
};

const mintLine = (mintId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: '2026-11-24T10:02:00.000Z',
    decoy_id: 'web-bait-env',
    kind: 'mint',
    ip: '203.0.113.9',
    method: 'GET',
    path: '/.env',
    req_id: 'r9',
    status: 200,
    honeytoken_id: 'ht_api_01',
    mint_id: mintId,
    ...extra,
  });

function tokensFile(withSecret: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-mint-'));
  const file = path.join(dir, 'honeytokens.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      tokens: [
        { id: 'ht_api_01', kind: 'api_key', value: 'acme_live_STATIC', prefix: 'acme_live_' },
        { id: 'ht_db_01', kind: 'db_url', value: 'postgres://x:y@h:5432/d' },
      ],
      ...(withSecret ? { mint_secret: SECRET } : {}),
    }),
  );
  return file;
}

test('the agent re-derives the same value ds-web minted (vector shared with apps/decoy-web)', () => {
  const keys = loadMintKeys(tokensFile(true));
  assert.ok(keys);
  assert.equal(
    mintedValue(keys.secret, 'ht_api_01.swvxpgns7opr', 'acme_live_'),
    'acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw',
  );
  assert.equal(
    mintedValue(keys.secret, 'ht_api_01.4j2gqppzcx7e', 'acme_live_'),
    'acme_live_PyxK11iQEOWbhF3hfCYA9iFb195dZKp8',
  );
  assert.equal(loadMintKeys(tokensFile(false)), null, 'no secret: static token only');
});

test('mint ids register their value hash; unknown bases and malformed ids are refused', () => {
  const keys = loadMintKeys(tokensFile(true));
  assert.ok(keys);
  const reg = new MintRegistry(keys, null);
  const r = reg.add('ht_api_01.swvxpgns7opr');
  assert.deepEqual(r, {
    hash: sha('acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw'),
    id: 'ht_api_01.swvxpgns7opr',
  });
  assert.equal(reg.add('ht_api_01.swvxpgns7opr'), null, 'already known');
  assert.equal(reg.add('ht_db_01.swvxpgns7opr'), null, 'db_url tokens are not minted');
  assert.equal(reg.add('ht_api_01.NOT-BASE32!!'), null);
  assert.equal(reg.add('ht_api_01'), null);
  assert.equal(reg.size, 1);
});

test('the registry is bounded and survives a restart', () => {
  const keys = loadMintKeys(tokensFile(true));
  assert.ok(keys);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-mint-state-')), 'm.json');
  const a = new MintRegistry(keys, file, 2);
  a.add('ht_api_01.aaaaaaaaaaaa');
  a.add('ht_api_01.bbbbbbbbbbbb');
  a.add('ht_api_01.cccccccccccc');
  assert.equal(a.size, 2);
  a.save();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('acme_live_'), 'only ids are persisted, never values');
  const b = new MintRegistry(keys, file, 2);
  b.load();
  assert.deepEqual(Object.values(b.entries()).sort(), [
    'ht_api_01.bbbbbbbbbbbb',
    'ht_api_01.cccccccccccc',
  ]);
});

test('minted tokens join the policy the SDK polls, next to the static token', () => {
  const store = new PolicyStore({ [sha('acme_live_STATIC')]: 'ht_api_01' });
  const rev = store.snapshot().revision;
  store.addHoneytoken(sha('acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw'), 'ht_api_01.swvxpgns7opr');
  const snap = store.snapshot();
  assert.ok(snap.revision > rev, 'revision bump makes the SDK refetch');
  assert.equal(snap.honeytokens[sha('acme_live_STATIC')], 'ht_api_01');
  assert.equal(
    snap.honeytokens[sha('acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw')],
    'ht_api_01.swvxpgns7opr',
  );
  const again = store.snapshot().revision;
  store.addHoneytoken(sha('acme_live_0suwzkfOOd3LWTxalRH6ioqdowFYs7bw'), 'ht_api_01.swvxpgns7opr');
  assert.equal(store.snapshot().revision, again, 'no-op add does not bump');
});

for (const impl of ['package', 'local'] as const) {
  test(`${impl} normalizer: a mint line becomes one honeytoken.mint event (no extra read)`, async () => {
    const n = impl === 'package' ? await createNormalizer(opts) : createLocalNormalizer(opts);
    const evs = n.normalize({
      source: 'web',
      decoyId: 'ds-web',
      fileKey: 'web/ds-web.jsonl',
      offset: 10,
      text: mintLine('ht_api_01.swvxpgns7opr', { session_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    });
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev?.event_type, 'honeytoken.mint');
    assert.equal(ev?.honeytoken_id, 'ht_api_01.swvxpgns7opr');
    assert.equal(ev?.src_ip, '203.0.113.9');
    assert.equal(ev?.url, '/.env');
    assert.equal(ev?.session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(ev?.is_decoy, true);
    const bad = n.normalize({
      source: 'web',
      decoyId: 'ds-web',
      fileKey: 'web/ds-web.jsonl',
      offset: 20,
      text: mintLine('../../etc/passwd'),
    });
    assert.equal(bad.length, 0);
  });
}
