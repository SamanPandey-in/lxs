import { sql as dsql, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/client.js';
import { apiKeys, projects } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface IngestAuth {
  keyId: string;
  keyPrefix: string;
  projectId: string;
  orgId: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    ingest?: IngestAuth;
  }
}

interface CacheEntry {
  auth: IngestAuth;
  expires: number;
  touchedAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, CacheEntry>(); // insertion-ordered => simple LRU

/**
 * Ingest-key auth: `Authorization: Bearer ds_<prefix>_<secret>` → sha256 → api_keys.key_hash.
 * Result cached 60 s (revocation takes effect within a minute); last_used_at touched at most once a minute.
 */
export async function authenticateKey(
  header: string | undefined,
  requiredScope = 'ingest',
): Promise<IngestAuth> {
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token', 'missing_key');
  const token = header.slice(7).trim();
  if (!/^ds_[a-z]+_[A-Za-z0-9]{8,}$/.test(token))
    throw unauthorized('Malformed API key', 'invalid_key');
  const hash = sha256(token);
  const ck = hash.toString('hex');
  const now = Date.now();

  let entry = cache.get(ck);
  if (entry && entry.expires > now) {
    cache.delete(ck);
    cache.set(ck, entry);
  } else {
    cache.delete(ck);
    const rows = await db
      .select({
        id: apiKeys.id,
        prefix: apiKeys.prefix,
        projectId: apiKeys.projectId,
        scopes: apiKeys.scopes,
        revokedAt: apiKeys.revokedAt,
        orgId: projects.orgId,
        archivedAt: projects.archivedAt,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);
    const row = rows[0];
    if (!row) throw unauthorized('Unknown API key', 'invalid_key');
    if (row.revokedAt) throw forbidden('API key has been revoked', 'key_revoked');
    if (row.archivedAt) throw forbidden('Project is archived', 'project_archived');
    entry = {
      auth: {
        keyId: row.id,
        keyPrefix: row.prefix,
        projectId: row.projectId,
        orgId: row.orgId,
        scopes: row.scopes,
      },
      expires: now + TTL_MS,
      touchedAt: 0,
    };
    cache.set(ck, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }

  if (!entry.auth.scopes.includes(requiredScope))
    throw forbidden('API key lacks required scope', 'wrong_scope');
  if (now - entry.touchedAt > 60_000) {
    entry.touchedAt = now;
    void db
      .update(apiKeys)
      .set({ lastUsedAt: dsql`now()` })
      .where(eq(apiKeys.id, entry.auth.keyId))
      .catch(() => {});
  }
  return entry.auth;
}

/** Drop cached key lookups (called when a key is revoked in this process). */
export function evictKeyCache(): void {
  cache.clear();
}

/** preHandler: requires a valid ingest key; attaches `req.ingest`. */
export async function requireIngestKey(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.ingest = await authenticateKey(req.headers.authorization);
}

export default fp(async function bearerKey(app: FastifyInstance) {
  app.decorateRequest('ingest', undefined);
});
