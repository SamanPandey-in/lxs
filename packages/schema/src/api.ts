import { z } from 'zod';
import { EventType } from './event.js';

export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const IncidentLabel = z.enum(['noise', 'opportunistic', 'targeted']);
export type IncidentLabel = z.infer<typeof IncidentLabel>;

export const IncidentStatus = z.enum(['open', 'acknowledged', 'resolved', 'false_positive']);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

/** Six stages. Persistence / Cred Access / Defense Evasion / C2 show as ATT&CK chips, not stages. */
export const KillChainStage = z.enum([
  'recon',
  'initial_access',
  'execution',
  'discovery',
  'collection',
  'exfiltration',
]);
export type KillChainStage = z.infer<typeof KillChainStage>;

export const Technique = z.object({
  id: z.string(), // "T1078.001"
  name: z.string(),
  tactic: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Technique = z.infer<typeof Technique>;

export const Detection = z.object({
  rule_id: z.string(),
  points: z.number().int(),
  reason: z.string(),
  techniques: z.array(Technique),
  stage: KillChainStage.nullable(),
  floor: Severity.nullable(),
  evidence_event_ids: z.array(z.string()),
});
export type Detection = z.infer<typeof Detection>;

export const IncidentSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: IncidentStatus,
  label: IncidentLabel,
  severity: Severity,
  score: z.number().int(),
  src_ip: z.string(),
  stages: z.array(KillChainStage),
  techniques: z.array(z.string()),
  real_asset_reached: z.boolean(),
  honeytoken_used: z.boolean(),
  event_count: z.number().int(),
  first_event_at: z.string().datetime(),
  last_event_at: z.string().datetime(),
  ai_status: z.enum(['pending', 'ready', 'fallback', 'failed']).default('pending'),
  ai_headline: z.string().nullable().optional(),
});
export type IncidentSummary = z.infer<typeof IncidentSummary>;

export const AiSummary = z.object({
  headline: z.string(),
  what_happened: z.string(),
  why_it_matters: z.string(),
  recommended_actions: z.array(z.string()),
  is_fallback: z.boolean(),
});
export type AiSummary = z.infer<typeof AiSummary>;

export const IncidentDetail = IncidentSummary.extend({
  detections: z.array(Detection),
  ai_summary: AiSummary.nullable(),
  attacker_id: z.string(),
});
export type IncidentDetail = z.infer<typeof IncidentDetail>;

export const AttackerProfile = z.object({
  id: z.string(),
  entity_key: z.string(),
  ip: z.string(),
  label: IncidentLabel,
  cadence: z.enum(['bot', 'human', 'unknown']),
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  event_count: z.number().int(),
  session_count: z.number().int(),
  decoys_touched: z.array(z.string()),
  fingerprints: z.record(z.string(), z.unknown()).optional(),
});
export type AttackerProfile = z.infer<typeof AttackerProfile>;

export const StoredEvent = z.object({
  id: z.string(),
  event_uid: z.string(),
  event_type: EventType,
  is_decoy: z.boolean(),
  src_ip: z.string(),
  src_port: z.number().int().nullable().optional(),
  dst_service: z.string(),
  decoy_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  occurred_at: z.string().datetime(),
  received_at: z.string().datetime(),
  fields: z.record(z.string(), z.unknown()),
  count: z.number().int(),
  simulated: z.boolean(),
  incident_id: z.string().nullable().optional(),
  stage: KillChainStage.nullable().optional(),
  techniques: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

export const Overview = z.object({
  incidents_open: z.number().int(),
  incidents_critical: z.number().int(),
  events_24h: z.number().int(),
  noise_suppressed_24h: z.number().int(),
  attackers_24h: z.number().int(),
  decoys_healthy: z.number().int(),
  decoys_total: z.number().int(),
  mtta_seconds: z.number().nullable(),
  top_incidents: z.array(IncidentSummary),
  llm: z.object({ provider: z.string().nullable(), model: z.string().nullable() }).optional(),
});
export type Overview = z.infer<typeof Overview>;

export const ResponseActionType = z.enum(['block_ip', 'unblock_ip', 'export_iocs']);
export type ResponseActionType = z.infer<typeof ResponseActionType>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** SSE frame names on GET /v1/stream?project=:pid */
export const StreamEventName = z.enum([
  'event.new',
  'incident.new',
  'incident.updated',
  'incident.ai',
  'sensor.status',
  'action.applied',
  'heartbeat',
]);
export type StreamEventName = z.infer<typeof StreamEventName>;
