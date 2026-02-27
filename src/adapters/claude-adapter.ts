import { errorToMessage, extractAssistantText, isLikelyJsonObjectLine, tryParseJsonObject } from "./parsing.js";
import type { CommandRunner } from "./command-runner.js";
import type { AdapterRunInput, AdapterRunResult, ToolAdapter } from "./types.js";

export class ClaudeAdapter implements ToolAdapter {
  private readonly runner: CommandRunner;
  private readonly command: string;

  public constructor(runner: CommandRunner, options?: { command?: string }) {
    this.runner = runner;
    this.command = options?.command ?? "claude";
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
        errorMessage: "claude command timed out",
        assistantText: "",
        adapterState: {},
        diagnosticLogs: [],
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    const diagnostics: string[] = [];
    const assistantParts: string[] = [];
    let sessionId: string | null = null;

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
          assistantText: assistantParts.join("\n").trim(),
          adapterState: {},
          diagnosticLogs: diagnostics,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (typeof parsed.session_id === "string") {
        sessionId = parsed.session_id;
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
        errorMessage: `claude exited with code ${runResult.exitCode}`,
        assistantText: assistantParts.join("\n").trim(),
        adapterState: sessionId ? { session_id: sessionId } : {},
        diagnosticLogs: diagnostics,
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    if (!sessionId) {
      return {
        ok: false,
        errorCode: "E_ADAPTER_SESSION_KEY_MISSING",
        errorMessage: "claude did not emit session_id",
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
      adapterState: { session_id: sessionId },
      diagnosticLogs: diagnostics,
      stdoutLines: runResult.stdoutLines,
      stderrLines: runResult.stderrLines
    };
  }

  private buildArgs(input: AdapterRunInput): string[] {
    const args = ["-p", "--verbose", "--output-format", "stream-json"];
    if (input.resumeKey) {
      args.push("-r", input.resumeKey);
    }
    args.push(input.prompt);
    return args;
  }
}
