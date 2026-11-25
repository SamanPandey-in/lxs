import { createHmac } from 'node:crypto';

/**
 * Per-visitor honeytokens. A token is derived, never stored:
 *
 *   tag     = base32(HMAC(secret, "mint|<base id>|<ip>|<session>"))[0..12]
 *   mint id = "<base id>.<tag>"                          e.g. ht_api_01.k3j9q2m7x4ab
 *   value   = prefix + base62(HMAC(secret, "value|<mint id>"))[0..32]
 *
 * The same visitor (IP + PHPSESSID, or IP alone without the cookie) always gets the same token, so a
 * refetch does not hand out a second one. ds-agent holds the same secret and re-derives the value from
 * the mint id in the `mint` log line, so a forged log line can only register values the secret makes.
 * apps/agent/src/mint.ts implements the same derivation; both test suites pin the same vector.
 */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const MINT_TAG_LEN = 12;
export const MINT_VALUE_LEN = 32;

function base32(buf: Buffer, n: number): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < n) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= n) break;
  }
  return out;
}

/** The secret from honeytokens.json, or null when it is missing or malformed (static token then). */
export function parseMintSecret(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v)) return null;
  return Buffer.from(v, 'base64');
}

export function mintId(secret: Buffer, baseId: string, ip: string, session: string): string {
  const mac = createHmac('sha256', secret).update(`mint|${baseId}|${ip}|${session}`).digest();
  return `${baseId}.${base32(mac, MINT_TAG_LEN)}`;
}

export function mintedValue(secret: Buffer, id: string, prefix: string): string {
  const mac = createHmac('sha256', secret).update(`value|${id}`).digest();
  let out = '';
  for (let i = 0; i < MINT_VALUE_LEN; i++) out += B62[(mac[i] as number) % 62];
  return `${prefix}${out}`;
}

export interface MintedToken {
  baseId: string;
  id: string;
  value: string;
}

export function mintToken(
  secret: Buffer,
  base: { id: string; prefix?: string },
  ip: string,
  session: string,
): MintedToken {
  const id = mintId(secret, base.id, ip, session);
  return { baseId: base.id, id, value: mintedValue(secret, id, base.prefix ?? '') };
}
