/**
 * v1.5.0 ingestion pipeline — pgvector writer (commit 7).
 *
 * upsertChunks escribe una lista de ChunkRecord a pgvector de
 * forma idempotente: re-procesar el mismo archivo NO duplica filas.
 *
 * Mecánica:
 *   - La UNIQUE INDEX documents_source_chunk_id_idx hace de
 *     clave del upsert.
 *   - INSERT ... ON CONFLICT (source, chunk_id) DO UPDATE SET
 *     content = EXCLUDED.content, embedding = EXCLUDED.embedding.
 *   - Cada chunk se upserta individualmente. Si N=100 chunks se
 *     hacen 100 statements en una transacción — más simple que
 *     VALUES (...) bulk insert y permite al caller saber qué chunk
 *     falló.
 *
 * Decisión documentada: NO hacemos batching de SQL para mantener
 * la trazabilidad por chunk. El costo es ~1ms por round-trip a
 * Postgres local; aceptable para v1.5.0 (pocos cientos de chunks
 * por documento). v1.5.x puede mover a COPY si el rendimiento
 * importa.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import type { ChunkRecord, ProcessingError } from "./types.js";

export interface UpsertResult {
  /** Cantidad de filas realmente afectadas (insert + update). */
  written: number;
}

export interface WriterDeps {
  /**
   * Executor inyectable para tests. Default: el `db` exportado por
   * db/client.ts. La firma acepta un template SQL de drizzle.
   */
  executor?: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

export class WriterError extends Error {
  readonly code: ProcessingError["code"];
  readonly chunk_id?: string;
  readonly cause?: unknown;

  constructor(
    code: ProcessingError["code"],
    message: string,
    chunk_id?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WriterError";
    this.code = code;
    this.chunk_id = chunk_id;
    this.cause = cause;
  }
}

/**
 * Upserta una lista de chunks. Devuelve el conteo de filas
 * afectadas. Si un chunk no tiene embedding, se rechaza con
 * WriterError antes de tocar la DB.
 */
export async function upsertChunks(
  chunks: ChunkRecord[],
  deps: WriterDeps = {},
): Promise<UpsertResult> {
  const executor =
    deps.executor ?? ((q) => defaultDb.execute(q as Parameters<typeof defaultDb.execute>[0]));

  if (chunks.length === 0) return { written: 0 };

  for (const c of chunks) {
    if (!Array.isArray(c.embedding) || c.embedding.length === 0) {
      throw new WriterError(
        "write_failed",
        `chunk ${c.chunk_id} has no embedding`,
        c.chunk_id,
      );
    }
  }

  let written = 0;
  for (const c of chunks) {
    try {
      const vectorLiteral = `[${c.embedding!.join(",")}]`;
      await executor(sql`
        INSERT INTO documents (source, content, embedding, chunk_id)
        VALUES (${c.source}, ${c.content}, ${vectorLiteral}::vector, ${c.chunk_id})
        ON CONFLICT (source, chunk_id) DO UPDATE
        SET content = EXCLUDED.content,
            embedding = EXCLUDED.embedding
      `);
      written++;
    } catch (err) {
      throw new WriterError(
        "write_failed",
        `upsert failed for chunk ${c.chunk_id}: ${(err as Error).message}`,
        c.chunk_id,
        err,
      );
    }
  }
  return { written };
}