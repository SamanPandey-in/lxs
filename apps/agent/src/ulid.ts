import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 80 bits -> 16 base32 chars. */
function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  return out.slice(0, 16);
}

export function ulid(ms: number = Date.now()): string {
  return encodeTime(ms) + encodeRandom(randomBytes(10));
}

/**
 * Valid ULID whose random part is derived from `seed`. Replaying the same log line after a crash yields the
 * same event id, so the platform's (project_id, event_id) uniqueness absorbs the duplicate.
 */
export function deterministicUlid(ms: number, seed: string): string {
  return encodeTime(ms) + encodeRandom(createHash('sha256').update(seed).digest().subarray(0, 10));
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
