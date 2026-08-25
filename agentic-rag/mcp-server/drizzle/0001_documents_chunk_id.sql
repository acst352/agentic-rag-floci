-- v1.5.0 ingestion pipeline — chunk_id column for idempotent upsert.
--
-- The ingestion pipeline produces one row per chunk (not per
-- document). To support idempotent re-ingestion (running the
-- pipeline on the same file twice must NOT produce duplicates),
-- we need a stable per-chunk identifier.
--
-- Strategy:
--   1. Add a nullable chunk_id column.
--   2. Backfill existing rows with `${source}:0` (legacy seed.ts
--      treats each source as a single chunk).
--   3. Make chunk_id NOT NULL.
--   4. Add UNIQUE(source, chunk_id) — the upsert key used by
--      writer.ts.

ALTER TABLE "documents" ADD COLUMN "chunk_id" text;

-- Backfill: existing rows (from seed.ts) get chunk_id = `${source}:0`.
-- This is consistent with how chunker.ts indexes chunks (zero-based).
UPDATE "documents" SET "chunk_id" = "source" || ':0' WHERE "chunk_id" IS NULL;

ALTER TABLE "documents" ALTER COLUMN "chunk_id" SET NOT NULL;

CREATE UNIQUE INDEX "documents_source_chunk_id_idx"
  ON "documents" ("source", "chunk_id");