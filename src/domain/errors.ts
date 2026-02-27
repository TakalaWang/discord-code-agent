export const ERROR_CODES = [
  "E_OWNER_ONLY",
  "E_NOT_IN_MANAGED_THREAD",
  "E_PROJECT_NOT_FOUND",
  "E_PROJECT_EXISTS",
  "E_INVALID_PATH",
  "E_INVALID_TOOLSET",
  "E_TOOL_NOT_ENABLED",
  "E_SESSION_NOT_FOUND",
  "E_THREAD_ACCESS_FAILED",
  "E_QUEUE_FULL",
  "E_JOB_NOT_RETRYABLE",
  "E_CLI_TIMEOUT",
  "E_CLI_EXIT_NONZERO",
  "E_ADAPTER_PARSE",
  "E_ADAPTER_MISSING_RESULT",
  "E_ADAPTER_SESSION_KEY_MISSING",
  "E_DISCORD_RATE_LIMIT"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DomainError";
  }
}
