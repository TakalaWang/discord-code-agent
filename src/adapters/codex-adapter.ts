import { errorToMessage, isLikelyJsonObjectLine, tryParseJsonObject } from "./parsing.js";
import type { CommandRunner } from "./command-runner.js";
import type {
  AdapterProgressEvent,
  AdapterRunInput,
  AdapterRunResult,
  ToolAdapter
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexItem(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type !== "item.started" && event.type !== "item.completed") {
    return null;
  }

  const item = event.item;
  if (!isObject(item)) {
    return null;
  }

  return item;
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

function extractCodexAssistantText(event: Record<string, unknown>): string {
  const item = parseCodexItem(event);
  if (item) {
    if (item.type === "agent_message" && typeof item.text === "string") {
      return item.text.trim();
    }
    return "";
  }

  return "";
}

function extractToolLabel(command: string): string {
  if (command.includes("/bin/zsh") || command.includes("/bin/bash")) {
    return "bash";
  }

  const head = command.trim().split(/\s+/)[0];
  if (!head) {
    return "tool";
  }

  const leaf = head.split("/").at(-1);
  return leaf && leaf.length > 0 ? leaf : head;
}

function emitProgress(event: Record<string, unknown>, onProgress?: (event: AdapterProgressEvent) => void): void {
  if (!onProgress) {
    return;
  }

  const item = parseCodexItem(event);
  if (!item || typeof item.type !== "string") {
    return;
  }

  if (item.type === "reasoning") {
    onProgress({
      type: "activity",
      activity: "thinking",
      label: "reasoning"
    });
    return;
  }

  if (item.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "";
    onProgress({
      type: "activity",
      activity: "tool",
      label: extractToolLabel(command)
    });
    return;
  }

  if (item.type === "agent_message" && typeof item.text === "string") {
    const text = item.text.trim();
    if (text.length > 0) {
      onProgress({
        type: "assistant_text",
        text
      });
    }
  }
}

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
            emitProgress(parsed, input.onProgress);
          } catch {
            // Keep parse handling in the post-run pass where errors become adapter failures.
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

      appendUnique(assistantParts, extractCodexAssistantText(parsed));
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
      return [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "resume",
        input.resumeKey,
        "--json",
        input.prompt
      ];
    }

    return [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      input.prompt
    ];
  }
}
