-- Auto-run by the postgres image on first boot (anything in
-- /docker-entrypoint-initdb.d/ runs once when the data dir is
-- empty). Idempotent — re-runs no-op because of IF NOT EXISTS.
--
-- The `vector` extension is provided by the pgvector/pgvector:pg16
-- image; this just enables it in the drive360 database. Migrations
-- in the API binary handle table schemas.
CREATE EXTENSION IF NOT EXISTS vector;
