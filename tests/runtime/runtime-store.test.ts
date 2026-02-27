import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/state/runtime-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dca-runtime-"));
  dirs.push(dir);
  return dir;
}

describe("RuntimeStore", () => {
  it("marks running jobs as unknown_after_crash during recovery", async () => {
    const dir = await tempDir();
    const store = await RuntimeStore.open({ stateDir: dir });

    await store.appendEvent("SessionCreated", {
      thread_id: "thread-a",
      project_name: "my-app",
      tool: "gemini"
    });
    await store.appendEvent("JobEnqueued", {
      thread_id: "thread-a",
      job_id: "job-1",
      discord_message_id: "msg-1",
      prompt: "hello",
      tool: "gemini"
    });
    await store.appendEvent("JobStarted", {
      thread_id: "thread-a",
      job_id: "job-1"
    });

    await store.flushSnapshot();

    const restarted = await RuntimeStore.open({ stateDir: dir });
    const marked = await restarted.recoverRunningJobsAfterCrash();

    expect(marked).toEqual(["job-1"]);
    expect(restarted.getState().jobs["job-1"]?.state).toBe("unknown_after_crash");
  });

  it("replays full state from events when snapshot is removed", async () => {
    const dir = await tempDir();
    const store = await RuntimeStore.open({ stateDir: dir });

    await store.appendEvent("SessionCreated", {
      thread_id: "thread-b",
      project_name: "my-app",
      tool: "gemini"
    });
    await store.appendEvent("JobEnqueued", {
      thread_id: "thread-b",
      job_id: "job-2",
      discord_message_id: "msg-2",
      prompt: "hello",
      tool: "gemini"
    });
    await store.appendEvent("JobStarted", {
      thread_id: "thread-b",
      job_id: "job-2"
    });
    await store.appendEvent("JobCompleted", {
      thread_id: "thread-b",
      job_id: "job-2",
      result_excerpt: "done",
      adapter_state: { session_id: "gmn-x" }
    });
    await store.flushSnapshot();

    await rm(join(dir, "snapshot.json"));
    const replayed = await RuntimeStore.open({ stateDir: dir });

    const state = replayed.getState();
    expect(state.jobs["job-2"]?.state).toBe("success");
    expect(state.sessions["thread-b"]?.adapter_state.session_id).toBe("gmn-x");
  });
});
