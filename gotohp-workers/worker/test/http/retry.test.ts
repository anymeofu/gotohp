import { describe, expect, it } from "vitest";
import { calculateBackoff, defaultRetryConfig, shouldRetry } from "../../src/http/retry";

describe("retry", () => {
  it("defaults match the Go RetryConfig", () => {
    const c = defaultRetryConfig();
    expect(c.maxRetries).toBe(3);
    expect(c.initialDelayMs).toBe(1000);
    expect(c.maxDelayMs).toBe(30000);
  });

  it("doubles the delay each attempt, capped at maxDelay, plus up to 10% jitter", () => {
    const config = defaultRetryConfig();
    for (let attempt = 0; attempt < 6; attempt++) {
      const base = Math.min(config.initialDelayMs * 2 ** attempt, config.maxDelayMs);
      const delay = calculateBackoff(attempt, config);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.1 + 1e-6);
    }
  });

  it("flags 5xx and 429 as retryable, 2xx/4xx (other) and undefined status appropriately", () => {
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(429)).toBe(true);
    expect(shouldRetry(200)).toBe(false);
    expect(shouldRetry(400)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
    expect(shouldRetry(undefined)).toBe(true); // network error, no response
  });
});
