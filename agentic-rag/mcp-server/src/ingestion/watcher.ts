/**
 * v1.5.0 ingestion pipeline — filesystem watcher (commit 8).
 *
 * Vigila un directorio (default /data/ingestion) y procesa cada
 * archivo nuevo (.md / .txt) en serie vía processFile().
 *
 * Decisiones:
 *
 *   - Concurrencia: serial. Un doc a la vez. Razón: Ollama local
 *     no rate-limita con elegancia y el costo de un pool no se
 *     justifica en v1.5.0 (decisión del plan locked-in).
 *
 *   - Eventos: solo `add`, no `change`. Re-editar un archivo NO
 *     lo re-ingesta automáticamente. El operador decide (futuro
 *     comando `npm run ingest:release`).
 *
 *   - Errors: cualquier excepción no manejada se loguea y el
 *     watcher sigue vivo. El job queda como `failed` en el store.
 *
 *   - SIGINT/SIGTERM: cierre limpio (await chokidar.close()).
 */
import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { createJobsStore } from "./jobs.js";
import { processFile } from "./pipeline.js";
import type { WatcherOptions } from "./types.js";

export interface WatcherHandle {
  /** Espera a que el directorio inicial esté listo. */
  ready: Promise<void>;
  /** Cierra el watcher (await close antes de exit). */
  close: () => Promise<void>;
}

const DEFAULT_WATCH_DIR =
  process.env.INGEST_WATCH_DIR ?? "/data/ingestion";
const DEFAULT_PATTERNS = ["**/*.md", "**/*.txt", "**/*.markdown"];

export async function startWatcher(
  options: WatcherOptions = {},
): Promise<WatcherHandle> {
  const watchDir = resolve(options.watchDir ?? DEFAULT_WATCH_DIR);
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const store = createJobsStore();

  console.log(`[watcher] watching ${watchDir}`);
  console.log(`[watcher] patterns: ${patterns.join(", ")}`);
  console.log(`[watcher] jobs store: ${process.env.JOBS_STORE ?? "dynamo"}`);

  let watcher: FSWatcher | null = null;
  const queue: string[] = [];
  let draining = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        try {
          const { job } = await processFile(next, { store });
          console.log(
            `[watcher] ${next} → ${job.status}` +
              (job.quarantine_reason ? ` (${job.quarantine_reason})` : "") +
              (job.chunk_count !== undefined ? ` chunks=${job.chunk_count}` : ""),
          );
        } catch (err) {
          console.error(`[watcher] error processing ${next}: ${(err as Error).message}`);
        }
      }
    } finally {
      draining = false;
    }
  };

  watcher = chokidar.watch(patterns, {
    cwd: watchDir,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const ready = new Promise<void>((resolveReady) => {
    watcher!.on("ready", () => {
      console.log(`[watcher] ready`);
      resolveReady();
    });
  });

  watcher.on("add", (relPath) => {
    const absolute = resolve(watchDir, relPath);
    queue.push(absolute);
    void drain();
  });

  watcher.on("error", (err) => {
    console.error(`[watcher] chokidar error: ${err.message}`);
  });

  const close = async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
  };

  // Si se ejecuta directamente (npm run ingest:watch), manejamos
  // SIGINT/SIGTERM para cierre limpio. Importado como módulo, esto
  // no se activa.
  if (require.main === module) {
    const onSignal = async (sig: string) => {
      console.log(`[watcher] received ${sig}, closing`);
      await close();
      process.exit(0);
    };
    process.on("SIGINT", () => void onSignal("SIGINT"));
    process.on("SIGTERM", () => void onSignal("SIGTERM"));
  }

  return { ready, close };
}

// Entry point cuando se ejecuta como script (`npm run ingest:watch`).
if (require.main === module) {
  startWatcher().catch((err) => {
    console.error(`[watcher] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}