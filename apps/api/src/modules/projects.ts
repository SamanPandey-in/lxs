import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Overview } from '@lxs/schema';
import { and, asc, desc, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, sql as rawSql } from '../db/client.js';
import { apiKeys, attackers, incidents, memberships, projects } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { generateIngestKey } from '../lib/crypto.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { type IncidentRow, incidentSummaryCols, iso, toIncidentSummary } from '../lib/serialize.js';
import { isUuid, projectAccess, requireSession, userOrgs } from '../plugins/auth-session.js';
import { evictKeyCache } from '../plugins/bearer-key.js';
import { slugify } from './auth.js';

const toCidr = (v: string): string => {
  const [addr, mask] = v.trim().split('/');
  const fam = isIP(addr ?? '');
  if (!fam) throw new Error('bad ip');
  return mask === undefined ? `${addr}/${fam === 4 ? 32 : 128}` : `${addr}/${mask}`;
};

const CidrList = z
  .array(z.string().max(64))
  .max(200)
  .transform((arr, ctx) => {
    try {
      return arr.map(toCidr);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'allowlist entries must be IPs or CIDRs' });
      return z.NEVER;
    }
  });

const CreateProject = z.object({
  name: z.string().min(1).max(128),
  slug: z.string().min(1).max(64).optional(),
  environment: z.string().min(1).max(32).default('production'),
  org_id: z.string().uuid().optional(),
});

const PatchProject = z.object({
  name: z.string().min(1).max(128).optional(),
  environment: z.string().min(1).max(32).optional(),
  allowlist: CidrList.optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  ai_enabled: z.boolean().optional(),
  ai_daily_cap: z.number().int().min(0).max(100000).optional(),
});

const CreateKey = z.object({ name: z.string().min(1).max(64) });

