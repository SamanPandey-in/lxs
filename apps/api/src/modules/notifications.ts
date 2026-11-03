import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notificationChannels } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import { isUuid, projectAccess, requireSession } from '../plugins/auth-session.js';

const key = createHash('sha256').update(`channels:${env.SESSION_SECRET}`).digest();

export function encryptUrl(url: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(url, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function decryptUrl(buf: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** SSRF guard: https only, no literal private/loopback/link-local hosts. (Delivery itself is not wired in the MVP API.) */
function safeUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && x.protocol === 'http:'))
      return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
      h === '::1' ||
      h.startsWith('[')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

const Create = z.object({
  type: z.enum(['slack', 'webhook']),
  name: z.string().min(1).max(64),
  url: z.string().url().max(1024).refine(safeUrl, 'URL must be public https'),
  min_severity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  labels: z.array(z.enum(['noise', 'opportunistic', 'targeted'])).default(['targeted']),
  enabled: z.boolean().default(true),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };
  const view = (c: typeof notificationChannels.$inferSelect) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    min_severity: c.minSeverity,
    labels: c.labels,
    enabled: c.enabled,
    last_status: c.lastStatus,
    created_at: iso(c.createdAt),
  });

  app.get('/v1/projects/:pid/notification-channels', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'owner');
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.projectId, project.id))
      .orderBy(desc(notificationChannels.createdAt));
    return { items: rows.map(view) };
  });

  app.post('/v1/projects/:pid/notification-channels', auth, async (req, reply) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const b = parse(Create, req.body);
    const [c] = await db
      .insert(notificationChannels)
      .values({
        projectId: project.id,
        type: b.type,
        name: b.name,
        urlEncrypted: encryptUrl(b.url),
        minSeverity: b.min_severity,
        labels: b.labels,
        enabled: b.enabled,
      })
      .returning();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'channel.create',
      targetType: 'notification_channel',
      targetId: c!.id,
      metadata: { type: b.type, name: b.name },
      req,
    });
    return reply.status(201).send(view(c!));
  });

  app.delete('/v1/projects/:pid/notification-channels/:cid', auth, async (req, reply) => {
    const { pid, cid } = req.params as { pid: string; cid: string };
    const { project, user } = await projectAccess(req, pid, 'owner');
    if (!isUuid(cid)) throw notFound('Channel');
    const rows = await db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.id, cid), eq(notificationChannels.projectId, project.id)))
      .returning({ id: notificationChannels.id });
    if (!rows.length) throw notFound('Channel');
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'channel.delete',
      targetType: 'notification_channel',
      targetId: cid,
      req,
    });
    return reply.status(204).send();
  });

  // Delivery is not implemented in the MVP API; the test endpoint validates configuration only.
  app.post('/v1/projects/:pid/notification-channels/:cid/test', auth, async (req) => {
    const { pid, cid } = req.params as { pid: string; cid: string };
    const { project } = await projectAccess(req, pid, 'owner');
    if (!isUuid(cid)) throw notFound('Channel');
    const [c] = await db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.id, cid), eq(notificationChannels.projectId, project.id)))
      .limit(1);
    if (!c) throw notFound('Channel');
    return {
      ok: safeUrl(decryptUrl(c.urlEncrypted)),
      delivered: false,
      note: 'Delivery is stubbed in the MVP; configuration validated only.',
    };
  });
}
