import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { DecoyEvent } from '@lxs/schema';
import { and, desc, sql as dsql, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { decoys, events, sensors } from '../db/schema.js';
import { env } from '../env.js';
import { enqueueProcessEvents } from '../jobs/queue.js';
import { HttpError, invalid } from '../lib/errors.js';
import { parse } from '../lib/parse.js';
import { requireIngestKey } from '../plugins/bearer-key.js';
import { ingestRateLimit } from '../plugins/rate-limit.js';

const gunzipAsync = promisify(gunzip);

/**
 * Ceilings for compressed ingest bodies.
 *
 * gzip runs around 675:1 on repetitive JSON, so what a request costs is the
 * decompressed size, not the body limit: at the old 8x the default 2 MB body
 * could expand to 16 MB, with nothing bounding how many did so at once. 4x is
 * still far more than a legitimate batch needs — the envelope caps a batch at
 * 500 events and DecoyEvent caps each field — and the gate bounds how much
 * decompression can be in flight at any moment.
 *
 * `gunzipGate` is exported so the limit can be exercised in tests without
 * racing real requests against each other.
 */
const MAX_DECOMPRESSED_RATIO = 4;
export const gunzipGate = { inFlight: 0, max: 4 };

const Envelope = z.object({
  sensor_id: z.string().max(128).optional(),
  sent_at: z.string().optional(),
  events: z.array(z.unknown()).min(1).max(500),
});

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; id?: string; error: string }[];
  eventIds: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate, de-duplicate on (project_id, event_uid), store and enqueue. Shared by /v1/ingest and demo replay. */
export async function ingestEvents(opts: {
  projectId: string;
  apiKeyId?: string | null;
  sensorId?: string;
  rawEvents: unknown[];
}): Promise<IngestResult> {
  const valid: DecoyEvent[] = [];
  const rejected: IngestResult['rejected'] = [];
  opts.rawEvents.forEach((raw, index) => {
    const r = DecoyEvent.safeParse(raw);
    if (r.success) valid.push(r.data);
    else
      rejected.push({
        index,
        id:
          typeof (raw as { id?: unknown })?.id === 'string'
            ? (raw as { id: string }).id
            : undefined,
        error: r.error.issues[0]
          ? `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`
          : 'invalid event',
      });
  });
  if (valid.length === 0) {
    throw invalid('No valid events in batch', rejected.slice(0, 20));
  }

  // Resolve the sensor: explicit id (must belong to the project) or the newest sensor of this key.
  let sensorId: string | null = null;
  if (opts.sensorId && UUID_RE.test(opts.sensorId)) {
    const [s] = await db
      .select({ id: sensors.id })
      .from(sensors)
      .where(and(eq(sensors.id, opts.sensorId), eq(sensors.projectId, opts.projectId)))
      .limit(1);
    sensorId = s?.id ?? null;
  }
  if (!sensorId && opts.apiKeyId) {
    const [s] = await db
      .select({ id: sensors.id })
      .from(sensors)
      .where(and(eq(sensors.projectId, opts.projectId), eq(sensors.apiKeyId, opts.apiKeyId)))
      .orderBy(desc(sensors.lastSeenAt))
      .limit(1);
    sensorId = s?.id ?? null;
  }

  const keys = [...new Set(valid.map((e) => e.decoy_id).filter((k): k is string => !!k))];
  const decoyMap = new Map<string, string>();
  if (keys.length) {
    const rows = await db
      .select({ id: decoys.id, key: decoys.decoyKey, sensorId: decoys.sensorId })
      .from(decoys)
      .where(and(eq(decoys.projectId, opts.projectId), inArray(decoys.decoyKey, keys)));
    for (const r of rows)
      if (!decoyMap.has(r.key) || r.sensorId === sensorId) decoyMap.set(r.key, r.id);
  }

  const rows = valid.map((e) => {
    const fields: Record<string, unknown> = {
      sensor_kind: e.sensor,
      decoy_key: e.decoy_id,
      username: e.username,
      password_clear: e.password_clear,
      password_masked: e.password_masked,
      password_sha256: e.password_sha256,
      command: e.command,
      method: e.method,
      url: e.url,
      status_code: e.status_code,
      user_agent: e.user_agent,
      payload: e.payload,
      file_name: e.file_name,
      file_sha256: e.file_sha256,
      file_size: e.file_size,
      client_banner: e.client_banner,
      asset_name: e.asset_name,
      honeytoken_id: e.honeytoken_id,
    };
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    return {
      projectId: opts.projectId,
      sensorId,
      decoyId: e.decoy_id ? (decoyMap.get(e.decoy_id) ?? null) : null,
      eventUid: e.id,
      eventType: e.event_type,
      isDecoy: e.is_decoy,
      srcIp: e.src_ip,
      srcPort: e.src_port ?? null,
      sessionId: e.session_id ?? null,
      dstService: e.dst_service,
      outcome: e.outcome ?? null,
      occurredAt: new Date(e.timestamp),
      fields,
      raw: e.raw ?? null,
      count: e.count,
      simulated: e.simulated,
    };
  });

  // De-dup inside the batch too (same id twice in one request).
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.eventUid) ? false : (seen.add(r.eventUid), true)));

  const eventIds: string[] = [];
  try {
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const inserted = await db
        .insert(events)
        .values(chunk)
        .onConflictDoNothing({ target: [events.projectId, events.eventUid] })
        .returning({ id: events.id });
      for (const r of inserted) eventIds.push(r.id);
    }
  } catch {
    throw new HttpError(503, 'unavailable', 'Storage unavailable; keep buffering and retry');
  }

  if (keys.length) {
    await db
      .update(decoys)
      .set({ lastEventAt: dsql`now()`, status: 'online' })
      .where(and(eq(decoys.projectId, opts.projectId), inArray(decoys.decoyKey, keys)))
      .catch(() => {});
  }
  if (eventIds.length) await enqueueProcessEvents({ projectId: opts.projectId, eventIds });

  return {
    accepted: eventIds.length,
    duplicates: valid.length - eventIds.length,
    rejected,
    eventIds,
  };
}

