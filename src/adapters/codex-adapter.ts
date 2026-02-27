import { errorToMessage, extractAssistantText, isLikelyJsonObjectLine, tryParseJsonObject } from "./parsing.js";
import type { CommandRunner } from "./command-runner.js";
import type { AdapterRunInput, AdapterRunResult, ToolAdapter } from "./types.js";

export class CodexAdapter implements ToolAdapter {
  private readonly runner: CommandRunner;
  private readonly command: string;

  public constructor(runner: CommandRunner, options?: { command?: string }) {
    this.runner = runner;
    this.command = options?.command ?? "codex";
  }

  public async run(input: AdapterRunInput): Promise<AdapterRunResult> {
    let runResult;
    try {
      runResult = await this.runner.run({
        command: this.command,
        args: this.buildArgs(input),
        cwd: input.cwd,
        timeoutSec: input.timeoutSec
      });
    } catch (error) {
      return {
        ok: false,
        errorCode: "E_CLI_EXIT_NONZERO",
        errorMessage: errorToMessage(error),
        assistantText: "",
        adapterState: {},
        diagnosticLogs: [],
        stdoutLines: [],
        stderrLines: []
      };
    }

    if (runResult.timedOut) {
      return {
        ok: false,
        errorCode: "E_CLI_TIMEOUT",
        errorMessage: "codex command timed out",
        assistantText: "",
        adapterState: {},
        diagnosticLogs: [],
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    const diagnostics: string[] = [];
    const assistantParts: string[] = [];
    let threadId: string | null = null;

    for (const line of runResult.stdoutLines) {
      if (!isLikelyJsonObjectLine(line)) {
        diagnostics.push(line);
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = tryParseJsonObject(line) ?? {};
      } catch (error) {
        return {
          ok: false,
          errorCode: "E_ADAPTER_PARSE",
          errorMessage: errorToMessage(error),
          assistantText: assistantParts.join("\n"),
          adapterState: {},
          diagnosticLogs: diagnostics,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        threadId = parsed.thread_id;
      }

      if (!threadId && typeof parsed.thread_id === "string") {
        threadId = parsed.thread_id;
      }

      const text = extractAssistantText(parsed);
      if (text.length > 0) {
        assistantParts.push(text);
      }
    }

    if (runResult.exitCode !== 0) {
      return {
        ok: false,
        errorCode: "E_CLI_EXIT_NONZERO",
        errorMessage: `codex exited with code ${runResult.exitCode}`,
        assistantText: assistantParts.join("\n").trim(),
        adapterState: threadId ? { thread_id: threadId } : {},
        diagnosticLogs: diagnostics,
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    if (!threadId) {
      return {
        ok: false,
        errorCode: "E_ADAPTER_SESSION_KEY_MISSING",
        errorMessage: "codex did not emit thread_id",
        assistantText: assistantParts.join("\n").trim(),
        adapterState: {},
        diagnosticLogs: diagnostics,
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    return {
      ok: true,
      assistantText: assistantParts.join("\n").trim(),
      adapterState: { thread_id: threadId },
      diagnosticLogs: diagnostics,
      stdoutLines: runResult.stdoutLines,
      stderrLines: runResult.stderrLines
    };
  }

  private buildArgs(input: AdapterRunInput): string[] {
    if (input.resumeKey) {
      return ["exec", "resume", input.resumeKey, "--json", input.prompt];
    }

    return ["exec", "--json", input.prompt];
  }
}
