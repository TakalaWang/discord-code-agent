import { describe, expect, it } from "vitest";
import {
  deriveSessionState,
  type JobEntity,
  type SessionEntity,
  SessionQueueScheduler
} from "../../src/queue/session-queue.js";

function createSession(threadId: string): SessionEntity {
  return {
    thread_id: threadId,
    project_name: "my-app",
    tool: "gemini",
    adapter_state: {},
    queue: [],
    running_job_id: null,
    last_job_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: "2026-01-01T00:00:00.000Z"
  };
}

function createJob(jobId: string, state: JobEntity["state"]): JobEntity {
  return {
    job_id: jobId,
    thread_id: "thread-a",
    discord_message_id: `msg-${jobId}`,
    state,
    prompt: "test",
    attempt: 1,
    tool: "gemini",
    error_code: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    result_excerpt: null
  };
}

describe("deriveSessionState", () => {
  it("follows the spec priority order", () => {
    const session = createSession("thread-a");
    session.running_job_id = "job-running";
    expect(deriveSessionState(session, undefined)).toBe("running");

    session.running_job_id = null;
    session.queue.push("job-queued");
    expect(deriveSessionState(session, undefined)).toBe("queued");

    session.queue = [];
    expect(deriveSessionState(session, createJob("job-1", "unknown_after_crash"))).toBe(
      "unknown_after_crash"
    );
    expect(deriveSessionState(session, createJob("job-2", "failed"))).toBe("failed");
    expect(deriveSessionState(session, createJob("job-3", "success"))).toBe("idle");
  });
});

describe("SessionQueueScheduler", () => {
  it("enforces single-consumer FIFO per thread", () => {
    const scheduler = new SessionQueueScheduler({ globalMaxRunning: 2 });
    scheduler.ensureSession("thread-a");

    scheduler.enqueue("thread-a", "job-1");
    scheduler.enqueue("thread-a", "job-2");

    expect(scheduler.startNext("thread-a")).toBe("job-1");
    expect(scheduler.startNext("thread-a")).toBeNull();

    scheduler.finishRunning("thread-a", "job-1");
    expect(scheduler.startNext("thread-a")).toBe("job-2");
  });

  it("enforces global max running across threads", () => {
    const scheduler = new SessionQueueScheduler({ globalMaxRunning: 2 });
    scheduler.ensureSession("thread-a");
    scheduler.ensureSession("thread-b");
    scheduler.ensureSession("thread-c");

    scheduler.enqueue("thread-a", "job-1");
    scheduler.enqueue("thread-b", "job-2");
    scheduler.enqueue("thread-c", "job-3");

    expect(scheduler.startNext("thread-a")).toBe("job-1");
    expect(scheduler.startNext("thread-b")).toBe("job-2");
    expect(scheduler.startNext("thread-c")).toBeNull();

    scheduler.finishRunning("thread-a", "job-1");
    expect(scheduler.startNext("thread-c")).toBe("job-3");
  });

  it("deduplicates by thread_id:message_id key", () => {
    const scheduler = new SessionQueueScheduler({ globalMaxRunning: 2 });
    scheduler.ensureSession("thread-a");

    const first = scheduler.registerDedupe("thread-a", "msg-1", "job-1");
    const second = scheduler.registerDedupe("thread-a", "msg-1", "job-2");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(scheduler.lookupDedupe("thread-a", "msg-1")).toBe("job-1");
  });
});
