/**
 * v1.5.0 ingestion pipeline — writer tests.
 *
 * Cubre los 3 casos del commit plan:
 *   1. Insert nuevo: rows affected
 *   2. Re-insert sin duplicar (ON CONFLICT)
 *   3. Mezcla nuevo + existente
 *
 * Más casos:
 *   4. Lista vacía → written=0, executor no se llama
 *   5. Chunk sin embedding → WriterError pre-DB
 *   6. Error de executor propaga como WriterError con chunk_id
 *   7. El SQL generado contiene ON CONFLICT (source, chunk_id)
 */
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  upsertChunks,
  WriterError,
} from "../../src/ingestion/writer.js";
import type { ChunkRecord } from "../../src/ingestion/types.js";

function makeChunk(
  id: string,
  content = "body",
  embedding?: number[],
): ChunkRecord {
  return {
    chunk_id: id,
    source: "doc.md",
    content,
    index: Number(id.split(":")[1] ?? 0),
    embedding,
  };
}

function withEmbedding(c: ChunkRecord, e: number[]): ChunkRecord {
  return { ...c, embedding: e };
}

describe("upsertChunks — happy path", () => {
  it("inserts new chunks and counts rows affected", async () => {
    const executor = vi.fn().mockResolvedValue({ rowCount: 1 });

    const result = await upsertChunks(
      [withEmbedding(makeChunk("doc.md:0"), [0.1]),
       withEmbedding(makeChunk("doc.md:1"), [0.2])],
      { executor },
    );

    expect(result.written).toBe(2);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("returns written=0 for empty input without calling executor", async () => {
    const executor = vi.fn();

    const result = await upsertChunks([], { executor });

    expect(result.written).toBe(0);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("upsertChunks — idempotency", () => {
  it("re-inserting the same chunk_id does not fail (ON CONFLICT)", async () => {
    // El mock del executor devuelve éxito en todas las llamadas —
    // lo que validamos aquí es que NO se lanza WriterError y que
    // el executor se llama una vez por chunk.
    const executor = vi.fn().mockResolvedValue({ rowCount: 1 });

    const chunk = withEmbedding(makeChunk("doc.md:0", "updated content"), [0.5]);

    const result = await upsertChunks([chunk], { executor });

    expect(result.written).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("mixes new and existing chunks in the same batch", async () => {
    const executor = vi.fn().mockResolvedValue({ rowCount: 1 });

    const result = await upsertChunks(
      [withEmbedding(makeChunk("doc.md:0"), [0.1]),
       withEmbedding(makeChunk("doc.md:1"), [0.2]),
       withEmbedding(makeChunk("doc.md:0"), [0.3])],
      { executor },
    );

    // 3 statements ejecutados (uno por chunk del input).
    expect(executor).toHaveBeenCalledTimes(3);
    expect(result.written).toBe(3);
  });
});

describe("upsertChunks — SQL contract", () => {
  it("calls executor with a drizzle SQL object containing ON CONFLICT clause", async () => {
    const executor = vi.fn().mockResolvedValue({ rowCount: 1 });

    await upsertChunks([withEmbedding(makeChunk("doc.md:0"), [0.1])], { executor });

    const arg = executor.mock.calls[0]?.[0];
    // drizzle SQL se serializa con .queryChunks; verificamos que
    // incluye los pedazos clave de la query.
    const serialized = JSON.stringify(arg);
    expect(serialized).toContain("ON CONFLICT");
    expect(serialized).toContain("source");
    expect(serialized).toContain("chunk_id");
  });

  it("uses sql tagged template (drizzle marker)", async () => {
    const executor = vi.fn().mockResolvedValue({ rowCount: 1 });
    await upsertChunks([withEmbedding(makeChunk("doc.md:0"), [0.1])], { executor });
    // Drizzle marca los SQL templates; verificamos que el primer
    // arg del executor es un objeto drizzle (no un string).
    const arg = executor.mock.calls[0]?.[0] as unknown;
    expect(arg).toBeDefined();
    // El query de drizzle tiene una estructura reconocible.
    expect(typeof (arg as { queryChunks?: unknown }).queryChunks).toBe(
      "object",
    );
  });
});

describe("upsertChunks — validation", () => {
  it("rejects chunk without embedding BEFORE touching DB", async () => {
    const executor = vi.fn();

    await expect(
      upsertChunks([makeChunk("doc.md:0", "x")], { executor }),
    ).rejects.toBeInstanceOf(WriterError);

    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects chunk with empty embedding array", async () => {
    const executor = vi.fn();

    await expect(
      upsertChunks([withEmbedding(makeChunk("doc.md:0"), [])], { executor }),
    ).rejects.toMatchObject({
      code: "write_failed",
      chunk_id: "doc.md:0",
    });

    expect(executor).not.toHaveBeenCalled();
  });
});

describe("upsertChunks — error propagation", () => {
  it("wraps executor errors in WriterError with chunk_id", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("connection lost"));

    await expect(
      upsertChunks([withEmbedding(makeChunk("doc.md:0"), [0.1])], { executor }),
    ).rejects.toMatchObject({
      name: "WriterError",
      code: "write_failed",
      chunk_id: "doc.md:0",
    });
  });
});

// Sanity: el sql de drizzle compila sin importar la config.
it("drizzle sql template compiles", () => {
  const q = sql`SELECT 1`;
  expect(q).toBeDefined();
});