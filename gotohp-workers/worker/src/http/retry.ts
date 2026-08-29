// Port of backend/httpclient.go's RetryConfig / CalculateBackoff / ShouldRetry.

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export function defaultRetryConfig(): RetryConfig {
  return {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  };
}

/** Exponential backoff with up to 10% jitter, mirroring Go's CalculateBackoff. */
export function calculateBackoff(attempt: number, config: RetryConfig): number {
  let delay = config.initialDelayMs * Math.pow(2, attempt);
  if (delay > config.maxDelayMs) {
    delay = config.maxDelayMs;
  }
  const jitter = Math.random() * (delay / 10);
  return delay + jitter;
}

/** Retry on 5xx and 429, or when no response was received (network error). */
export function shouldRetry(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status >= 500 || status === 429;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
