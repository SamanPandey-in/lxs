import { createHash } from 'node:crypto';
import { and, sql as dsql, eq, isNotNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizations, projectExports, projects } from '../db/schema.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/notify.js';
import { PLAN_NAMES, PLANS } from '../lib/plans.js';
import { type ExportStorage, exportStorage } from './export-project.js';

/** sensor-staleness (every 30 s): mark sensors/decoys stale after 90 s, offline after 5 min. */
export async function sensorStaleness(): Promise<void> {
  const rows = (await db.execute(dsql`
    update sensors set status = case
        when last_seen_at < now() - interval '5 minutes' then 'offline'
        when last_seen_at < now() - interval '90 seconds' then 'stale'
        else 'online' end
    where status is distinct from case
        when last_seen_at < now() - interval '5 minutes' then 'offline'
        when last_seen_at < now() - interval '90 seconds' then 'stale'
        else 'online' end
    returning id, project_id, status
  `)) as unknown as { id: string; project_id: string; status: string }[];
  for (const r of rows) {
    await db.execute(dsql`update decoys set status = ${r.status} where sensor_id = ${r.id}::uuid`);
    await publish(r.project_id, 'sensor.status', { id: r.id, status: r.status });
  }
}

/** blocklist-expiry (every minute): remove expired entries and bump policy_version so agents drop them. */
export async function blocklistExpiry(): Promise<void> {
  const rows = (await db.execute(dsql`
    with gone as (
      update blocklist_entries set removed_at = now(), removed_by = 'system:expiry'
      where removed_at is null and expires_at is not null and expires_at <= now()
      returning project_id
    )
    update projects p set policy_version = policy_version + 1
    where p.id in (select project_id from gone)
    returning p.id
  `)) as unknown as { id: string }[];
  void rows;
}

/** auto-close-noise (hourly): resolve noise incidents idle for 72 h. */
export async function autoCloseNoise(): Promise<void> {
  await db.execute(dsql`
    update incidents set status = 'resolved', resolved_at = now(), resolved_by = 'system:auto-close', updated_at = now()
    where status in ('open','acknowledged') and label = 'noise' and last_event_at < now() - interval '72 hours'
  `);
}

/** The plan table as a SQL VALUES list, so purge statements can join an org's plan. */
function planValues() {
  return dsql.join(
    PLAN_NAMES.map(
      (n) => dsql`(${n}::text, ${PLANS[n].retentionDays}::int, ${PLANS[n].rawRetentionDays}::int)`,
    ),
    dsql`, `,
  );
}

/**
 * retention-purge (daily 03:00 UTC): delete events past retention and null `raw` past the raw
 * window. Both come from the org's plan (lib/plans.ts); a project may keep events for less
 * than its plan allows (`projects.retention_days`), never more. Unknown plans count as free.
 */
export async function retentionPurge(): Promise<void> {
  const free = PLANS.free;
  await db.execute(dsql`
    with plan(name, retention_days, raw_days) as (values ${planValues()})
    delete from events e
    using projects p
      join organizations o on o.id = p.org_id
      left join plan pl on pl.name = o.plan
    where e.project_id = p.id
      and e.received_at < now() - make_interval(days => least(p.retention_days, coalesce(pl.retention_days, ${free.retentionDays}::int)))
  `);
  await db.execute(dsql`
    with plan(name, retention_days, raw_days) as (values ${planValues()})
    update events e set raw = null
    from projects p
      join organizations o on o.id = p.org_id
      left join plan pl on pl.name = o.plan
    where e.project_id = p.id and e.raw is not null
      and e.received_at < now() - make_interval(days => coalesce(pl.raw_days, ${free.rawRetentionDays}::int))
  `);
}

/* ------------------------- captured-credential hashing ------------------------- */

type Json = Record<string, unknown>;

export const CREDENTIAL_KEYS = ['password_clear', 'password_masked', 'password_sha256'] as const;
export const credentialDigest = (pepper: string, value: string): string =>
  `sha256:${createHash('sha256')
    .update(pepper + value)
    .digest('hex')}`;

