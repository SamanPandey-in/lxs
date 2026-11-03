import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, desc, sql as dsql, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, sql as rawSql, type Tx } from '../db/client.js';
import { blocklistEntries, projects, responseActions } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { HttpError, invalid, notFound } from '../lib/errors.js';
import { publish } from '../lib/notify.js';
import { parse } from '../lib/parse.js';
import { iso } from '../lib/serialize.js';
import {
  isUuid,
  type ProjectAccess,
  projectAccess,
  requireSession,
} from '../plugins/auth-session.js';
import { loadIncident } from './incidents.js';

/* ------------------------------ core ops --------------------------------- */

async function assertBlockable(tx: Tx, projectId: string, ip: string): Promise<void> {
  if (!isIP(ip)) throw invalid('params.ip must be a valid IPv4/IPv6 address');
  const r = (await tx.execute(
    dsql`select exists(select 1 from projects where id = ${projectId}::uuid and ${ip}::inet <<= any(allowlist)) as hit`,
  )) as unknown as { hit: boolean }[];
  if (r[0]?.hit)
    throw new HttpError(
      409,
      'allowlisted',
      'This address is on the project allowlist and cannot be blocked',
    );
}

async function bumpPolicy(tx: Tx, projectId: string): Promise<number> {
  const [p] = await tx
    .update(projects)
    .set({ policyVersion: dsql`${projects.policyVersion} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ v: projects.policyVersion });
  return p!.v;
}

/** One transaction: blocklist row + policy_version bump + response action + audit (BREAKDOWN 8.3). */
export async function blockIp(
  access: Pick<ProjectAccess, 'project' | 'user'>,
  p: { ip: string; durationHours?: number | null; reason?: string; incidentId?: string | null },
  req?: Parameters<typeof audit>[1]['req'],
) {
  const { project, user } = access;
  return db.transaction(async (tx) => {
    await assertBlockable(tx, project.id, p.ip);
    const expiresAt = p.durationHours ? new Date(Date.now() + p.durationHours * 3600_000) : null;
    const [entry] = await tx
      .insert(blocklistEntries)
      .values({
        projectId: project.id,
        ip: p.ip,
        reason: p.reason ?? null,
        incidentId: p.incidentId ?? null,
        createdBy: user.id,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [blocklistEntries.projectId, blocklistEntries.ip],
        targetWhere: dsql`removed_at is null`,
        set: { reason: p.reason ?? null, expiresAt, incidentId: p.incidentId ?? null },
      })
      .returning({ id: blocklistEntries.id });
    const version = await bumpPolicy(tx, project.id);
    const [action] = await tx
      .insert(responseActions)
      .values({
        projectId: project.id,
        incidentId: p.incidentId ?? null,
        type: 'block_ip',
        params: {
          ip: p.ip,
          duration_hours: p.durationHours ?? null,
          reason: p.reason ?? null,
          policy_version: version,
          blocklist_entry_id: entry!.id,
        },
        requestedBy: user.id,
      })
      .returning({ id: responseActions.id, status: responseActions.status });
    await audit(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'response.block_ip',
      targetType: 'blocklist_entry',
      targetId: entry!.id,
      metadata: {
        ip: p.ip,
        duration_hours: p.durationHours ?? null,
        incident_id: p.incidentId ?? null,
      },
      req,
    });
    return {
      action_id: action!.id,
      status: action!.status,
      policy_version: version,
      blocklist_entry_id: entry!.id,
    };
  });
}

export async function unblockIp(
  access: Pick<ProjectAccess, 'project' | 'user'>,
  p: { ip?: string; entryId?: string; incidentId?: string | null },
  req?: Parameters<typeof audit>[1]['req'],
) {
  const { project, user } = access;
  return db.transaction(async (tx) => {
    const cond = p.entryId
      ? and(
          eq(blocklistEntries.id, p.entryId),
          eq(blocklistEntries.projectId, project.id),
          dsql`${blocklistEntries.removedAt} is null`,
        )
      : and(
          eq(blocklistEntries.ip, p.ip!),
          eq(blocklistEntries.projectId, project.id),
          dsql`${blocklistEntries.removedAt} is null`,
        );
    const [entry] = await tx
      .update(blocklistEntries)
      .set({ removedAt: dsql`now()`, removedBy: user.id })
      .where(cond)
      .returning({ id: blocklistEntries.id, ip: blocklistEntries.ip });
    if (!entry) throw notFound('Active block');
    const version = await bumpPolicy(tx, project.id);
    const [action] = await tx
      .insert(responseActions)
      .values({
        projectId: project.id,
        incidentId: p.incidentId ?? null,
        type: 'unblock_ip',
        params: { ip: entry.ip, policy_version: version },
        requestedBy: user.id,
      })
      .returning({ id: responseActions.id, status: responseActions.status });
    await audit(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'response.unblock_ip',
      targetType: 'blocklist_entry',
      targetId: entry.id,
      metadata: { ip: entry.ip },
      req,
    });
    return {
      action_id: action!.id,
      status: action!.status,
      policy_version: version,
      blocklist_entry_id: entry.id,
    };
  });
}

/* ------------------------------- IOCs ------------------------------------ */

interface Indicator {
  type: string;
  value: string;
  first_seen?: string;
  last_seen?: string;
  context: string;
}

/**
 * Human-readable context for an attacker indicator. `label` is NOT NULL in the
 * schema but is not constrained to be non-empty, and the worker writes
 * `verdict.label` straight through — an empty one used to throw here and 500 the
 * whole export, so it degrades to "Unlabelled" instead.
 */
export function attackerContext(a: {
  label: string;
  real_asset_reached: boolean;
  number: number;
}): string {
  const label = a.label ? `${a.label[0]!.toUpperCase()}${a.label.slice(1)}` : 'Unlabelled';
  return `${label}${a.real_asset_reached ? '; reached a real asset' : ''} (incident #${a.number})`;
}

export async function buildIocs(
  projectId: string,
  incidentId?: string,
): Promise<{ indicators: Indicator[]; incident: number | null }> {
  const incFilter = incidentId
    ? rawSql`i.id = ${incidentId}::uuid`
    : rawSql`i.last_event_at > now() - interval '7 days'`;
  const attackersRows = (await rawSql`
    select host(a.ip) as ip, a.label, i.number, i.title, i.real_asset_reached,
           to_char(i.first_event_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_seen,
           to_char(i.last_event_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_seen
    from incidents i join attackers a on a.id = i.attacker_id
    where i.project_id = ${projectId}::uuid and ${incFilter}
    order by i.last_event_at desc limit 200
  `) as unknown as {
    ip: string;
    label: string;
    number: number;
    title: string;
    real_asset_reached: boolean;
    first_seen: string;
    last_seen: string;
  }[];

  const evs = (await rawSql`
    select e.event_type, e.outcome, e.fields, e.dst_service, host(e.src_ip) as ip,
           to_char(e.occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
    from events e join incidents i on i.id = e.incident_id
    where e.project_id = ${projectId}::uuid and ${incFilter}
    order by e.occurred_at asc limit 5000
  `) as unknown as {
    event_type: string;
    outcome: string | null;
    fields: Record<string, string | undefined>;
    dst_service: string;
    ip: string;
    at: string;
  }[];

  const out: Indicator[] = attackersRows.map((a) => ({
    type: a.ip.includes(':') ? 'ipv6' : 'ipv4',
    value: a.ip,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    context: attackerContext(a),
  }));
  const seen = new Set<string>();
  const add = (i: Indicator) => {
    const k = `${i.type}|${i.value}`;
    if (!seen.has(k) && out.length < 2000) {
      seen.add(k);
      out.push(i);
    }
  };
  for (const e of evs) {
    const f = e.fields;
    if (
      e.event_type === 'auth.attempt' &&
      e.outcome === 'success' &&
      f.username &&
      f.password_clear
    )
      add({
        type: 'credential',
        value: `${f.username}:${f.password_clear}`,
        first_seen: e.at,
        last_seen: e.at,
        context: `Accepted on ${e.dst_service} (common credential)`,
      });
    if (e.event_type === 'command.exec' && f.command) {
      add({
        type: 'command',
        value: f.command,
        first_seen: e.at,
        last_seen: e.at,
        context: `Executed on ${e.dst_service}`,
      });
      for (const m of f.command.match(/https?:\/\/[^\s'"]+/g) ?? [])
        add({
          type: 'url',
          value: m,
          first_seen: e.at,
          last_seen: e.at,
          context: 'Tool download attempt (blocked by containment)',
        });
    }
    if (f.url && (e.event_type === 'file.download' || e.event_type === 'proxy.attempt'))
      add({
        type: 'url',
        value: f.url,
        first_seen: e.at,
        last_seen: e.at,
        context: e.event_type === 'proxy.attempt' ? 'Proxy attempt' : 'Download attempt',
      });
    if (f.client_banner)
      add({
        type: 'ssh_client',
        value: f.client_banner,
        first_seen: e.at,
        last_seen: e.at,
        context: 'Client banner',
      });
    if (e.event_type === 'file.upload' && f.file_sha256)
      add({
        type: 'sha256',
        value: f.file_sha256,
        first_seen: e.at,
        last_seen: e.at,
        context: `Uploaded file ${f.file_name ?? ''}`.trim(),
      });
  }
  return { indicators: out, incident: incidentId ? (attackersRows[0]?.number ?? null) : null };
}

const csvCell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // formula-injection escaping
  return `"${safe.replace(/"/g, '""')}"`;
};

export function iocsToCsv(ind: Indicator[]): string {
  const lines = ['type,value,first_seen,last_seen,context'];
  for (const i of ind)
    lines.push(
      [i.type, i.value, i.first_seen ?? '', i.last_seen ?? '', i.context].map(csvCell).join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}

function iocsToStix(ind: Indicator[]) {
  const now = new Date().toISOString();
  const objects = ind
    .map((i) => {
      const esc = i.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const pattern =
        i.type === 'ipv4'
          ? `[ipv4-addr:value = '${esc}']`
          : i.type === 'ipv6'
            ? `[ipv6-addr:value = '${esc}']`
            : i.type === 'url'
              ? `[url:value = '${esc}']`
              : i.type === 'sha256'
                ? `[file:hashes.'SHA-256' = '${esc}']`
                : null;
      return pattern
        ? {
            type: 'indicator',
            spec_version: '2.1',
            id: `indicator--${randomUUID()}`,
            created: now,
            modified: now,
            name: `${i.type}: ${i.value}`.slice(0, 200),
            description: i.context,
            pattern,
            pattern_type: 'stix',
            valid_from: i.first_seen ?? now,
          }
        : null;
    })
    .filter(Boolean);
  return { type: 'bundle', id: `bundle--${randomUUID()}`, objects };
}

/* ------------------------------ routes ----------------------------------- */

const Action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('block_ip'),
    params: z
      .object({
        ip: z.string().max(64).optional(),
        duration_hours: z
          .number()
          .positive()
          .max(24 * 365)
          .nullable()
          .optional(),
      })
      .default({}),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('unblock_ip'),
    params: z.object({ ip: z.string().max(64).optional() }).default({}),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('export_iocs'),
    params: z
      .object({ format: z.enum(['json', 'csv', 'stix']).default('json') })
      .default({ format: 'json' }),
    reason: z.string().max(256).optional(),
  }),
]);

const ManualBlock = z.object({
  ip: z.string().max(64),
  reason: z.string().max(256).optional(),
  duration_hours: z
    .number()
    .positive()
    .max(24 * 365)
    .nullable()
    .optional(),
});

export async function responseRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireSession };

  app.post('/v1/incidents/:iid/actions', auth, async (req, reply) => {
    const { incident, project, user } = await loadIncident(
      req,
      (req.params as { iid: string }).iid,
      'analyst',
    );
    const a = parse(Action, req.body);
    const access = { project, user };
    if (a.type === 'block_ip') {
      const ip = a.params.ip ?? incident.srcIp;
      const res = await blockIp(
        access,
        {
          ip,
          durationHours: a.params.duration_hours === undefined ? 24 : a.params.duration_hours,
          reason: a.reason,
          incidentId: incident.id,
        },
        req,
      );
      await publish(project.id, 'incident.updated', { id: incident.id, blocked: true });
      return reply.status(202).send(res);
    }
    if (a.type === 'unblock_ip') {
      const res = await unblockIp(
        access,
        { ip: a.params.ip ?? incident.srcIp, incidentId: incident.id },
        req,
      );
      await publish(project.id, 'incident.updated', { id: incident.id, blocked: false });
      return reply.status(202).send(res);
    }
    const { indicators } = await buildIocs(project.id, incident.id);
    const [row] = await db
      .insert(responseActions)
      .values({
        projectId: project.id,
        incidentId: incident.id,
        type: 'export_iocs',
        params: { format: a.params.format },
        status: 'completed',
        requestedBy: user.id,
        appliedAt: new Date(),
        result: { indicators: indicators.length },
      })
      .returning({ id: responseActions.id });
    await audit(db, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: 'user',
      actorId: user.id,
      action: 'response.export_iocs',
      targetType: 'incident',
      targetId: incident.id,
      metadata: { format: a.params.format, count: indicators.length },
      req,
    });
    if (a.params.format === 'csv')
      return reply
        .status(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .send(iocsToCsv(indicators));
    return reply.status(200).send({
      action_id: row!.id,
      status: 'completed',
      incident: incident.number,
      generated_at: new Date().toISOString(),
      project: project.name,
      indicators,
      ...(a.params.format === 'stix' ? { stix: iocsToStix(indicators) } : {}),
    });
  });

  app.get('/v1/projects/:pid/blocklist', auth, async (req) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid);
    const all = (req.query as { include_removed?: string }).include_removed === 'true';
    const rows = await db
      .select()
      .from(blocklistEntries)
      .where(
        and(
          eq(blocklistEntries.projectId, project.id),
          all ? undefined : dsql`${blocklistEntries.removedAt} is null`,
        ),
      )
      .orderBy(desc(blocklistEntries.createdAt))
      .limit(500);
    return {
      policy_version: project.policyVersion,
      items: rows.map((b) => ({
        id: b.id,
        ip: b.ip,
        reason: b.reason,
        incident_id: b.incidentId,
        created_by: b.createdBy,
        created_at: iso(b.createdAt),
        expires_at: iso(b.expiresAt),
        removed_at: iso(b.removedAt),
      })),
    };
  });

  app.post('/v1/projects/:pid/blocklist', auth, async (req, reply) => {
    const access = await projectAccess(req, (req.params as { pid: string }).pid, 'analyst');
    const b = parse(ManualBlock, req.body);
    const res = await blockIp(
      access,
      { ip: b.ip, durationHours: b.duration_hours ?? null, reason: b.reason ?? 'Manual block' },
      req,
    );
    return reply.status(202).send(res);
  });

  app.delete('/v1/projects/:pid/blocklist/:bid', auth, async (req, reply) => {
    const { pid, bid } = req.params as { pid: string; bid: string };
    const access = await projectAccess(req, pid, 'analyst');
    if (!isUuid(bid)) throw notFound('Block');
    const res = await unblockIp(access, { entryId: bid }, req);
    return reply.status(202).send(res);
  });

  app.get('/v1/projects/:pid/iocs', auth, async (req, reply) => {
    const { project } = await projectAccess(req, (req.params as { pid: string }).pid, 'analyst');
    const q = parse(
      z.object({
        format: z.enum(['json', 'csv', 'stix']).default('json'),
        incident: z.string().uuid().optional(),
      }),
      req.query,
    );
    const { indicators, incident } = await buildIocs(project.id, q.incident);
    if (q.format === 'csv')
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="iocs.csv"')
        .send(iocsToCsv(indicators));
    if (q.format === 'stix') return reply.send(iocsToStix(indicators));
    return { generated_at: new Date().toISOString(), project: project.name, incident, indicators };
  });
}
