import { errorToMessage, extractAssistantText, hasTransientErrorHint, isLikelyJsonObjectLine, tryParseJsonObject } from "./parsing.js";
import type { CommandRunner } from "./command-runner.js";
import type { AdapterRunInput, AdapterRunResult, ToolAdapter } from "./types.js";

interface GeminiParseResult {
  sessionId: string | null;
  assistantText: string;
  diagnosticLogs: string[];
  hasResult: boolean;
  resultStatus: string | null;
  parseError: string | null;
}

function parseGemini(stdoutLines: string[]): GeminiParseResult {
  const diagnostics: string[] = [];
  const assistantParts: string[] = [];
  let sessionId: string | null = null;
  let hasResult = false;
  let resultStatus: string | null = null;

  for (const line of stdoutLines) {
    if (!isLikelyJsonObjectLine(line)) {
      diagnostics.push(line);
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = tryParseJsonObject(line) ?? {};
    } catch (error) {
      return {
        sessionId,
        assistantText: assistantParts.join("\n"),
        diagnosticLogs: diagnostics,
        hasResult,
        resultStatus,
        parseError: errorToMessage(error)
      };
    }

    if (typeof parsed.session_id === "string") {
      sessionId = parsed.session_id;
    }

    if (parsed.type === "init" && typeof parsed.session_id === "string") {
      sessionId = parsed.session_id;
    }

    if (parsed.type === "message" && parsed.role === "assistant") {
      if (typeof parsed.delta === "string") {
        assistantParts.push(parsed.delta);
      } else {
        const extracted = extractAssistantText(parsed);
        if (extracted.length > 0) {
          assistantParts.push(extracted);
        }
      }
    }

    if (parsed.type === "result") {
      hasResult = true;
      if (typeof parsed.status === "string") {
        resultStatus = parsed.status;
      }
    }
  }

  return {
    sessionId,
    assistantText: assistantParts.join("\n").trim(),
    diagnosticLogs: diagnostics,
    hasResult,
    resultStatus,
    parseError: null
  };
}

export class GeminiAdapter implements ToolAdapter {
  private readonly runner: CommandRunner;
  private readonly command: string;

  public constructor(runner: CommandRunner, options?: { command?: string }) {
    this.runner = runner;
    this.command = options?.command ?? "gemini";
  }

  public async run(input: AdapterRunInput): Promise<AdapterRunResult> {
    let attempt = 0;

    while (attempt < 2) {
      attempt += 1;
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
          errorMessage: "gemini command timed out",
          assistantText: "",
          adapterState: {},
          diagnosticLogs: [],
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      const parsed = parseGemini(runResult.stdoutLines);
      if (parsed.parseError !== null) {
        return {
          ok: false,
          errorCode: "E_ADAPTER_PARSE",
          errorMessage: parsed.parseError,
          assistantText: parsed.assistantText,
          adapterState: {},
          diagnosticLogs: parsed.diagnosticLogs,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (runResult.exitCode !== 0) {
        const combined = [...runResult.stdoutLines, ...runResult.stderrLines, ...parsed.diagnosticLogs];
        if (attempt === 1 && hasTransientErrorHint(combined)) {
          continue;
        }

        return {
          ok: false,
          errorCode: "E_CLI_EXIT_NONZERO",
          errorMessage: `gemini exited with code ${runResult.exitCode}`,
          assistantText: parsed.assistantText,
          adapterState: parsed.sessionId ? { session_id: parsed.sessionId } : {},
          diagnosticLogs: parsed.diagnosticLogs,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (!parsed.hasResult) {
        return {
          ok: false,
          errorCode: "E_ADAPTER_MISSING_RESULT",
          errorMessage: "gemini stream-json missing result event",
          assistantText: parsed.assistantText,
          adapterState: parsed.sessionId ? { session_id: parsed.sessionId } : {},
          diagnosticLogs: parsed.diagnosticLogs,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (parsed.resultStatus !== "success") {
        return {
          ok: false,
          errorCode: "E_CLI_EXIT_NONZERO",
          errorMessage: `gemini result status is ${parsed.resultStatus ?? "unknown"}`,
          assistantText: parsed.assistantText,
          adapterState: parsed.sessionId ? { session_id: parsed.sessionId } : {},
          diagnosticLogs: parsed.diagnosticLogs,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      if (!parsed.sessionId) {
        return {
          ok: false,
          errorCode: "E_ADAPTER_SESSION_KEY_MISSING",
          errorMessage: "gemini did not emit session_id",
          assistantText: parsed.assistantText,
          adapterState: {},
          diagnosticLogs: parsed.diagnosticLogs,
          stdoutLines: runResult.stdoutLines,
          stderrLines: runResult.stderrLines
        };
      }

      return {
        ok: true,
        assistantText: parsed.assistantText,
        adapterState: { session_id: parsed.sessionId },
        diagnosticLogs: parsed.diagnosticLogs,
        stdoutLines: runResult.stdoutLines,
        stderrLines: runResult.stderrLines
      };
    }

    return {
      ok: false,
      errorCode: "E_CLI_EXIT_NONZERO",
      errorMessage: "gemini retry exhausted",
      assistantText: "",
      adapterState: {},
      diagnosticLogs: [],
      stdoutLines: [],
      stderrLines: []
    };
  }

  private buildArgs(input: AdapterRunInput): string[] {
    const args = ["-p", input.prompt, "--output-format", "stream-json"];
    if (input.resumeKey) {
      args.push("--resume", input.resumeKey);
    }
    return args;
  }
}
