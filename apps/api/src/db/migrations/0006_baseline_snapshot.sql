-- Baseline: 0001-0005 were hand-written, so drizzle's snapshot stopped at 0000.
-- meta/0006_snapshot.json now matches schema.ts. The only drift was the name of the
-- ingest_usage FK (inline REFERENCES in 0003 gets Postgres's default name).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_usage_project_id_fkey') THEN
    ALTER TABLE "ingest_usage" RENAME CONSTRAINT "ingest_usage_project_id_fkey" TO "ingest_usage_project_id_projects_id_fk";
  END IF;
END $$;
