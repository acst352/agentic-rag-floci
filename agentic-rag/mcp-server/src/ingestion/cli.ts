/**
 * v1.5.0 ingestion pipeline — CLI entrypoint.
 *
 * Usage:
 *   npm run ingest -- /path/to/file.md
 *   npm run ingest -- /path/to/file.txt
 *
 * Procesa UN archivo. Sale con código 0 si el job termina en
 * `completed` o `quarantined` (estado terminal esperado), 1 si
 * termina en `failed`.
 *
 * El job se persiste en DynamoDB (producción) o in-memory
 * (JOBS_STORE=memory). En este último caso el job se pierde al
 * terminar el proceso — solo útil para CI y smoke tests.
 */
import { resolve } from "node:path";
import { createJobsStore } from "./jobs.js";
import { processFile } from "./pipeline.js";

async function main(argv: string[]): Promise<void> {
  const path = argv[2];
  if (!path) {
    console.error("[ingest] usage: npm run ingest -- <path>");
    process.exit(2);
  }

  const absolute = resolve(path);
  const store = createJobsStore();

  console.log(`[ingest] processing ${absolute}`);
  console.log(`[ingest] jobs store: ${process.env.JOBS_STORE ?? "dynamo"}`);

  const { job } = await processFile(absolute, { store });

  console.log(
    `[ingest] job_id=${job.job_id} status=${job.status}` +
      (job.quarantine_reason ? ` reason=${job.quarantine_reason}` : "") +
      (job.last_error ? ` error=${job.last_error}` : "") +
      (job.chunk_count !== undefined ? ` chunks=${job.chunk_count}` : ""),
  );

  if (job.status === "failed") {
    process.exit(1);
  }
  process.exit(0);
}

main(process.argv).catch((err) => {
  console.error(`[ingest] fatal: ${(err as Error).message}`);
  process.exit(1);
});