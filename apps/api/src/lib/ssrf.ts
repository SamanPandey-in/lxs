import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Send-time SSRF guard for outbound alert delivery.
 *
 * `blockedReason` classifies a literal IP. `safeLookup` is passed to http(s).request as its
 * `lookup`, so the address that is vetted is the address the socket connects to: a DNS
 * answer cannot change between the check and the connect (no rebinding window).
 */

function v4Reason(o: number[]): string | null {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'documentation';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';
  if (a === 198 && b === 51 && c === 100) return 'documentation';
  if (a === 203 && b === 0 && c === 113) return 'documentation';
  if (a >= 224) return a < 240 ? 'multicast' : 'reserved';
  return null;
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** 8 hextets, or null. Accepts `::`, a trailing dotted quad, and strips a zone id. */
export function parseV6(input: string): number[] | null {
  let ip = input.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (!ip.includes(':')) return null;
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.', lastColon)) {
    const v4 = parseV4(ip.slice(lastColon + 1));
    if (!v4) return null;
    const hex = (n: number) => n.toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hex((v4[0]! << 8) | v4[1]!)}:${hex((v4[2]! << 8) | v4[3]!)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toNums = (s: string) =>
    s === ''
      ? []
      : s.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : -1));
  const head = toNums(halves[0]!);
  const rest = halves.length === 2 ? toNums(halves[1]!) : [];
  if ([...head, ...rest].some((n) => n < 0)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

const embeddedV4 = (h: number[], i: number) => [
  h[i]! >> 8,
  h[i]! & 255,
  h[i + 1]! >> 8,
  h[i + 1]! & 255,
];

function v6Reason(h: number[]): string | null {
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return 'unspecified';
  if (zero(0, 7) && h[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d (v4-mapped) and ::ffff:0:a.b.c.d (v4-translated): judge the IPv4 inside.
  if (zero(0, 5) && h[5] === 0xffff) return v4Reason(embeddedV4(h, 6)) ?? null;
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return v4Reason(embeddedV4(h, 6)) ?? null;
  // ::a.b.c.d (deprecated v4-compatible): never a legitimate webhook target.
  if (zero(0, 6)) return 'ipv4-compatible';
  // 64:ff9b::/96 NAT64: judge the IPv4 inside. 64:ff9b:1::/48 is local-use.
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (zero(2, 6)) return v4Reason(embeddedV4(h, 6));
    if (h[2] === 1) return 'nat64-local';
  }
  if (h[0] === 0x100 && zero(1, 4)) return 'discard';
  if (h[0] === 0x2001 && h[1] === 0) return 'teredo';
  if (h[0] === 0x2001 && h[1] === 0xdb8) return 'documentation';
  if (h[0] === 0x2002) return v4Reason(embeddedV4(h, 1)); // 6to4 carries an IPv4
  const top = h[0]!;
  if ((top & 0xfe00) === 0xfc00) return 'unique-local';
  if ((top & 0xffc0) === 0xfe80) return 'link-local';
  if ((top & 0xffc0) === 0xfec0) return 'site-local';
  if ((top & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** Why this IP must not be contacted, or null when it is a public unicast address. */
export function blockedReason(ip: string): string | null {
  const v4 = parseV4(ip);
  if (v4) return v4Reason(v4);
  const v6 = parseV6(ip);
  if (v6) return v6Reason(v6);
  return 'invalid';
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs),
    ),
  );

/** Reject a literal-IP host up front (Node skips `lookup` for literal IPs). */
export function checkLiteralHost(hostname: string, allowPrivate: boolean): void {
  const h = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (!isIP(h) || allowPrivate) return;
  const why = blockedReason(h);
  if (why) throw new SsrfError(`refused: ${h} is a ${why} address`);
}

/**
 * A `lookup` for http(s).request that resolves every address for the host and refuses the
 * connection if any of them is non-public (a mixed answer is treated as hostile).
 */
export function safeLookup(
  opts: { allowPrivate?: boolean; resolver?: Resolver } = {},
): LookupFunction {
  const resolver = opts.resolver ?? systemResolver;
  return ((
    hostname: string,
    options: { all?: boolean; family?: number | string },
    cb: (...a: unknown[]) => void,
  ) => {
    resolver(hostname).then(
      (addrs) => {
        const family = Number(options?.family) || 0;
        const usable = family ? addrs.filter((a) => a.family === family) : addrs;
        if (!usable.length) return cb(new SsrfError(`refused: ${hostname} did not resolve`));
        if (!opts.allowPrivate) {
          for (const a of addrs) {
            const why = blockedReason(a.address);
            if (why)
              return cb(
                new SsrfError(`refused: ${hostname} resolves to a ${why} address (${a.address})`),
              );
          }
        }
        if (options?.all) return cb(null, usable);
        return cb(null, usable[0]!.address, usable[0]!.family);
      },
      (err: unknown) => cb(err),
    );
  }) as unknown as LookupFunction;
}
