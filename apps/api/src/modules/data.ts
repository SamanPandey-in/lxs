/**
 * Data handling (H5/G11): project export, project soft delete and restore, account delete,
 * and the retention numbers the dashboard shows. Hard deletes and credential hashing run in
 * worker/maintenance.ts; the export bundle is built by worker/export-project.ts.
 *
 * Every route here is owner-only except the read-only retention summary, and every change
 * is written to the audit log.
 */
import { and, desc, sql as dsql, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type DbOrTx, db } from '../db/client.js';
import {
  apiKeys,
  memberships,
  organizations,
  projectExports,
  projects,
  users,
} from '../db/schema.js';
import { env } from '../env.js';
import { enqueueExportProject } from '../jobs/queue.js';
import { audit } from '../lib/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { effectiveRetentionDays, orgPlan, planJson } from '../lib/plans.js';
import { iso } from '../lib/serialize.js';
import {
  clearSession,
  isUuid,
  membershipInOrg,
  orgAccess,
  orgDisabled,
  projectAccess,
  requireSession,
} from '../plugins/auth-session.js';
import { evictKeyCache } from '../plugins/bearer-key.js';
import { exportStorage } from '../worker/export-project.js';
import { assertUnderCap } from './projects.js';

export const E_CONFIRM_MISMATCH = 'E_CONFIRM_MISMATCH';
export const E_EXPORT_EXPIRED = 'E_EXPORT_EXPIRED';
export const E_EXPORT_BUSY = 'E_EXPORT_BUSY';
export const E_PURGE_STARTED = 'E_PURGE_STARTED';
export const E_PASSWORD_INVALID = 'E_PASSWORD_INVALID';
export const E_LAST_OWNER = 'E_LAST_OWNER';

/** Exports one project may request per rolling 24 h. */
export const EXPORTS_PER_DAY = 5;

const DeleteProject = z.object({ confirm: z.string().max(128) });
const DeleteAccount = z.object({ password: z.string().min(1).max(256) });

type ExportRow = typeof projectExports.$inferSelect;
const exportJson = (e: ExportRow, now = new Date()) => {
  const live = e.status === 'ready' && !!e.expiresAt && e.expiresAt > now;
  return {
    id: e.id,
    project_id: e.projectId,
    status: e.status === 'ready' && !live ? 'expired' : e.status,
    requested_by: e.requestedBy,
    created_at: iso(e.createdAt),
    completed_at: iso(e.completedAt),
    expires_at: iso(e.expiresAt),
    size_bytes: e.sizeBytes,
    row_counts: e.rowCounts,
    error: e.error,
    download_path: live ? `/v1/projects/${e.projectId}/exports/${e.id}/download` : null,
  };
};

type ProjectRow = typeof projects.$inferSelect;
const deletedJson = (p: ProjectRow, now = new Date()) => ({
  id: p.id,
  org_id: p.orgId,
  name: p.name,
  slug: p.slug,
  deleted_at: iso(p.deletedAt),
  deleted_by: p.deletedBy,
  purge_after: iso(p.purgeAfter),
  restorable: !!p.purgeAfter && p.purgeAfter > now,
});

const graceMs = () => env.PROJECT_DELETE_GRACE_DAYS * 86_400_000;

/**
 * Soft-delete one project inside `tx`: hide it (every project query filters `deleted_at`),
 * revoke its ingest keys so ingest stops at once, and schedule the hard purge. Returns the
 * number of keys revoked, or null when the project was already deleted.
 */
export async function softDeleteProject(
  tx: DbOrTx,
  project: { id: string; orgId: string; slug: string },
  actor: { id: string; reason?: string },
  req?: FastifyRequest,
): Promise<{ purgeAfter: Date; keysRevoked: number } | null> {
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + graceMs());
  const [row] = await tx
    .update(projects)
    .set({ deletedAt: now, deletedBy: actor.id, purgeAfter })
    .where(and(eq(projects.id, project.id), isNull(projects.deletedAt)))
    .returning({ id: projects.id });
  if (!row) return null;
  const revoked = await tx
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.projectId, project.id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  await audit(tx, {
    orgId: project.orgId,
    projectId: project.id,
    actorType: 'user',
    actorId: actor.id,
    action: 'project.delete',
    targetType: 'project',
    targetId: project.id,
    metadata: {
      slug: project.slug,
      purge_after: purgeAfter.toISOString(),
      keys_revoked: revoked.length,
      ...(actor.reason ? { reason: actor.reason } : {}),
    },
    req,
  });
  return { purgeAfter, keysRevoked: revoked.length };
}

/**
 * Like projectAccess, but also resolves soft-deleted projects (restore needs them). Owner
 * only; non-members get 404 so a foreign project's existence is never confirmed.
 */
