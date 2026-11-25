CREATE TABLE "honeytoken_mints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mint_id" text NOT NULL,
	"base_token_id" text NOT NULL,
	"decoy_key" text,
	"session_id" text,
	"minted_for_ip" "inet" NOT NULL,
	"planted_via" text NOT NULL,
	"minted_at" timestamp with time zone NOT NULL,
	"first_used_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"used_from_ip" "inet",
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "honeytoken_mints" ADD CONSTRAINT "honeytoken_mints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "honeytoken_mints_project_mint_uq" ON "honeytoken_mints" USING btree ("project_id","mint_id");