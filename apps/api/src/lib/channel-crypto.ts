import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DEV_ENCRYPTION_KEY, decodeKey32, env } from '../env.js';

/**
 * Encryption for notification channel secrets (webhook URLs, signing secrets).
 *
 * Current format:  [version:1][iv:12][tag:16][ciphertext]   (AES-256-GCM, key from ENCRYPTION_KEY)
 * Legacy format:   [iv:12][tag:16][ciphertext]              (key = sha256("channels:" + SESSION_SECRET))
 *
 * Decrypt tries the versioned format first, then the legacy derivation, so rows written
 * before ENCRYPTION_KEY existed keep working until `db:reencrypt-channels` rewrites them.
 */
export const KEY_VERSION = 1;

export interface Keyring {
  current: Buffer;
  version: number;
  legacy: Buffer | null;
}

export function encryptionKeyFrom(value: string): Buffer {
  if (value === DEV_ENCRYPTION_KEY) return createHash('sha256').update(`lxs-dev:${value}`).digest();
  const k = decodeKey32(value);
  if (!k) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  return k;
}

export const legacyKeyFrom = (sessionSecret: string): Buffer =>
  createHash('sha256').update(`channels:${sessionSecret}`).digest();

let cached: Keyring | null = null;
export function keyring(): Keyring {
  cached ??= {
    current: encryptionKeyFrom(env.ENCRYPTION_KEY),
    version: KEY_VERSION,
    legacy: legacyKeyFrom(env.SESSION_SECRET),
  };
  return cached;
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function encryptSecret(plain: string, ring: Keyring = keyring()): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ring.current, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([ring.version]), iv, c.getAuthTag(), enc]);
}

/** Decrypt and report whether the row still uses the legacy format (needs re-encryption). */
export function decryptSecretWithInfo(
  buf: Buffer,
  ring: Keyring = keyring(),
): { plain: string; legacy: boolean } {
  if (buf.length >= 29 && buf[0] === ring.version) {
    try {
      return {
        plain: gcmDecrypt(
          ring.current,
          buf.subarray(1, 13),
          buf.subarray(13, 29),
          buf.subarray(29),
        ),
        legacy: false,
      };
    } catch {
      /* a legacy IV can start with the version byte by chance: fall through */
    }
  }
  if (ring.legacy && buf.length >= 28) {
    return {
      plain: gcmDecrypt(ring.legacy, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28)),
      legacy: true,
    };
  }
  throw new Error('cannot decrypt channel secret');
}

export const decryptSecret = (buf: Buffer, ring?: Keyring): string =>
  decryptSecretWithInfo(buf, ring).plain;
