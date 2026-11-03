import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { ResolvedConfig } from '../types.js';

export interface HoneytokenEntry {
  id: string;
  kind: 'api_key' | 'db_url';
  /** Plaintext. Lives only in .lxs/secrets/ (git-ignored). Only sha256 hashes ever leave the host. */
  value: string;
  header?: 'authorization' | 'x-api-key';
  prefix?: string;
  planted_in: string[];
}

export interface CanaryRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  company: string;
  plan: string;
  card_last4: string;
}

export interface HoneytokenFile {
  version: 1;
  generated_at: string;
  tokens: HoneytokenEntry[];
  /** Bait login leaked in /.env: not a platform-registered token, but its use on the SSH decoy chains the incident. */
  credentials: { ssh: { user: string; password: string } };
  canary: { rows: CanaryRow[] };
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomBase62(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += B62[(bytes[i] as number) % 62];
  return out;
}

const FIRST = [
  'maria',
  'james',
  'priya',
  'chen',
  'olivia',
  'lucas',
  'amara',
  'noah',
  'sofia',
  'liam',
  'yuki',
  'ethan',
];
const LAST = [
  'okafor',
  'nguyen',
  'patel',
  'garcia',
  'kowalski',
  'silva',
  'haddad',
  'mueller',
  'tanaka',
  'reyes',
];
const COMPANIES = [
  'Northwind Traders',
  'Contoso Retail',
  'Fabrikam Goods',
  'Tailspin Supply',
  'Adatum Foods',
  'Litware Home',
];
const PLANS = ['starter', 'growth', 'enterprise'];
const WORDS = ['Summer', 'Winter', 'Autumn', 'Spring', 'Harbor', 'Falcon', 'Copper', 'Meadow'];

function canaryRow(i: number): CanaryRow {
  const first = FIRST[randomInt(FIRST.length)] as string;
  const last = LAST[randomInt(LAST.length)] as string;
  const tag = randomBytes(3).toString('hex');
  return {
    id: 1000 + i,
    name: `${first[0]?.toUpperCase()}${first.slice(1)} ${last[0]?.toUpperCase()}${last.slice(1)}`,
    // example.com is reserved: the data is obviously fake to a human, and the unique tag makes each row a tripwire.
    email: `${first}.${last}.${tag}@example.com`,
    phone: `+1-555-01${String(randomInt(100)).padStart(2, '0')}`,
    company: COMPANIES[randomInt(COMPANIES.length)] as string,
    plan: PLANS[randomInt(PLANS.length)] as string,
    card_last4: '4242',
  };
}

/**
 * Generate (or refresh) the honeytoken set. Values already on disk are reused when still valid so that
 * `build` is idempotent and decoys do not rotate secrets on every run.
 */
export function generateHoneytokens(
  cfg: ResolvedConfig,
  existing: HoneytokenFile | null,
  now: Date = new Date(),
): HoneytokenFile {
  const web = cfg.decoys.flatMap((d) =>
    (d.type === 'web-bait' && (d.template === 'dotenv' || d.template === 'sql-dump')) ||
    d.type === 'web-admin'
      ? [`web:${d.mount}`]
      : [],
  );
  const ssh = cfg.decoys.flatMap((d) =>
    d.type === 'ssh' ? [`${d.id}:/home/deploy/.config/acme.json`] : [],
  );
  const planted = [...web, ...ssh];

  const tokens: HoneytokenEntry[] = [];
  const apiCfg = cfg.honeytokens?.apiKey;
  if (apiCfg) {
    const prev = existing?.tokens.find((t) => t.id === 'ht_api_01' && t.prefix === apiCfg.prefix);
    tokens.push({
      id: 'ht_api_01',
      kind: 'api_key',
      value: prev?.value ?? `${apiCfg.prefix}${randomBase62(32)}`,
      header: apiCfg.header,
      prefix: apiCfg.prefix,
      planted_in: planted,
    });
  }
  const prevDb = existing?.tokens.find((t) => t.id === 'ht_db_01');
  const dbPass = prevDb
    ? (prevDb.value.split(':')[2]?.split('@')[0] ?? randomBase62(20))
    : randomBase62(20);
  tokens.push({
    id: 'ht_db_01',
    kind: 'db_url',
    value: `postgres://svc_reporting:${dbPass}@db-backup-01.internal:5432/${cfg.options.service}_prod`,
    planted_in: web,
  });

  const wanted = cfg.honeytokens?.canaryRows ?? 5;
  const prevRows = existing?.canary.rows ?? [];
  const rows =
    prevRows.length === wanted ? prevRows : Array.from({ length: wanted }, (_, i) => canaryRow(i));

  return {
    version: 1,
    generated_at: existing?.generated_at ?? now.toISOString(),
    tokens,
    credentials: {
      ssh: existing?.credentials.ssh ?? {
        user: 'deploy',
        password: `${WORDS[randomInt(WORDS.length)]}${randomInt(1000, 9999)}!`,
      },
    },
    canary: { rows },
  };
}

/** Hash map handed to the agent (never the plaintext) so the SDK can recognise token use. */
export function tokenHashes(file: HoneytokenFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of file.tokens) if (t.kind === 'api_key') out[sha256Hex(t.value)] = t.id;
  return out;
}

export function parseHoneytokenFile(text: string): HoneytokenFile | null {
  try {
    const j = JSON.parse(text) as HoneytokenFile;
    return j &&
      j.version === 1 &&
      Array.isArray(j.tokens) &&
      j.credentials?.ssh &&
      Array.isArray(j.canary?.rows)
      ? j
      : null;
  } catch {
    return null;
  }
}

export const SECRETS_GITIGNORE =
  '# Generated by lxs — honeytoken plaintext. Never commit.\n*\n!.gitignore\n';
