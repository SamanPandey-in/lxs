import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { decryptSecretWithInfo, encryptSecret } from '../lib/channel-crypto.js';
import { db, sql } from './client.js';
import { notificationChannels } from './schema.js';

/**
 * Rewrite notification channel secrets stored in the legacy format (key derived from
 * SESSION_SECRET) with the versioned ENCRYPTION_KEY format. Run once after setting
 * ENCRYPTION_KEY, while SESSION_SECRET is still the value the rows were written with.
 * Idempotent: rows already in the current format are left alone.
 */
export async function reencryptChannels(): Promise<{
  total: number;
  updated: number;
  failed: number;
}> {
  const rows = await db.select().from(notificationChannels);
  let updated = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const url = decryptSecretWithInfo(r.urlEncrypted);
      const secret = r.secretEncrypted ? decryptSecretWithInfo(r.secretEncrypted) : null;
      if (!url.legacy && !secret?.legacy) continue;
      await db
        .update(notificationChannels)
        .set({
          urlEncrypted: encryptSecret(url.plain),
          ...(secret ? { secretEncrypted: encryptSecret(secret.plain) } : {}),
        })
        .where(eq(notificationChannels.id, r.id));
      updated++;
    } catch {
      failed++;
      console.error(
        `channel ${r.id}: cannot decrypt with ENCRYPTION_KEY or the legacy key; skipped`,
      );
    }
  }
  return { total: rows.length, updated, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  reencryptChannels()
    .then(async (r) => {
      console.log(`channels: ${r.total} total, ${r.updated} re-encrypted, ${r.failed} failed`);
      await sql.end();
      if (r.failed) process.exit(1);
    })
    .catch(async (err) => {
      console.error(err);
      await sql.end();
      process.exit(1);
    });
}
