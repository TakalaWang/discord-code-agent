import type { JobEntity, SessionEntity } from "../state/replay.js";

export type { JobEntity, SessionEntity };

export type SessionStatus =
  | "idle"
  | "running"
  | "queued"
  | "failed"
  | "unknown_after_crash";

export function deriveSessionState(
  session: SessionEntity,
  lastJob: JobEntity | undefined
): SessionStatus {
  if (session.running_job_id !== null) {
    return "running";
  }

  if (session.queue.length > 0) {
    return "queued";
  }

  if (lastJob?.state === "unknown_after_crash") {
    return "unknown_after_crash";
  }

  if (lastJob?.state === "failed") {
    return "failed";
  }

  return "idle";
}

interface QueueSession {
  queue: string[];
  running: string | null;
}

export class SessionQueueScheduler {
  private readonly globalMaxRunning: number;
  private readonly sessions: Map<string, QueueSession>;
  private readonly dedupe: Map<string, string>;
  private runningTotal: number;

  public constructor(options: { globalMaxRunning: number }) {
    if (options.globalMaxRunning < 1) {
      throw new Error("globalMaxRunning must be positive");
    }

    this.globalMaxRunning = options.globalMaxRunning;
    this.sessions = new Map();
    this.dedupe = new Map();
    this.runningTotal = 0;
  }

  public ensureSession(threadId: string): void {
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, { queue: [], running: null });
    }
  }

  public enqueue(threadId: string, jobId: string): void {
    const session = this.mustGetSession(threadId);
    session.queue.push(jobId);
  }

  public startNext(threadId: string): string | null {
    const session = this.mustGetSession(threadId);

    if (session.running !== null) {
      return null;
    }

    if (this.runningTotal >= this.globalMaxRunning) {
      return null;
    }

    const next = session.queue.shift();
    if (!next) {
      return null;
    }

    session.running = next;
    this.runningTotal += 1;
    return next;
  }

  public finishRunning(threadId: string, jobId: string): void {
    const session = this.mustGetSession(threadId);

    if (session.running !== jobId) {
      throw new Error(
        `finishRunning mismatch: running=${session.running ?? "none"}, finished=${jobId}`
      );
    }

    session.running = null;
    this.runningTotal -= 1;
  }

  public registerDedupe(
    threadId: string,
    discordMessageId: string,
    jobId: string
  ): boolean {
    const key = `${threadId}:${discordMessageId}`;
    if (this.dedupe.has(key)) {
      return false;
    }

    this.dedupe.set(key, jobId);
    return true;
  }

  public lookupDedupe(threadId: string, discordMessageId: string): string | undefined {
    return this.dedupe.get(`${threadId}:${discordMessageId}`);
  }

  private mustGetSession(threadId: string): QueueSession {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`unknown thread session: ${threadId}`);
    }
    return session;
  }
}
