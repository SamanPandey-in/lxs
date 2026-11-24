import { sql } from 'drizzle-orm';
import {
  bigint,
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
    // Null until the address is confirmed. Unverified users can sign in and look
    // around, but cannot create ingest keys or invite members.
    emailVerifiedAt: ts('email_verified_at'),
    /** Weekly digest email opt-out (Settings toggle or the signed unsubscribe link). */
    digestOptOut: boolean('digest_opt_out').notNull().default(false),
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
    // Admin kill switch (src/db/org-kill-switch.ts): blocks login and ingest for the org.
    disabledAt: ts('disabled_at'),
    disabledReason: text('disabled_reason'),
    // Data handling: retention and caps come from this plan (lib/plans.ts). No billing.
    plan: text('plan').notNull().default('free'), // free | team | custom
    // Set when the last member deleted their account; purged with its projects after the grace.
    deletedAt: ts('deleted_at'),
    // Per-org LLM calls per UTC day. Null: LLM_ORG_DAILY_CAP (lib/llm-budget.ts).
    llmDailyCap: integer('llm_daily_cap'),
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

/**
 * Emailed single-use tokens for verification and password reset. The token is
 * `<id>.<secret>`; only sha256(secret) is stored (see lib/tokens.ts).
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // verify_email | reset_password
    tokenHash: bytea('token_hash').notNull(),
    email: text('email').notNull(), // the address the link was sent to
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose, t.createdAt)],
);

/** Pending and historical invitations to join an organization. */
export const orgInvites = pgTable(
  'org_invites',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(), // owner | analyst | viewer
    tokenHash: bytea('token_hash').notNull(),
    invitedBy: text('invited_by'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedBy: text('accepted_by'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('org_invites_org_idx').on(t.orgId),
    uniqueIndex('org_invites_pending_uq')
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
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
    /** Last time an owner confirmed the allowlist is still right (coverage check). */
    allowlistReviewedAt: ts('allowlist_reviewed_at'),
    createdAt: createdAt(),
    archivedAt: ts('archived_at'),
    // Soft delete (modules/data.ts): hidden everywhere and ingest refused at once; the
    // maintenance job purges the row and everything under it after `purge_after`.
    deletedAt: ts('deleted_at'),
    deletedBy: text('deleted_by'),
    purgeAfter: ts('purge_after'),
  },
  (t) => [
    uniqueIndex('projects_org_slug_uq').on(t.orgId, t.slug),
    index('projects_purge_idx').on(t.purgeAfter).where(sql`${t.deletedAt} is not null`),
  ],
);

/** Async project exports (worker/export-project.ts). The bundle itself lives in EXPORT_STORAGE. */
export const projectExports = pgTable(
  'project_exports',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by'),
    status: text('status').notNull().default('pending'), // pending | running | ready | failed | expired
    storage: text('storage').notNull().default('local'), // local | s3
    objectKey: text('object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    rowCounts: jsonb('row_counts').notNull().default(sql`'{}'::jsonb`),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('project_exports_project_idx').on(t.projectId, t.createdAt.desc())],
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
    /** Canned onboarding sample data (a subset of `simulated`); removable with DELETE …/demo/sample-data. */
    sample: boolean('sample').notNull().default(false),
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
    index('events_project_sample_idx').on(t.projectId).where(sql`${t.sample}`),
    // Events still holding an attacker-typed password (clear, masked or salted) that the
    // credential-hashing job has not rewritten yet. Same predicate as worker/maintenance.ts.
    index('events_unhashed_creds_idx')
      .on(t.receivedAt)
      .where(
        sql`${t.fields} ?| array['password_clear','password_masked','password_sha256'] or ${t.raw} ? 'password'`,
      ),
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
    /** manual | auto | slack. `auto` rows carry the policy that fired in `rule`. */
    source: text('source').notNull().default('manual'),
    rule: jsonb('rule'),
  },
  (t) => [
    index('blocklist_project_incident_idx').on(t.projectId, t.incidentId),
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
    /** HMAC signing secret for generic webhooks (encrypted like the URL). Null for Slack. */
    secretEncrypted: bytea('secret_encrypted'),
    lastStatus: text('last_status'), // null (never sent) | ok | failed
    lastError: text('last_error'),
    lastDeliveredAt: ts('last_delivered_at'),
    /** Opt-in: also post the weekly digest to this channel. */
    digest: boolean('digest').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('notification_channels_project_idx').on(t.projectId)],
);

/** One row per message attempt (incident alert or test). Drives dedupe, cooldown and debugging. */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: pk(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
    attackerId: uuid('attacker_id'),
    kind: text('kind').notNull().default('incident'), // incident | test
    severity: text('severity').notNull(),
    status: text('status').notNull().default('sending'), // sending | ok | failed
    httpStatus: integer('http_status'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_deliveries_step_uq').on(t.channelId, t.incidentId, t.severity),
    index('notification_deliveries_attacker_idx').on(t.channelId, t.attackerId, t.createdAt.desc()),
  ],
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

/** One row per project per ISO week: the dedupe claim and the record of what a digest said. */
export const digestRuns = pgTable(
  'digest_runs',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    week: text('week').notNull(), // ISO week of the reported period, e.g. 2026-W47
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    summary: jsonb('summary').notNull().default(sql`'{}'::jsonb`),
    emailsSent: integer('emails_sent').notNull().default(0),
    emailsFailed: integer('emails_failed').notNull().default(0),
    channelsSent: integer('channels_sent').notNull().default(0),
    channelsFailed: integer('channels_failed').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('digest_runs_project_week_uq').on(t.projectId, t.week)],
);

/** Milestones a project has reached. Recorded once; `reached_at` comes from the data itself. */
export const projectMilestones = pgTable(
  'project_milestones',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    reachedAt: ts('reached_at').notNull(),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    recordedAt: ts('recorded_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.key] })],
);

/**
 * Auto-block policy (one per project). Off by default. The decision is the pure
 * `decideAutoBlock` in lib/auto-block.ts; the LLM is never consulted.
 */
export const responsePolicies = pgTable('response_policies', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  mode: text('mode').notNull().default('monitor'), // monitor | enforce
  minSeverity: text('min_severity').notNull().default('critical'),
  labels: text('labels').array().notNull().default(sql`ARRAY['targeted']::text[]`),
  durationHours: integer('duration_hours').notNull().default(24),
  requireRealAssetTouch: boolean('require_real_asset_touch').notNull().default(false),
  allowPrivate: boolean('allow_private').notNull().default(false),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Slack app used for interactive alert buttons. Secrets are encrypted (lib/channel-crypto.ts). */
export const slackIntegrations = pgTable('slack_integrations', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  signingSecretEncrypted: bytea('signing_secret_encrypted').notNull(),
  botTokenEncrypted: bytea('bot_token_encrypted'),
  teamId: text('team_id'),
  createdBy: text('created_by'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Slack user -> LXS member, for projects without a bot token (no users.info lookup). */
export const slackUserLinks = pgTable(
  'slack_user_links',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slackUserId: text('slack_user_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.slackUserId] })],
);

/** LLM spend ledger, one row per project per UTC day. Drives the global/org/project caps. */
export const llmUsage = pgTable(
  'llm_usage',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // YYYY-MM-DD (UTC)
    calls: integer('calls').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Estimated USD x 1e6 (list prices; plugins/metrics.ts estimateLlmCostUsd). */
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    cappedCalls: integer('capped_calls').notNull().default(0),
    lastCapReason: text('last_cap_reason'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.day] }),
    index('llm_usage_org_day_idx').on(t.orgId, t.day),
    index('llm_usage_day_idx').on(t.day),
  ],
);
