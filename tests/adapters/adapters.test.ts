import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude-adapter.js";
import { CodexAdapter } from "../../src/adapters/codex-adapter.js";
import { GeminiAdapter } from "../../src/adapters/gemini-adapter.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner
} from "../../src/adapters/command-runner.js";

class FakeRunner implements CommandRunner {
  private readonly replies: CommandRunResult[];
  public readonly requests: CommandRunRequest[];

  public constructor(replies: CommandRunResult[]) {
    this.replies = replies;
    this.requests = [];
  }

  public async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (!next) {
      throw new Error("no fake reply available");
    }

    for (const line of next.stdoutLines) {
      request.onStdoutLine?.(line);
    }
    for (const line of next.stderrLines) {
      request.onStderrLine?.(line);
    }

    return next;
  }
}

describe("GeminiAdapter", () => {
  it("parses stream-json with diagnostic non-json lines", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          "Loaded cached credentials.",
          '{"type":"init","session_id":"gmn-1"}',
          '{"type":"message","role":"assistant","delta":"Hello"}',
          '{"type":"result","status":"success"}'
        ],
        stderrLines: []
      }
    ]);

    const adapter = new GeminiAdapter(runner);
    const result = await adapter.run({
      prompt: "hi",
      cwd: "/tmp",
      timeoutSec: 30
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapterState.session_id).toBe("gmn-1");
      expect(result.assistantText).toContain("Hello");
      expect(result.diagnosticLogs).toContain("Loaded cached credentials.");
    }
  });

  it("fails when result event is missing", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: ['{"type":"init","session_id":"gmn-1"}'],
        stderrLines: []
      }
    ]);

    const adapter = new GeminiAdapter(runner);
    const result = await adapter.run({
      prompt: "hi",
      cwd: "/tmp",
      timeoutSec: 30
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("E_ADAPTER_MISSING_RESULT");
    }
  });

  it("retries once on transient quota errors", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 1,
        timedOut: false,
        stdoutLines: [],
        stderrLines: ["quota exceeded, retry later"]
      },
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"init","session_id":"gmn-2"}',
          '{"type":"result","status":"success"}'
        ],
        stderrLines: []
      }
    ]);

    const adapter = new GeminiAdapter(runner);
    const result = await adapter.run({
      prompt: "hi",
      cwd: "/tmp",
      timeoutSec: 30
    });

    expect(result.ok).toBe(true);
    expect(runner.requests).toHaveLength(2);
  });
});

describe("CodexAdapter", () => {
  it("extracts thread_id and uses resume command when provided", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello"}}'
        ],
        stderrLines: []
      },
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"again"}}'
        ],
        stderrLines: []
      }
    ]);

    const adapter = new CodexAdapter(runner);
    const first = await adapter.run({ prompt: "first", cwd: "/tmp", timeoutSec: 30 });

    const second = await adapter.run({
      prompt: "second",
      cwd: "/tmp",
      timeoutSec: 30,
      resumeKey: "codex-thread-1"
    });

    expect(second.ok).toBe(true);
    expect(runner.requests[1]?.args.slice(0, 6)).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "codex-thread-1",
      "--json",
      "second"
    ]);

    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.assistantText).toContain("hello");
    }
  });

  it("emits progress for codex tool activity and assistant text", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"thread.started","thread_id":"codex-thread-2"}',
          '{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc \\"ls -la\\""}}',
          '{"type":"item.completed","item":{"id":"item_4","type":"reasoning","text":"thinking"}}',
          '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"final answer"}}'
        ],
        stderrLines: []
      }
    ]);

    const progress: string[] = [];
    const adapter = new CodexAdapter(runner);
    const result = await adapter.run({
      prompt: "run",
      cwd: "/tmp",
      timeoutSec: 30,
      onProgress: (event) => {
        if (event.type === "assistant_text") {
          progress.push(`text:${event.text}`);
          return;
        }
        progress.push(`${event.activity}:${event.label}`);
      }
    });

    expect(result.ok).toBe(true);
    expect(progress).toContain("tool:bash");
    expect(progress).toContain("thinking:reasoning");
    expect(progress).toContain("text:final answer");
  });
});

describe("ClaudeAdapter", () => {
  it("uses -r for resume and requires session_id", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"assistant","session_id":"claude-session-1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}'
        ],
        stderrLines: []
      }
    ]);

    const adapter = new ClaudeAdapter(runner);
    const result = await adapter.run({
      prompt: "hello",
      cwd: "/tmp",
      timeoutSec: 30,
      resumeKey: "claude-session-1"
    });

    expect(result.ok).toBe(true);
    expect(runner.requests[0]?.args).toContain("-r");
    expect(runner.requests[0]?.args).toContain("claude-session-1");
  });

  it("ignores user/tool_result payload and keeps assistant text", async () => {
    const runner = new FakeRunner([
      {
        exitCode: 0,
        timedOut: false,
        stdoutLines: [
          '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"1→{\\"name\\":\\"discord-code-agent\\"}"}]}}',
          '{"type":"assistant","session_id":"claude-session-2","message":{"role":"assistant","content":[{"type":"text","text":"這是專案摘要"}]}}',
          '{"type":"result","subtype":"success","session_id":"claude-session-2","result":"最終回覆"}'
        ],
        stderrLines: []
      }
    ]);

    const adapter = new ClaudeAdapter(runner);
    const result = await adapter.run({
      prompt: "what is this project",
      cwd: "/tmp",
      timeoutSec: 30
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assistantText).toContain("這是專案摘要");
      expect(result.assistantText).not.toContain("1→{");
    }
  });
});
