import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import { DomainError } from "../../src/domain/errors.js";
import type { AdapterRunInput, AdapterRunResult, ToolAdapter } from "../../src/adapters/types.js";
import { InMemoryAdapterRegistry } from "../../src/adapters/registry.js";
import { JobCoordinator } from "../../src/runner/job-coordinator.js";
import { RuntimeStore } from "../../src/state/runtime-store.js";
import { AgentService } from "../../src/agent/agent-service.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dca-agent-"));
  dirs.push(dir);
  return dir;
}

class QueueAdapter implements ToolAdapter {
  public readonly calls: Array<{ tool: string; prompt: string }> = [];
  public maxInFlight = 0;
  public inFlight = 0;
  private readonly tool: string;
  private readonly delayMs: number;
  private readonly failOnce: boolean;
  private failed = false;

  public constructor(tool: string, delayMs = 0, failOnce = false) {
    this.tool = tool;
    this.delayMs = delayMs;
    this.failOnce = failOnce;
  }

  public async run(input: AdapterRunInput): Promise<AdapterRunResult> {
    this.calls.push({ tool: this.tool, prompt: input.prompt });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }

      if (this.failOnce && !this.failed) {
        this.failed = true;
        return {
          ok: false,
          errorCode: "E_CLI_EXIT_NONZERO",
          errorMessage: "first failure",
          assistantText: "",
          adapterState: {},
          diagnosticLogs: [],
          stdoutLines: [],
          stderrLines: []
        };
      }

      return {
        ok: true,
        assistantText: `done:${input.prompt}`,
        adapterState:
          this.tool === "codex"
            ? { thread_id: "thread-key" }
            : { session_id: `${this.tool}-session` },
        diagnosticLogs: [],
        stdoutLines: [],
        stderrLines: []
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

async function createHarness() {
  const root = await tempDir();
  const stateDir = join(root, "state");
  const configPath = join(stateDir, "config.json");

  const config = await ConfigStore.open(configPath, "owner-1");
  await config.createProject({
    name: "my-app",
    path: root,
    toolsCsv: "gemini,codex,claude",
    defaultTool: "gemini"
  });

  const runtime = await RuntimeStore.open({ stateDir });
  const gemini = new QueueAdapter("gemini", 5);
  const codex = new QueueAdapter("codex", 5);
  const claude = new QueueAdapter("claude", 5, true);
  const registry = new InMemoryAdapterRegistry({ gemini, codex, claude });
  const coordinator = new JobCoordinator({ runtimeStore: runtime, configStore: config, adapters: registry });

  const service = new AgentService({
    ownerId: "owner-1",
    configStore: config,
    runtimeStore: runtime,
    coordinator,
    now: () => new Date("2026-02-26T14:00:00.000Z")
  });

  return { root, runtime, service, gemini, codex, claude };
}

describe("AgentService", () => {
  it("enforces owner-only operations", async () => {
    const { service } = await createHarness();

    await expect(
      service.startSession({ userId: "not-owner", projectName: "my-app", threadId: "thread-a" })
    ).rejects.toMatchObject({ code: "E_OWNER_ONLY" });
  });

  it("processes thread jobs in FIFO order", async () => {
    const { service, gemini } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-a" });

    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m1",
      prompt: "first"
    });
    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m2",
      prompt: "second"
    });
    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m3",
      prompt: "third"
    });

    await service.waitForIdle();

    expect(gemini.calls.map((call) => call.prompt)).toEqual(["first", "second", "third"]);
  });

  it("tool switch only affects newly enqueued jobs", async () => {
    const { service, gemini, codex } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-a" });

    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m1",
      prompt: "before-switch"
    });

    await service.changeTool({ userId: "owner-1", threadId: "thread-a", tool: "codex" });

    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m2",
      prompt: "after-switch"
    });

    await service.waitForIdle();

    expect(gemini.calls.map((call) => call.prompt)).toEqual(["before-switch"]);
    expect(codex.calls.map((call) => call.prompt)).toEqual(["after-switch"]);
  });

  it("supports retry for failed jobs", async () => {
    const { service } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-a" });
    await service.changeTool({ userId: "owner-1", threadId: "thread-a", tool: "claude" });

    await service.enqueueThreadMessage({
      userId: "owner-1",
      threadId: "thread-a",
      messageId: "m1",
      prompt: "will-fail-once"
    });

    await service.waitForIdle();

    const failed = Object.values(service.runtimeState().jobs).find((job) => job.state === "failed");
    expect(failed).toBeDefined();

    await service.retryJob({ userId: "owner-1", jobId: failed!.job_id });
    await service.waitForIdle();

    const successes = Object.values(service.runtimeState().jobs).filter((job) => job.state === "success");
    expect(successes.length).toBeGreaterThan(0);
  });

  it("formats /status fields exactly", async () => {
    const { service } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-a" });

    const status = await service.status({ userId: "owner-1", threadId: "thread-a" });

    expect(status).toContain("Session Status");
    expect(status).toContain("project: my-app");
    expect(status).toContain("tool: gemini");
    expect(status).toContain("state: idle");
    expect(status).toContain("resume_ready:");
  });

  it("caps global parallel running jobs at 2 across threads", async () => {
    const { service, gemini } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-a" });
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-b" });
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-c" });

    await Promise.all([
      service.enqueueThreadMessage({
        userId: "owner-1",
        threadId: "thread-a",
        messageId: "m-a",
        prompt: "a"
      }),
      service.enqueueThreadMessage({
        userId: "owner-1",
        threadId: "thread-b",
        messageId: "m-b",
        prompt: "b"
      }),
      service.enqueueThreadMessage({
        userId: "owner-1",
        threadId: "thread-c",
        messageId: "m-c",
        prompt: "c"
      })
    ]);

    await service.waitForIdle();
    expect(gemini.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("opens existing session thread and rejects missing session", async () => {
    const { service } = await createHarness();
    await service.startSession({ userId: "owner-1", projectName: "my-app", threadId: "thread-open" });

    const opened: string[] = [];
    const sessionId = await service.openSession({
      userId: "owner-1",
      sessionId: "thread-open",
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      }
    });

    expect(sessionId).toBe("thread-open");
    expect(opened).toEqual(["thread-open"]);

    await expect(
      service.openSession({
        userId: "owner-1",
        sessionId: "missing"
      })
    ).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });
});
