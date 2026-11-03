import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const inet = customType<{ data: string }>({ dataType: () => 'inet' });
const cidr = customType<{ data: string }>({ dataType: () => 'cidr' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** Prototype email/password users and JWT-backed sessions. */
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    sessionVersion: integer('session_version').notNull().default(0),
    name: text('name').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_username_uq').on(t.username),
  ],
);

export const organizations = pgTable(
  'organizations',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('organizations_slug_uq').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('owner'), // owner | analyst | viewer
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    environment: text('environment').notNull().default('production'),
    policyVersion: integer('policy_version').notNull().default(1),
    incidentSeq: integer('incident_seq').notNull().default(0),
    passwordSalt: bytea('password_salt').notNull(),
    allowlist: cidr('allowlist').array().notNull().default(sql`'{}'::cidr[]`),
    retentionDays: integer('retention_days').notNull().default(30),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    aiDailyCap: integer('ai_daily_cap').notNull().default(200),
    createdAt: createdAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [uniqueIndex('projects_org_slug_uq').on(t.orgId, t.slug)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: bytea('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['ingest']::text[]`),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_uq').on(t.keyHash),
    index('api_keys_project_idx').on(t.projectId),
  ],
);

/** Shared fixed-window ingest budgets. Rows are updated transactionally across API replicas. */
export const ingestUsage = pgTable('ingest_usage', {
  scopeKey: text('scope_key').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  windowStart: ts('window_start').notNull(),
  requests: integer('requests').notNull().default(0),
  events: integer('events').notNull().default(0),
  bytes: integer('bytes').notNull().default(0),
});

export const sensors = pgTable(
  'sensors',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    hostname: text('hostname').notNull(),
    agentVersion: text('agent_version'),
    sdkVersion: text('sdk_version'),
    manifest: jsonb('manifest').notNull().default(sql`'{}'::jsonb`),
    appliedPolicyVersion: integer('applied_policy_version').notNull().default(0),
    stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('online'), // online | stale | offline
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('sensors_project_last_seen_idx').on(t.projectId, t.lastSeenAt.desc())],
);

export const decoys = pgTable(
  'decoys',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id')
      .notNull()
      .references(() => sensors.id, { onDelete: 'cascade' }),
    decoyKey: text('decoy_key').notNull(),
    type: text('type').notNull(),
    mount: text('mount').notNull().default(''),
    persona: text('persona'),
    declaredPosture: jsonb('declared_posture').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('online'),
    lastEventAt: ts('last_event_at'),
    lastHeartbeatAt: ts('last_heartbeat_at'),
  },
  (t) => [
    uniqueIndex('decoys_sensor_key_uq').on(t.sensorId, t.decoyKey),
    index('decoys_project_idx').on(t.projectId),
  ],
);

export const attackers = pgTable(
  'attackers',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    entityKey: text('entity_key').notNull(),
    ip: inet('ip').notNull(),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    eventCount: integer('event_count').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    decoysTouched: text('decoys_touched').array().notNull().default(sql`'{}'::text[]`),
    label: text('label').notNull().default('noise'),
    cadence: text('cadence').notNull().default('unknown'),
    fingerprints: jsonb('fingerprints').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex('attackers_project_entity_uq').on(t.projectId, t.entityKey),
    index('attackers_project_last_seen_idx').on(t.projectId, t.lastSeenAt.desc()),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    attackerId: uuid('attacker_id')
      .notNull()
      .references(() => attackers.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open'),
    label: text('label').notNull().default('noise'),
    severity: text('severity').notNull().default('low'),
    score: smallint('score').notNull().default(0),
    floor: text('floor'),
    stages: text('stages').array().notNull().default(sql`'{}'::text[]`),
    techniques: text('techniques').array().notNull().default(sql`'{}'::text[]`),
    realAssetReached: boolean('real_asset_reached').notNull().default(false),
    honeytokenUsed: boolean('honeytoken_used').notNull().default(false),
    title: text('title').notNull().default(''),
    eventCount: integer('event_count').notNull().default(0),
    firstEventAt: ts('first_event_at').notNull().defaultNow(),
    lastEventAt: ts('last_event_at').notNull().defaultNow(),
    openedAt: ts('opened_at').notNull().defaultNow(),
    acknowledgedAt: ts('acknowledged_at'),
    resolvedAt: ts('resolved_at'),
    resolvedBy: text('resolved_by'),
    assigneeId: text('assignee_id'),
    aiStatus: text('ai_status').notNull().default('pending'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('incidents_project_number_uq').on(t.projectId, t.number),
    index('incidents_project_attacker_status_idx').on(t.projectId, t.attackerId, t.status),
    index('incidents_queue_idx').on(
      t.projectId,
      t.status,
      t.label,
      t.severity,
      t.lastEventAt.desc(),
    ),
  ],
);

export const events = pgTable(
  'events',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'set null' }),
    decoyId: uuid('decoy_id').references(() => decoys.id, { onDelete: 'set null' }),
    eventUid: text('event_uid').notNull(),
    eventType: text('event_type').notNull(),
    isDecoy: boolean('is_decoy').notNull().default(true),
    srcIp: inet('src_ip').notNull(),
    srcPort: integer('src_port'),
    sessionId: text('session_id'),
    dstService: text('dst_service').notNull().default(''),
    outcome: text('outcome'),
    occurredAt: ts('occurred_at').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    fields: jsonb('fields').notNull().default(sql`'{}'::jsonb`),
    raw: jsonb('raw'),
    count: integer('count').notNull().default(1),
    simulated: boolean('simulated').notNull().default(false),
    attackerId: uuid('attacker_id').references(() => attackers.id, { onDelete: 'set null' }),
    incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    techniques: text('techniques').array().notNull().default(sql`'{}'::text[]`),
    stage: text('stage'),
    processedAt: ts('processed_at'),
  },
  (t) => [
    uniqueIndex('events_project_uid_uq').on(t.projectId, t.eventUid),
    index('events_project_received_idx').on(t.projectId, t.receivedAt.desc()),
    index('events_project_src_idx').on(t.projectId, t.srcIp, t.occurredAt.desc()),
    index('events_incident_idx').on(t.incidentId, t.occurredAt),
    index('events_unprocessed_idx').on(t.id).where(sql`${t.processedAt} is null`),
  ],
);

