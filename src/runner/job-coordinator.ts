import { join } from "node:path";
import { CLI_TIMEOUT_SEC, GLOBAL_MAX_RUNNING, MAX_RESULT_EXCERPT_CHARS } from "../domain/constants.js";
import { AppLogger } from "../logging/app-logger.js";
import { writeJobLog } from "../logging/job-log-writer.js";
import type { ConfigStore } from "../config/config-store.js";
import type { AdapterRegistry } from "../adapters/types.js";
import type { RuntimeStore } from "../state/runtime-store.js";
import type { SessionEntity } from "../state/replay.js";

export interface JobCoordinatorOptions {
  runtimeStore: RuntimeStore;
  configStore: ConfigStore;
  adapters: AdapterRegistry;
  globalMaxRunning?: number;
  timeoutSec?: number;
  logDir?: string;
  onJobStarted?: (event: { threadId: string; jobId: string }) => Promise<void> | void;
  onJobFinished?: (event: {
    threadId: string;
    jobId: string;
    state: "success" | "failed";
    resultExcerpt?: string;
    errorCode?: string;
    errorMessage?: string;
  }) => Promise<void> | void;
}

export class JobCoordinator {
  private readonly runtimeStore: RuntimeStore;
  private readonly configStore: ConfigStore;
  private readonly adapters: AdapterRegistry;
  private readonly globalMaxRunning: number;
  private readonly timeoutSec: number;
  private readonly logDir: string;
  private readonly logger: AppLogger;
  private onJobStarted?: JobCoordinatorOptions["onJobStarted"];
  private onJobFinished?: JobCoordinatorOptions["onJobFinished"];

  private readonly runningThreads: Set<string>;
  private readonly runningPromises: Set<Promise<void>>;
  private kicking: boolean;

  public constructor(options: JobCoordinatorOptions) {
    this.runtimeStore = options.runtimeStore;
    this.configStore = options.configStore;
    this.adapters = options.adapters;
    this.globalMaxRunning = options.globalMaxRunning ?? GLOBAL_MAX_RUNNING;
    this.timeoutSec = options.timeoutSec ?? CLI_TIMEOUT_SEC;
    this.logDir = options.logDir ?? "logs";
    this.logger = new AppLogger(join(this.logDir, "app.ndjson"));
    this.onJobStarted = options.onJobStarted;
    this.onJobFinished = options.onJobFinished;

    this.runningThreads = new Set();
    this.runningPromises = new Set();
    this.kicking = false;
  }

  public notifyNewWork(): void {
    void this.kick();
  }

  public setHooks(hooks: {
    onJobStarted?: JobCoordinatorOptions["onJobStarted"];
    onJobFinished?: JobCoordinatorOptions["onJobFinished"];
  }): void {
    this.onJobStarted = hooks.onJobStarted ?? this.onJobStarted;
    this.onJobFinished = hooks.onJobFinished ?? this.onJobFinished;
  }

  public async waitForIdle(): Promise<void> {
    for (;;) {
      await this.kick();

      const hasRunning = this.runningPromises.size > 0;
      const hasQueued = this.hasQueuedJobs();
      if (!hasRunning && !hasQueued) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private hasQueuedJobs(): boolean {
    const state = this.runtimeStore.unsafeStateReference();
    return Object.values(state.sessions).some((session) => session.queue.length > 0);
  }

  private async kick(): Promise<void> {
    if (this.kicking) {
      return;
    }

    this.kicking = true;
    try {
      while (this.runningThreads.size < this.globalMaxRunning) {
        const next = this.pickNextRunnable();
        if (!next) {
          break;
        }

        const promise = this.processJob(next.threadId, next.jobId)
          .catch(async (error) => {
            await this.logger.log({
              ts: new Date().toISOString(),
              level: "error",
              message: "job processing crashed",
              meta: {
                thread_id: next.threadId,
                job_id: next.jobId,
                reason: error instanceof Error ? error.message : String(error)
              }
            });
          })
          .finally(() => {
            this.runningThreads.delete(next.threadId);
            this.runningPromises.delete(promise);
            void this.kick();
          });

        this.runningThreads.add(next.threadId);
        this.runningPromises.add(promise);
      }
    } finally {
      this.kicking = false;
    }
  }

  private pickNextRunnable(): { threadId: string; jobId: string } | null {
    const state = this.runtimeStore.unsafeStateReference();
    const sessions = Object.values(state.sessions).sort((a, b) => {
      return a.last_activity_at.localeCompare(b.last_activity_at);
    });

    for (const session of sessions) {
      if (this.runningThreads.has(session.thread_id)) {
        continue;
      }

      if (session.running_job_id !== null) {
        continue;
      }

      const nextJobId = session.queue[0];
      if (!nextJobId) {
        continue;
      }

      return {
        threadId: session.thread_id,
        jobId: nextJobId
      };
    }

    return null;
  }

  private async processJob(threadId: string, jobId: string): Promise<void> {
    await this.runtimeStore.appendEvent("JobStarted", {
      thread_id: threadId,
      job_id: jobId
    });
    await this.onJobStarted?.({ threadId, jobId });

    const state = this.runtimeStore.unsafeStateReference();
    const session = state.sessions[threadId];
    const job = state.jobs[jobId];

    if (!session || !job) {
      await this.runtimeStore.appendEvent("JobFailed", {
        thread_id: threadId,
        job_id: jobId,
        error_code: "E_ADAPTER_PARSE",
        error_message: "job/session missing after JobStarted"
      });
      return;
    }

    const project = this.configStore.getProject(session.project_name);
    if (!project) {
      await this.runtimeStore.appendEvent("JobFailed", {
        thread_id: threadId,
        job_id: jobId,
        error_code: "E_PROJECT_NOT_FOUND",
        error_message: `project not found: ${session.project_name}`
      });
      return;
    }

    const adapter = this.adapters.get(job.tool);
    const resumeKey = this.extractResumeKey(session);

    const adapterInput: {
      prompt: string;
      cwd: string;
      timeoutSec: number;
      resumeKey?: string;
    } = {
      prompt: job.prompt,
      cwd: project.path,
      timeoutSec: this.timeoutSec
    };
    if (resumeKey !== undefined) {
      adapterInput.resumeKey = resumeKey;
    }

    const result = await adapter.run(adapterInput);

    await writeJobLog({
      logDir: this.logDir,
      jobId,
      stdoutLines: result.stdoutLines,
      stderrLines: result.stderrLines,
      diagnosticLogs: result.diagnosticLogs
    });

    if (result.ok) {
      const excerpt = result.assistantText.slice(0, MAX_RESULT_EXCERPT_CHARS);
      await this.runtimeStore.appendEvent("JobCompleted", {
        thread_id: threadId,
        job_id: jobId,
        result_excerpt: excerpt,
        adapter_state: result.adapterState
      });
      await this.onJobFinished?.({
        threadId,
        jobId,
        state: "success",
        resultExcerpt: excerpt
      });
      return;
    }

    await this.runtimeStore.appendEvent("JobFailed", {
      thread_id: threadId,
      job_id: jobId,
      error_code: result.errorCode,
      error_message: result.errorMessage,
      adapter_state: result.adapterState
    });
    await this.onJobFinished?.({
      threadId,
      jobId,
      state: "failed",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage
    });
  }

  private extractResumeKey(session: SessionEntity): string | undefined {
    if (session.tool === "codex") {
      const threadId = session.adapter_state.thread_id;
      return typeof threadId === "string" ? threadId : undefined;
    }

    const sessionId = session.adapter_state.session_id;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
}
