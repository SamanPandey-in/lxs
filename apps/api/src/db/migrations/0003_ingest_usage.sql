CREATE TABLE "ingest_usage" (
  "scope_key" text PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "window_start" timestamptz NOT NULL,
  "requests" integer NOT NULL DEFAULT 0,
  "events" integer NOT NULL DEFAULT 0,
  "bytes" integer NOT NULL DEFAULT 0
);

CREATE INDEX "ingest_usage_project_window_idx" ON "ingest_usage" ("project_id", "window_start");
