CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid,
	"attacker_id" uuid,
	"kind" text DEFAULT 'incident' NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"http_status" integer,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "secret_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "last_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_step_uq" ON "notification_deliveries" USING btree ("channel_id","incident_id","severity");--> statement-breakpoint
CREATE INDEX "notification_deliveries_attacker_idx" ON "notification_deliveries" USING btree ("channel_id","attacker_id","created_at" DESC NULLS LAST);