/**
 * Rewrite one event's credential fields (pure; tests call it directly). What stays: the
 * username, `password_hash` (`sha256:<hex>` of pepper + password), `password_length` when the
 * password was known, and `password_common` when it came from the common-credentials list.
 * What goes: `password_clear`, `password_masked` (it leaks two characters) and the
 * project-salted `password_sha256` (its salt lives in the same database). When only the salted
 * digest was stored, the pepper is applied to that digest instead (`password_hash_of`).
 * A top-level `raw.password` is replaced with the same hash.
 */
export function hashCredentialFields(
  fields: Json,
  raw: Json | null,
  pepper: string,
  now = new Date(),
): { fields: Json; raw: Json | null; changed: boolean } {
  const clear = typeof fields.password_clear === 'string' ? fields.password_clear : null;
  const rawPw = raw && typeof raw.password === 'string' ? raw.password : null;
  const salted = typeof fields.password_sha256 === 'string' ? fields.password_sha256 : null;
  const hasAny = CREDENTIAL_KEYS.some((k) => k in fields) || rawPw !== null;
  if (!hasAny) return { fields, raw, changed: false };

  const out: Json = {};
  for (const [k, v] of Object.entries(fields))
    if (!(CREDENTIAL_KEYS as readonly string[]).includes(k)) out[k] = v;
  const plain = clear ?? rawPw;
  if (plain !== null && plain !== '') {
    out.password_hash = credentialDigest(pepper, plain);
    out.password_hash_of = 'password';
    out.password_length = Array.from(plain).length;
  } else if (salted) {
    out.password_hash = credentialDigest(pepper, `salted:${salted}`);
    out.password_hash_of = 'salted_sha256';
  }
  if (clear !== null) out.password_common = true;
  out.password_hashed_at = now.toISOString();

  let newRaw = raw;
  if (raw && rawPw !== null)
    newRaw = { ...raw, password: rawPw === '' ? '' : credentialDigest(pepper, rawPw) };
  return { fields: out, raw: newRaw, changed: true };
}

export const CREDENTIAL_BATCH = 500;

/** Events the hashing job may rewrite: same predicate as `events_unhashed_creds_idx`. */
export const CREDENTIAL_PREDICATE = dsql`(fields ?| array['password_clear','password_masked','password_sha256'] or raw ? 'password')`;

/**
 * hash-credentials (daily, with retention-purge): replace attacker-typed passwords older than
 * CREDENTIAL_HASH_DAYS with a peppered hash. Only processed events are touched, and the
 * window is at least 2 days (env.ts), well past the correlator's 24 h lookback
 * (worker/process-events.ts), so detection and scoring of new chains never read a hashed
 * event. Returns the number of events rewritten.
 */
export async function hashCapturedCredentials(
  pepper = env.CREDENTIAL_PEPPER,
  days = env.CREDENTIAL_HASH_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let last = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const rows = (await db.execute(dsql`
      select id, fields, raw from events
      where received_at < ${cutoff}::timestamptz and processed_at is not null
        and ${CREDENTIAL_PREDICATE}
        and id > ${last}::uuid
      order by id limit ${CREDENTIAL_BATCH}
    `)) as unknown as { id: string; fields: Json | null; raw: Json | null }[];
    if (rows.length === 0) break;
    last = rows[rows.length - 1]!.id;
    const updates = rows
      .map((r) => ({ id: r.id, ...hashCredentialFields(r.fields ?? {}, r.raw, pepper) }))
      .filter((u) => u.changed)
      .map((u) => ({ id: u.id, f: u.fields, r: u.raw }));
    if (updates.length) {
      await db.execute(dsql`
        update events e set fields = x.f, raw = x.r
        from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as x(id uuid, f jsonb, r jsonb)
        where e.id = x.id
      `);
      total += updates.length;
    }
    if (rows.length < CREDENTIAL_BATCH) break;
  }
  return total;
}

/* ------------------------------ exports and delete ------------------------------ */