export const detections = pgTable(
  'detections',
  {
    id: pk(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    points: smallint('points').notNull().default(0),
    reason: text('reason').notNull(),
    techniques: jsonb('techniques').notNull().default(sql`'[]'::jsonb`),
    stage: text('stage'),
    floor: text('floor'),
    evidenceEventIds: uuid('evidence_event_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  // Spec says (incident_id, rule_id); the detection engine can emit several R05/R08/R14/R15 with distinct reasons.
  (t) => [uniqueIndex('detections_incident_rule_uq').on(t.incidentId, t.ruleId, t.reason)],
);

export const aiSummaries = pgTable(
  'ai_summaries',
  {
    id: pk(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    provider: text('provider').notNull().default('template'),
    model: text('model').notNull().default('none'),
    promptVersion: text('prompt_version').notNull().default('fallback-1'),
    output: jsonb('output').notNull(),
    isFallback: boolean('is_fallback').notNull().default(true),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ai_summaries_fp_uq').on(t.fingerprint, t.promptVersion),
    index('ai_summaries_incident_idx').on(t.incidentId, t.createdAt.desc()),
  ],
);

export const responseActions = pgTable(
  'response_actions',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'), // pending | applied | completed | failed
    requestedBy: text('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    appliedAt: ts('applied_at'),
    result: jsonb('result'),
  },
  (t) => [index('response_actions_project_idx').on(t.projectId, t.requestedAt.desc())],
);

export const blocklistEntries = pgTable(
  'blocklist_entries',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ip: inet('ip').notNull(),
    reason: text('reason'),
    incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at'),
    removedAt: ts('removed_at'),
    removedBy: text('removed_by'),
  },
  (t) => [
    uniqueIndex('blocklist_project_ip_active_uq')
      .on(t.projectId, t.ip)
      .where(sql`${t.removedAt} is null`),
  ],
);

export const honeytokens = pgTable(
  'honeytokens',
  {
    id: text('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    valueSha256: bytea('value_sha256').notNull(),
    plantedIn: text('planted_in').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    firstUsedAt: ts('first_used_at'),
  },
  (t) => [uniqueIndex('honeytokens_project_sha_uq').on(t.projectId, t.valueSha256)],
);

export const incidentNotes = pgTable(
  'incident_notes',
  {
    id: pk(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    authorId: text('author_id'),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('incident_notes_incident_idx').on(t.incidentId, t.createdAt)],
);

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // slack | webhook
    name: text('name').notNull(),
    urlEncrypted: bytea('url_encrypted').notNull(),
    minSeverity: text('min_severity').notNull().default('high'),
    labels: text('labels').array().notNull().default(sql`ARRAY['targeted']::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    lastStatus: text('last_status'),
    createdAt: createdAt(),
  },
  (t) => [index('notification_channels_project_idx').on(t.projectId)],
);

export const containmentReports = pgTable(
  'containment_reports',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sensorId: uuid('sensor_id').references(() => sensors.id, { onDelete: 'set null' }),
    passed: boolean('passed').notNull(),
    checks: jsonb('checks').notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('containment_reports_project_idx').on(t.projectId, t.createdAt.desc())],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(), // user | api_key | system
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_project_idx').on(t.projectId, t.createdAt.desc())],
);
