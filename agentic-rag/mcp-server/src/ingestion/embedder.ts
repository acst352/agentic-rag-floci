/**
 * v1.5.0 ingestion pipeline — Ollama embedder (commit 6).
 *
 * Toma una lista de ChunkRecord (sin embedding) y devuelve la
 * misma lista con `embedding` poblado. Cada chunk se embebe
 * individualmente vía Ollama con retry exponencial (3 intentos
 * default: 1s, 4s, 16s).
 *
 * Decisiones de diseño:
 *
 *   - Por qué NO batch: Ollama en CPU local procesa 1 prompt a la
 *     vez; el batch no acelera y complica el manejo de errores.
 *     v1.5.x puede añadir batch si migramos a un modelo con GPU.
 *
 *   - Por qué retry solo para 5xx / network errors: un 4xx (modelo
 *     no encontrado, input inválido) NO se recupera con reintento;
 *     tiene que fallar rápido para no contaminar el job.
 *
 *   - Por qué un `fetcher` inyectable: permite mockear fetch en
 *     tests sin tocar el global. También deja la puerta abierta a
 *     mover a un cliente nativo de Ollama sin tocar el call site.
 *
 * Logging: emitimos por consola con prefijo `[embedder]` y NO
 * logueamos el contenido del chunk (SEC-16: nada de prompts
 * del usuario — y los chunks son material que va a pgvector, no
 * prompt del usuario, pero la disciplina es la misma).
 */
import type {
  ChunkRecord,
  EmbedderOptions,
  ProcessingError,
} from "./types.js";

export interface EmbedderDeps {
  /**
    Inyectable para tests. Firma compatible con `fetch` global.
    Default: globalThis.fetch.
   */
  fetcher?: typeof fetch;
  /**
    Función de sleep para tests deterministas. Default: setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
    Logger estructurado. Default: console.log (no loguea contenido).
   */
  logger?: (event: EmbedderLogEvent) => void;
}

export interface EmbedderLogEvent {
  attempt: number;
  totalAttempts: number;
  chunkIndex: number;
  chunkId: string;
  status: "success" | "retry" | "failed";
  elapsedMs: number;
  error?: string;
}

export class EmbedderError extends Error {
  readonly code: ProcessingError["code"];
  readonly attempts: number;
  readonly cause?: unknown;

  constructor(
    code: ProcessingError["code"],
    message: string,
    attempts: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EmbedderError";
    this.code = code;
    this.attempts = attempts;
    this.cause = cause;
  }
}

export const DEFAULT_EMBEDDER_OPTIONS: Required<
  Omit<EmbedderOptions, "ollamaHost" | "model">
> & { ollamaHost: string; model: string } = {
  ollamaHost: "http://localhost:11434",
  model: "nomic-embed-text",
  maxAttempts: 3,
  retryDelaysMs: [1000, 4000, 16000],
  timeoutMs: 30000,
};

/**
 * Embebe una lista de chunks. Devuelve una NUEVA lista con el
 * campo `embedding` poblado; los chunks originales NO se mutan.
 *
 * Si un chunk falla todos los reintentos, la función entera
 * falla con `EmbedderError` — el pipeline (cli.ts / watcher.ts)
 * marca el job como `failed`. NO se hace partial commit.
 */
export async function embedChunks(
  chunks: ChunkRecord[],
  options: EmbedderOptions = {},
  deps: EmbedderDeps = {},
): Promise<ChunkRecord[]> {
  const cfg = { ...DEFAULT_EMBEDDER_OPTIONS, ...options };
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger ?? defaultLogger;

  if (chunks.length === 0) return [];

  const out: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const embedding = await embedOne(
      c,
      i,
      cfg,
      fetcher,
      sleep,
      log,
    );
    out.push({ ...c, embedding });
  }
  return out;
}

async function embedOne(
  chunk: ChunkRecord,
  index: number,
  cfg: Required<Omit<EmbedderOptions, "ollamaHost" | "model">> & {
    ollamaHost: string;
    model: string;
  },
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  log: (e: EmbedderLogEvent) => void,
): Promise<number[]> {
  const url = `${cfg.ollamaHost}/api/embeddings`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.model, prompt: chunk.content }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const json = (await res.json()) as { embedding: number[] };
        if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
          throw new Error("Ollama returned empty embedding");
        }
        log({
          attempt,
          totalAttempts: cfg.maxAttempts,
          chunkIndex: index,
          chunkId: chunk.chunk_id,
          status: "success",
          elapsedMs: Date.now() - start,
        });
        return json.embedding;
      }

      // 4xx no se reintenta; 5xx sí.
      if (res.status >= 400 && res.status < 500) {
        // Lanzamos FUERA del try para que el catch de abajo no
        // lo recapture como error transitorio.
        throw new EmbedderError(
          "embed_failed",
          `Ollama 4xx ${res.status}: ${await res.text()}`,
          attempt,
        );
      }
      lastErr = new Error(`Ollama ${res.status} ${await res.text()}`);
    } catch (err) {
      // Si ya es un EmbedderError de "fail fast", propagamos sin
      // reintentar.
      if (err instanceof EmbedderError) throw err;
      lastErr = err;
    }

    const elapsed = Date.now() - start;
    const isLast = attempt === cfg.maxAttempts;
    log({
      attempt,
      totalAttempts: cfg.maxAttempts,
      chunkIndex: index,
      chunkId: chunk.chunk_id,
      status: isLast ? "failed" : "retry",
      elapsedMs: elapsed,
      error: errorMessage(lastErr),
    });

    if (isLast) {
      throw new EmbedderError(
        "embed_failed",
        `chunk ${chunk.chunk_id} failed after ${cfg.maxAttempts} attempts: ${errorMessage(lastErr)}`,
        cfg.maxAttempts,
        lastErr,
      );
    }

    const delay = cfg.retryDelaysMs[attempt - 1] ?? 1000;
    await sleep(delay);
  }

  // Inalcanzable: el bucle siempre retorna o tira.
  throw new EmbedderError(
    "embed_failed",
    "unreachable: embed loop exited without result",
    cfg.maxAttempts,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultLogger(event: EmbedderLogEvent): void {
  console.log(
    `[embedder] chunk=${event.chunkId} attempt=${event.attempt}/${event.totalAttempts} status=${event.status} elapsed=${event.elapsedMs}ms${event.error ? ` error=${event.error}` : ""}`,
  );
}