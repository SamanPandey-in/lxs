/**
 * Single-use emailed tokens (email verification, password reset, invites).
 *
 * Selector/verifier split: the token is `<row id>.<secret>`. The row is found by
 * its id, and only sha256(secret) is stored, compared in constant time. A database
 * leak therefore yields no usable links, and lookups never compare secrets with
 * a short-circuiting `=`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, no padding

export interface MintedToken {
  id: string;
  token: string;
  hash: Buffer;
}

export function mintToken(): MintedToken {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return { id, token: `${id}.${secret}`, hash: sha256(secret) };
}

/** Split a presented token; null when it is not shaped like one of ours. */
export function parseToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 128) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID_RE.test(id) || !SECRET_RE.test(secret)) return null;
  return { id: id.toLowerCase(), secret };
}

/** Constant-time check of a presented secret against the stored sha256. */
export function secretMatches(secret: string, storedHash: Buffer | null | undefined): boolean {
  if (!storedHash || storedHash.length !== 32) return false;
  return timingSafeEqual(sha256(secret), storedHash);
}

export const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
