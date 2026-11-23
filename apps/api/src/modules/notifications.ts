import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notificationChannels, notificationDeliveries } from '../db/schema.js';
import { env } from '../env.js';
import { formatTest, generateSigningSecret } from '../lib/alert-delivery.js';
import { audit } from '../lib/audit.js';
import { decryptSecret, encryptSecret } from '../lib/channel-crypto.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import { isUuid, projectAccess, requireSession } from '../plugins/auth-session.js';
import { recordResult, sendChannelPayload } from '../worker/notify-incident.js';

/**
 * Create-time SSRF guard: https only (http allowed outside production), no literal
 * private/loopback/link-local hosts. Delivery re-checks the resolved address at send time.
 */
export function safeUrl(u: string, allowPrivate = env.NOTIFY_ALLOW_PRIVATE): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && x.protocol === 'http:'))
      return false;
    if (x.username || x.password) return false;
    if (allowPrivate && env.NODE_ENV !== 'production') return true;
    const h = x.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      h.endsWith('.internal')
    )
      return false;
    if (
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
        h,
      ) ||
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
  url: z
    .string()
    .url()
    .max(1024)
    .refine((u) => safeUrl(u), 'URL must be public https'),
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
    target: maskUrl(c.urlEncrypted),
    signed: !!c.secretEncrypted,
    last_status: c.lastStatus,
    last_error: c.lastError,
    last_delivered_at: iso(c.lastDeliveredAt),
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
    // Generic webhooks are signed; the secret is returned once, here, and stored encrypted.
    const secret = b.type === 'webhook' ? generateSigningSecret() : null;
    const [c] = await db
      .insert(notificationChannels)
      .values({
        projectId: project.id,
        type: b.type,
        name: b.name,
        urlEncrypted: encryptSecret(b.url),
        secretEncrypted: secret ? encryptSecret(secret) : null,
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
    return reply.status(201).send(secret ? { ...view(c!), signing_secret: secret } : view(c!));
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

  // Sends a real test message through the same transport as incident alerts.
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
    const [d] = await db
      .insert(notificationDeliveries)
      .values({ channelId: c.id, projectId: project.id, kind: 'test', severity: 'test' })
      .returning({ id: notificationDeliveries.id });
    const r = await sendChannelPayload(
      c,
      formatTest(c.type, c.name, env.DASHBOARD_URL, project.id),
    );
    await recordResult(c.id, d?.id ?? null, r);
    return { ok: r.delivered, delivered: r.delivered, status: r.status, error: r.error };
  });
}

/** Scheme + host + a hint of the path, so a webhook token in the URL is never echoed back. */
function maskUrl(buf: Buffer): string | null {
  try {
    const u = new URL(decryptSecret(buf));
    const path = u.pathname.length > 1 ? `/${u.pathname.split('/')[1]?.slice(0, 12) ?? ''}/…` : '';
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}
