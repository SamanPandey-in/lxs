CREATE TABLE "llm_usage" (
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"capped_calls" integer DEFAULT 0 NOT NULL,
	"last_cap_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
CREATE TABLE "response_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'monitor' NOT NULL,
	"min_severity" text DEFAULT 'critical' NOT NULL,
	"labels" text[] DEFAULT ARRAY['targeted']::text[] NOT NULL,
	"duration_hours" integer DEFAULT 24 NOT NULL,
	"require_real_asset_touch" boolean DEFAULT false NOT NULL,
	"allow_private" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_integrations" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"signing_secret_encrypted" "bytea" NOT NULL,
	"bot_token_encrypted" "bytea",
	"team_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_links" (
	"project_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_links_project_id_slack_user_id_pk" PRIMARY KEY("project_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD COLUMN "rule" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_daily_cap" integer;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_policies" ADD CONSTRAINT "response_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_org_day_idx" ON "llm_usage" USING btree ("org_id","day");--> statement-breakpoint
CREATE INDEX "llm_usage_day_idx" ON "llm_usage" USING btree ("day");--> statement-breakpoint
CREATE INDEX "blocklist_project_incident_idx" ON "blocklist_entries" USING btree ("project_id","incident_id");