/** Exports stuck in pending/running this long are marked failed (a crashed worker). */
export const EXPORT_STUCK_MS = 2 * 3_600_000;

/**
 * export-cleanup (hourly, and with retention-purge): delete bundles past their expiry and
 * mark them expired; fail exports whose worker died mid-run.
 */
export async function exportCleanup(storage: ExportStorage = exportStorage()): Promise<number> {
  const now = new Date();
  const due = await db
    .select({ id: projectExports.id, key: projectExports.objectKey })
    .from(projectExports)
    .where(and(eq(projectExports.status, 'ready'), lte(projectExports.expiresAt, now)));
  for (const e of due) {
    if (e.key) await storage.remove(e.key);
    await db.update(projectExports).set({ status: 'expired' }).where(eq(projectExports.id, e.id));
  }
  const stuckBefore = new Date(now.getTime() - EXPORT_STUCK_MS);
  for (const status of ['pending', 'running'])
    await db
      .update(projectExports)
      .set({ status: 'failed', error: 'timed out', completedAt: now })
      .where(and(eq(projectExports.status, status), lte(projectExports.createdAt, stuckBefore)));
  return due.length;
}

export const PURGE_EVENT_BATCH = 5000;

/**
 * project-purge (daily, with retention-purge): hard-delete projects whose soft-delete grace
 * has passed, then organizations deleted with their last member's account once they have no
 * projects left. Restore is refused once `purge_after` has passed, so a purge never races a
 * restore. Events go first in batches so one huge project does not hold a giant cascade.
 */
export async function purgeDeletedProjects(
  storage: ExportStorage = exportStorage(),
): Promise<string[]> {
  const now = new Date();
  const due = await db
    .select({ id: projects.id, orgId: projects.orgId, slug: projects.slug })
    .from(projects)
    .where(and(isNotNull(projects.deletedAt), lte(projects.purgeAfter, now)));
  for (const p of due) {
    const files = await db
      .select({ key: projectExports.objectKey })
      .from(projectExports)
      .where(eq(projectExports.projectId, p.id));
    for (const f of files) if (f.key) await storage.remove(f.key);
    for (;;) {
      const gone = (await db.execute(dsql`
        delete from events where id in (
          select id from events where project_id = ${p.id}::uuid limit ${PURGE_EVENT_BATCH}
        ) returning id
      `)) as unknown as unknown[];
      if (gone.length < PURGE_EVENT_BATCH) break;
    }
    await db.delete(projects).where(and(eq(projects.id, p.id), isNotNull(projects.deletedAt)));
    const [org] = await db
      .select({ deletedAt: organizations.deletedAt })
      .from(organizations)
      .where(eq(organizations.id, p.orgId))
      .limit(1);
    if (org && !org.deletedAt)
      await audit(db, {
        orgId: p.orgId,
        actorType: 'system',
        action: 'project.purge',
        targetType: 'project',
        targetId: p.id,
        metadata: { slug: p.slug },
      });
  }
  const orgCutoff = new Date(now.getTime() - env.PROJECT_DELETE_GRACE_DAYS * 86_400_000);
  await db.execute(dsql`
    delete from organizations o
    where o.deleted_at is not null and o.deleted_at <= ${orgCutoff.toISOString()}::timestamptz
      and not exists (select 1 from projects p where p.org_id = o.id)
  `);
  return due.map((p) => p.id);
}

/**
 * The daily data-handling run: retention, credential hashing, hard deletes, export expiry.
 * Each step runs even if an earlier one failed; failures are rethrown together at the end.
 */
export async function dailyDataMaintenance(): Promise<void> {
  const errors: unknown[] = [];
  const steps: (() => Promise<unknown>)[] = [
    retentionPurge,
    () => hashCapturedCredentials(),
    () => purgeDeletedProjects(),
    () => exportCleanup(),
  ];
  for (const step of steps)
    try {
      await step();
    } catch (err) {
      errors.push(err);
    }
  if (errors.length) throw new AggregateError(errors, 'data maintenance failed');
}
