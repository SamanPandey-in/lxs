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
  /**
   * Per-deployment HMAC key (base64, 32 bytes) for per-visitor honeytokens: ds-web derives a unique
   * API key per visitor session from it, and ds-agent re-derives the same value to recognise it.
   * Absent in files written before per-visitor tokens; ds-web then serves the static token.
   */
  mint_secret?: string;
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
const SYMBOLS = ['!', '#', '$', '%', '*', '-', '_', '.'];
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
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

const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const pickChar = (set: string): string => set[randomInt(set.length)] as string;

/**
 * A DB password that looks like one a person or a password manager chose, not 20 base62 characters.
 * Crypto randomness, not the build seed: the value is honeytoken plaintext and never committed.
 */
export function realisticDbPassword(): string {
  const style = randomInt(3);
  if (style === 0) {
    // Two capitalised words, digits, a symbol: "CopperMeadow2291!".
    const a = WORDS[randomInt(WORDS.length)] as string;
    let b = WORDS[randomInt(WORDS.length)] as string;
    while (b === a) b = WORDS[randomInt(WORDS.length)] as string;
    return `${a}${b}${randomInt(10, 10_000)}${SYMBOLS[randomInt(SYMBOLS.length)]}`;
  }
  if (style === 1) {
    // Generator style in dash-separated groups: "pK7v-x9Qm-T2wb-h4Rz".
    const group = (): string =>
      Array.from({ length: 4 }, () => pickChar(randomInt(3) === 0 ? DIGITS : LOWER + UPPER)).join(
        '',
      );
    return Array.from({ length: 4 }, group).join('-');
  }
  // 16-24 mixed characters with at least one of each class.
  const all = LOWER + UPPER + DIGITS + SYMBOLS.join('');
  const len = randomInt(16, 25);
  const chars = [pickChar(LOWER), pickChar(UPPER), pickChar(DIGITS), pickChar('!#%*-_.')];
  while (chars.length < len) chars.push(pickChar(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
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
  const prevPass = prevDb?.value.split(':')[2]?.split('@')[0];
  const dbPass = prevPass ? safeDecode(prevPass) : realisticDbPassword();
  tokens.push({
    id: 'ht_db_01',
    kind: 'db_url',
    value: `postgres://svc_reporting:${encodeURIComponent(dbPass)}@db-backup-01.internal:5432/${cfg.options.service}_prod`,
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
    // Reused across builds: rotating it would orphan every token minted so far.
    mint_secret:
      existing?.mint_secret && /^[A-Za-z0-9+/]{43}=$/.test(existing.mint_secret)
        ? existing.mint_secret
        : randomBytes(32).toString('base64'),
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