async function anyProjectAsOwner(req: FastifyRequest, pid: string) {
  if (!req.user) throw unauthorized();
  if (!isUuid(pid)) throw notFound('Project');
  const [p] = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
  if (!p) throw notFound('Project');
  const m = await membershipInOrg(req.user.id, p.orgId);
  if (!m) throw notFound('Project');
  if (m.disabled) throw orgDisabled();
  if (m.role !== 'owner') throw forbidden('Requires owner role', 'insufficient_role');
  return { project: p, user: req.user };
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };

  /* --------------------------- retention summary --------------------------- */

  app.get('/v1/projects/:pid/data', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const { name, plan } = await orgPlan(db, project.orgId);
    return {
      plan: planJson(name, plan),
      retention: {
        project_days: project.retentionDays,
        events_days: effectiveRetentionDays(project.retentionDays, plan),
        raw_days: plan.rawRetentionDays,
        credential_hash_days: env.CREDENTIAL_HASH_DAYS,
      },
      delete_grace_days: env.PROJECT_DELETE_GRACE_DAYS,
      export_ttl_hours: env.EXPORT_TTL_HOURS,
    };
  });

  /* -------------------------------- export -------------------------------- */

  app.post('/v1/projects/:pid/export', auth, async (req, reply) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const recent = await db
      .select({ id: projectExports.id, status: projectExports.status })
      .from(projectExports)
      .where(
        and(
          eq(projectExports.projectId, project.id),
          gt(projectExports.createdAt, new Date(Date.now() - 86_400_000)),
        ),
      );
    if (recent.some((e) => e.status === 'pending' || e.status === 'running'))
      throw new HttpError(
        409,
        E_EXPORT_BUSY,
        'An export of this project is already running. Wait for it to finish.',
      );
    if (recent.length >= EXPORTS_PER_DAY)
      throw new HttpError(
        429,
        E_EXPORT_BUSY,
        `A project can be exported ${EXPORTS_PER_DAY} times a day. Try again tomorrow.`,
      );
    const [row] = await db
      .insert(projectExports)
      .values({
        projectId: project.id,
        orgId: project.orgId,
        requestedBy: user.id,
        status: 'pending',
        storage: exportStorage().kind,
      })
      .returning();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'project.export.request',
      targetType: 'project_export',
      targetId: row!.id,
      req,
    });
    await enqueueExportProject(row!.id);
    return reply.status(202).send(exportJson(row!));
  });

  app.get('/v1/projects/:pid/exports', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'owner');
    const rows = await db
      .select()
      .from(projectExports)
      .where(eq(projectExports.projectId, project.id))
      .orderBy(desc(projectExports.createdAt))
      .limit(20);
    const now = new Date();
    return { items: rows.map((r) => exportJson(r, now)) };
  });

  app.get('/v1/projects/:pid/exports/:eid/download', auth, async (req, reply) => {
    const { pid, eid } = req.params as { pid: string; eid: string };
    const { project, user } = await projectAccess(req, pid, 'owner');
    if (!isUuid(eid)) throw notFound('Export');
    const [e] = await db
      .select()
      .from(projectExports)
      .where(and(eq(projectExports.id, eid), eq(projectExports.projectId, project.id)))
      .limit(1);
    if (!e) throw notFound('Export');
    const expired = () =>
      new HttpError(410, E_EXPORT_EXPIRED, 'This export has expired. Request a new one.');
    if (e.status === 'expired' || (e.expiresAt && e.expiresAt <= new Date())) throw expired();
    if (e.status !== 'ready' || !e.objectKey) throw conflict('This export is not ready yet');
    const stream = await exportStorage().get(e.objectKey);
    if (!stream) throw expired();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'project.export.download',
      targetType: 'project_export',
      targetId: e.id,
      req,
    });
    const day = (e.completedAt ?? e.createdAt).toISOString().slice(0, 10);
    const name = `lxs-export-${project.slug.replace(/[^a-z0-9-]/gi, '')}-${day}.tar`;
    void reply
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .type('application/x-tar');
    if (e.sizeBytes) void reply.header('content-length', String(e.sizeBytes));
    return reply.send(stream);
  });

  /* ------------------------- project delete / restore ------------------------- */

  app.delete('/v1/projects/:pid', auth, async (req) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const body = parse(DeleteProject, req.body);
    if (body.confirm.trim() !== project.slug)
      throw new HttpError(
        422,
        E_CONFIRM_MISMATCH,
        `Type the project slug "${project.slug}" to confirm`,
        { field: 'confirm' },
      );
    const res = await db.transaction((tx) => softDeleteProject(tx, project, { id: user.id }, req));
    evictKeyCache();
    if (!res) throw notFound('Project');
    return {
      id: project.id,
      deleted: true,
      purge_after: res.purgeAfter.toISOString(),
      keys_revoked: res.keysRevoked,
    };
  });

  app.post('/v1/projects/:pid/restore', auth, async (req) => {
    const { project, user } = await anyProjectAsOwner(req, (req.params as { pid: string }).pid);
    if (!project.deletedAt) throw conflict('This project is not deleted');
    const now = new Date();
    if (!project.purgeAfter || project.purgeAfter <= now)
      throw new HttpError(
        410,
        E_PURGE_STARTED,
        'The grace period is over and this project is being purged. It cannot be restored.',
      );
    const restored = await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${`org-cap:${project.orgId}`}))`);
      const [{ n }] = (await tx.execute(dsql`
        SELECT count(*)::int AS n FROM projects WHERE org_id = ${project.orgId}::uuid AND archived_at IS NULL AND deleted_at IS NULL
      `)) as unknown as [{ n: number }];
      assertUnderCap('projects', n, (await orgPlan(tx, project.orgId)).plan.maxProjects);
      const [row] = await tx
        .update(projects)
        .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
        .where(
          and(
            eq(projects.id, project.id),
            isNotNull(projects.deletedAt),
            gt(projects.purgeAfter, now),
          ),
        )
        .returning({ id: projects.id });
      if (!row) return false;
      await audit(tx, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: 'user',
        actorId: user.id,
        action: 'project.restore',
        targetType: 'project',
        targetId: project.id,
        req,
      });
      return true;
    });
    if (!restored) throw conflict('This project is not deleted');
    return {
      id: project.id,
      restored: true,
      note: 'Ingest keys revoked at deletion stay revoked. Create a new key for your sensors.',
    };
  });

  app.get('/v1/orgs/:oid/deleted-projects', auth, async (req) => {
    const { orgId } = await orgAccess(req, (req.params as { oid: string }).oid, 'owner');
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), isNotNull(projects.deletedAt)))
      .orderBy(desc(projects.deletedAt));
    const now = new Date();
    return { items: rows.map((p) => deletedJson(p, now)) };
  });

  /* ------------------------------ account delete ------------------------------ */

  app.delete('/v1/me', auth, async (req, reply) => {
    const me = req.user!;
    const body = parse(DeleteAccount, req.body);
    const [u] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1);
    if (!u || !(await verifyPassword(body.password, u.passwordHash)))
      throw new HttpError(403, E_PASSWORD_INVALID, 'That password is not correct');

    const summary = await db.transaction(async (tx) => {
      const mine = await tx
        .select({ orgId: memberships.orgId, role: memberships.role, name: organizations.name })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(eq(memberships.userId, me.id));
      const sole: { orgId: string; name: string }[] = [];
      const blocking: { id: string; name: string }[] = [];
      const left: string[] = [];
      for (const m of mine) {
        // Lock the org's owners so a concurrent demotion cannot leave it ownerless.
        const owners = (await tx.execute(dsql`
          SELECT user_id FROM memberships WHERE org_id = ${m.orgId}::uuid AND role = 'owner' FOR UPDATE
        `)) as unknown as { user_id: string }[];
        const members = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.orgId, m.orgId));
        if (members.length <= 1) sole.push({ orgId: m.orgId, name: m.name });
        else if (m.role === 'owner' && owners.filter((o) => o.user_id !== me.id).length === 0)
          blocking.push({ id: m.orgId, name: m.name });
        else left.push(m.orgId);
      }
      if (blocking.length)
        throw new HttpError(
          409,
          E_LAST_OWNER,
          `You are the only owner of ${blocking.map((o) => o.name).join(', ')}, which has other members. Make someone else an owner in Settings → Members first, then delete your account.`,
          { orgs: blocking },
        );

      let projectsDeleted = 0;
      for (const o of sole) {
        const live = await tx
          .select({ id: projects.id, orgId: projects.orgId, slug: projects.slug })
          .from(projects)
          .where(and(eq(projects.orgId, o.orgId), isNull(projects.deletedAt)));
        for (const p of live)
          if (await softDeleteProject(tx, p, { id: me.id, reason: 'account_deleted' }, req))
            projectsDeleted++;
        await tx
          .update(organizations)
          .set({ deletedAt: new Date() })
          .where(eq(organizations.id, o.orgId));
        await audit(tx, {
          orgId: o.orgId,
          actorType: 'user',
          actorId: me.id,
          action: 'org.delete',
          targetType: 'organization',
          targetId: o.orgId,
          metadata: { reason: 'account_deleted', projects: live.length },
          req,
        });
      }
      for (const orgId of left)
        await audit(tx, {
          orgId,
          actorType: 'user',
          actorId: me.id,
          action: 'member.remove',
          targetType: 'user',
          targetId: me.id,
          metadata: { reason: 'account_deleted' },
          req,
        });
      await tx.delete(memberships).where(eq(memberships.userId, me.id));
      await tx.delete(users).where(eq(users.id, me.id));
      return { orgsDeleted: sole.length, orgsLeft: left.length, projectsDeleted };
    });
    evictKeyCache();
    clearSession(reply);
    return {
      deleted: true,
      orgs_deleted: summary.orgsDeleted,
      orgs_left: summary.orgsLeft,
      projects_deleted: summary.projectsDeleted,
      purge_after_days: env.PROJECT_DELETE_GRACE_DAYS,
    };
  });
}
