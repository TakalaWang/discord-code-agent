import type { ErrorCode } from "../domain/errors.js";
import type { ToolName } from "../state/replay.js";

export interface AdapterRunInput {
  prompt: string;
  cwd: string;
  timeoutSec: number;
  resumeKey?: string;
}

export interface AdapterRunSuccess {
  ok: true;
  assistantText: string;
  adapterState: Record<string, unknown>;
  diagnosticLogs: string[];
  stdoutLines: string[];
  stderrLines: string[];
}

export interface AdapterRunFailure {
  ok: false;
  errorCode: ErrorCode;
  errorMessage: string;
  assistantText: string;
  adapterState: Record<string, unknown>;
  diagnosticLogs: string[];
  stdoutLines: string[];
  stderrLines: string[];
}

export type AdapterRunResult = AdapterRunSuccess | AdapterRunFailure;

export interface ToolAdapter {
  run(input: AdapterRunInput): Promise<AdapterRunResult>;
}

export interface AdapterRegistry {
  get(tool: ToolName): ToolAdapter;
}
