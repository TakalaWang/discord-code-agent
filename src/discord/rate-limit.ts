function readRetryAfterSeconds(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const raw = error as Record<string, unknown>;

  if (raw.status !== 429) {
    return null;
  }

  const retryAfter = raw.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }

  const data = raw.data;
  if (typeof data === "object" && data !== null) {
    const retry = (data as Record<string, unknown>).retry_after;
    if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) {
      return retry;
    }
  }

  return null;
}

export async function withDiscordRateLimitRetry<T>(
  operation: () => Promise<T>,
  options?: { maxRetries?: number }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryAfter = readRetryAfterSeconds(error);
      if (retryAfter === null || attempt === maxRetries) {
        throw error;
      }

      const jitterMs = Math.floor(Math.random() * 80);
      const waitMs = Math.ceil(retryAfter * 1000) + jitterMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw new Error("unreachable");
}
