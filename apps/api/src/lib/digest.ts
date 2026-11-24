/**
 * Weekly digest: what the honeypots caught in a week, and what nobody had to read.
 *
 * Three layers, so the arithmetic and the wording can be tested without a database:
 * - windows (`weeklyWindow`, `rollingWindow`, `isoWeek`): which seven days a digest covers;
 * - counts (`loadDigestCounts`): one aggregate query per window. Onboarding sample data
 *   (`events.sample`) and test hits (`events.simulated`) are excluded from every number;
 * - rendering (`buildDigest`, `renderDigestText`, `renderDigestHtml`, `formatDigestSlack`,
 *   `formatDigestWebhook`): pure functions of a `Digest`.
 *
 * The unsubscribe link carries a signed token (`unsubscribeToken`), so it works without a
 * session and cannot be forged for another user.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { signToken, verifyToken } from './crypto.js';
import type { MailMessage } from './mailer.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/* ───────── windows ───────── */

export interface DigestWindow {
  start: Date;
  end: Date;
  /** ISO week the window is filed under (dedupe key), e.g. `2026-W47`. */
  week: string;
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function startOfIsoWeek(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** ISO-8601 week label (`YYYY-Www`, UTC). The year is the ISO week-numbering year. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The last complete ISO week before `now` (Monday 00:00 to Monday 00:00 UTC). */
export function weeklyWindow(now: Date): DigestWindow {
  const end = startOfIsoWeek(now);
  const start = new Date(end.getTime() - WEEK_MS);
  return { start, end, week: isoWeek(start) };
}

/** The seven days ending at `now` (the dashboard preview), filed under the current ISO week. */
export function rollingWindow(now: Date): DigestWindow {
  return { start: new Date(now.getTime() - WEEK_MS), end: now, week: isoWeek(now) };
}

/** The same-length window immediately before `w`. */
export function previousWindow(w: DigestWindow): { start: Date; end: Date } {
  const len = w.end.getTime() - w.start.getTime();
  return { start: new Date(w.start.getTime() - len), end: w.start };
}

/* ───────── counts ───────── */

export interface TechniqueCount {
  id: string;
  name: string;
  incidents: number;
}

export interface DigestCounts {
  attackers: { targeted: number; opportunistic: number; noise: number; total: number };
  incidents: { critical: number; high: number; medium: number; low: number; total: number };
  techniques: TechniqueCount[];
  /** Blocks added in the window, and blocks in force when it ended. */
  blocks: { issued: number; held: number };
  /** Response actions (block/unblock/...) applied in the window. */
  actions: number;
  /** What an analyst did not have to read: events and incidents labelled noise or auto-closed. */
  noise: { events: number; incidents: number };
  honeytokenUses: number;
  /** All real events in the window (the denominator for `noise.events`). */
  events: number;
}

export const emptyCounts = (): DigestCounts => ({
  attackers: { targeted: 0, opportunistic: 0, noise: 0, total: 0 },
  incidents: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
  techniques: [],
  blocks: { issued: 0, held: 0 },
  actions: 0,
  noise: { events: 0, incidents: 0 },
  honeytokenUses: 0,
  events: 0,
});

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
};

const arr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

/** Map one row of the counts query to `DigestCounts` (tolerates missing columns). */
export function countsFromRow(row: Record<string, unknown> | undefined): DigestCounts {
  if (!row) return emptyCounts();
  const a = obj(row.attackers);
  const i = obj(row.incidents);
  const techs = arr(row.techniques);
  const attackers = {
    targeted: n(a.targeted),
    opportunistic: n(a.opportunistic),
    noise: n(a.noise),
    total: 0,
  };
  attackers.total = attackers.targeted + attackers.opportunistic + attackers.noise;
  const incidents = {
    critical: n(i.critical),
    high: n(i.high),
    medium: n(i.medium),
    low: n(i.low),
    total: 0,
  };
  incidents.total = incidents.critical + incidents.high + incidents.medium + incidents.low;
  return {
    attackers,
    incidents,
    techniques: techs
      .map((t) => obj(t))
      .filter((t) => typeof t.id === 'string' && t.id)
      .map((t) => ({ id: String(t.id), name: String(t.name ?? t.id), incidents: n(t.incidents) })),
    blocks: { issued: n(row.blocks_issued), held: n(row.blocks_held) },
    actions: n(row.actions),
    noise: { events: n(row.noise_events), incidents: n(row.noise_incidents) },
    honeytokenUses: n(row.honeytoken_uses),
    events: n(row.events),
  };
}

/** A real (non-sample, non-test) event exists for this incident. Used to drop sample-only incidents. */
const realIncident = (col: string) =>
  dsql.raw(
    `exists (select 1 from events re where re.incident_id = ${col} and not re.sample and not re.simulated)`,
  );

/** Every digest number for one project over `[start, end)`, in one query. */
export async function loadDigestCounts(
  projectId: string,
  start: Date,
  end: Date,
): Promise<DigestCounts> {
  const s = start.toISOString();
  const e = end.toISOString();
  const rows = (await db.execute(dsql`
    with ev as (
      select e.attacker_id, e.incident_id, e.event_type, e.tags, e.count
      from events e
      where e.project_id = ${projectId}::uuid and e.received_at >= ${s}::timestamptz
        and e.received_at < ${e}::timestamptz and not e.sample and not e.simulated
    ),
    inc as (
      select i.id, i.severity, i.label from incidents i
      where i.project_id = ${projectId}::uuid and i.opened_at >= ${s}::timestamptz
        and i.opened_at < ${e}::timestamptz and ${realIncident('i.id')}
    )
    select
      (select json_build_object(
          'targeted', count(*) filter (where a.label = 'targeted'),
          'opportunistic', count(*) filter (where a.label = 'opportunistic'),
          'noise', count(*) filter (where a.label not in ('targeted', 'opportunistic')))
        from attackers a
        where a.project_id = ${projectId}::uuid
          and a.id in (select attacker_id from ev where attacker_id is not null)) as attackers,
      (select json_build_object(
          'critical', count(*) filter (where severity = 'critical'),
          'high', count(*) filter (where severity = 'high'),
          'medium', count(*) filter (where severity = 'medium'),
          'low', count(*) filter (where severity not in ('critical', 'high', 'medium')))
        from inc) as incidents,
      (select coalesce(json_agg(t order by t.incidents desc, t.id), '[]'::json) from (
          select tj->>'id' as id, max(tj->>'name') as name, count(distinct d.incident_id)::int as incidents
          from detections d join inc on inc.id = d.incident_id
          cross join lateral jsonb_array_elements(d.techniques) tj
          where tj->>'id' is not null
          group by tj->>'id' order by count(distinct d.incident_id) desc, tj->>'id' limit 5) t) as techniques,
      (select count(*)::int from blocklist_entries b
        where b.project_id = ${projectId}::uuid and b.created_at >= ${s}::timestamptz
          and b.created_at < ${e}::timestamptz
          and (b.incident_id is null or ${realIncident('b.incident_id')})) as blocks_issued,
      (select count(*)::int from blocklist_entries b
        where b.project_id = ${projectId}::uuid and b.created_at < ${e}::timestamptz
          and (b.removed_at is null or b.removed_at >= ${e}::timestamptz)
          and (b.expires_at is null or b.expires_at > ${e}::timestamptz)
          and (b.incident_id is null or ${realIncident('b.incident_id')})) as blocks_held,
      (select count(*)::int from response_actions ra
        where ra.project_id = ${projectId}::uuid and ra.status in ('applied', 'completed')
          and coalesce(ra.applied_at, ra.requested_at) >= ${s}::timestamptz
          and coalesce(ra.applied_at, ra.requested_at) < ${e}::timestamptz
          and (ra.incident_id is null or ${realIncident('ra.incident_id')})) as actions,
      (select coalesce(sum(ev.count), 0)::int from ev left join incidents i on i.id = ev.incident_id
        where i.label = 'noise' or i.resolved_by = 'system:auto-close'
          or 'allowlisted' = any(ev.tags)) as noise_events,
      (select count(*)::int from incidents i
        where i.project_id = ${projectId}::uuid and ${realIncident('i.id')}
          and ((i.label = 'noise' and i.opened_at >= ${s}::timestamptz and i.opened_at < ${e}::timestamptz)
            or (i.resolved_by = 'system:auto-close' and i.resolved_at >= ${s}::timestamptz
              and i.resolved_at < ${e}::timestamptz))) as noise_incidents,
      (select coalesce(sum(count), 0)::int from ev where event_type = 'honeytoken.use') as honeytoken_uses,
      (select coalesce(sum(count), 0)::int from ev) as events
  `)) as unknown as Record<string, unknown>[];
  return countsFromRow(rows[0]);
}

/* ───────── the digest model ───────── */

export interface Delta {
  current: number;
  previous: number;
  diff: number;
  /** Whole-number percent change; null when the previous week was zero. */
  pct: number | null;
}

export const delta = (current: number, previous: number): Delta => ({
  current,
  previous,
  diff: current - previous,
  pct: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
});

export interface DigestMilestone {
  key: string;
  title: string;
  reached_at: string;
}

export interface Digest {
  project: { id: string; name: string };
  week: string;
  period: { start: string; end: string };
  current: DigestCounts;
  previous: DigestCounts;
  change: {
    attackers: Delta;
    targeted: Delta;
    incidents: Delta;
    critical: Delta;
    blocks: Delta;
    noise: Delta;
    honeytokenUses: Delta;
  };
  milestones: DigestMilestone[];
}

export function buildDigest(input: {
  project: { id: string; name: string };
  window: DigestWindow;
  current: DigestCounts;
  previous: DigestCounts;
  milestones?: DigestMilestone[];
}): Digest {
  const { current: c, previous: p } = input;
  return {
    project: input.project,
    week: input.window.week,
    period: { start: input.window.start.toISOString(), end: input.window.end.toISOString() },
    current: c,
    previous: p,
    change: {
      attackers: delta(c.attackers.total, p.attackers.total),
      targeted: delta(c.attackers.targeted, p.attackers.targeted),
      incidents: delta(c.incidents.total, p.incidents.total),
      critical: delta(c.incidents.critical, p.incidents.critical),
      blocks: delta(c.blocks.issued, p.blocks.issued),
      noise: delta(c.noise.events, p.noise.events),
      honeytokenUses: delta(c.honeytokenUses, p.honeytokenUses),
    },
    milestones: input.milestones ?? [],
  };
}

/** True when nothing at all happened in the week (still worth a short "quiet week" note). */
export const isQuiet = (d: Digest): boolean =>
  d.current.events === 0 && d.current.incidents.total === 0 && d.current.blocks.held === 0;

/* ───────── rendering ───────── */

const fmt = (x: number): string => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${fmt(x)} ${x === 1 ? one : many}`;

/** "+5 vs last week", "-2 vs last week", "same as last week". */
export function changeText(d: Delta): string {
  if (d.diff === 0) return 'same as last week';
  const sign = d.diff > 0 ? '+' : '-';
  const pct = d.pct === null ? '' : ` (${sign}${Math.abs(d.pct)}%)`;
  return `${sign}${fmt(Math.abs(d.diff))}${pct} vs last week`;
}

/** `2026-11-16 to 2026-11-22` (the end is exclusive, so the last day shown is end - 1 ms). */
export function periodText(d: Digest): string {
  const start = d.period.start.slice(0, 10);
  const last = new Date(new Date(d.period.end).getTime() - 1).toISOString().slice(0, 10);
  return `${start} to ${last} (UTC)`;
}

export interface DigestLinks {
  dashboard: string;
  unsubscribe?: string;
  settings?: string;
}

export function digestSubject(d: Digest): string {
  const c = d.current;
  const crit = c.incidents.critical ? `, ${plural(c.incidents.critical, 'critical incident')}` : '';
  return `LXS weekly digest for ${d.project.name}: ${plural(c.attackers.total, 'attacker')}${crit} (${d.week})`;
}

/** The digest as plain lines (shared by the text email and the Slack fallback). */
export function digestLines(d: Digest): string[] {
  const c = d.current;
  const lines = [
    `Attackers caught: ${fmt(c.attackers.total)} (${changeText(d.change.attackers)})`,
    `  targeted ${fmt(c.attackers.targeted)}, opportunistic ${fmt(c.attackers.opportunistic)}, noise ${fmt(c.attackers.noise)}`,
    `Incidents opened: ${fmt(c.incidents.total)} (${changeText(d.change.incidents)})`,
    `  critical ${fmt(c.incidents.critical)}, high ${fmt(c.incidents.high)}, medium ${fmt(c.incidents.medium)}, low ${fmt(c.incidents.low)}`,
  ];
  if (c.techniques.length) {
    lines.push('Top ATT&CK techniques:');
    for (const t of c.techniques)
      lines.push(`  ${t.id} ${t.name}: ${plural(t.incidents, 'incident')}`);
  } else lines.push('Top ATT&CK techniques: none observed');
  lines.push(
    `Blocks: ${fmt(c.blocks.issued)} issued, ${fmt(c.blocks.held)} in force at week end, ${plural(c.actions, 'response action')} applied`,
    `Noise you did not have to read: ${plural(c.noise.events, 'event')} across ${plural(c.noise.incidents, 'incident')} (labelled noise or auto-closed)${c.events ? `, ${pctOf(c.noise.events, c.events)} of all events` : ''}`,
    `Honeytoken uses: ${fmt(c.honeytokenUses)}`,
  );
  if (d.milestones.length)
    lines.push(`Milestones reached: ${d.milestones.map((m) => m.title).join(', ')}`);
  return lines;
}

const pctOf = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';

export function renderDigestText(d: Digest, links: DigestLinks): string {
  const out = [
    `LXS weekly digest: ${d.project.name}`,
    `Week ${d.week}, ${periodText(d)}`,
    '',
    ...(isQuiet(d)
      ? ['A quiet week: no real traffic reached your decoys and nothing is blocked.', '']
      : []),
    ...digestLines(d),
    '',
    `Open the dashboard: ${links.dashboard}`,
    'Sample data and test hits are not counted.',
  ];
  if (links.unsubscribe) out.push('', `Stop these emails: ${links.unsubscribe}`, '— LXS');
  return out.join('\n');
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Email-safe HTML: tables, inline styles, no images, no colour beyond neutral greys. */
export function renderDigestHtml(d: Digest, links: DigestLinks): string {
  const c = d.current;
  const row = (label: string, value: string, note = '') =>
    `<tr><td style="padding:6px 0;color:#52525b;font-size:14px">${esc(label)}</td>` +
    `<td style="padding:6px 0;text-align:right;font-size:14px;color:#18181b;font-weight:600">${esc(value)}</td>` +
    `<td style="padding:6px 0 6px 12px;text-align:right;font-size:12px;color:#71717a">${esc(note)}</td></tr>`;
  const techniques = c.techniques.length
    ? c.techniques
        .map(
          (t) =>
            `<tr><td style="padding:4px 0;font-size:14px;color:#18181b"><span style="font-family:ui-monospace,Menlo,monospace">${esc(t.id)}</span> ${esc(t.name)}</td>` +
            `<td style="padding:4px 0;text-align:right;font-size:14px;color:#18181b">${esc(plural(t.incidents, 'incident'))}</td></tr>`,
        )
        .join('')
    : '<tr><td style="padding:4px 0;font-size:14px;color:#71717a">None observed</td></tr>';
  const milestones = d.milestones.length
    ? `<p style="margin:16px 0 0;font-size:14px;color:#18181b"><strong>Milestones reached:</strong> ${esc(d.milestones.map((m) => m.title).join(', '))}</p>`
    : '';
  const quiet = isQuiet(d)
    ? '<p style="margin:0 0 12px;font-size:14px;color:#52525b">A quiet week: no real traffic reached your decoys and nothing is blocked.</p>'
    : '';
  const unsub = links.unsubscribe
    ? ` · <a href="${esc(links.unsubscribe)}" style="color:#71717a">Stop these emails</a>`
    : '';
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:24px">
<p style="margin:0;font-size:12px;color:#71717a">LXS weekly digest · ${esc(d.week)} · ${esc(periodText(d))}</p>
<h1 style="margin:4px 0 16px;font-size:20px;font-weight:600;color:#18181b">${esc(d.project.name)}</h1>
${quiet}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${row('Attackers caught', fmt(c.attackers.total), changeText(d.change.attackers))}
${row('  targeted / opportunistic / noise', `${fmt(c.attackers.targeted)} / ${fmt(c.attackers.opportunistic)} / ${fmt(c.attackers.noise)}`)}
${row('Incidents opened', fmt(c.incidents.total), changeText(d.change.incidents))}
${row('  critical / high / medium / low', `${fmt(c.incidents.critical)} / ${fmt(c.incidents.high)} / ${fmt(c.incidents.medium)} / ${fmt(c.incidents.low)}`)}
${row('Blocks issued', fmt(c.blocks.issued), `${fmt(c.blocks.held)} in force at week end`)}
${row('Response actions applied', fmt(c.actions))}
${row('Noise you did not have to read', plural(c.noise.events, 'event'), `${plural(c.noise.incidents, 'incident')}${c.events ? `, ${pctOf(c.noise.events, c.events)} of events` : ''}`)}
${row('Honeytoken uses', fmt(c.honeytokenUses), changeText(d.change.honeytokenUses))}
</table>
<p style="margin:20px 0 4px;font-size:14px;font-weight:600;color:#18181b">Top ATT&amp;CK techniques</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${techniques}</table>
${milestones}
<p style="margin:24px 0 0"><a href="${esc(links.dashboard)}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px">Open the dashboard</a></p>
</td></tr></table>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#71717a">Sample data and test hits are not counted.${unsub}</p>
</body></html>`;
}

