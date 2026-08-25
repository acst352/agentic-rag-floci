/**
 * v1.5.0 ingestion pipeline — jobs table state machine (commit 8).
 *
 * Cada documento que entra al pipeline genera un IngestionJob.
 * El job se persiste en DynamoDB (producción) o en memoria
 * (tests, dev sin AWS). La clave primaria es `job_id` (UUID v4).
 *
 * Estados y transiciones:
 *
 *   pending  ──> processing ──> completed
 *                          ╲──> quarantined
 *                          ╱──> failed
 *   failed   ──> processing   (re-proceso manual vía CLI v1.5.x)
 *
 * Las transiciones inválidas se rechazan con JobsError.
 *
 * Por qué un store alternativo in-memory:
 *   - Tests e2e no deben depender de AWS ni de DynamoDB Local.
 *   - Dev local sin AWS puede usar el watcher end-to-end.
 *   - La interfaz `JobsStore` es la misma; el código que llama
 *     (cli.ts / watcher.ts) no sabe ni le importa cuál está activo.
 */
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  IngestionJob,
  JobStatus,
  QuarantineReason,
} from "./types.js";

export class JobsError extends Error {
  readonly code: "invalid_transition" | "not_found" | "store_error";
  readonly job_id?: string;

  constructor(
    code: "invalid_transition" | "not_found" | "store_error",
    message: string,
    job_id?: string,
  ) {
    super(message);
    this.name = "JobsError";
    this.code = code;
    this.job_id = job_id;
  }
}

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ["processing"],
  processing: ["completed", "quarantined", "failed"],
  completed: [],
  quarantined: [],
  failed: ["processing"],
};

export function isValidTransition(
  from: JobStatus,
  to: JobStatus,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Interfaz que ambos backends implementan.
 */
export interface JobsStore {
  create(input: { source: string }): Promise<IngestionJob>;
  transition(
    job_id: string,
    to: JobStatus,
    fields?: Partial<
      Pick<
        IngestionJob,
        "last_error" | "quarantine_reason" | "chunk_count"
      >
    >,
  ): Promise<IngestionJob>;
  get(job_id: string): Promise<IngestionJob | undefined>;
}

// ─────────────────────────────────────────────────────────────────
// In-memory store (tests + dev sin AWS)
// ─────────────────────────────────────────────────────────────────

export class InMemoryJobsStore implements JobsStore {
  private readonly store = new Map<string, IngestionJob>();

  async create(input: { source: string }): Promise<IngestionJob> {
    const job: IngestionJob = {
      job_id: randomUUID(),
      status: "pending",
      source: input.source,
      attempts: 1,
    };
    this.store.set(job.job_id, job);
    return job;
  }

  async transition(
    job_id: string,
    to: JobStatus,
    fields: Partial<
      Pick<
        IngestionJob,
        "last_error" | "quarantine_reason" | "chunk_count"
      >
    > = {},
  ): Promise<IngestionJob> {
    const current = this.store.get(job_id);
    if (!current) {
      throw new JobsError("not_found", `job ${job_id} not found`, job_id);
    }
    if (!isValidTransition(current.status, to)) {
      throw new JobsError(
        "invalid_transition",
        `cannot transition from ${current.status} to ${to}`,
        job_id,
      );
    }
    const next: IngestionJob = {
      ...current,
      status: to,
      ...fields,
      processed_at: new Date().toISOString(),
    };
    this.store.set(job_id, next);
    return next;
  }

  async get(job_id: string): Promise<IngestionJob | undefined> {
    return this.store.get(job_id);
  }
}

// ─────────────────────────────────────────────────────────────────
// DynamoDB store (producción)
// ─────────────────────────────────────────────────────────────────

export interface DynamoJobsStoreOptions {
  tableName?: string;
  region?: string;
  /** Cliente AWS opcional para tests (mock). */
  client?: DynamoDBClient;
}

export class DynamoJobsStore implements JobsStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoJobsStoreOptions = {}) {
    const config: DynamoDBClientConfig = { region: options.region ?? process.env.AWS_REGION ?? "us-east-1" };
    const raw = options.client ?? new DynamoDBClient(config);
    this.doc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.tableName =
      options.tableName ??
      process.env.JOBS_TABLE ??
      "ingestion_jobs";
  }

  async create(input: { source: string }): Promise<IngestionJob> {
    const job: IngestionJob = {
      job_id: randomUUID(),
      status: "pending",
      source: input.source,
      attempts: 1,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: job,
        ConditionExpression: "attribute_not_exists(job_id)",
      }),
    );
    return job;
  }

  async transition(
    job_id: string,
    to: JobStatus,
    fields: Partial<
      Pick<
        IngestionJob,
        "last_error" | "quarantine_reason" | "chunk_count"
      >
    > = {},
  ): Promise<IngestionJob> {
    const current = await this.get(job_id);
    if (!current) {
      throw new JobsError("not_found", `job ${job_id} not found`, job_id);
    }
    if (!isValidTransition(current.status, to)) {
      throw new JobsError(
        "invalid_transition",
        `cannot transition from ${current.status} to ${to}`,
        job_id,
      );
    }
    const sets: string[] = ["#s = :s", "processed_at = :ts"];
    const names: Record<string, string> = { "#s": "status" };
    const values: Record<string, unknown> = {
      ":s": to,
      ":ts": new Date().toISOString(),
      ":from": current.status,
    };

    if (fields.last_error !== undefined) {
      sets.push("last_error = :le");
      values[":le"] = fields.last_error;
    }
    if (fields.quarantine_reason !== undefined) {
      sets.push("quarantine_reason = :qr");
      values[":qr"] = fields.quarantine_reason;
    }
    if (fields.chunk_count !== undefined) {
      sets.push("chunk_count = :cc");
      values[":cc"] = fields.chunk_count;
    }

    const out = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { job_id },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return out.Attributes as IngestionJob;
  }

  async get(job_id: string): Promise<IngestionJob | undefined> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { job_id },
        ConsistentRead: true,
      }),
    );
    return out.Item as IngestionJob | undefined;
  }
}

/**
 * Factory: lee `JOBS_STORE` env. Default: dynamo.
 *   JOBS_STORE=memory → InMemoryJobsStore (dev, tests e2e)
 *   JOBS_STORE=dynamo → DynamoJobsStore (default, producción)
 */
export function createJobsStore(): JobsStore {
  const which = (process.env.JOBS_STORE ?? "dynamo").toLowerCase();
  if (which === "memory") return new InMemoryJobsStore();
  return new DynamoJobsStore();
}

/**
 * Helper: marca el job como `quarantined` con razón. Atajo a
 * transition() porque es el caso más común en el pipeline.
 */
export async function quarantine(
  store: JobsStore,
  job_id: string,
  reason: QuarantineReason,
): Promise<IngestionJob> {
  return store.transition(job_id, "quarantined", { quarantine_reason: reason });
}

/**
 * Helper: marca el job como `failed` con error. Atajo a transition().
 */
export async function fail(
  store: JobsStore,
  job_id: string,
  last_error: string,
): Promise<IngestionJob> {
  return store.transition(job_id, "failed", { last_error });
}