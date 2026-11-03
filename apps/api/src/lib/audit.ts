import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

export interface AuditEntry {
  orgId: string;
  projectId?: string | null;
  actorType: 'user' | 'api_key' | 'system';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  req?: FastifyRequest;
}

/** Append-only audit writer. Never put secrets in `metadata`. */
export async function audit(dbx: DbOrTx, e: AuditEntry): Promise<void> {
  await dbx.insert(auditLogs).values({
    orgId: e.orgId,
    projectId: e.projectId ?? null,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    metadata: e.metadata ?? {},
    ip: e.req && /^[0-9a-f.:]+$/i.test(e.req.ip) ? e.req.ip : null,
    userAgent: e.req?.headers['user-agent']?.slice(0, 256) ?? null,
  });
}
