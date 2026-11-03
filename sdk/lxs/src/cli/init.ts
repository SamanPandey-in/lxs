import fs from 'node:fs';
import path from 'node:path';

export interface InitOptions {
  cwd: string;
  service: string;
  force?: boolean;
  log?: (msg: string) => void;
}

export const GITIGNORE_ENTRIES = ['.env.lxs', '.lxs/secrets/'];

export function configTemplate(service: string): string {
  return `// decoy.config.ts — declares your decoys. Nothing here is secret: commit this file.
import { LXS } from 'lxs';

const t = new LXS({
  service: '${service}',          // the app's service name in docker-compose.yml
  mode: 'enforce',          // 'monitor' never blocks, even if the platform asks
  // trustProxy: ['loopback'], // only if a reverse proxy runs in front of the app
  // allowlist: ['10.0.0.0/8'], // your own scanners and uptime monitors
});

// Web decoys: the second argument is a path on your own domain.
t.create('web-admin', '/admin', { brand: 'My App', acceptCredentials: [['admin', 'admin']], panel: 'customers' });
t.create('web-bait', '/.env'); // template inferred from the path
t.create('web-bait', '/backup.sql');

// Network decoys: the second argument is a host port (move the real sshd to another port first).
// t.create('ssh', 22, { persona: 'db-backup', hostname: 'db-backup-01', credentials: 'weak-defaults' });

// Real routes worth naming in alerts.
// t.asset('/api/payments/*', { name: 'Payments API', criticality: 'critical' });

// A fake key in the same format as your real keys; planted in /.env and on the SSH box.
// t.honeytokens({ apiKey: { header: 'authorization', prefix: 'myapp_live_' } });

export default t;
`;
}

export const ENV_EXAMPLE = `# .env.lxs  (git-ignored; paste the key from the dashboard)
LXS_INGEST_KEY=ds_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LXS_ENDPOINT=https://soc.example.dev
`;

function appendIgnore(file: string, entries: string[]): string[] {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e));
  if (missing.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      file,
      `${prefix}${existing.length > 0 ? '\n' : ''}# lxs\n${missing.join('\n')}\n`,
    );
  }
  return missing;
}

export function runInit(opts: InitOptions): number {
  const log = opts.log ?? console.log;
  const cfgPath = path.join(opts.cwd, 'decoy.config.ts');
  if (fs.existsSync(cfgPath) && !opts.force) {
    log(`  decoy.config.ts already exists, leaving it alone (use --force to overwrite)`);
  } else {
    fs.writeFileSync(cfgPath, configTemplate(opts.service));
    log('  ✔ created decoy.config.ts');
  }

  const examplePath = path.join(opts.cwd, '.env.lxs.example');
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(examplePath, ENV_EXAMPLE);
    log('  ✔ created .env.lxs.example');
  }
  const envPath = path.join(opts.cwd, '.env.lxs');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, ENV_EXAMPLE, { mode: 0o600 });
    log('  ✔ created .env.lxs (paste your ingest key; it is git-ignored)');
  }
  const added = appendIgnore(path.join(opts.cwd, '.gitignore'), GITIGNORE_ENTRIES);
  if (added.length > 0) log(`  ✔ .gitignore: added ${added.join(', ')}`);

  log('');
  log('Next: edit decoy.config.ts, wire `app.use(decoys.express())` first in your server,');
  log('then run  npx lxs build');
  return 0;
}