export function digestEmail(to: string, d: Digest, links: DigestLinks): MailMessage {
  return {
    to,
    subject: digestSubject(d),
    text: renderDigestText(d, links),
    html: renderDigestHtml(d, links),
  };
}

const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatDigestSlack(d: Digest, dashboardUrl: string): Record<string, unknown> {
  const c = d.current;
  const title = `Weekly digest: ${d.project.name} (${d.week})`;
  const techs = c.techniques.length
    ? c.techniques.map((t) => `\`${t.id}\` ${slackEscape(t.name)}: ${t.incidents}`).join('\n')
    : 'None observed';
  return {
    text: `${title}: ${plural(c.attackers.total, 'attacker')}, ${plural(c.incidents.total, 'incident')}, ${plural(c.noise.events, 'noise event')} you did not have to read`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: false } },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `${periodText(d)}. Sample data and test hits are not counted.` },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Attackers caught*\n${fmt(c.attackers.total)} (${changeText(d.change.attackers)})\ntargeted ${c.attackers.targeted}, opportunistic ${c.attackers.opportunistic}, noise ${c.attackers.noise}`,
          },
          {
            type: 'mrkdwn',
            text: `*Incidents opened*\n${fmt(c.incidents.total)} (${changeText(d.change.incidents)})\ncritical ${c.incidents.critical}, high ${c.incidents.high}, medium ${c.incidents.medium}, low ${c.incidents.low}`,
          },
          {
            type: 'mrkdwn',
            text: `*Blocks*\n${fmt(c.blocks.issued)} issued, ${fmt(c.blocks.held)} in force\n${plural(c.actions, 'response action')} applied`,
          },
          {
            type: 'mrkdwn',
            text: `*Noise you did not have to read*\n${plural(c.noise.events, 'event')}, ${plural(c.noise.incidents, 'incident')}`,
          },
          { type: 'mrkdwn', text: `*Honeytoken uses*\n${fmt(c.honeytokenUses)}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Top ATT&CK techniques*\n${techs}` } },
      ...(d.milestones.length
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Milestones reached*\n${slackEscape(d.milestones.map((m) => m.title).join(', '))}`,
              },
            },
          ]
        : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open the dashboard' },
            url: dashboardUrl,
          },
        ],
      },
    ],
  };
}

