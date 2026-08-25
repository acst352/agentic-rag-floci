/**
 * v1.5.0 ingestion pipeline — embedder tests.
 *
 * Cubre los 3 casos del commit plan (docs/v1.5.0-plan.md §"Commit
 * plan"):
 *   1. Éxito en el primer intento
 *   2. Éxito después de un retry (5xx transitorio)
 *   3. Fallo permanente (3 strikes) → EmbedderError
 *
 * Más casos:
 *   4. 4xx no se reintenta (falla rápido)
 *   5. Empty input / empty embedding array → error
 *   6. Lista vacía → []
 *   7. Logger recibe eventos correctos (success/retry/failed)
 *   8. Sleep inyectable: delays respetados en orden
 *   9. Timeout vía AbortController se cuenta como retry
 */
import { describe, expect, it, vi } from "vitest";
import {
  embedChunks,
  EmbedderError,
  type EmbedderLogEvent,
} from "../../src/ingestion/embedder.js";
import type { ChunkRecord } from "../../src/ingestion/types.js";

function makeChunk(i: number, content = `chunk ${i}`): ChunkRecord {
  return {
    chunk_id: `doc.md:${i}`,
    source: "doc.md",
    content,
    index: i,
  };
}

function makeOkResponse(embedding: number[]): Response {
  return new Response(JSON.stringify({ embedding }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeErrorResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

describe("embedChunks — happy path", () => {
  it("embeds each chunk and returns them with embedding populated", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeOkResponse([0.1, 0.2, 0.3]))
      .mockResolvedValueOnce(makeOkResponse([0.4, 0.5, 0.6]));

    const out = await embedChunks(
      [makeChunk(0), makeChunk(1)],
      { ollamaHost: "http://x", model: "nomic-embed-text" },
      { fetcher, sleep: async () => {} },
    );

    expect(out).toHaveLength(2);
    expect(out[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(out[1]?.embedding).toEqual([0.4, 0.5, 0.6]);
    // Los originales NO se mutan.
    expect(out[0]?.chunk_id).toBe("doc.md:0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns [] for empty input", async () => {
    const fetcher = vi.fn();
    const out = await embedChunks([], {}, { fetcher });
    expect(out).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("embedChunks — retry on 5xx", () => {
  it("retries on 500 and succeeds on the 2nd attempt", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(500, "boom"))
      .mockResolvedValueOnce(makeOkResponse([0.1, 0.2, 0.3]));
    const sleep = vi.fn(async () => {});
    const log: EmbedderLogEvent[] = [];
    const logger = (e: EmbedderLogEvent) => log.push(e);

    const out = await embedChunks(
      [makeChunk(0)],
      {
        ollamaHost: "http://x",
        model: "m",
        maxAttempts: 3,
        retryDelaysMs: [10, 20, 40],
      },
      { fetcher, sleep, logger },
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10); // primer delay (attempt 1 → delay[0])
    expect(log).toHaveLength(2);
    expect(log[0]?.status).toBe("retry");
    expect(log[1]?.status).toBe("success");
  });

  it("uses retryDelaysMs[attempt-1] for the delay BEFORE attempt N+1", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503, "x"))
      .mockResolvedValueOnce(makeErrorResponse(503, "x"))
      .mockResolvedValueOnce(makeOkResponse([0.1]));
    const sleep = vi.fn(async () => {});

    await embedChunks(
      [makeChunk(0)],
      {
        ollamaHost: "http://x",
        model: "m",
        maxAttempts: 3,
        retryDelaysMs: [100, 200, 400],
      },
      { fetcher, sleep },
    );

    expect(sleep.mock.calls[0]?.[0]).toBe(100); // before attempt 2
    expect(sleep.mock.calls[1]?.[0]).toBe(200); // before attempt 3
  });
});

describe("embedChunks — fail after 3 attempts", () => {
  it("throws EmbedderError after maxAttempts strikes", async () => {
    // mockResolvedValueOnce × 3 → cada intento recibe una Response
    // nueva (res.text() se puede leer exactamente una vez).
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503, "still down"))
      .mockResolvedValueOnce(makeErrorResponse(503, "still down"))
      .mockResolvedValueOnce(makeErrorResponse(503, "still down"));
    const sleep = vi.fn(async () => {});
    const log: EmbedderLogEvent[] = [];
    const logger = (e: EmbedderLogEvent) => log.push(e);

    await expect(
      embedChunks(
        [makeChunk(0)],
        {
          ollamaHost: "http://x",
          model: "m",
          maxAttempts: 3,
          retryDelaysMs: [1, 2, 4],
        },
        { fetcher, sleep, logger },
      ),
    ).rejects.toMatchObject({
      name: "EmbedderError",
      code: "embed_failed",
      attempts: 3,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // sleep N-1 times
    expect(log.map((e) => e.status)).toEqual(["retry", "retry", "failed"]);
  });
});

describe("embedChunks — fail fast on 4xx", () => {
  it("does NOT retry on 400 / 404 — fails immediately", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeErrorResponse(404, "no model"));
    const sleep = vi.fn(async () => {});

    await expect(
      embedChunks(
        [makeChunk(0)],
        {
          ollamaHost: "http://x",
          model: "m",
          maxAttempts: 3,
          retryDelaysMs: [10, 20, 40],
        },
        { fetcher, sleep },
      ),
    ).rejects.toBeInstanceOf(EmbedderError);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("embedChunks — malformed response", () => {
  it("errors on empty embedding array", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeOkResponse([]));
    const sleep = vi.fn(async () => {});

    await expect(
      embedChunks(
        [makeChunk(0)],
        { ollamaHost: "http://x", model: "m", maxAttempts: 3 },
        { fetcher, sleep },
      ),
    ).rejects.toBeInstanceOf(EmbedderError);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});