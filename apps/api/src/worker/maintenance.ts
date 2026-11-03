import { sql as dsql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { publish } from '../lib/notify.js';

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

/** retention-purge (daily 03:00 UTC): delete events past retention, null raw after 7 days. */
export async function retentionPurge(): Promise<void> {
  await db.execute(dsql`
    delete from events e using projects p
    where e.project_id = p.id and e.received_at < now() - make_interval(days => p.retention_days)
  `);
  await db.execute(
    dsql`update events set raw = null where raw is not null and received_at < now() - interval '7 days'`,
  );
}
