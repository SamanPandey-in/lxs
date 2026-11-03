import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const sha256 = (input: string | Buffer): Buffer =>
  createHash('sha256').update(input).digest();
export const sha256hex = (input: string | Buffer): string => sha256(input).toString('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

const B64 = (b: Buffer) => b.toString('base64url');

/** Signed, expiring token: base64url(json).hmac */
export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = B64(Buffer.from(JSON.stringify(payload)));
  const sig = B64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T extends { exp?: number }>(token: string, secret: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** ds_live_<32 random chars>. `prefix` (first 12 chars) is safe to display. */
export function generateIngestKey(): { key: string; prefix: string; hash: Buffer } {
  const key = `ds_live_${randomString(32)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export const DEV_INGEST_KEY = `ds_dev_${'0'.repeat(40)}`;