type ProjectRow = typeof projects.$inferSelect;
const projectJson = (p: ProjectRow) => ({
  id: p.id,
  org_id: p.orgId,
  name: p.name,
  slug: p.slug,
  environment: p.environment,
  policy_version: p.policyVersion,
  allowlist: p.allowlist,
  retention_days: p.retentionDays,
  ai_enabled: p.aiEnabled,
  ai_daily_cap: p.aiDailyCap,
  created_at: iso(p.createdAt),
  archived_at: iso(p.archivedAt),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };

  app.get('/v1/projects', auth, async (req) => {
    const rows = await db
      .select({ p: projects })
      .from(projects)
      .innerJoin(memberships, eq(memberships.orgId, projects.orgId))
      .where(eq(memberships.userId, req.user!.id))
      .orderBy(asc(projects.createdAt));
    return { items: rows.map((r) => projectJson(r.p)) };
  });

  app.post('/v1/projects', auth, async (req, reply) => {
    const body = parse(CreateProject, req.body);
    const orgs = (await userOrgs(req.user!.id)).filter((o) => o.role === 'owner');
    const org = body.org_id ? orgs.find((o) => o.id === body.org_id) : orgs[0];
    if (!org) throw forbidden('Owner role required in an organization', 'insufficient_role');
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    const [dupe] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, org.id), eq(projects.slug, slug)))
      .limit(1);
    if (dupe) throw conflict('A project with this slug already exists');
    const [p] = await db
      .insert(projects)
      .values({
        orgId: org.id,
        name: body.name,
        slug,
        environment: body.environment,
        passwordSalt: randomBytes(16),
      })
      .returning();
    await audit(db, {
      orgId: org.id,
      projectId: p!.id,
      actorType: 'user',
      actorId: req.user!.id,
      action: 'project.create',
      targetType: 'project',
      targetId: p!.id,
      req,
    });
    return reply.status(201).send(projectJson(p!));
  });

  app.get('/v1/projects/:pid', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    return projectJson(project);
  });

  app.patch('/v1/projects/:pid', auth, async (req) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const b = parse(PatchProject, req.body);
    const [p] = await db
      .update(projects)
      .set({
        ...(b.name !== undefined && { name: b.name }),
        ...(b.environment !== undefined && { environment: b.environment }),
        ...(b.allowlist !== undefined && { allowlist: b.allowlist }),
        ...(b.retention_days !== undefined && { retentionDays: b.retention_days }),
        ...(b.ai_enabled !== undefined && { aiEnabled: b.ai_enabled }),
        ...(b.ai_daily_cap !== undefined && { aiDailyCap: b.ai_daily_cap }),
      })
      .where(eq(projects.id, project.id))
      .returning();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'project.update',
      targetType: 'project',
      targetId: project.id,
      metadata: { fields: Object.keys(b) },
      req,
    });
    return projectJson(p!);
  });

  /* ------------------------------- keys -------------------------------- */

  app.get('/v1/projects/:pid/keys', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'owner');
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.projectId, project.id))
      .orderBy(desc(apiKeys.createdAt));
    return {
      items: rows.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        created_at: iso(k.createdAt),
        last_used_at: iso(k.lastUsedAt),
        revoked_at: iso(k.revokedAt),
      })),
    };
  });

  app.post('/v1/projects/:pid/keys', auth, async (req, reply) => {
    const { project, user } = await projectAccess(
      req,
      (req.params as { pid: string }).pid,
      'owner',
    );
    const body = parse(CreateKey, req.body);
    const k = generateIngestKey();
    const [row] = await db
      .insert(apiKeys)
      .values({
        projectId: project.id,
        name: body.name,
        prefix: k.prefix,
        keyHash: k.hash,
        createdBy: user.id,
      })
      .returning();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'key.create',
      targetType: 'api_key',
      targetId: row!.id,
      metadata: { name: body.name, prefix: k.prefix },
      req,
    });
    return reply.status(201).send({
      id: row!.id,
      name: row!.name,
      prefix: k.prefix,
      key: k.key,
      scopes: row!.scopes,
      created_at: iso(row!.createdAt),
      note: 'This is the only time the full key is shown.',
    });
  });

  app.delete('/v1/projects/:pid/keys/:kid', auth, async (req, reply) => {
    const { pid, kid } = req.params as { pid: string; kid: string };
    const { project, user } = await projectAccess(req, pid, 'owner');
    if (!isUuid(kid)) throw notFound('Key');
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: dsql`now()` })
      .where(and(eq(apiKeys.id, kid), eq(apiKeys.projectId, project.id)))
      .returning({ id: apiKeys.id });
    if (!row) throw notFound('Key');
    evictKeyCache();
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'key.revoke',
      targetType: 'api_key',
      targetId: kid,
      req,
    });
    return reply.status(204).send();
  });

  /* ----------------------------- onboarding ----------------------------- */

  app.get('/v1/projects/:pid/onboarding', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const [c] = (await rawSql`
      select (select count(*) from api_keys where project_id = ${project.id}::uuid and revoked_at is null)::int as keys,
             (select count(*) from sensors where project_id = ${project.id}::uuid)::int as sensors,
             (select count(*) from events where project_id = ${project.id}::uuid)::int as events,
             (select count(*) from incidents where project_id = ${project.id}::uuid)::int as incidents,
             (select passed from containment_reports where project_id = ${project.id}::uuid order by created_at desc limit 1) as selftest
    `) as unknown as {
      keys: number;
      sensors: number;
      events: number;
      incidents: number;
      selftest: boolean | null;
    }[];
    const steps = [
      { id: 'project', label: 'Create a project', done: true },
      { id: 'key', label: 'Create an ingest key', done: c!.keys > 0 },
      { id: 'agent', label: 'Connect the agent', done: c!.sensors > 0 },
      { id: 'selftest', label: 'Containment self-test passes', done: c!.selftest === true },
      { id: 'event', label: 'Receive the first event', done: c!.events > 0 },
      { id: 'incident', label: 'See the first incident', done: c!.incidents > 0 },
    ];
    return { steps, complete: steps.every((s) => s.done) };
  });

  /* ------------------------------ overview ------------------------------ */

  app.get('/v1/projects/:pid/overview', auth, async (req): Promise<Overview> => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const pid = project.id;
    const [o] = (await rawSql`
      select
        (select count(*) from incidents where project_id = ${pid}::uuid and status in ('open','acknowledged'))::int as incidents_open,
        (select count(*) from incidents where project_id = ${pid}::uuid and status in ('open','acknowledged') and severity = 'critical')::int as incidents_critical,
        (select coalesce(sum(count),0) from events where project_id = ${pid}::uuid and received_at > now() - interval '24 hours')::int as events_24h,
        (select coalesce(sum(e.count),0) from events e left join incidents i on i.id = e.incident_id
           where e.project_id = ${pid}::uuid and e.received_at > now() - interval '24 hours'
             and (i.label = 'noise' or 'allowlisted' = any(e.tags)))::int as noise_suppressed_24h,
        (select count(distinct attacker_id) from events where project_id = ${pid}::uuid and received_at > now() - interval '24 hours' and attacker_id is not null)::int as attackers_24h,
        (select count(*) from decoys where project_id = ${pid}::uuid and status = 'online')::int as decoys_healthy,
        (select count(*) from decoys where project_id = ${pid}::uuid)::int as decoys_total,
        (select extract(epoch from avg(acknowledged_at - opened_at)) from incidents where project_id = ${pid}::uuid and acknowledged_at is not null)::float8 as mtta_seconds
    `) as unknown as Omit<Overview, 'top_incidents'>[];
    const top = (await db
      .select(incidentSummaryCols)
      .from(incidents)
      .innerJoin(attackers, eq(attackers.id, incidents.attackerId))
      .where(and(eq(incidents.projectId, pid), inArray(incidents.status, ['open', 'acknowledged'])))
      .orderBy(
        dsql`case ${incidents.severity} when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc`,
        desc(incidents.score),
        desc(incidents.lastEventAt),
      )
      .limit(5)) as IncidentRow[];
    return {
      ...o!,
      mtta_seconds: o!.mtta_seconds ?? null,
      top_incidents: top.map(toIncidentSummary),
    };
  });
}
