import { describe, expect, it } from "vitest";
import { withDiscordRateLimitRetry } from "../../src/discord/rate-limit.js";

describe("withDiscordRateLimitRetry", () => {
  it("retries on 429 and eventually succeeds", async () => {
    let calls = 0;

    const result = await withDiscordRateLimitRetry(async () => {
      calls += 1;
      if (calls < 3) {
        throw {
          status: 429,
          retry_after: 0.001
        };
      }

      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});
