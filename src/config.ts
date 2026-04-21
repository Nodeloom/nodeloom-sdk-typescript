/**
 * SDK version string, kept in sync with package.json.
 */
export const SDK_VERSION = "0.10.0";

/**
 * Language identifier included in every batch payload.
 */
export const SDK_LANGUAGE = "typescript" as const;

/**
 * Configuration for the NodeLoom SDK client.
 */
export interface NodeLoomConfig {
  /** API key for authentication (prefix: "sdk_"). */
  apiKey: string;

  /** Base URL of the NodeLoom telemetry endpoint. */
  endpoint?: string;

  /** Maximum number of events buffered before a forced flush. */
  maxBatchSize?: number;

  /** Interval in milliseconds between automatic flushes. */
  flushIntervalMs?: number;

  /** Maximum number of events the internal queue will hold. Older events are dropped when exceeded. */
  maxQueueSize?: number;

  /** Maximum number of retry attempts for failed HTTP requests. */
  maxRetries?: number;

  /** Base delay in milliseconds for exponential backoff between retries. */
  retryBaseDelayMs?: number;

  /** Default environment label attached to all traces (e.g. "production", "staging"). */
  environment?: string;

  /** If true, suppresses all internal warning/error logs. */
  silent?: boolean;

  /** If true, the SDK is disabled and no events are sent. Useful for local dev. */
  disabled?: boolean;

  /**
   * Interval in milliseconds between standalone control polls. Telemetry batch
   * responses already piggy-back the control payload, so polling is mainly
   * useful for sparse-traffic agents. Set to 0 to disable.
   */
  controlPollIntervalMs?: number;

  /**
   * Per-request HTTP timeout in milliseconds. Applies to both telemetry
   * batches and control/guardrail calls. Lower values fail fast when the
   * backend is unreachable; higher values tolerate slow networks.
   */
  requestTimeoutMs?: number;
}

/**
 * Resolved configuration with all defaults applied.
 */
export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  environment: string;
  silent: boolean;
  disabled: boolean;
  controlPollIntervalMs: number;
  requestTimeoutMs: number;
}

const DEFAULT_ENDPOINT = "https://api.nodeloom.io";
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_ENVIRONMENT = "production";
const DEFAULT_CONTROL_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Merges user-provided configuration with defaults to produce a fully resolved config.
 */
export function resolveConfig(config: NodeLoomConfig): ResolvedConfig {
  if (!config.apiKey) {
    throw new Error("NodeLoom SDK: apiKey is required");
  }

  const endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");

  if (endpoint && !endpoint.startsWith("https://") && !endpoint.includes("localhost") && !endpoint.includes("127.0.0.1")) {
    console.warn(`[nodeloom] WARNING: Endpoint '${endpoint}' does not use HTTPS. API keys will be sent in plaintext.`);
  }

  return {
    apiKey: config.apiKey,
    endpoint,
    maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelayMs: config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    environment: config.environment ?? DEFAULT_ENVIRONMENT,
    silent: config.silent ?? false,
    disabled: config.disabled ?? false,
    controlPollIntervalMs: config.controlPollIntervalMs ?? DEFAULT_CONTROL_POLL_INTERVAL_MS,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}
