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

/**
 * Normalise one allowlist entry to a literal the `cidr[]` column will accept.
 *
 * The address was always checked, the prefix length never was, so "10.0.0.0/999"
 * and "10.0.0.0/abc" passed validation and then failed in Postgres as a generic
 * 422 that named neither the field nor the entry. Every rejection here carries a
 * message saying what is wrong with which value.
 *
 * `cidr` also refuses host bits to the right of the mask, so an IPv4 entry like
 * "192.168.1.5/24" is masked down to its network address — that is the network
 * the entry denotes, and the normalised value is returned to the caller in the
 * project JSON, so nothing is hidden. The equivalent IPv6 normalisation needs a
 * full address expansion and is deliberately not hand-rolled here; an IPv6 entry
 * carrying host bits is still caught, by Postgres, as it was before.
 */
export function toCidr(v: string): string {
  const trimmed = v.trim();
  if (!trimmed) throw new Error('entry is empty');
  const slash = trimmed.indexOf('/');
  const addr = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const suffix = slash < 0 ? null : trimmed.slice(slash + 1);
  const fam = isIP(addr);
  if (!fam) throw new Error(`"${trimmed}" is not an IPv4 or IPv6 address`);
  const maxBits = fam === 4 ? 32 : 128;
  if (suffix === null) return `${addr}/${maxBits}`;
  if (!/^\d{1,3}$/.test(suffix))
    throw new Error(
      `"${trimmed}" has prefix length "${suffix}"; expected a number from 0 to ${maxBits}`,
    );
  const bits = Number(suffix);
  if (bits > maxBits)
    throw new Error(`"${trimmed}" has prefix length ${bits}; IPv${fam} allows at most ${maxBits}`);
  if (fam === 6) return `${addr}/${bits}`;
  // IPv4: zero the host bits so the value is a valid `cidr` network.
  const octets = addr.split('.').map(Number);
  const asInt = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const network = bits === 0 ? 0 : (asInt & (0xffffffff << (32 - bits))) >>> 0;
  const masked = [network >>> 24, (network >>> 16) & 255, (network >>> 8) & 255, network & 255];
  return `${masked.join('.')}/${bits}`;
}

const CidrList = z
  .array(z.string().max(64))
  .max(200)
  .transform((arr, ctx) => {
    const out: string[] = [];
    let failed = false;
    arr.forEach((entry, i) => {
      try {
        out.push(toCidr(entry));
      } catch (err) {
        failed = true;
        // path: [i] so the client is told which entry to fix, not just that one is wrong.
        ctx.addIssue({ code: 'custom', message: (err as Error).message, path: [i] });
      }
    });
    return failed ? z.NEVER : out;
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
