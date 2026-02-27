import { errorToMessage, isLikelyJsonObjectLine, tryParseJsonObject } from "./parsing.js";
import type { CommandRunner } from "./command-runner.js";
import type { AdapterRunInput, AdapterRunResult, ToolAdapter } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractClaudeAssistantText(event: Record<string, unknown>): string {
  if (event.type === "assistant") {
    const message = event.message;
    if (!isObject(message) || message.role !== "assistant") {
      return "";
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return "";
    }

    const chunks: string[] = [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        chunks.push(block.text);
      }
    }

    return chunks.join("\n").trim();
  }

  if (
    event.type === "result" &&
    typeof event.result === "string" &&
    event.result.length > 0
  ) {
    return event.result;
  }

  return "";
}

function emitClaudeProgress(
  event: Record<string, unknown>,
  onProgress?: AdapterRunInput["onProgress"]
): void {
  if (!onProgress) {
    return;
  }

  if (event.type === "assistant") {
    const message = event.message;
    if (!isObject(message) || message.role !== "assistant") {
      return;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (!isObject(block) || typeof block.type !== "string") {
        continue;
      }

      if (block.type === "tool_use") {
        const label = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
        onProgress({
          type: "activity",
          activity: "tool",
          label
        });
        continue;
      }

      if (block.type === "thinking") {
        onProgress({
          type: "activity",
          activity: "thinking",
          label: "thinking"
        });
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text.length > 0) {
          onProgress({
            type: "assistant_text",
            text
          });
        }
      }
    }

    return;
  }

}

function appendUnique(parts: string[], text: string): void {
  if (text.length === 0) {
    return;
  }

  if (parts.at(-1) === text) {
    return;
  }

  parts.push(text);
}

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
        timeoutSec: input.timeoutSec,
        onStdoutLine: (line) => {
          if (!isLikelyJsonObjectLine(line)) {
            return;
          }

          try {
            const parsed = tryParseJsonObject(line);
            if (!parsed) {
              return;
            }
            emitClaudeProgress(parsed, input.onProgress);
          } catch {
            // Parse failures are handled in the post-run pass.
          }
        }
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

      appendUnique(assistantParts, extractClaudeAssistantText(parsed));
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
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json"
    ];
    if (input.resumeKey) {
      args.push("-r", input.resumeKey);
    }
    args.push(input.prompt);
    return args;
  }
}
