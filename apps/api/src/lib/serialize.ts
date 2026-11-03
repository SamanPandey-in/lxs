import type { IncidentSummary } from '@lxs/schema';
import { sql } from 'drizzle-orm';
import { aiSummaries, attackers, incidents } from '../db/schema.js';

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

/** Columns needed for an IncidentSummary (join incidents x attackers). */
const summaryCols = {
  id: incidents.id,
  projectId: incidents.projectId,
  number: incidents.number,
  title: incidents.title,
  status: incidents.status,
  label: incidents.label,
  severity: incidents.severity,
  score: incidents.score,
  srcIp: attackers.ip,
  attackerId: incidents.attackerId,
  stages: incidents.stages,
  techniques: incidents.techniques,
  realAssetReached: incidents.realAssetReached,
  honeytokenUsed: incidents.honeytokenUsed,
  eventCount: incidents.eventCount,
  firstEventAt: incidents.firstEventAt,
  lastEventAt: incidents.lastEventAt,
  aiStatus: incidents.aiStatus,
  floor: incidents.floor,
  openedAt: incidents.openedAt,
  acknowledgedAt: incidents.acknowledgedAt,
  resolvedAt: incidents.resolvedAt,
  assigneeId: incidents.assigneeId,
};

export const incidentSummaryCols = {
  ...summaryCols,
  aiHeadline: sql<
    string | null
  >`(select s.output->>'headline' from ${aiSummaries} s where s.incident_id = ${incidents.id} order by s.created_at desc limit 1)`.as(
    'ai_headline',
  ),
};

export type IncidentRow = {
  [K in keyof typeof summaryCols]: (typeof summaryCols)[K]['_']['data'];
} & { aiHeadline: string | null };

export function toIncidentSummary(r: IncidentRow): IncidentSummary {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status as IncidentSummary['status'],
    label: r.label as IncidentSummary['label'],
    severity: r.severity as IncidentSummary['severity'],
    score: r.score,
    src_ip: r.srcIp,
    stages: r.stages as IncidentSummary['stages'],
    techniques: r.techniques,
    real_asset_reached: r.realAssetReached,
    honeytoken_used: r.honeytokenUsed,
    event_count: r.eventCount,
    first_event_at: iso(r.firstEventAt)!,
    last_event_at: iso(r.lastEventAt)!,
    ai_status: r.aiStatus as IncidentSummary['ai_status'],
    ai_headline: r.aiHeadline,
  };
}

/** Compact incident for SSE frames (kept far below the 8 KB NOTIFY limit). */
export function compactIncident(r: IncidentRow) {
  return {
    ...toIncidentSummary(r),
    attacker_id: r.attackerId,
    floor: r.floor,
  };
}
