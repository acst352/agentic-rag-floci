/**
 * v1.5.0 ingestion pipeline — jobs state machine tests.
 *
 * Cubre:
 *   1. Transiciones válidas (pending → processing → completed/quarantined/failed)
 *   2. Transiciones inválidas rechazadas con JobsError
 *   3. isValidTransition exportada
 *   4. Quarantine helper
 *   5. Fail helper
 *   6. Create asigna job_id y source correctos
 *   7. InMemoryJobsStore: get retorna el último estado
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryJobsStore,
  JobsError,
  fail,
  isValidTransition,
  quarantine,
} from "../../src/ingestion/jobs.js";

describe("InMemoryJobsStore — create", () => {
  it("returns a fresh job in pending state with attempts=1", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "docs/a.md" });

    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(job.source).toBe("docs/a.md");
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
  });

  it("assigns a unique job_id on each call", async () => {
    const store = new InMemoryJobsStore();
    const a = await store.create({ source: "x.md" });
    const b = await store.create({ source: "y.md" });
    expect(a.job_id).not.toBe(b.job_id);
  });
});

describe("InMemoryJobsStore — transitions", () => {
  it("follows pending → processing → completed", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });

    const processing = await store.transition(job.job_id, "processing");
    expect(processing.status).toBe("processing");
    expect(processing.processed_at).toBeTruthy();

    const completed = await store.transition(job.job_id, "completed", {
      chunk_count: 5,
    });
    expect(completed.status).toBe("completed");
    expect(completed.chunk_count).toBe(5);
  });

  it("supports processing → quarantined with reason", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });
    await store.transition(job.job_id, "processing");

    const q = await quarantine(store, job.job_id, "pattern:you_are_now");
    expect(q.status).toBe("quarantined");
    expect(q.quarantine_reason).toBe("pattern:you_are_now");
  });

  it("supports processing → failed with error", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });
    await store.transition(job.job_id, "processing");

    const f = await fail(store, job.job_id, "ollama unreachable");
    expect(f.status).toBe("failed");
    expect(f.last_error).toBe("ollama unreachable");
  });

  it("supports failed → processing (re-proceso)", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });
    await store.transition(job.job_id, "processing");
    await store.transition(job.job_id, "failed");

    const retry = await store.transition(job.job_id, "processing");
    expect(retry.status).toBe("processing");
  });
});

describe("InMemoryJobsStore — invalid transitions", () => {
  it.each([
    ["pending", "completed"],
    ["pending", "failed"],
    ["pending", "quarantined"],
    ["completed", "processing"],
    ["completed", "failed"],
    ["quarantined", "processing"],
  ])("rejects %s → %s", async (from, to) => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });
    // Forzar el estado inicial al "from".
    if (from === "processing") {
      await store.transition(job.job_id, "processing");
    } else if (from === "completed") {
      await store.transition(job.job_id, "processing");
      await store.transition(job.job_id, "completed");
    } else if (from === "quarantined") {
      await store.transition(job.job_id, "processing");
      await store.transition(job.job_id, "quarantined");
    }

    await expect(
      store.transition(job.job_id, to as never),
    ).rejects.toMatchObject({
      name: "JobsError",
      code: "invalid_transition",
    });
  });

  it("rejects transition on unknown job_id", async () => {
    const store = new InMemoryJobsStore();
    await expect(
      store.transition("does-not-exist", "processing"),
    ).rejects.toMatchObject({
      name: "JobsError",
      code: "not_found",
    });
  });
});

describe("isValidTransition", () => {
  it("returns true for valid transitions", () => {
    expect(isValidTransition("pending", "processing")).toBe(true);
    expect(isValidTransition("processing", "completed")).toBe(true);
    expect(isValidTransition("processing", "failed")).toBe(true);
    expect(isValidTransition("processing", "quarantined")).toBe(true);
    expect(isValidTransition("failed", "processing")).toBe(true);
  });

  it("returns false for invalid transitions", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
    expect(isValidTransition("completed", "processing")).toBe(false);
    expect(isValidTransition("quarantined", "processing")).toBe(false);
  });
});

describe("InMemoryJobsStore — get", () => {
  it("returns the latest state after transitions", async () => {
    const store = new InMemoryJobsStore();
    const job = await store.create({ source: "x.md" });
    await store.transition(job.job_id, "processing");

    const got = await store.get(job.job_id);
    expect(got?.status).toBe("processing");
  });

  it("returns undefined for unknown id", async () => {
    const store = new InMemoryJobsStore();
    expect(await store.get("ghost")).toBeUndefined();
  });
});

// Reference JobsError para que TS no marque el import como unused.
it("JobsError carries code and job_id", () => {
  const e = new JobsError("not_found", "x", "job-1");
  expect(e.code).toBe("not_found");
  expect(e.job_id).toBe("job-1");
});