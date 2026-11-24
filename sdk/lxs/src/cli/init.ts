import fs from 'node:fs';
import path from 'node:path';
import { LXSConfigError } from '../errors.js';
import { isPresetName, PRESET_NAMES, PRESETS, type PresetName } from '../presets/index.js';

/**
 * Where agents send events unless told otherwise (`--endpoint`, env LXS_ENDPOINT, or an existing
 * LXS_ENDPOINT in .env.lxs win, in that order).
 * TODO(owner): confirm the hosted API URL before the first public release; this is a placeholder.
 */
export const DEFAULT_ENDPOINT = 'https://api.lxs.dev';

/** The env file the generated compose hands to ds-agent (`env_file: [.env.lxs]`). The only place the key lives. */
export const ENV_FILE = '.env.lxs';

export const GITIGNORE_ENTRIES = [ENV_FILE, '.lxs/secrets/'];

/** Same shape the API accepts (plugins/bearer-key.ts). */
export const KEY_PATTERN = /^ds_[a-z]+_[A-Za-z0-9]{8,}$/;
/** The value the .example file ships with; never a real key. */
export const PLACEHOLDER_KEY = 'ds_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

export interface InitOptions {
  cwd: string;
  service: string;
  force?: boolean;
  preset?: string;
  /** --endpoint */
  endpoint?: string;
  /** --key (also read from env LXS_INGEST_KEY). */
  key?: string;
  /** Prompt for the key when none was given. Defaults to "stdin and stdout are TTYs". */
  interactive?: boolean;
  /** Reads the key without echoing it. Injected by tests. */
  promptKey?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export function configTemplate(service: string): string {
  return `// decoy.config.ts — declares your decoys. Nothing here is secret: commit this file.
import { LXS } from 'lxs';

const t = new LXS({
  service: '${service}',          // the app's service name in docker-compose.yml
  mode: 'enforce',          // 'monitor' never blocks, even if the platform asks
  // Behind a reverse proxy? Either count the proxies in front of the app (only if the app is
  // unreachable except through them) or list their addresses. Never true: X-Forwarded-For is
  // client-controlled, so true would let attackers pick their own IP.
  // trustProxy: 1,              // one proxy (nginx, a load balancer) in front of the app
  // trustProxy: ['loopback'],   // or: the proxies' addresses ('loopback' | 'uniquelocal' | CIDRs)
  // allowlist: ['10.0.0.0/8'],  // your own scanners and uptime monitors (never 0.0.0.0/0)
  // telemetry: { dir: './telemetry' }, // firewall.jsonl / auth.jsonl for the agent to tail
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

export function envExample(endpoint = DEFAULT_ENDPOINT): string {
  return `# ${ENV_FILE}  (git-ignored; paste the key from the dashboard)
LXS_INGEST_KEY=${PLACEHOLDER_KEY}
LXS_ENDPOINT=${endpoint}
`;
}

/** @deprecated kept for callers of 0.1.x; use envExample(). */
export const ENV_EXAMPLE = envExample();

/** Parses KEY=value lines (no interpolation, optional quotes). */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] as string).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out.set(m[1] as string, v);
  }
  return out;
}

/** Sets KEY=value in an env file's text, replacing an existing line or appending one. */
export function upsertEnv(text: string, key: string, value: string): string {
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  return `${text}${sep}${key}=${value}\n`;
}

export function isPlaceholderKey(v: string | undefined): boolean {
  return !v || v === PLACEHOLDER_KEY || /^ds_live_x+$/.test(v);
}

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

/**
 * Reads one line from a TTY without echoing it (raw mode). Handles paste, backspace, Ctrl-C.
 */
export function promptHidden(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    let buf = '';
    const finish = (err?: Error): void => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(buf.trim());
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004' || ch === '\u0003') {
          finish(ch === '\u0003' ? new Error('cancelled') : undefined);
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    input.on('data', onData);
  });
}

function resolvePreset(name: string | undefined): PresetName | undefined {
  if (name === undefined) return undefined;
  if (!isPresetName(name))
    throw new LXSConfigError(
      'E_PRESET_UNKNOWN',
      `unknown preset '${name}'.`,
      `Use one of: ${PRESET_NAMES.join(', ')}.`,
    );
  return name;
}

function checkKey(key: string): string {
  const k = key.trim();
  if (!KEY_PATTERN.test(k))
    throw new LXSConfigError(
      'E_KEY_FORMAT',
      'that does not look like an ingest key (expected ds_live_ followed by letters and digits).',
      'Copy it again from the dashboard: Settings → Ingest keys.',
    );
  return k;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const env = opts.env ?? process.env;
  const preset = resolvePreset(opts.preset);

  const cfgPath = path.join(opts.cwd, 'decoy.config.ts');
  if (fs.existsSync(cfgPath) && !opts.force) {
    log(`  decoy.config.ts already exists, leaving it alone (use --force to overwrite)`);
  } else {
    fs.writeFileSync(
      cfgPath,
      preset ? PRESETS[preset].render(opts.service) : configTemplate(opts.service),
    );
    log(
      `  ✔ created decoy.config.ts${preset ? ` (preset: ${preset}, ${PRESETS[preset].summary})` : ''}`,
    );
  }

  // .gitignore first, so the key never sits in an unignored file even for a moment.
  const added = appendIgnore(path.join(opts.cwd, '.gitignore'), GITIGNORE_ENTRIES);
  if (added.length > 0) log(`  ✔ .gitignore: added ${added.join(', ')}`);

  const envPath = path.join(opts.cwd, ENV_FILE);
  let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const current = parseEnvFile(envText);

  const endpoint = (
    opts.endpoint ??
    env.LXS_ENDPOINT ??
    current.get('LXS_ENDPOINT') ??
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
  } catch {
    throw new LXSConfigError(
      'E_ENDPOINT_INVALID',
      `'${endpoint}' is not an http(s) URL.`,
      'Pass --endpoint https://your-lxs-host',
    );
  }

  let key = opts.key ?? env.LXS_INGEST_KEY;
  const haveKey = !isPlaceholderKey(current.get('LXS_INGEST_KEY'));
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!key && !haveKey && interactive) {
    log('');
    log('  Paste your ingest key (dashboard → Settings → Ingest keys). Input is hidden;');
    log('  press Enter to skip and add it to .env.lxs later.');
    const prompt = opts.promptKey ?? (() => promptHidden('  Ingest key: '));
    key = (await prompt()).trim() || undefined;
  }
  if (key) key = checkKey(key);

  const before = envText;
  envText = upsertEnv(envText, 'LXS_ENDPOINT', endpoint);
  if (key) envText = upsertEnv(envText, 'LXS_INGEST_KEY', key);
  else if (!current.has('LXS_INGEST_KEY'))
    envText = upsertEnv(envText, 'LXS_INGEST_KEY', PLACEHOLDER_KEY);
  if (envText !== before || !fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, envText, { mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600); // writeFileSync's mode only applies on create
    } catch {
      /* best effort (Windows) */
    }
  }
  log(`  ✔ ${ENV_FILE}: LXS_ENDPOINT=${endpoint}`);
  if (key) log(`  ✔ ${ENV_FILE}: ingest key saved (not shown; the file is git-ignored)`);
  else if (haveKey) log(`  ✔ ${ENV_FILE}: keeping the ingest key already there`);
  else
    log(
      `  ! ${ENV_FILE}: no ingest key yet. Paste it as LXS_INGEST_KEY=... or run  npx lxs init --key <key>`,
    );

  const examplePath = path.join(opts.cwd, `${ENV_FILE}.example`);
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(examplePath, envExample(endpoint));
    log(`  ✔ created ${ENV_FILE}.example`);
  }

  log('');
  log('Next: wire `app.use(decoys.express())` first in your server, then');
  log('  npx lxs build     compile decoy.config.ts into lxs.compose.yml');
  log('  npx lxs doctor    check Docker, ports, the key and the endpoint before you start');
  return 0;
}
