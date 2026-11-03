import fs from 'node:fs';

export interface WebDecoyConfig {
  id: string;
  type: 'web-admin' | 'web-bait';
  mount: string;
  brand?: string;
  acceptCredentials?: Array<[string, string]>;
  acceptAfter?: number;
  panel?: 'customers' | 'none';
  template?: 'dotenv' | 'sql-dump' | 'git-config' | 'wp-login' | 'phpmyadmin';
  breadcrumbs?: boolean;
}

export interface WebDecoysFile {
  decoys: WebDecoyConfig[];
  service?: string;
  breadcrumbs?: {
    ssh?: { host: string; port: number; user: string } | null;
    adminMount?: string | null;
  };
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

export interface HoneytokenSet {
  tokens: Array<{ id: string; kind: string; value: string; prefix?: string }>;
  credentials: { ssh: { user: string; password: string } };
  canary: { rows: CanaryRow[] };
}

/** Used when the honeytoken file is not mounted: obviously fake, never registered with the platform. */
export const FALLBACK_HONEYTOKENS: HoneytokenSet = {
  tokens: [],
  credentials: { ssh: { user: 'deploy', password: 'Winter2024!' } },
  canary: {
    rows: [
      {
        id: 1001,
        name: 'Maria Okafor',
        email: 'maria.okafor@example.com',
        phone: '+1-555-0142',
        company: 'Northwind Traders',
        plan: 'growth',
        card_last4: '4242',
      },
      {
        id: 1002,
        name: 'James Nguyen',
        email: 'james.nguyen@example.com',
        phone: '+1-555-0177',
        company: 'Contoso Retail',
        plan: 'starter',
        card_last4: '4242',
      },
      {
        id: 1003,
        name: 'Priya Patel',
        email: 'priya.patel@example.com',
        phone: '+1-555-0118',
        company: 'Fabrikam Goods',
        plan: 'enterprise',
        card_last4: '4242',
      },
    ],
  },
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadDecoys(file: string): WebDecoysFile {
  const j = readJson<WebDecoysFile>(file);
  if (!j || !Array.isArray(j.decoys))
    throw new Error(`ds-web: cannot read decoy config at ${file}`);
  return j;
}

export function loadHoneytokens(file: string): HoneytokenSet {
  const j = readJson<HoneytokenSet>(file);
  if (!j || !Array.isArray(j.tokens) || !j.canary?.rows) return FALLBACK_HONEYTOKENS;
  return j;
}
