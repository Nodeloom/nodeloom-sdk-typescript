import type { ResolvedConfig } from "./config.js";
import type { BatchPayload } from "./types.js";

/**
 * Result of a transport send attempt.
 *
 * `body` carries the parsed JSON response on success so the caller can pull
 * out the agent control payload for the kill-switch / require-guardrails
 * machinery without making a second round-trip.
 */
export interface TransportResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  retryable: boolean;
  body?: unknown;
}

/**
 * HTTP transport layer using the native `fetch` API (Node 18+).
 *
 * Handles authentication, serialization, and retry logic with
 * exponential backoff for transient failures.
 */
export class Transport {
  private readonly config: ResolvedConfig;
  private readonly telemetryUrl: string;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.telemetryUrl = `${config.endpoint}/api/sdk/v1/telemetry`;
  }

  /**
   * Sends a batch payload to the telemetry endpoint with retry logic.
   * Returns the {@link TransportResult} so callers can pull the parsed
   * body out (in particular, the agent control payload).
   */
  async send(payload: BatchPayload): Promise<TransportResult> {
    let lastResult: TransportResult | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
      }

      lastResult = await this.attemptSend(payload);

      if (lastResult.success) {
        return lastResult;
      }

      if (!lastResult.retryable) {
        if (!this.config.silent) {
          console.warn(
            `NodeLoom SDK: non-retryable error (status ${lastResult.statusCode}): ${lastResult.error ?? "unknown"}`
          );
        }
        return lastResult;
      }
    }

    if (!this.config.silent) {
      console.warn(
        `NodeLoom SDK: failed after ${this.config.maxRetries + 1} attempts. Last error: ${lastResult?.error ?? "unknown"}`
      );
    }

    return lastResult ?? { success: false, retryable: false, error: "unknown" };
  }

  /**
   * Performs a single HTTP POST to the telemetry endpoint.
   */
  private async attemptSend(payload: BatchPayload): Promise<TransportResult> {
    try {
      const response = await fetch(this.telemetryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "User-Agent": `nodeloom-sdk-typescript/${payload.sdk_version}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });

      if (response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        return { success: true, statusCode: response.status, retryable: false, body };
      }

      const retryable = this.isRetryableStatus(response.status);

      let errorBody: string;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = `HTTP ${response.status}`;
      }

      return {
        success: false,
        statusCode: response.status,
        error: errorBody,
        retryable,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      // Network errors and timeouts are retryable
      return {
        success: false,
        error: message,
        retryable: true,
      };
    }
  }

  /**
   * Determines if an HTTP status code warrants a retry.
   * 429 (rate limited) and 5xx (server errors) are retryable.
   * 4xx client errors (except 429) are not retryable.
   */
  private isRetryableStatus(status: number): boolean {
    if (status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  /**
   * Calculates exponential backoff delay with jitter.
   * Formula: baseDelay * 2^(attempt-1) + random jitter up to 25%.
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay =
      this.config.retryBaseDelayMs * Math.pow(2, attempt - 1);
    const jitter = exponentialDelay * 0.25 * Math.random();
    return Math.min(exponentialDelay + jitter, 30_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
