import { MAX_QUEUE_PER_SESSION } from "../domain/constants.js";
import { DomainError } from "../domain/errors.js";
import { deriveSessionState } from "../queue/session-queue.js";
import type { ConfigStore, ProjectConfig } from "../config/config-store.js";
import type { ToolName } from "../state/replay.js";
import type { RuntimeStore } from "../state/runtime-store.js";
import type { JobCoordinator } from "../runner/job-coordinator.js";

export interface AgentServiceOptions {
  ownerId: string;
  configStore: ConfigStore;
  runtimeStore: RuntimeStore;
  coordinator: JobCoordinator;
  now?: () => Date;
}

export class AgentService {
  private readonly ownerId: string;
  private readonly configStore: ConfigStore;
  private readonly runtimeStore: RuntimeStore;
  private readonly coordinator: JobCoordinator;
  private readonly now: () => Date;
  private idCounter: number;

  public constructor(options: AgentServiceOptions) {
    this.ownerId = options.ownerId;
    this.configStore = options.configStore;
    this.runtimeStore = options.runtimeStore;
    this.coordinator = options.coordinator;
    this.now = options.now ?? (() => new Date());
    this.idCounter = 0;
  }

  public runtimeState() {
    return this.runtimeStore.getState();
  }

  public async waitForIdle(): Promise<void> {
    await this.coordinator.waitForIdle();
  }

  public async createProject(options: {
    userId: string;
    name: string;
    path: string;
    argsJson?: string;
  }): Promise<ProjectConfig> {
    this.assertOwner(options.userId);
    const input: {
      name: string;
      path: string;
      argsJson?: string;
    } = {
      name: options.name,
      path: options.path
    };
    if (options.argsJson !== undefined) {
      input.argsJson = options.argsJson;
    }

    const project = await this.configStore.createProject(input);

    await this.runtimeStore.appendEvent("ProjectCreated", {
      project_name: project.name,
      path: project.path,
      enabled_tools: project.enabled_tools
    });

    return project;
  }

  public listProjects(options: { userId: string }): ProjectConfig[] {
    this.assertOwner(options.userId);
    return this.configStore.listProjects();
  }

