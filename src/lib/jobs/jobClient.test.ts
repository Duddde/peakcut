import { describe, expect, it, vi } from "vitest";
import {
  enqueueJob,
  fetchJob,
  requestJobCancel,
  pollJobUntilDone,
  runJob,
  JobClientError,
  JobPollTimeoutError,
} from "./jobClient";

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    projectId: "proj-1",
    kind: "analysis",
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    payload: {},
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("enqueueJob", () => {
  it("POSTs to /api/jobs with the given params and parses the returned job", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture() }, 201));
    const job = await enqueueJob({ projectId: "proj-1", kind: "analysis", payload: {}, idempotencyKey: "idem-1" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/jobs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "proj-1", kind: "analysis", payload: {}, idempotencyKey: "idem-1" }),
      })
    );
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("queued");
  });

  it("throws JobClientError with the server's message on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "Projet introuvable." }, 404));
    await expect(enqueueJob({ projectId: "x", kind: "analysis" }, fetchImpl)).rejects.toThrow(JobClientError);
    await expect(enqueueJob({ projectId: "x", kind: "analysis" }, fetchImpl)).rejects.toThrow(/Projet introuvable/);
  });

  it("throws JobClientError when the network call itself fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(enqueueJob({ projectId: "x", kind: "analysis" }, fetchImpl)).rejects.toThrow(JobClientError);
  });
});

describe("fetchJob", () => {
  it("GETs /api/jobs/:id and parses the job", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture({ status: "running", progress: 40 }) }));
    const job = await fetchJob("job-1", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/jobs/job-1", expect.objectContaining({ cache: "no-store" }));
    expect(job.progress).toBe(40);
  });
});

describe("requestJobCancel", () => {
  it("returns the job on a successful cancel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture({ status: "cancelled" }) }));
    const job = await requestJobCancel("job-1", fetchImpl);
    expect(job.status).toBe("cancelled");
  });

  it("still returns the job when the route reports 409 (already terminal) but includes the job", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "déjà terminé", job: jobFixture({ status: "succeeded" }) }, 409));
    const job = await requestJobCancel("job-1", fetchImpl);
    expect(job.status).toBe("succeeded");
  });

  it("throws when there is no job in the response at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "Job introuvable." }, 404));
    await expect(requestJobCancel("job-1", fetchImpl)).rejects.toThrow(/Job introuvable/);
  });
});

describe("pollJobUntilDone", () => {
  it("polls until a terminal status, calling onUpdate for every check", async () => {
    const statuses = ["queued", "running", "running", "succeeded"];
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({ ok: true, job: jobFixture({ status: statuses.shift(), progress: 100 }) })
    );
    const updates: string[] = [];
    const job = await pollJobUntilDone("job-1", { fetchImpl, intervalMs: 0, onUpdate: (j) => updates.push(j.status) });

    expect(job.status).toBe("succeeded");
    expect(updates).toEqual(["queued", "running", "running", "succeeded"]);
  });

  it("stops and throws JobPollTimeoutError after maxAttempts without a terminal status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture({ status: "running" }) }));
    await expect(pollJobUntilDone("job-1", { fetchImpl, intervalMs: 0, maxAttempts: 3 })).rejects.toThrow(
      JobPollTimeoutError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops promptly once the signal is aborted, without waiting for the next terminal status", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort();
      return jsonResponse({ ok: true, job: jobFixture({ status: "running" }) });
    });
    await expect(pollJobUntilDone("job-1", { fetchImpl, intervalMs: 0, signal: controller.signal })).rejects.toThrow(
      /interrompu/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately (no extra fetch) when the job is already terminal on the first check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture({ status: "failed", errorMessage: "boom" }) }));
    const job = await pollJobUntilDone("job-1", { fetchImpl, intervalMs: 0 });
    expect(job.status).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("runJob", () => {
  it("enqueues then polls to a terminal status", async () => {
    let created = false;
    const fetchImpl = vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/jobs" && init?.method === "POST") {
        created = true;
        return jsonResponse({ ok: true, job: jobFixture({ status: "queued" }) }, 201);
      }
      if (String(url) === "/api/jobs/job-1") {
        return jsonResponse({ ok: true, job: jobFixture({ status: created ? "succeeded" : "queued", result: { segments: [] } }) });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const job = await runJob(
      { projectId: "proj-1", kind: "analysis", payload: {} },
      { fetchImpl, intervalMs: 0 }
    );
    expect(job.status).toBe("succeeded");
    expect(job.result).toEqual({ segments: [] });
  });

  it("does not poll further when the enqueue response is already terminal (idempotent hit on a finished job)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, job: jobFixture({ status: "succeeded" }) }, 200));
    const job = await runJob({ projectId: "proj-1", kind: "analysis" }, { fetchImpl });
    expect(job.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
