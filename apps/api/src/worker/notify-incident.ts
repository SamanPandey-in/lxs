import { and, sql as dsql, eq, gt, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  attackers,
  incidents,
  notificationChannels,
  notificationDeliveries,
} from '../db/schema.js';
import { env } from '../env.js';
import { enqueueNotifyIncident } from '../jobs/queue.js';
import {
  type AlertIncident,
  COOLDOWN_MS,
  type DeliveryResult,
  decide,
  formatSlack,
  formatWebhook,
  matchesChannel,
  sendToChannel,
} from '../lib/alert-delivery.js';
import { decryptSecret } from '../lib/channel-crypto.js';

type ChannelRow = typeof notificationChannels.$inferSelect;

/** A 'sending' claim older than this is treated as a crashed attempt and may be retried. */
const STALE_SENDING_MS = 2 * 60 * 1000;

/** Decrypt a channel's target and send one payload. Never throws. */
export async function sendChannelPayload(
  c: ChannelRow,
  payload: Record<string, unknown>,
): Promise<DeliveryResult> {
  let url: string;
  let secret: string | null = null;
  try {
    url = decryptSecret(c.urlEncrypted);
    if (c.secretEncrypted) secret = decryptSecret(c.secretEncrypted);
  } catch {
    return {
      delivered: false,
      status: null,
      error: 'cannot decrypt channel URL (check ENCRYPTION_KEY)',
    };
  }
  return sendToChannel({ type: c.type, url, secret }, payload, {
    allowPrivate: env.NOTIFY_ALLOW_PRIVATE && env.NODE_ENV !== 'production',
  });
}

/** Write a result to the delivery row (if any) and the channel's health columns. */
export async function recordResult(
  channelId: string,
  deliveryId: string | null,
  r: DeliveryResult,
): Promise<void> {
  if (deliveryId)
    await db
      .update(notificationDeliveries)
      .set({
        status: r.delivered ? 'ok' : 'failed',
        httpStatus: r.status,
        error: r.error,
        updatedAt: dsql`now()`,
      })
      .where(eq(notificationDeliveries.id, deliveryId));
  await db
    .update(notificationChannels)
    .set(
      r.delivered
        ? { lastStatus: 'ok', lastError: null, lastDeliveredAt: dsql`now()` }
        : { lastStatus: 'failed', lastError: r.error ?? `HTTP ${r.status}` },
    )
    .where(eq(notificationChannels.id, channelId));
}

export interface NotifyOutcome {
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
}

/**
 * pg-boss handler for `notify-incident`. Idempotent: every decision and claim is made under a
 * per-(channel, attacker) advisory lock against notification_deliveries. Throws when any
 * delivery failed, so pg-boss retries with backoff; channels that already succeeded are
 * skipped on the retry by the dedupe rule.
 */
