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

const MAPPED_PREFIX = 0xffffn;

/**
 * Parses an IPv4 or IPv6 address (an IPv6 zone is ignored). IPv4-mapped IPv6 addresses
 * (::ffff:a.b.c.d, in dotted or hex form) are returned as IPv4, so one client has one identity.
 */
export function parseIp(raw: string): ParsedIp | null {
  const ip = stripMapped(raw);
  const k = isIP(ip);
  if (k === 4) return { v: 4, n: v4ToBig(ip) };
  if (k === 6) {
    const n = v6ToBig(ip);
    if (n >> 32n === MAPPED_PREFIX) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  return null;
}

/** Canonical text form: dotted IPv4, or RFC 5952 IPv6 (lowercase, longest zero run compressed). */
export function formatIp(p: ParsedIp): string {
  if (p.v === 4) return [24n, 16n, 8n, 0n].map((s) => Number((p.n >> s) & 0xffn)).join('.');
  const g = Array.from({ length: 8 }, (_, i) => Number((p.n >> BigInt(112 - i * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 1; // a single zero group is never compressed
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (a: number[]): string => a.map((x) => x.toString(16)).join(':');
  if (best < 0) return hex(g);
  return `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

/** The canonical form of an address, or null if it is not one. */
export function canonicalIp(raw: string): string | null {
  const p = parseIp(raw);
  return p ? formatIp(p) : null;
}

export type CidrMatcher = (ip: ParsedIp) => boolean;

interface Cidr {
  base: ParsedIp;
  bits: number;
}

/**
 * 'addr' or 'addr/bits'. bits is plain decimal. An IPv4-mapped IPv6 prefix (::ffff:a.b.c.d/96..128)
 * is the IPv4 prefix with 96 fewer bits; a shorter mapped prefix is rejected.
 */
function parseCidrSpec(spec: string): Cidr | null {
  const parts = spec.split('/');
  if (parts.length > 2) return null;
  const [addr = '', bitsRaw] = parts;
  const base = parseIp(addr);
  if (!base) return null;
  const writtenAsV6 = addr.includes(':');
  const max = writtenAsV6 ? 128 : 32;
  if (bitsRaw !== undefined && !/^[0-9]{1,3}$/.test(bitsRaw)) return null;
  let bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (bits > max) return null;
  if (writtenAsV6 && base.v === 4) {
    if (bits < 96) return null;
    bits -= 96;
  }
  return { base, bits };
}

export function parseCidr(spec: string): CidrMatcher | null {
  const c = parseCidrSpec(spec);
  if (!c) return null;
  const shift = BigInt((c.base.v === 4 ? 32 : 128) - c.bits);
  const prefix = c.base.n >> shift;
  const v = c.base.v;
  return (ip) => ip.v === v && ip.n >> shift === prefix;
}

/** True for a valid CIDR whose prefix length is 0 (0.0.0.0/0, ::/0, ::ffff:0.0.0.0/96): it matches every address of its family. */
export function isMatchAll(spec: string): boolean {
  const c = parseCidrSpec(spec);
  return c !== null && spec.includes('/') && c.bits === 0;
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
