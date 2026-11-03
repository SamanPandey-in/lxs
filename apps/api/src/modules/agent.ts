import { createHash } from 'node:crypto';
import { AgentHeartbeat, AgentRegister, ContainmentReport } from '@lxs/schema';
import { and, sql as dsql, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { containmentReports, decoys, honeytokens, projects, sensors } from '../db/schema.js';
import { HttpError, invalid, notFound } from '../lib/errors.js';
import { publish } from '../lib/notify.js';
import { parse } from '../lib/parse.js';
import { isUuid } from '../plugins/auth-session.js';
import { requireIngestKey } from '../plugins/bearer-key.js';
import { ingestRateLimit } from '../plugins/rate-limit.js';

export const HEARTBEAT_SECONDS = 30;
export const POLICY_POLL_SECONDS = 5;
export const MAX_BATCH = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

async function ownedSensor(projectId: string, sensorId: string) {
  if (!isUuid(sensorId)) throw notFound('Sensor');
  const [s] = await db
    .select()
    .from(sensors)
    .where(and(eq(sensors.id, sensorId), eq(sensors.projectId, projectId)))
    .limit(1);
  if (!s)
    throw new HttpError(
      404,
      'sensor_not_found',
      'Unknown sensor_id for this key; call /v1/agent/register first',
    );
  return s;
}

/** When every online sensor has applied a policy version >= the action's, the action becomes `applied`. */
export async function settleActions(projectId: string): Promise<void> {
  const rows = (await db.execute(dsql`
    update response_actions ra set status = 'applied', applied_at = now(),
      result = jsonb_build_object('applied_policy_version', (select min(applied_policy_version) from sensors where project_id = ra.project_id and status = 'online'))
    where ra.project_id = ${projectId}::uuid and ra.status = 'pending' and ra.type in ('block_ip','unblock_ip')
      and exists (select 1 from sensors where project_id = ra.project_id and status = 'online')
      and (ra.params->>'policy_version')::int <= (select min(applied_policy_version) from sensors where project_id = ra.project_id and status = 'online')
    returning ra.id, ra.type, ra.incident_id
  `)) as unknown as { id: string; type: string; incident_id: string | null }[];
  for (const r of rows) {
    await publish(projectId, 'action.applied', {
      id: r.id,
      type: r.type,
      status: 'applied',
      incident_id: r.incident_id,
    });
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: requireIngestKey, config: ingestRateLimit };

  app.post('/v1/agent/register', pre, async (req) => {
    const auth = req.ingest!;
    const raw = isObj(req.body) ? req.body : {};
    const rawManifest = isObj(raw.manifest) ? raw.manifest : {};
    // Accept both {decoy_key} (schema) and {id} (BREAKDOWN example) and numeric mounts.
    const decoyList = Array.isArray(rawManifest.decoys) ? rawManifest.decoys : [];
    const normalized = decoyList.filter(isObj).map((d) => ({
      ...d,
      decoy_key: String(d.decoy_key ?? d.id ?? ''),
      type: String(d.type ?? 'unknown'),
      mount: String(d.mount ?? ''),
    }));
    const body = parse(AgentRegister, { ...raw, manifest: { ...rawManifest, decoys: normalized } });
    if (body.manifest.decoys.some((d) => !d.decoy_key))
      throw invalid('Every decoy needs a decoy_key');

    const [existing] = await db
      .select({ id: sensors.id })
      .from(sensors)
      .where(
        and(
          eq(sensors.projectId, auth.projectId),
          eq(sensors.apiKeyId, auth.keyId),
          eq(sensors.hostname, body.hostname),
        ),
      )
      .limit(1);

    const manifest = { ...rawManifest, decoys: normalized };
    let sensorId: string;
    if (existing) {
      sensorId = existing.id;
      await db
        .update(sensors)
        .set({
          agentVersion: body.agent_version,
          sdkVersion: body.sdk_version ?? null,
          manifest,
          status: 'online',
          lastSeenAt: dsql`now()`,
        })
        .where(eq(sensors.id, sensorId));
    } else {
      const [created] = await db
        .insert(sensors)
        .values({
          projectId: auth.projectId,
          apiKeyId: auth.keyId,
          hostname: body.hostname,
          agentVersion: body.agent_version,
          sdkVersion: body.sdk_version ?? null,
          manifest,
        })
        .returning({ id: sensors.id });
      sensorId = created!.id;
    }

    for (const d of body.manifest.decoys) {
      await db
        .insert(decoys)
        .values({
          projectId: auth.projectId,
          sensorId,
          decoyKey: d.decoy_key,
          type: d.type,
          mount: d.mount,
          persona: d.persona ?? null,
          declaredPosture: d.posture ?? {},
          status: 'online',
          lastHeartbeatAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [decoys.sensorId, decoys.decoyKey],
          set: {
            type: d.type,
            mount: d.mount,
            persona: d.persona ?? null,
            declaredPosture: d.posture ?? {},
            status: 'online',
          },
        });
    }

    // Honeytokens declared in the manifest (hashes only).
    const hts = Array.isArray(rawManifest.honeytokens) ? rawManifest.honeytokens.filter(isObj) : [];
    for (const h of hts) {
      const sha = String(h.sha256 ?? h.value_sha256 ?? '');
      if (!/^[0-9a-f]{64}$/i.test(sha) || typeof h.id !== 'string') continue;
      await db
        .insert(honeytokens)
        .values({
          id: h.id.slice(0, 64),
          projectId: auth.projectId,
          sensorId,
          kind: String(h.kind ?? 'api_key'),
          valueSha256: Buffer.from(sha, 'hex'),
          plantedIn: Array.isArray(h.planted_in) ? h.planted_in.map(String) : [],
        })
        .onConflictDoNothing();
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, auth.projectId))
      .limit(1);
    await publish(auth.projectId, 'sensor.status', {
      id: sensorId,
      hostname: body.hostname,
      status: 'online',
      registered: true,
    });
    return {
      sensor_id: sensorId,
      project: { id: project!.id, name: project!.name },
      password_salt: project!.passwordSalt.toString('base64'),
      heartbeat_seconds: HEARTBEAT_SECONDS,
      policy_poll_seconds: POLICY_POLL_SECONDS,
      max_batch: MAX_BATCH,
    };
  });

  app.post('/v1/agent/heartbeat', pre, async (req) => {
    const auth = req.ingest!;
    const body = parse(AgentHeartbeat, req.body);
    const sensor = await ownedSensor(auth.projectId, body.sensor_id);
    const wasOnline = sensor.status === 'online';
    await db
      .update(sensors)
      .set({
        appliedPolicyVersion: body.applied_policy_version,
        stats: body.stats ?? sensor.stats,
        status: 'online',
        lastSeenAt: dsql`now()`,
      })
      .where(eq(sensors.id, sensor.id));
    for (const d of body.decoys ?? []) {
      await db
        .update(decoys)
        .set({ status: d.status, lastHeartbeatAt: dsql`now()` })
        .where(and(eq(decoys.sensorId, sensor.id), eq(decoys.decoyKey, d.decoy_key)));
    }
    if (!wasOnline)
      await publish(auth.projectId, 'sensor.status', { id: sensor.id, status: 'online' });
    await settleActions(auth.projectId);
    const [p] = await db
      .select({ v: projects.policyVersion })
      .from(projects)
      .where(eq(projects.id, auth.projectId));
    return { ok: true, policy_version: p?.v ?? 0, server_time: new Date().toISOString() };
  });

  app.get('/v1/agent/policy', pre, async (req, reply) => {
    const auth = req.ingest!;
    const [p] = await db
      .select({ v: projects.policyVersion, allow: projects.allowlist })
      .from(projects)
      .where(eq(projects.id, auth.projectId));
    const blocklist = (await db.execute(dsql`
      select host(ip) as ip, reason, expires_at from blocklist_entries
      where project_id = ${auth.projectId}::uuid and removed_at is null and (expires_at is null or expires_at > now())
      order by created_at desc limit 10000
    `)) as unknown as { ip: string; reason: string | null; expires_at: Date | string | null }[];
    const watch = (await db.execute(dsql`
      select host(src_ip) as ip from events
      where project_id = ${auth.projectId}::uuid and is_decoy and received_at > now() - interval '24 hours'
      group by src_ip order by max(received_at) desc limit 50000
    `)) as unknown as { ip: string }[];

    const version = p?.v ?? 0;
    const watchlist = watch.map((r) => r.ip);
    const wHash = createHash('sha1').update(watchlist.join(',')).digest('hex').slice(0, 8);
    const etag = `"pv-${version}-${wHash}"`;
    void reply.header('ETag', etag).header('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();

    return {
      policy_version: version,
      version,
      blocklist: blocklist.map((b) => ({
        ip: b.ip,
        ...(b.reason ? { reason: b.reason } : {}),
        expires_at: b.expires_at ? new Date(b.expires_at).toISOString() : null,
      })),
      watchlist,
      allowlist: p?.allow ?? [],
      block_ttl_seconds: 3600,
      poll_interval_seconds: POLICY_POLL_SECONDS,
    };
  });

  app.post('/v1/agent/selftest-report', pre, async (req, reply) => {
    const auth = req.ingest!;
    const body = parse(ContainmentReport, req.body);
    const sensor = await ownedSensor(auth.projectId, body.sensor_id);
    const [row] = await db
      .insert(containmentReports)
      .values({
        projectId: auth.projectId,
        sensorId: sensor.id,
        passed: body.passed,
        checks: body.checks,
      })
      .returning({ id: containmentReports.id });
    await publish(auth.projectId, 'sensor.status', {
      id: sensor.id,
      containment_passed: body.passed,
    });
    return reply.status(201).send({ id: row!.id, passed: body.passed });
  });
}
