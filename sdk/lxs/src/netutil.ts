import { isIP } from 'node:net';

export interface ParsedIp {
  v: 4 | 6;
  n: bigint;
}

export function stripMapped(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function v4ToBig(ip: string): bigint {
  const p = ip.split('.').map(Number);
  return (
    (BigInt(p[0] ?? 0) << 24n) |
    (BigInt(p[1] ?? 0) << 16n) |
    (BigInt(p[2] ?? 0) << 8n) |
    BigInt(p[3] ?? 0)
  );
}

function v6ToBig(ip: string): bigint {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = v4ToBig(tail);
    s =
      s.slice(0, lastColon + 1) +
      ((v4 >> 16n) & 0xffffn).toString(16) +
      ':' +
      (v4 & 0xffffn).toString(16);
  }
  const [head = '', rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - h.length - t.length;
  const groups = rest === undefined ? h : [...h, ...Array(Math.max(missing, 0)).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g || '0', 16)), 0n);
}

export function parseIp(raw: string): ParsedIp | null {
  const ip = stripMapped(raw);
  const k = isIP(ip);
  if (k === 4) return { v: 4, n: v4ToBig(ip) };
  if (k === 6) return { v: 6, n: v6ToBig(ip) };
  return null;
}

export type CidrMatcher = (ip: ParsedIp) => boolean;

export function parseCidr(spec: string): CidrMatcher | null {
  const [addr = '', bitsRaw] = spec.split('/');
  const base = parseIp(addr);
  if (!base) return null;
  const max = base.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number.parseInt(bitsRaw, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  const prefix = base.n >> shift;
  return (ip) => ip.v === base.v && ip.n >> shift === prefix;
}

const NAMED: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
};

/** Build a predicate from CIDRs / named ranges ('loopback', 'uniquelocal'). Invalid entries are ignored. */
export function buildIpPredicate(
  specs: readonly string[] | undefined,
): ((ip: string) => boolean) | null {
  if (!specs || specs.length === 0) return null;
  const matchers: CidrMatcher[] = [];
  for (const s of specs) {
    for (const c of NAMED[s] ?? [s]) {
      const m = parseCidr(c);
      if (m) matchers.push(m);
    }
  }
  if (matchers.length === 0) return null;
  return (ip) => {
    const p = parseIp(ip);
    return p ? matchers.some((m) => m(p)) : false;
  };
}

export function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0;
}
