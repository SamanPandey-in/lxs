/**
 * weekly-digest (pg-boss cron, `DIGEST_CRON`, default Monday 09:00 UTC).
 *
 * For every live project: claim the ISO week in `digest_runs` (unique per project and week,
 * so a retried or doubled job sends nothing twice), compute the digest for the last complete
 * week, email the project's owners and analysts who have not opted out, and post it to the
 * channels that opted in (`notification_channels.digest`). The claim is taken before sending:
 * a crash mid-run skips that week's remainder rather than sending duplicates.
 */
import { and, sql as dsql, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  digestRuns,
  memberships,
  notificationChannels,
  notificationDeliveries,
  projects,
  users,
} from '../db/schema.js';
import { env } from '../env.js';
import {
  buildDigest,
  type Digest,
  type DigestWindow,
  digestEmail,
  formatDigestSlack,
  formatDigestWebhook,
  loadDigestCounts,
  previousWindow,
  rollingWindow,
  unsubscribeToken,
  weeklyWindow,
} from '../lib/digest.js';
import { appLink, mailer } from '../lib/mailer.js';
import { milestoneTitle, recordMilestones } from '../lib/milestones.js';
import { recordResult, sendChannelPayload } from './notify-incident.js';

export interface DigestProject {
  id: string;
  name: string;
  orgId: string;
}

/** Compute (but do not send) a project's digest for a window. Also records new milestones. */
export async function computeDigest(project: DigestProject, window: DigestWindow): Promise<Digest> {
  const prev = previousWindow(window);
  const [current, previous, milestones] = await Promise.all([
    loadDigestCounts(project.id, window.start, window.end),
    loadDigestCounts(project.id, prev.start, prev.end),
    recordMilestones(project.id).catch(() => []),
  ]);
  return buildDigest({
    project: { id: project.id, name: project.name },
    window,
    current,
    previous,
    milestones: milestones
      .filter((m) => {
        const t = new Date(m.reached_at).getTime();
        return t >= window.start.getTime() && t < window.end.getTime();
      })
      .map((m) => ({ key: m.key, title: milestoneTitle(m.key), reached_at: m.reached_at })),
  });
}

/** The digest for the seven days ending now (dashboard preview). */
export const previewDigest = (project: DigestProject, now = new Date()) =>
  computeDigest(project, rollingWindow(now));

/** Verified owners and analysts of the project's org who have not opted out. */
export async function digestRecipients(orgId: string): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, dsql`${users.id}::text = ${memberships.userId}`)
    .where(
      and(
        eq(memberships.orgId, orgId),
        inArray(memberships.role, ['owner', 'analyst']),
        eq(users.digestOptOut, false),
        isNotNull(users.emailVerifiedAt),
      ),
    );
}

export interface DigestOutcome {
  project: string;
  week: string;
  status: 'sent' | 'duplicate';
  emailsSent: number;
  emailsFailed: number;
  channelsSent: number;
  channelsFailed: number;
}

/** Send one project's digest for the last complete week. Idempotent per project and ISO week. */
export async function sendProjectDigest(
  project: DigestProject,
  now = new Date(),
  log: { error: (o: unknown, m?: string) => void } = console,
): Promise<DigestOutcome> {
  const window = weeklyWindow(now);
  const out: DigestOutcome = {
    project: project.id,
    week: window.week,
    status: 'duplicate',
    emailsSent: 0,
    emailsFailed: 0,
    channelsSent: 0,
    channelsFailed: 0,
  };
  const [claim] = await db
    .insert(digestRuns)
    .values({
      projectId: project.id,
      week: window.week,
      periodStart: window.start,
      periodEnd: window.end,
    })
    .onConflictDoNothing({ target: [digestRuns.projectId, digestRuns.week] })
    .returning({ id: digestRuns.id });
  if (!claim) return out;
  out.status = 'sent';

  const digest = await computeDigest(project, window);
  const dashboard = appLink('/');

  for (const r of await digestRecipients(project.orgId)) {
    const msg = digestEmail(r.email, digest, {
      dashboard,
      unsubscribe: appLink('/digest/unsubscribe', { token: unsubscribeToken(r.id, now) }),
    });
    try {
      await mailer().send(msg);
      out.emailsSent++;
    } catch (err) {
      out.emailsFailed++;
      log.error({ err, project: project.id }, 'digest email failed');
    }
  }

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.projectId, project.id),
        eq(notificationChannels.enabled, true),
        eq(notificationChannels.digest, true),
      ),
    );
  for (const c of channels) {
    const payload =
      c.type === 'slack'
        ? formatDigestSlack(digest, env.DASHBOARD_URL)
        : formatDigestWebhook(digest, env.DASHBOARD_URL, now);
    const [d] = await db
      .insert(notificationDeliveries)
      .values({ channelId: c.id, projectId: project.id, kind: 'digest', severity: 'digest' })
      .returning({ id: notificationDeliveries.id });
    const res = await sendChannelPayload(c, payload);
    await recordResult(c.id, d?.id ?? null, res);
    if (res.delivered) out.channelsSent++;
    else out.channelsFailed++;
  }

  await db
    .update(digestRuns)
    .set({
      summary: digest as unknown as Record<string, unknown>,
      emailsSent: out.emailsSent,
      emailsFailed: out.emailsFailed,
      channelsSent: out.channelsSent,
      channelsFailed: out.channelsFailed,
    })
    .where(eq(digestRuns.id, claim.id));
  return out;
}

/** Cron entry point: every live project, one at a time. One project's failure does not stop the rest. */
export async function weeklyDigest(
  now = new Date(),
  log: { error: (o: unknown, m?: string) => void } = console,
): Promise<DigestOutcome[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, orgId: projects.orgId })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const results: DigestOutcome[] = [];
  for (const p of rows) {
    try {
      results.push(await sendProjectDigest(p, now, log));
    } catch (err) {
      log.error({ err, project: p.id }, 'weekly digest failed for project');
    }
  }
  return results;
}
