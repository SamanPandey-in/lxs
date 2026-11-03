// decoy.config.ts: declares the decoys. Nothing here is secret, so this file is committed.
import { LXS } from 'lxs';

const t = new LXS({
  service: 'shop', // the app's service name in docker-compose.yml
  mode: 'enforce', // 'monitor' never blocks, even if the platform asks
  // trustProxy: ['loopback'], // only if a reverse proxy runs in front of the app
  // allowlist: ['10.0.0.0/8'], // your own scanners and uptime monitors
});

// Web decoys: the second argument is a path on your own domain.
t.create('web-admin', '/admin', {
  brand: 'Acme Shop',
  acceptCredentials: [['admin', 'admin']],
  panel: 'customers',
});
t.create('web-bait', '/.env'); // template inferred from the path
t.create('web-bait', '/backup.sql');

// Network decoy: the second argument is a host port. Move the host's real sshd to another port first.
t.create('ssh', 22, {
  persona: 'db-backup',
  hostname: 'db-backup-01',
  credentials: 'weak-defaults',
});

// Real routes worth naming in alerts.
t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });
t.asset('/api/*', { name: 'Shop API' });

// A fake key in the same format as the real ones; planted in /.env and on the SSH box.
t.honeytokens({ apiKey: { header: 'authorization', prefix: 'acme_live_' } });

export default t;