export async function notifyIncident(incidentId: string): Promise<NotifyOutcome> {
  const out: NotifyOutcome = { sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const [inc] = await db
    .select({
      id: incidents.id,
      projectId: incidents.projectId,
      attackerId: incidents.attackerId,
      number: incidents.number,
      title: incidents.title,
      status: incidents.status,
      severity: incidents.severity,
      score: incidents.score,
      label: incidents.label,
      stages: incidents.stages,
      techniques: incidents.techniques,
      realAssetReached: incidents.realAssetReached,
      honeytokenUsed: incidents.honeytokenUsed,
      openedAt: incidents.openedAt,
      srcIp: attackers.ip,
    })
    .from(incidents)
    .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!inc || (inc.status !== 'open' && inc.status !== 'acknowledged')) return out;

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.projectId, inc.projectId),
        eq(notificationChannels.enabled, true),
      ),
    );
  const candidates = channels.filter((c) =>
    matchesChannel({ enabled: c.enabled, minSeverity: c.minSeverity, labels: c.labels }, inc),
  );
  out.skipped += channels.length - candidates.length;
  if (!candidates.length) return out;

  const alert: AlertIncident = { ...inc, srcIp: String(inc.srcIp) };
  let deferUntil: Date | null = null;
  let firstError: string | null = null;

  for (const c of candidates) {
    const claim = await db.transaction(async (tx) => {
      await tx.execute(
        dsql`select pg_advisory_xact_lock(hashtextextended(${`notify|${c.id}|${inc.attackerId}`}, 0))`,
      );
      const since = new Date(Date.now() - COOLDOWN_MS);
      const prior = await tx
        .select({
          incidentId: notificationDeliveries.incidentId,
          severity: notificationDeliveries.severity,
          status: notificationDeliveries.status,
          createdAt: notificationDeliveries.createdAt,
          updatedAt: notificationDeliveries.updatedAt,
        })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.channelId, c.id),
            eq(notificationDeliveries.kind, 'incident'),
            or(
              eq(notificationDeliveries.incidentId, inc.id),
              and(
                eq(notificationDeliveries.attackerId, inc.attackerId),
                gt(notificationDeliveries.createdAt, since),
              ),
            ),
          ),
        );
      const siblings = await tx
        .select({
          id: incidents.id,
          severity: incidents.severity,
          label: incidents.label,
          openedAt: incidents.openedAt,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.projectId, inc.projectId),
            eq(incidents.attackerId, inc.attackerId),
            inArray(incidents.status, ['open', 'acknowledged']),
            ne(incidents.id, inc.id),
          ),
        );
      const now = new Date();
      const decision = decide({
        channel: { enabled: c.enabled, minSeverity: c.minSeverity, labels: c.labels },
        incident: inc,
        prior: prior.map((p) => ({
          ...p,
          status:
            p.status === 'sending' && now.getTime() - p.updatedAt.getTime() > STALE_SENDING_MS
              ? 'failed'
              : p.status,
        })),
        siblings,
        now,
      });
      if (decision.action !== 'send') return decision;

      const staleBefore = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
      const [row] = await tx
        .insert(notificationDeliveries)
        .values({
          channelId: c.id,
          projectId: inc.projectId,
          incidentId: inc.id,
          attackerId: inc.attackerId,
          kind: 'incident',
          severity: inc.severity,
          status: 'sending',
        })
        .onConflictDoUpdate({
          target: [
            notificationDeliveries.channelId,
            notificationDeliveries.incidentId,
            notificationDeliveries.severity,
          ],
          set: {
            status: 'sending',
            attempts: dsql`${notificationDeliveries.attempts} + 1`,
            error: null,
            updatedAt: dsql`now()`,
          },
          setWhere: dsql`${notificationDeliveries.status} = 'failed' or (${notificationDeliveries.status} = 'sending' and ${notificationDeliveries.updatedAt} < ${staleBefore}::timestamptz)`,
        })
        .returning({ id: notificationDeliveries.id });
      return row ? { action: 'claimed' as const, deliveryId: row.id } : decision;
    });

    if (claim.action === 'skip' || claim.action === 'send') {
      out.skipped++;
      continue;
    }
    if (claim.action === 'defer') {
      out.deferred++;
      if (!deferUntil || claim.until < deferUntil) deferUntil = claim.until;
      continue;
    }
    const payload =
      c.type === 'slack'
        ? formatSlack(alert, env.DASHBOARD_URL)
        : formatWebhook(alert, env.DASHBOARD_URL, inc.projectId);
    const r = await sendChannelPayload(c, payload);
    await recordResult(c.id, claim.deliveryId, r);
    if (r.delivered) out.sent++;
    else {
      out.failed++;
      firstError ??= `${c.name}: ${r.error}`;
    }
  }

  if (deferUntil)
    await enqueueNotifyIncident(inc.id, (deferUntil.getTime() - Date.now()) / 1000 + 1);
  if (firstError) throw new Error(`notify-incident: delivery failed (${firstError})`);
  return out;
}
