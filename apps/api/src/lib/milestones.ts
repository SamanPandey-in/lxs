/**
 * Project milestones. Each is recorded once per project (`project_milestones`, primary key
 * project + key). `reached_at` is taken from the data (when the first targeted attacker's
 * incident opened, when the first block was applied, ...), not from when we noticed, so
 * evaluating late or twice changes nothing. `recorded_at` says when we noticed, which is what
 * the dashboard uses to decide whether a milestone is "new".
 *
 * Sample data and test hits never count.
 */
import { asc, sql as dsql, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectMilestones } from '../db/schema.js';

export const MILESTONES = [
  {
    key: 'first_catch',
    title: 'First attacker caught',
    description: 'A real source touched one of your decoys for the first time.',
  },
  {
    key: 'first_targeted',
    title: 'First targeted attacker',
    description: 'An incident was labelled targeted: someone went after this deployment.',
  },
  {
    key: 'first_honeytoken_use',
    title: 'First honeytoken use',
    description: 'A planted credential was used, so it was taken from a decoy and tried.',
  },
  {
    key: 'first_block',
    title: 'First successful block',
    description: 'A block was applied by your sensors.',
  },
  {
    key: 'attackers_100',
    title: '100 attackers caught',
    description: 'One hundred distinct sources have touched your decoys.',
  },
  {
    key: 'quiet_week',
    title: 'A week with no critical incidents',
    description: 'A full week of live traffic without a single critical incident.',
  },
] as const;

export type MilestoneKey = (typeof MILESTONES)[number]['key'];
const META = new Map<string, (typeof MILESTONES)[number]>(MILESTONES.map((m) => [m.key, m]));
export const milestoneTitle = (key: string): string => META.get(key)?.title ?? key;

export interface MilestoneFacts {
  firstCatchAt: Date | null;
  firstTargetedAt: Date | null;
  firstHoneytokenUseAt: Date | null;
  firstBlockAt: Date | null;
  /** first_seen_at of the 100th distinct real attacker (null below 100). */
  hundredthAttackerAt: Date | null;
  /** End of the first full ISO week with real traffic and no critical incident. */
  quietWeekEndAt: Date | null;
  quietWeek: string | null;
}

export interface ReachedMilestone {
  key: MilestoneKey;
  reachedAt: Date;
  detail: Record<string, unknown>;
}

/** Pure: which milestones the facts show as reached. Order follows MILESTONES. */
export function reachedMilestones(f: MilestoneFacts): ReachedMilestone[] {
  const out: ReachedMilestone[] = [];
  const add = (key: MilestoneKey, at: Date | null, detail: Record<string, unknown> = {}) => {
    if (at && !Number.isNaN(at.getTime())) out.push({ key, reachedAt: at, detail });
  };
  add('first_catch', f.firstCatchAt);
  add('first_targeted', f.firstTargetedAt);
  add('first_honeytoken_use', f.firstHoneytokenUseAt);
  add('first_block', f.firstBlockAt);
  add('attackers_100', f.hundredthAttackerAt);
  add('quiet_week', f.quietWeekEndAt, f.quietWeek ? { week: f.quietWeek } : {});
  return out;
}

const date = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function factsFromRow(row: Record<string, unknown> | undefined): MilestoneFacts {
  return {
    firstCatchAt: date(row?.first_catch_at),
    firstTargetedAt: date(row?.first_targeted_at),
    firstHoneytokenUseAt: date(row?.first_honeytoken_use_at),
    firstBlockAt: date(row?.first_block_at),
    hundredthAttackerAt: date(row?.hundredth_attacker_at),
    quietWeekEndAt: date(row?.quiet_week_end_at),
    quietWeek: typeof row?.quiet_week === 'string' ? row.quiet_week : null,
  };
}

const REAL = dsql.raw('not e.sample and not e.simulated');

