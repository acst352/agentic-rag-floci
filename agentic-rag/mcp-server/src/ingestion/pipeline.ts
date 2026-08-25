/**
 * v1.5.0 ingestion pipeline — orchestrator (commit 8).
 *
 * processFile toma una ruta absoluta, ejecuta el pipeline
 * completo (load → chunk → quarantine → embed → write) y reporta
 * el resultado a un JobsStore.
 *
 * Esta función es la única que debería tocar TODOS los módulos.
 * cli.ts y watcher.ts solo la invocan; ellos gestionan el origen
 * del path y la concurrencia.
 *
 * Cada etapa es inyectable vía `pipelineStages` para que el e2e
 * test pueda mockear Ollama y pgvector sin tocar globalThis ni
 * el módulo-level. En producción se usan las implementaciones
 * reales; los tests pasan versiones mockeadas.
 */
import { loadDocument, LoaderError } from "./loader.js";
import { chunkDocument } from "./chunker.js";
import { assessDocument } from "./quarantine.js";
import { embedChunks } from "./embedder.js";
import { upsertChunks, WriterError } from "./writer.js";
import { fail, quarantine, type JobsStore } from "./jobs.js";
import type {
  ChunkRecord,
  EmbedderOptions,
  IngestionJob,
  LoadedDocument,
  ProcessingError,
} from "./types.js";

export interface ProcessResult {
  job: IngestionJob;
}

export interface PipelineStages {
  load: (path: string) => Promise<LoadedDocument>;
  chunk: (doc: LoadedDocument) => ChunkRecord[];
  embed: (
    chunks: ChunkRecord[],
    options: EmbedderOptions,
  ) => Promise<ChunkRecord[]>;
  write: (chunks: ChunkRecord[]) => Promise<{ written: number }>;
}

export const DEFAULT_PIPELINE_STAGES: PipelineStages = {
  load: loadDocument,
  chunk: chunkDocument,
  embed: embedChunks,
  write: upsertChunks,
};

export interface PipelineDeps {
  store: JobsStore;
  embedderOptions?: EmbedderOptions;
  /** Injectable para tests. Default: DEFAULT_PIPELINE_STAGES. */
  stages?: PipelineStages;
}

/**
 * Procesa un archivo a través del pipeline. Crea el job, ejecuta
 * cada etapa y actualiza el estado en el JobsStore.
 *
 * Devuelve el job final. Nunca lanza — todos los errores se
 * convierten en transiciones de estado (failed/quarantined).
 */
export async function processFile(
  path: string,
  deps: PipelineDeps,
): Promise<ProcessResult> {
  const stages = deps.stages ?? DEFAULT_PIPELINE_STAGES;

  const job = await deps.store.create({ source: path });

  try {
    await deps.store.transition(job.job_id, "processing");
  } catch (err) {
    return {
      job: await fail(
        deps.store,
        job.job_id,
        `cannot start: ${(err as Error).message}`,
      ),
    };
  }

  // 1. Load
  let loaded: LoadedDocument;
  try {
    loaded = await stages.load(path);
  } catch (err) {
    return {
      job: await fail(deps.store, job.job_id, loaderErrorMessage(err)),
    };
  }

  // 2. Quarantine (BEFORE chunking — no gastamos compute en algo
  // que va a ser rechazado).
  const q = assessDocument(loaded);
  if (!q.ok) {
    return {
      job: await quarantine(deps.store, job.job_id, q.reason),
    };
  }

  // 3. Chunk
  const chunks = stages.chunk(loaded);
  if (chunks.length === 0) {
    return {
      job: await deps.store.transition(job.job_id, "completed", {
        chunk_count: 0,
      }),
    };
  }

  // 4. Embed
  let embedded: ChunkRecord[];
  try {
    embedded = await stages.embed(chunks, deps.embedderOptions ?? {});
  } catch (err) {
    return {
      job: await fail(deps.store, job.job_id, (err as Error).message),
    };
  }

  // 5. Write
  try {
    const result = await stages.write(embedded);
    return {
      job: await deps.store.transition(job.job_id, "completed", {
        chunk_count: result.written,
      }),
    };
  } catch (err) {
    return {
      job: await fail(deps.store, job.job_id, writerErrorMessage(err)),
    };
  }
}

function loaderErrorMessage(err: unknown): string {
  if (err instanceof LoaderError) return err.message;
  return (err as Error).message;
}

function writerErrorMessage(err: unknown): string {
  if (err instanceof WriterError) return err.message;
  // Si el writer mockeado tiró un error genérico, conservamos el
  // mensaje pero preservamos la causa para diagnóstico.
  const cause = err as ProcessingError | Error;
  return cause.message ?? String(err);
}