  public projectStatus(options: { userId: string; projectName: string }): string {
    this.assertOwner(options.userId);
    const project = this.configStore.getProject(options.projectName);
    if (!project) {
      throw new DomainError("E_PROJECT_NOT_FOUND", `project not found: ${options.projectName}`);
    }

    const state = this.runtimeStore.getState();
    const sessions = Object.values(state.sessions).filter(
      (session) => session.project_name === options.projectName
    );

    const nowMs = this.now().getTime();
    const jobs = Object.values(state.jobs).filter((job) => {
      const session = state.sessions[job.thread_id];
      return session?.project_name === options.projectName;
    });

    const runningSessions = sessions.filter((session) => session.running_job_id !== null).length;
    const queuedJobs = sessions.reduce((sum, session) => sum + session.queue.length, 0);
    const failed24h = jobs.filter((job) => {
      if (job.state !== "failed" || !job.finished_at) {
        return false;
      }
      return nowMs - new Date(job.finished_at).getTime() <= 24 * 3600 * 1000;
    }).length;

    const lastError = jobs
      .filter((job) => job.state === "failed")
      .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""))
      .at(-1)?.error_code;

    return [
      `Project Status: ${project.name}`,
      `session_total: ${sessions.length}`,
      `running_sessions: ${runningSessions}`,
      `queued_jobs: ${queuedJobs}`,
      `failed_jobs_24h: ${failed24h}`,
      `last_error: ${lastError ?? "n/a"}`
    ].join("\n");
  }

  public async startSession(options: {
    userId: string;
    projectName: string;
    threadId: string;
    tool: ToolName;
  }): Promise<{ sessionId: string }> {
    this.assertOwner(options.userId);

    const project = this.configStore.getProject(options.projectName);
    if (!project) {
      throw new DomainError("E_PROJECT_NOT_FOUND", `project not found: ${options.projectName}`);
    }

    if (!project.enabled_tools.includes(options.tool)) {
      throw new DomainError("E_TOOL_NOT_ENABLED", `tool not enabled: ${options.tool}`);
    }

    await this.runtimeStore.appendEvent("SessionCreated", {
      thread_id: options.threadId,
      project_name: project.name,
      tool: options.tool,
      adapter_state: {}
    });

    return { sessionId: options.threadId };
  }

  public listSessions(options: { userId: string; projectName?: string }): Array<{
    session_id: string;
    project_name: string;
    state: string;
    last_activity_at: string;
    thread_link: string;
  }> {
    this.assertOwner(options.userId);
    const state = this.runtimeStore.getState();

    return Object.values(state.sessions)
      .filter((session) =>
        options.projectName ? session.project_name === options.projectName : true
      )
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
      .slice(0, 20)
      .map((session) => ({
        session_id: session.thread_id,
        project_name: session.project_name,
        state: deriveSessionState(session, state.jobs[session.last_job_id ?? ""]),
        last_activity_at: session.last_activity_at,
        thread_link: `https://discord.com/channels/<guild>/<channel>/${session.thread_id}`
      }));
  }

  public async openSession(options: {
    userId: string;
    sessionId: string;
    onOpenThread?: (threadId: string) => Promise<void>;
  }): Promise<string> {
    this.assertOwner(options.userId);
    const session = this.runtimeStore.getState().sessions[options.sessionId];
    if (!session) {
      throw new DomainError("E_SESSION_NOT_FOUND", `session not found: ${options.sessionId}`);
    }

    if (options.onOpenThread) {
      try {
        await options.onOpenThread(options.sessionId);
      } catch {
        throw new DomainError("E_THREAD_ACCESS_FAILED", "unable to open thread");
      }
    }

    return session.thread_id;
  }

  public async status(options: { userId: string; threadId: string }): Promise<string> {
    this.assertOwner(options.userId);
    const state = this.runtimeStore.getState();
    const session = state.sessions[options.threadId];
    if (!session) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "current thread is not managed");
    }

    const lastJob = session.last_job_id ? state.jobs[session.last_job_id] : undefined;
    const derived = deriveSessionState(session, lastJob);

    const sessionKey =
      session.tool === "codex"
        ? session.adapter_state.thread_id
        : session.adapter_state.session_id;

    const resumeReady = typeof sessionKey === "string" && sessionKey.length > 0 ? "yes" : "no";
    const retryHint =
      lastJob && (lastJob.state === "failed" || lastJob.state === "unknown_after_crash")
        ? `/retry ${lastJob.job_id}`
        : "n/a";

    const lastJobText = lastJob
      ? `${lastJob.state}, ${this.durationSec(lastJob.started_at, lastJob.finished_at)}s, ${lastJob.finished_at ?? "running"}`
      : "n/a";

    return [
      "Session Status",
      `project: ${session.project_name}`,
      `tool: ${session.tool}`,
      `session_key: ${typeof sessionKey === "string" ? sessionKey : "n/a"}`,
      `state: ${derived}`,
      `queue: pending=${session.queue.length}, running=${session.running_job_id ?? "n/a"}`,
      `last_job: ${lastJobText}`,
      `resume_ready: ${resumeReady}`,
      `retry_hint: ${retryHint}`
    ].join("\n");
  }

  public async enqueueThreadMessage(options: {
    userId: string;
    threadId: string;
    messageId: string;
    prompt: string;
  }): Promise<{ jobId: string; deduped: boolean }> {
    this.assertOwner(options.userId);
    const state = this.runtimeStore.getState();
    const session = state.sessions[options.threadId];

    if (!session) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "current thread is not managed");
    }

    const dedupeKey = `${options.threadId}:${options.messageId}`;
    const existing = state.dedupe[dedupeKey];
    if (existing) {
      return {
        jobId: existing,
        deduped: true
      };
    }

    if (session.queue.length >= MAX_QUEUE_PER_SESSION) {
      throw new DomainError("E_QUEUE_FULL", "session queue is full");
    }

    const jobId = this.createJobId();
    await this.runtimeStore.appendEvent("JobEnqueued", {
      thread_id: options.threadId,
      job_id: jobId,
      discord_message_id: options.messageId,
      prompt: options.prompt,
      tool: session.tool,
      attempt: 1
    });

    this.coordinator.notifyNewWork();
    return { jobId, deduped: false };
  }

  public async retryJob(options: { userId: string; jobId: string }): Promise<{ jobId: string }> {
    this.assertOwner(options.userId);

    const state = this.runtimeStore.getState();
    const previous = state.jobs[options.jobId];
    if (!previous) {
      throw new DomainError("E_JOB_NOT_RETRYABLE", `job not found: ${options.jobId}`);
    }

    if (previous.state !== "failed" && previous.state !== "unknown_after_crash") {
      throw new DomainError("E_JOB_NOT_RETRYABLE", `job is not retryable: ${options.jobId}`);
    }

    const newJobId = this.createJobId();
    await this.runtimeStore.appendEvent("JobEnqueued", {
      thread_id: previous.thread_id,
      job_id: newJobId,
      discord_message_id: `retry:${previous.job_id}:${newJobId}`,
      prompt: previous.prompt,
      tool: previous.tool,
      attempt: previous.attempt + 1
    });

    this.coordinator.notifyNewWork();
    return { jobId: newJobId };
  }

  private createJobId(): string {
    this.idCounter += 1;
    const stamp = this.now().toISOString().replace(/[-:.TZ]/g, "");
    return `job_${stamp}_${this.idCounter.toString().padStart(4, "0")}`;
  }

  private durationSec(start: string | null, end: string | null): number {
    if (!start || !end) {
      return 0;
    }

    const elapsed = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
    return Math.round(elapsed / 1000);
  }

  private assertOwner(userId: string): void {
    if (userId !== this.ownerId) {
      throw new DomainError("E_OWNER_ONLY", "only owner can operate this bot");
    }
  }
}