export async function loadMilestoneFacts(projectId: string): Promise<MilestoneFacts> {
  const rows = (await db.execute(dsql`
    with first_ev as (
      select min(e.received_at) as at from events e
      where e.project_id = ${projectId}::uuid and ${REAL} and e.attacker_id is not null
    ),
    weeks as (
      select w as week_start
      from first_ev,
        generate_series(
          (date_trunc('week', first_ev.at at time zone 'UTC') + interval '1 week') at time zone 'UTC',
          (date_trunc('week', now() at time zone 'UTC') - interval '1 week') at time zone 'UTC',
          interval '1 week') w
      where first_ev.at is not null
    )
    select
      (select at from first_ev) as first_catch_at,
      (select min(i.opened_at) from incidents i
        where i.project_id = ${projectId}::uuid and i.label = 'targeted'
          and exists (select 1 from events e where e.incident_id = i.id and ${REAL})) as first_targeted_at,
      (select min(e.received_at) from events e
        where e.project_id = ${projectId}::uuid and e.event_type = 'honeytoken.use' and ${REAL}) as first_honeytoken_use_at,
      (select min(ra.applied_at) from response_actions ra
        where ra.project_id = ${projectId}::uuid and ra.type = 'block_ip'
          and ra.status in ('applied', 'completed') and ra.applied_at is not null
          and (ra.incident_id is null or exists (
            select 1 from events e where e.incident_id = ra.incident_id and ${REAL}))) as first_block_at,
      (select a.first_seen_at from attackers a
        where a.project_id = ${projectId}::uuid
          and exists (select 1 from events e where e.attacker_id = a.id and ${REAL})
        order by a.first_seen_at, a.id offset 99 limit 1) as hundredth_attacker_at,
      q.week_end as quiet_week_end_at,
      q.week as quiet_week
    from (select 1) one
    left join lateral (
      select wk.week_start + interval '1 week' as week_end,
             to_char(wk.week_start at time zone 'UTC', 'IYYY-"W"IW') as week
      from weeks wk
      where exists (
          select 1 from events e where e.project_id = ${projectId}::uuid and ${REAL}
            and e.received_at >= wk.week_start and e.received_at < wk.week_start + interval '1 week')
        and not exists (
          select 1 from incidents i where i.project_id = ${projectId}::uuid and i.severity = 'critical'
            and i.opened_at >= wk.week_start and i.opened_at < wk.week_start + interval '1 week'
            and exists (select 1 from events e where e.incident_id = i.id and ${REAL}))
      order by wk.week_start limit 1
    ) q on true
  `)) as unknown as Record<string, unknown>[];
  return factsFromRow(rows[0]);
}

export interface MilestoneView {
  key: string;
  title: string;
  description: string;
  reached_at: string;
  recorded_at: string;
  detail: Record<string, unknown>;
}

const view = (r: typeof projectMilestones.$inferSelect): MilestoneView => ({
  key: r.key,
  title: milestoneTitle(r.key),
  description: META.get(r.key)?.description ?? '',
  reached_at: new Date(r.reachedAt).toISOString(),
  recorded_at: new Date(r.recordedAt).toISOString(),
  detail: (r.detail ?? {}) as Record<string, unknown>,
});

/** Record any newly reached milestones (idempotent), then return all of the project's, oldest first. */
export async function recordMilestones(projectId: string): Promise<MilestoneView[]> {
  const reached = reachedMilestones(await loadMilestoneFacts(projectId));
  if (reached.length)
    await db
      .insert(projectMilestones)
      .values(
        reached.map((m) => ({
          projectId,
          key: m.key,
          reachedAt: m.reachedAt,
          detail: m.detail,
        })),
      )
      .onConflictDoNothing();
  const rows = await db
    .select()
    .from(projectMilestones)
    .where(eq(projectMilestones.projectId, projectId))
    .orderBy(asc(projectMilestones.reachedAt));
  return rows.map(view);
}
