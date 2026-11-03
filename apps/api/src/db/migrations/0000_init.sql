CREATE TABLE "ai_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"provider" text DEFAULT 'template' NOT NULL,
	"model" text DEFAULT 'none' NOT NULL,
	"prompt_version" text DEFAULT 'fallback-1' NOT NULL,
	"output" jsonb NOT NULL,
	"is_fallback" boolean DEFAULT true NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"scopes" text[] DEFAULT ARRAY['ingest']::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attackers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"entity_key" text NOT NULL,
	"ip" "inet" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"decoys_touched" text[] DEFAULT '{}'::text[] NOT NULL,
	"label" text DEFAULT 'noise' NOT NULL,
	"cadence" text DEFAULT 'unknown' NOT NULL,
	"fingerprints" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocklist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"ip" "inet" NOT NULL,
	"reason" text,
	"incident_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by" text
);
--> statement-breakpoint
CREATE TABLE "containment_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sensor_id" uuid,
	"passed" boolean NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decoys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sensor_id" uuid NOT NULL,
	"decoy_key" text NOT NULL,
	"type" text NOT NULL,
	"mount" text DEFAULT '' NOT NULL,
	"persona" text,
	"declared_posture" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"points" smallint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"techniques" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage" text,
	"floor" text,
	"evidence_event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sensor_id" uuid,
	"decoy_id" uuid,
	"event_uid" text NOT NULL,
	"event_type" text NOT NULL,
	"is_decoy" boolean DEFAULT true NOT NULL,
	"src_ip" "inet" NOT NULL,
	"src_port" integer,
	"session_id" text,
	"dst_service" text DEFAULT '' NOT NULL,
	"outcome" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb,
	"count" integer DEFAULT 1 NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"attacker_id" uuid,
	"incident_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"techniques" text[] DEFAULT '{}'::text[] NOT NULL,
	"stage" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "honeytokens" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"sensor_id" uuid,
	"kind" text NOT NULL,
	"value_sha256" "bytea" NOT NULL,
	"planted_in" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"attacker_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"label" text DEFAULT 'noise' NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"score" smallint DEFAULT 0 NOT NULL,
	"floor" text,
	"stages" text[] DEFAULT '{}'::text[] NOT NULL,
	"techniques" text[] DEFAULT '{}'::text[] NOT NULL,
	"real_asset_reached" boolean DEFAULT false NOT NULL,
	"honeytoken_used" boolean DEFAULT false NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"first_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"assignee_id" text,
	"ai_status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"url_encrypted" "bytea" NOT NULL,
	"min_severity" text DEFAULT 'high' NOT NULL,
	"labels" text[] DEFAULT ARRAY['targeted']::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"incident_seq" integer DEFAULT 0 NOT NULL,
	"password_salt" "bytea" NOT NULL,
	"allowlist" "cidr"[] DEFAULT '{}'::cidr[] NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"ai_daily_cap" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "response_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid,
	"type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "sensors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"api_key_id" uuid,
	"hostname" text NOT NULL,
	"agent_version" text,
	"sdk_version" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_policy_version" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attackers" ADD CONSTRAINT "attackers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containment_reports" ADD CONSTRAINT "containment_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containment_reports" ADD CONSTRAINT "containment_reports_sensor_id_sensors_id_fk" FOREIGN KEY ("sensor_id") REFERENCES "public"."sensors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decoys" ADD CONSTRAINT "decoys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decoys" ADD CONSTRAINT "decoys_sensor_id_sensors_id_fk" FOREIGN KEY ("sensor_id") REFERENCES "public"."sensors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_sensor_id_sensors_id_fk" FOREIGN KEY ("sensor_id") REFERENCES "public"."sensors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_decoy_id_decoys_id_fk" FOREIGN KEY ("decoy_id") REFERENCES "public"."decoys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_attacker_id_attackers_id_fk" FOREIGN KEY ("attacker_id") REFERENCES "public"."attackers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honeytokens" ADD CONSTRAINT "honeytokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honeytokens" ADD CONSTRAINT "honeytokens_sensor_id_sensors_id_fk" FOREIGN KEY ("sensor_id") REFERENCES "public"."sensors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notes" ADD CONSTRAINT "incident_notes_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_attacker_id_attackers_id_fk" FOREIGN KEY ("attacker_id") REFERENCES "public"."attackers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_summaries_fp_uq" ON "ai_summaries" USING btree ("fingerprint","prompt_version");--> statement-breakpoint
CREATE INDEX "ai_summaries_incident_idx" ON "ai_summaries" USING btree ("incident_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attackers_project_entity_uq" ON "attackers" USING btree ("project_id","entity_key");--> statement-breakpoint
CREATE INDEX "attackers_project_last_seen_idx" ON "attackers" USING btree ("project_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_project_idx" ON "audit_logs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_project_ip_active_uq" ON "blocklist_entries" USING btree ("project_id","ip") WHERE "blocklist_entries"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "containment_reports_project_idx" ON "containment_reports" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "decoys_sensor_key_uq" ON "decoys" USING btree ("sensor_id","decoy_key");--> statement-breakpoint
CREATE INDEX "decoys_project_idx" ON "decoys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "detections_incident_rule_uq" ON "detections" USING btree ("incident_id","rule_id","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_uid_uq" ON "events" USING btree ("project_id","event_uid");--> statement-breakpoint
CREATE INDEX "events_project_received_idx" ON "events" USING btree ("project_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_project_src_idx" ON "events" USING btree ("project_id","src_ip","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_incident_idx" ON "events" USING btree ("incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_unprocessed_idx" ON "events" USING btree ("id") WHERE "events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "honeytokens_project_sha_uq" ON "honeytokens" USING btree ("project_id","value_sha256");--> statement-breakpoint
CREATE INDEX "incident_notes_incident_idx" ON "incident_notes" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_project_number_uq" ON "incidents" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_active_per_attacker_uq" ON "incidents" USING btree ("project_id","attacker_id") WHERE "incidents"."status" in ('open','acknowledged');--> statement-breakpoint
CREATE INDEX "incidents_queue_idx" ON "incidents" USING btree ("project_id","status","label","severity","last_event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_channels_project_idx" ON "notification_channels" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_uq" ON "projects" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "response_actions_project_idx" ON "response_actions" USING btree ("project_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sensors_project_last_seen_idx" ON "sensors" USING btree ("project_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");