export function formatDigestWebhook(
  d: Digest,
  dashboardUrl: string,
  now = new Date(),
): Record<string, unknown> {
  const c = d.current;
  const p = d.previous;
  const flat = (x: DigestCounts) => ({
    attackers: x.attackers,
    incidents: x.incidents,
    techniques: x.techniques,
    blocks: x.blocks,
    response_actions: x.actions,
    noise: x.noise,
    honeytoken_uses: x.honeytokenUses,
    events: x.events,
  });
  return {
    type: 'digest.weekly',
    sent_at: now.toISOString(),
    project_id: d.project.id,
    project_name: d.project.name,
    week: d.week,
    period_start: d.period.start,
    period_end: d.period.end,
    current: flat(c),
    previous: flat(p),
    milestones: d.milestones,
    url: dashboardUrl,
  };
}

/* ───────── unsubscribe tokens ───────── */

const UNSUB_PURPOSE = 'digest_unsubscribe';
/** Long enough that an old digest's link still works; the opt-out is idempotent anyway. */
export const UNSUBSCRIBE_TTL_SECONDS = 180 * 24 * 3600;
/** A key separate from session cookies, so neither token can stand in for the other. */
const unsubKey = () => `${env.SESSION_SECRET}:${UNSUB_PURPOSE}`;

export function unsubscribeToken(userId: string, now = new Date()): string {
  return signToken(
    {
      p: UNSUB_PURPOSE,
      uid: userId,
      exp: Math.floor(now.getTime() / 1000) + UNSUBSCRIBE_TTL_SECONDS,
    },
    unsubKey(),
  );
}

/** The user id the token was minted for, or null when it is forged, expired or another kind. */
export function verifyUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const p = verifyToken<{ p?: string; uid?: string; exp?: number }>(token, unsubKey());
  if (!p || p.p !== UNSUB_PURPOSE || typeof p.uid !== 'string') return null;
  return p.uid;
}
