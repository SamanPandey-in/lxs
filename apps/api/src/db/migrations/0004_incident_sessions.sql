DROP INDEX IF EXISTS "incidents_one_active_per_attacker_uq";
CREATE INDEX IF NOT EXISTS "incidents_project_attacker_status_idx"
  ON "incidents" USING btree ("project_id", "attacker_id", "status");
CREATE INDEX IF NOT EXISTS "events_project_src_session_idx"
  ON "events" USING btree ("project_id", "src_ip", "session_id", "occurred_at" DESC NULLS LAST);
