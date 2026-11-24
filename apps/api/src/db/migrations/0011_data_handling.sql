CREATE TABLE "project_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage" text DEFAULT 'local' NOT NULL,
	"object_key" text,
	"size_bytes" bigint,
	"row_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_exports" ADD CONSTRAINT "project_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_exports" ADD CONSTRAINT "project_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_exports_project_idx" ON "project_exports" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_unhashed_creds_idx" ON "events" USING btree ("received_at") WHERE "events"."fields" ?| array['password_clear','password_masked','password_sha256'] or "events"."raw" ? 'password';--> statement-breakpoint
CREATE INDEX "projects_purge_idx" ON "projects" USING btree ("purge_after") WHERE "projects"."deleted_at" is not null;