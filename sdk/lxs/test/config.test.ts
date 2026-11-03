import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineConfig, LXS, LXSConfigError } from '../src/index.js';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof LXSConfigError ? e.code : `other:${(e as Error).message}`;
  }
  return undefined;
};

test('the documented declaration API produces the expected decoys', () => {
  const t = new LXS({ service: 'shop' });
  t.create('web-admin', '/admin', { brand: 'Acme Shop', acceptCredentials: [['admin', 'admin']] })
    .create('web-bait', '/.env')
    .create('web-bait', '/backup.sql')
    .create('ssh', 22, { persona: 'db-backup', hostname: 'db-backup-01' })
    .asset('/api/payments', { critical: true })
    .honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });
  assert.deepEqual(
    t.decoys.map((d) => d.id),
    ['web-admin-admin', 'web-bait-env', 'web-bait-backup-sql', 'ssh-db-backup-01'],
  );
  assert.equal(t.decoys[1]?.type === 'web-bait' && t.decoys[1].template, 'dotenv');
  assert.equal(t.decoys[2]?.type === 'web-bait' && t.decoys[2].template, 'sql-dump');
  assert.equal(t.assets[0]?.criticality, 'critical');
});

test('validation errors carry stable codes', () => {
  const t = () => new LXS();
  assert.equal(
    code(() =>
      t().create('web-admin', '/admin').create('web-bait', '/admin', { template: 'dotenv' }),
    ),
    'E_MOUNT_COLLISION',
  );
  assert.equal(
    code(() => t().create('web-bait', '/robots.txt', { template: 'dotenv' })),
    'E_MOUNT_RESERVED',
  );
  assert.equal(
    code(() => t().create('web-bait', '/healthz', { template: 'dotenv' })),
    'E_MOUNT_RESERVED',
  );
  assert.equal(
    code(() => t().create('web-bait', '/a/*', { template: 'dotenv' })),
    'E_MOUNT_INVALID',
  );
  assert.equal(
    code(() => t().create('web-bait', '/a?b=1', { template: 'dotenv' })),
    'E_MOUNT_INVALID',
  );
  assert.equal(
    code(() => t().create('web-bait', 'admin' as never)),
    'E_MOUNT_INVALID',
  );
  assert.equal(
    code(() => t().create('web-bait', '/mystery')),
    'E_TEMPLATE_UNKNOWN',
  );
  assert.equal(
    code(() => (t() as any).create('ssh', '/admin')),
    'E_PORT_TYPE',
  );
  assert.equal(
    code(() => (t() as any).create('web-admin', 2222)),
    'E_MOUNT_TYPE',
  );
  assert.equal(
    code(() => t().create('ssh', 70000)),
    'E_PORT_RANGE',
  );
  assert.equal(
    code(() => t().create('ssh', 22).create('ssh', 22, { id: 'other' })),
    'E_PORT_COLLISION',
  );
  assert.equal(
    code(() => t().create('ssh', 22).create('ssh', 23)),
    'E_ID_COLLISION',
  );
  assert.equal(
    code(() => new LXS({ allowlist: ['nope'] })),
    'E_OPTIONS',
  );
  assert.equal(
    code(() => t().asset('/api/*/x' as never)),
    'E_ASSET_PATTERN',
  );
});

test('errors expose a hint', () => {
  try {
    new LXS().create('web-admin', '/admin').create('web-admin', '/admin');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof LXSConfigError);
    assert.match(e.hint ?? '', /id:/);
  }
});

test('defineConfig builds the same thing declaratively', () => {
  const t = defineConfig({
    service: 'shop',
    decoys: [
      { type: 'web-bait', path: '/.env' },
      { type: 'ssh', port: 22 },
    ],
    assets: [{ pattern: '/api/payments/*', name: 'Payments API', criticality: 'critical' }],
    honeytokens: true,
  });
  assert.equal(t.decoys.length, 2);
  assert.equal(t.resolve().honeytokens?.canaryRows, 5);
});
