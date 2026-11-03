import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql as rawSql } from '../db/client.js';
import { badRequest } from '../lib/errors.js';
import { decodeCursor, encodeCursor, LimitQuery } from '../lib/pagination.js';
import { parse } from '../lib/parse.js';
import { projectAccess, requireSession } from '../plugins/auth-session.js';

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export interface EventQuery {
  projectId: string;
  incidentId?: string;
  attackerId?: string;
  srcIp?: string;
  eventType?: string;
  isDecoy?: boolean;
  simulated?: boolean;
  since?: string;
  until?: string;
  q?: string;
  order?: 'asc' | 'desc';
  by?: 'received_at' | 'occurred_at';
  cursor?: string | null;
  limit: number;
}

interface Row {
  id: string;
  event_uid: string;
  event_type: string;
  is_decoy: boolean;
  src_ip: string;
  src_port: number | null;
  dst_service: string;
  decoy_key: string | null;
  session_id: string | null;
  outcome: string | null;
  occurred_at: string;
  received_at: string;
  fields: Record<string, unknown>;
  count: number;
  simulated: boolean;
  incident_id: string | null;
  attacker_id: string | null;
  stage: string | null;
  techniques: string[];
  tags: string[];
  cur: string;
}

/** Keyset-paginated event query. Timestamps travel as microsecond-precision text so cursors never skip rows. */
export async function queryEvents(
  f: EventQuery,
): Promise<{ items: unknown[]; next_cursor: string | null }> {
  const order = f.order ?? 'desc';
  const by = f.by ?? 'received_at';
  const col = rawSql.unsafe(`e.${by}`);
  const cursor = decodeCursor(f.cursor);
  const [curTs, curId] = cursor ? cursor.split('|') : [];
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;

  const rows = (await rawSql`
    select e.id, e.event_uid, e.event_type, e.is_decoy, host(e.src_ip) as src_ip, e.src_port, e.dst_service,
           d.decoy_key, e.session_id, e.outcome,
           to_char(e.occurred_at at time zone 'utc', ${rawSql.unsafe(ISO_MS)}) as occurred_at,
           to_char(e.received_at at time zone 'utc', ${rawSql.unsafe(ISO_MS)}) as received_at,
           e.fields, e.count, e.simulated, e.incident_id, e.attacker_id, e.stage, e.techniques, e.tags,
           to_char(${col} at time zone 'utc', ${rawSql.unsafe(ISO_US)}) as cur
    from events e
    left join decoys d on d.id = e.decoy_id
    where e.project_id = ${f.projectId}::uuid
      ${f.incidentId ? rawSql`and e.incident_id = ${f.incidentId}::uuid` : rawSql``}
      ${f.attackerId ? rawSql`and e.attacker_id = ${f.attackerId}::uuid` : rawSql``}
      ${f.srcIp ? rawSql`and e.src_ip = ${f.srcIp}::inet` : rawSql``}
      ${f.eventType ? rawSql`and e.event_type = ${f.eventType}` : rawSql``}
      ${f.isDecoy !== undefined ? rawSql`and e.is_decoy = ${f.isDecoy}` : rawSql``}
      ${f.simulated !== undefined ? rawSql`and e.simulated = ${f.simulated}` : rawSql``}
      ${f.since ? rawSql`and e.occurred_at >= ${f.since}::timestamptz` : rawSql``}
      ${f.until ? rawSql`and e.occurred_at <= ${f.until}::timestamptz` : rawSql``}
      ${like ? rawSql`and (e.fields::text ilike ${like} or e.dst_service ilike ${like})` : rawSql``}
      ${
        curTs && curId
          ? order === 'desc'
            ? rawSql`and (${col}, e.id) < (${curTs}::timestamptz, ${curId}::uuid)`
            : rawSql`and (${col}, e.id) > (${curTs}::timestamptz, ${curId}::uuid)`
          : rawSql``
      }
    order by ${col} ${rawSql.unsafe(order)}, e.id ${rawSql.unsafe(order)}
    limit ${f.limit + 1}
  `) as unknown as Row[];

  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(({ cur: _cur, decoy_key, attacker_id, ...r }) => ({
      ...r,
      decoy_id: decoy_key,
      attacker_id,
    })),
    next_cursor: hasMore && last ? encodeCursor(`${last.cur}|${last.id}`) : null,
  };
}

const Bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

export const EventsQuery = z.object({
  cursor: z.string().optional(),
  limit: LimitQuery,
  incident: z.string().uuid().optional(),
  attacker: z.string().uuid().optional(),
  src_ip: z.string().max(64).optional(),
  event_type: z.string().max(64).optional(),
  is_decoy: Bool,
  simulated: Bool,
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  q: z.string().max(200).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/projects/:pid/events', { preHandler: requireSession }, async (req) => {
    const { pid } = req.params as { pid: string };
    await projectAccess(req, pid, 'viewer');
    const q = parse(EventsQuery, req.query);
    if (q.cursor && !decodeCursor(q.cursor)?.includes('|')) throw badRequest('Invalid cursor');
    return queryEvents({
      projectId: pid,
      incidentId: q.incident,
      attackerId: q.attacker,
      srcIp: q.src_ip,
      eventType: q.event_type,
      isDecoy: q.is_decoy,
      simulated: q.simulated,
      since: q.since,
      until: q.until,
      q: q.q,
      order: q.order,
      cursor: q.cursor,
      limit: q.limit,
    });
  });
}
