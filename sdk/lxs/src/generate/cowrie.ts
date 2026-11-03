import type { SshSpec } from '../types.js';
import { GENERATED_HEADER_HASH } from '../version.js';
import type { HoneytokenFile } from './honeytokens.js';

/** Paths inside the cowrie-personas image (see images/cowrie-personas.Dockerfile). */
export const COWRIE_BASE = '/cowrie/cowrie-git';

const DEFAULT_BANNER = 'SSH-2.0-OpenSSH_8.4p1 Debian-5+deb11u3';

const WEAK_DEFAULTS: Array<[string, string]> = [
  ['root', 'root'],
  ['root', '123456'],
  ['root', 'password'],
  ['admin', 'admin'],
  ['admin', 'password'],
  ['admin', 'admin123'],
  ['ubuntu', 'ubuntu'],
  ['postgres', 'postgres'],
  ['backup', 'backup'],
];

/** cowrie.cfg: non-secret, safe to commit. Forwarding is off, JSON logging is on, telnet is off. */
export function renderCowrieCfg(spec: SshSpec): string {
  return `${GENERATED_HEADER_HASH}
# Cowrie configuration for decoy '${spec.id}' (persona: ${spec.persona}).
# Key names verified against the image layout documented in images/cowrie-personas.Dockerfile.

[honeypot]
hostname = ${spec.hostname}
log_path = var/log/cowrie
state_path = var/lib/cowrie
download_path = \${honeypot:state_path}/downloads
etc_path = etc
# Operator override: files mounted here (generated honeytokens, canary export) replace the contents baked into the persona.
contents_path = /cowrie/honeyfs-live
txtcmds_path = ${COWRIE_BASE}/share/cowrie/personas/${spec.persona}/txtcmds
ttylog = true
backend = shell
auth_class = UserDB
download_limit_size = 10485760

[shell]
filesystem = ${COWRIE_BASE}/share/cowrie/personas/${spec.persona}/fs.pickle
arch = linux-x64-lsb

[ssh]
enabled = true
version = ${spec.banner ?? DEFAULT_BANNER}
listen_endpoints = tcp:2222:interface=0.0.0.0
sftp_enabled = true
# Abuse prevention (BREAKDOWN 7.12): the decoy can never be used as a proxy or tunnel endpoint.
forwarding = false
forward_redirect = false
forward_tunnel = false

[telnet]
enabled = false

[output_jsonlog]
enabled = true
logfile = \${honeypot:log_path}/cowrie.json
epoch_timestamp = false

[output_textlog]
enabled = false
`;
}

/**
 * userdb.txt (`user:x:password`, Cowrie format). Contains the leaked bait credential, which is secret-ish,
 * so unlike the rest of the SSH config it is written under .lxs/secrets/ (git-ignored).
 */
export function renderUserdb(spec: SshSpec, tokens: HoneytokenFile): string {
  const pairs = spec.credentials === 'weak-defaults' ? WEAK_DEFAULTS : spec.credentials;
  const { user, password } = tokens.credentials.ssh;
  const lines = [
    `${GENERATED_HEADER_HASH} Contains bait credentials: never commit.`,
    ...pairs.map(([u, p]) => `${u}:x:${p}`),
    `${user}:x:${password}`,
  ];
  return `${lines.join('\n')}\n`;
}

const csvEscape = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Files overlaid on the persona's honeyfs at container start: the planted honeytoken and the canary export. */
export function renderHoneyfs(spec: SshSpec, tokens: HoneytokenFile): Map<string, string> {
  const files = new Map<string, string>();
  const api = tokens.tokens.find((t) => t.kind === 'api_key');
  if (api) {
    files.set(
      'home/deploy/.config/acme.json',
      `${JSON.stringify(
        {
          api_base: 'https://api.acme-internal.example/v1',
          api_key: api.value,
          environment: 'production',
        },
        null,
        2,
      )}\n`,
    );
  }
  const header = 'id,name,email,phone,company,plan,card_last4';
  const rows = tokens.canary.rows.map((r) =>
    [r.id, r.name, r.email, r.phone, r.company, r.plan, r.card_last4]
      .map((v) => csvEscape(String(v)))
      .join(','),
  );
  files.set('srv/exports/customer_data.csv', `${[header, ...rows].join('\n')}\n`);
  if (spec.persona === 'db-backup') {
    const db = tokens.tokens.find((t) => t.kind === 'db_url');
    if (db) {
      files.set(
        'home/deploy/backup.env',
        `# nightly pg_dump credentials\nDATABASE_URL=${db.value}\nBACKUP_DIR=/srv/backups\nRETENTION_DAYS=14\n`,
      );
    }
  }
  return files;
}
