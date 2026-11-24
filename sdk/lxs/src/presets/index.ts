/**
 * Starter configs for `lxs init --preset <name>`. Each one renders a complete decoy.config.ts
 * that builds as-is (`lxs build` then `lxs build --check` pass; see test/presets.test.ts).
 *
 * Network decoys use high host ports (2222, 5433, 6380) so a first run never collides with a
 * real sshd, Postgres or Redis on the same host. Move them to 22/5432/6379 once the real
 * services listen elsewhere: attackers scan the default ports first.
 */

export const PRESET_NAMES = ['shop', 'saas-api', 'wordpress'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Preset {
  name: PresetName;
  /** One line for `lxs init --help` and the init log. */
  summary: string;
  render(service: string): string;
}

export function isPresetName(v: string): v is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(v);
}

const header = (
  service: string,
  what: string,
): string => `// decoy.config.ts (${what}). Declares your decoys. Nothing here is secret: commit this file.
import { LXS } from 'lxs';

const t = new LXS({
  service: '${service}', // the app's service name in docker-compose.yml
  mode: 'enforce', // 'monitor' never blocks, even if the platform asks
  // trustProxy: 1,             // one reverse proxy (nginx, a load balancer) in front of the app
  // allowlist: ['10.0.0.0/8'], // your own scanners and uptime monitors (never 0.0.0.0/0)
});
`;

const footer = `
export default t;
`;

const shop: Preset = {
  name: 'shop',
  summary: 'online store: admin panel, leaked .env and SQL dump, a backup SSH box, a shop database',
  render: (service) => `${header(service, 'preset: shop')}
// Web decoys: the second argument is a path on your own domain. They shadow any real route there.
t.create('web-admin', '/admin', {
  brand: 'My Shop',
  acceptCredentials: [['admin', 'admin']], // "works", then shows a fake customer list
  panel: 'customers',
});
t.create('web-bait', '/.env'); // fake secrets, including the honeytoken below
t.create('web-bait', '/backup.sql'); // a fake customer dump with canary rows
t.create('web-bait', '/.git/config');

// Network decoys: the second argument is a host port.
t.create('ssh', 2222, { persona: 'db-backup', hostname: 'db-backup-01', credentials: 'weak-defaults' });
t.create('postgres', 5433, { seed: 'shop', requirePassword: true });

// Real routes worth naming in alerts. Anything that reaches these after touching a decoy is critical.
t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
t.asset('/api/checkout/*', { name: 'Checkout', criticality: 'critical' });
t.asset('/api/*', { name: 'Shop API' });

// A fake key in the same format as your real ones; planted in /.env and on the SSH box.
t.honeytokens({ apiKey: { header: 'authorization', prefix: 'shop_live_' } });
${footer}`,
};

const saasApi: Preset = {
  name: 'saas-api',
  summary:
    'API product: internal admin, leaked env files and git config, a worker box, Redis sessions, a billing DB',
  render: (service) => `${header(service, 'preset: saas-api')}
// Web decoys: the second argument is a path on your own domain. They shadow any real route there.
t.create('web-admin', '/internal/admin', {
  brand: 'Admin Console',
  acceptCredentials: [['admin', 'changeme']],
  panel: 'customers',
});
t.create('web-bait', '/.env');
t.create('web-bait', '/.env.production');
t.create('web-bait', '/.git/config');
t.create('web-bait', '/db/backup.sql');

// Network decoys: the second argument is a host port.
t.create('ssh', 2222, { persona: 'web-server', hostname: 'api-worker-01', credentials: 'weak-defaults' });
t.create('redis', 6380, { seed: 'sessions', requirePassword: false });
t.create('postgres', 5433, { seed: 'finance', requirePassword: true });

// Real routes worth naming in alerts.
t.asset('/v1/billing/*', { name: 'Billing API', criticality: 'critical' });
t.asset('/v1/admin/*', { name: 'Admin API', criticality: 'critical' });
t.asset('/v1/*', { name: 'Public API' });

// A fake key in the same format as your customers' API keys (change the prefix to match yours).
t.honeytokens({ apiKey: { header: 'x-api-key', prefix: 'api_live_' } });
${footer}`,
};

const wordpress: Preset = {
  name: 'wordpress',
  summary:
    'WordPress bait for an app that is NOT WordPress: wp-login, phpMyAdmin, a DB backup, a web box',
  render: (service) => `${header(service, 'preset: wordpress')}
// WordPress paths draw most of the internet's scanner traffic. These decoys answer them on an app
// that does not run WordPress (the middleware runs in your Node app, not in PHP). If a real
// WordPress shares this domain, remove the decoys whose paths it serves.
t.create('web-bait', '/wp-login.php');
t.create('web-bait', '/phpmyadmin');
t.create('web-bait', '/wp-content/uploads/backup.sql');
t.create('web-bait', '/.env');

// Network decoys: the second argument is a host port.
t.create('ssh', 2222, { persona: 'web-server', hostname: 'wp-prod-01', credentials: 'weak-defaults' });
t.create('redis', 6380, { seed: 'sessions', requirePassword: false });

// Real routes worth naming in alerts.
t.asset('/api/*', { name: 'App API' });
// t.asset('/account/*', { name: 'Customer accounts', criticality: 'critical' });
${footer}`,
};

export const PRESETS: Record<PresetName, Preset> = {
  shop,
  'saas-api': saasApi,
  wordpress,
};
