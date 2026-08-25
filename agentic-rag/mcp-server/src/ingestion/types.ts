/**
 * v1.5.0 ingestion pipeline types (PRD §15 SEC-21).
 *
 * El pipeline produce tres artefactos:
 *   - IngestionJob:    estado de un documento dentro de la tabla
 *                      `ingestion_jobs` (DynamoDB en prod, in-memory
 *                      en tests). Permite al operador ver qué pasó
 *                      con cada doc y reprocesar los rechazados.
 *   - LoadedDocument:  el resultado de leer el archivo del disco,
 *                      con metadatos básicos (mime, size, mtime).
 *   - ChunkRecord:     un fragmento del documento listo para ser
 *                      embedido e insertado en pgvector. El chunk_id
 *                      es estable por (source, índice) y es la clave
 *                      del upsert idempotente.
 *
 * Los tipos aquí son puros — no tienen dependencias de runtime. Los
 * módulos loader / chunker / quarantine / embedder / writer / jobs
 * los importan. Cualquier cambio de forma debe ir acompañado de un
 * test correspondiente.
 */

/**
 * Estado de un IngestionJob. Las transiciones válidas son:
 *
 *   pending  → processing → completed
 *                         → quarantined
 *                         → failed
 *   failed   → processing (re-proceso manual vía CLI v1.5.x)
 *
 * `quarantined` es terminal: el operador decide reprocesar o
 * descartar. `completed` es terminal. `failed` es reintentable.
 */
export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "quarantined"
  | "failed";

export interface IngestionJob {
  /** Identificador estable del job (UUID v4). */
  job_id: string;
  /** Estado actual del job (ver JobStatus). */
  status: JobStatus;
  /** Ruta relativa del archivo ingerido. Estable entre re-procesos. */
  source: string;
  /** Número de intento de procesamiento (1 la primera vez). */
  attempts: number;
  /** Mensaje de error del último intento fallido, si aplica. */
  last_error?: string;
  /** ISO 8601 timestamp de la última transición de estado. */
  processed_at?: string;
  /** Razón de rechazo cuando status === "quarantined". */
  quarantine_reason?: QuarantineReason;
  /** Cantidad de chunks escritos en pgvector (post-procesamiento). */
  chunk_count?: number;
}

/**
 * Razones de rechazo de la cuarentena (SEC-21).
 *
 * Las razones son strings estables — aparecen en logs, métricas y
 * el campo `quarantine_reason` del job. NO cambiarlas sin
 * actualizar las pruebas y el runbook.
 */
export type QuarantineReason =
  | "length_too_large"
  | "length_too_small"
  | "encoding_suspicious"
  | "mime_mismatch"
  | `pattern:${string}`
  | "unsupported_format";

/**
 * Resultado del loader. `metadata.headings` se rellena para .md
 * (cada heading de la sección que contiene el chunk se asocia al
 * chunk en chunker.ts).
 */
export interface LoadedDocument {
  /** Ruta absoluta del archivo. */
  path: string;
  /** Ruta relativa estable (se persiste en pgvector.metadata.source). */
  source: string;
  /** Contenido textual del documento. */
  content: string;
  /** MIME detectado (text/markdown, text/plain, etc.). */
  mime: string;
  /** Tamaño en bytes del archivo. */
  size: number;
  /** Mtime como ISO 8601. */
  mtime: string;
  /** Headings del documento (MD only). Vacío para TXT. */
  headings: HeadingSection[];
}

export interface HeadingSection {
  /** Nivel del heading (1..6). 0 indica bloque pre-heading. */
  level: number;
  /** Texto del heading. */
  text: string;
  /** Offset de carácter donde empieza este bloque en `content`. */
  start: number;
  /** Offset de carácter donde termina este bloque en `content`. */
  end: number;
}

/**
 * Un chunk listo para embedder + upsert.
 *
 * `chunk_id` se calcula como `${source}:${index}` y se persiste
 * en pgvector. Es la clave del upsert idempotente de writer.ts:
 * un re-proceso del mismo archivo reemplaza in-place, no duplica.
 */
export interface ChunkRecord {
  chunk_id: string;
  source: string;
  content: string;
  /** Índice del chunk dentro del documento (0-based). */
  index: number;
  /** Heading de la sección a la que pertenece (MD only). */
  heading?: string;
  /** Vector de embedding (768 dims, modelo nomic-embed-text). */
  embedding?: number[];
}

/**
 * Error de pipeline. Lo emite cualquier módulo cuando una
 * condición no recuperable (vs. quarantine, que es recuperable).
 * El caller (cli.ts / watcher.ts) lo convierte en job.failed.
 */
export interface ProcessingError {
  code:
    | "load_failed"
    | "chunk_failed"
    | "embed_failed"
    | "write_failed"
    | "unsupported_format";
  message: string;
  /** Stack original para diagnóstico. NO se persiste en el job. */
  cause?: unknown;
}

/**
 * Configuración del chunker (default en chunker.ts).
 */
export interface ChunkerOptions {
  /** Tamaño máximo del chunk en caracteres. Default 2000 (~500 tokens). */
  maxChars?: number;
  /** Solapamiento entre chunks consecutivos. Default 200 chars. */
  overlapChars?: number;
}

/**
 * Configuración del embedder (default en embedder.ts).
 */
export interface EmbedderOptions {
  /** URL del servidor Ollama. Default http://localhost:11434. */
  ollamaHost?: string;
  /** Modelo de embeddings. Default nomic-embed-text (768 dims). */
  model?: string;
  /** Número de reintentos. Default 3. */
  maxAttempts?: number;
  /** Delays en ms antes de cada reintento (1s, 4s, 16s). */
  retryDelaysMs?: number[];
  /** Timeout por intento en ms. Default 30000. */
  timeoutMs?: number;
}

/**
 * Configuración del watcher.
 */
export interface WatcherOptions {
  /** Directorio a vigilar. Default $INGEST_WATCH_DIR o /data/ingestion. */
  watchDir?: string;
  /** Globs aceptados. Default ["**\/*.md", "**\/*.txt"]. */
  patterns?: string[];
  /** Si true, no procesa en serie — solo emite eventos. Default false. */
  dryRun?: boolean;
}