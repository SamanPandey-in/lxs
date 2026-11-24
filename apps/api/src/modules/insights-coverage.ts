/**
 * "Reasons to come back" (roadmap §3.2): coverage score, milestones, the noise counter and
 * the weekly digest (preview, per-user opt-out, signed unsubscribe).
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projects, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { loadCoverageFacts, scoreCoverage } from '../lib/coverage.js';
import {
  digestEmail,
  loadDigestCounts,
  previousWindow,
  rollingWindow,
  verifyUnsubscribeToken,
} from '../lib/digest.js';
import { invalid } from '../lib/errors.js';
import { appLink } from '../lib/mailer.js';
import { recordMilestones } from '../lib/milestones.js';
import { parse } from '../lib/parse.js';
import { projectAccess, requireSession } from '../plugins/auth-session.js';
import { previewDigest } from '../worker/weekly-digest.js';

const DigestPrefs = z.object({ opt_out: z.boolean() });
const Unsubscribe = z.object({ token: z.string().min(1).max(1024) });

export async function insightsCoverageRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };
  const pidOf = (req: { params: unknown }) => (req.params as { pid: string }).pid;

  /* ───────── coverage ───────── */

  app.get('/v1/projects/:pid/coverage', auth, async (req) => {
    const { project } = await projectAccess(req, pidOf(req));
    return scoreCoverage(await loadCoverageFacts(project));
  });

  /** An owner confirms the allowlist is still right (the coverage check counts 90 days from here). */
  app.post('/v1/projects/:pid/coverage/allowlist-reviewed', auth, async (req) => {
    const { project, user } = await projectAccess(req, pidOf(req), 'owner');
    const now = new Date();
    await db.update(projects).set({ allowlistReviewedAt: now }).where(eq(projects.id, project.id));
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'project.allowlist_reviewed',
      targetType: 'project',
      targetId: project.id,
      metadata: { entries: project.allowlist.length },
      req,
    });
    return scoreCoverage(await loadCoverageFacts({ ...project, allowlistReviewedAt: now }), now);
  });

  /* ───────── milestones and the noise counter ───────── */

  app.get('/v1/projects/:pid/milestones', auth, async (req) => {
    const { project } = await projectAccess(req, pidOf(req));
    return { items: await recordMilestones(project.id) };
  });

  /** "Noise you did not have to read": the digest's noise numbers for the last 7 days. */
  app.get('/v1/projects/:pid/noise', auth, async (req) => {
    const { project } = await projectAccess(req, pidOf(req));
    const w = rollingWindow(new Date());
    const prev = previousWindow(w);
    const [cur, before] = await Promise.all([
      loadDigestCounts(project.id, w.start, w.end),
      loadDigestCounts(project.id, prev.start, prev.end),
    ]);
    return {
      window_days: 7,
      period: { start: w.start.toISOString(), end: w.end.toISOString() },
      events: cur.noise.events,
      incidents: cur.noise.incidents,
      events_total: cur.events,
      previous: { events: before.noise.events, incidents: before.noise.incidents },
    };
  });

  /* ───────── digest ───────── */

  app.post('/v1/projects/:pid/digest/preview', auth, async (req) => {
    const { project, user } = await projectAccess(req, pidOf(req), 'analyst');
    const digest = await previewDigest({
      id: project.id,
      name: project.name,
      orgId: project.orgId,
    });
    // The preview never carries a live unsubscribe token; it points at the settings toggle.
    const mail = digestEmail(user.email, digest, {
      dashboard: appLink('/'),
      unsubscribe: `${appLink('/settings')}#digest`,
    });
    return { digest, subject: mail.subject, text: mail.text, html: mail.html };
  });

  app.get('/v1/me/digest', auth, async (req) => {
    const [u] = await db
      .select({ optOut: users.digestOptOut })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    return { opt_out: u?.optOut === true };
  });

  app.patch('/v1/me/digest', auth, async (req) => {
    const b = parse(DigestPrefs, req.body);
    await db.update(users).set({ digestOptOut: b.opt_out }).where(eq(users.id, req.user!.id));
    return { opt_out: b.opt_out };
  });

  /** Public: the signed token from the email is the credential. Idempotent. */
  app.post('/v1/digest/unsubscribe', async (req) => {
    const b = parse(Unsubscribe, req.body);
    const uid = verifyUnsubscribeToken(b.token);
    if (!uid) throw invalid('This unsubscribe link is invalid or has expired');
    await db.update(users).set({ digestOptOut: true }).where(eq(users.id, uid));
    return { opt_out: true };
  });
}