/** JSON parser that also understands `Content-Encoding: gzip`. Must be registered on the ROOT instance. */
export function registerJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: env.MAX_BODY_BYTES },
    async (req: FastifyRequest, body: Buffer) => {
      let buf = body;
      const enc = req.headers['content-encoding'];
      if (enc === 'gzip') {
        const maxOutputLength = env.MAX_BODY_BYTES * MAX_DECOMPRESSED_RATIO;
        // 429, not 503: shedding load is a throttle, not a failure. The agent
        // treats both the same (keep the batch, back off with jitter — ship.ts),
        // but the error handler logs >= 500 at error level with a stack, so a
        // burst of 503s floods the API log with alarming traces mid-demo.
        if (gunzipGate.inFlight >= gunzipGate.max)
          throw new HttpError(
            429,
            'too_many_inflight',
            'Too many compressed batches in flight; keep buffering and retry',
          );
        gunzipGate.inFlight += 1;
        try {
          buf = await gunzipAsync(body, { maxOutputLength });
        } catch (err) {
          // A body that expands past the ceiling is a size problem, not a
          // malformed one; reporting it as "Invalid gzip body" sent agents
          // looking for a corruption bug that was not there.
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
            throw new HttpError(
              413,
              'payload_too_large',
              `Decompressed body exceeds ${maxOutputLength} bytes; send smaller batches`,
            );
          throw new HttpError(400, 'bad_encoding', 'Invalid gzip body');
        } finally {
          gunzipGate.inFlight -= 1;
        }
      }
      if (buf.length === 0) return {};
      try {
        return JSON.parse(buf.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
      }
    },
  );
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/ingest',
    { preHandler: requireIngestKey, config: ingestRateLimit, bodyLimit: env.MAX_BODY_BYTES },
    async (req, reply) => {
      const auth = req.ingest!;
      const body = parse(Envelope, req.body);
      const res = await ingestEvents({
        projectId: auth.projectId,
        apiKeyId: auth.keyId,
        sensorId: body.sensor_id,
        rawEvents: body.events,
      });
      return reply
        .status(202)
        .send({ accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected });
    },
  );
}
