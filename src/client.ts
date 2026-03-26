import { createRequire } from "node:module";
import { ApiClient } from "./api.js";
import { BatchProcessor } from "./batch-processor.js";
import { type NodeLoomConfig, resolveConfig, type ResolvedConfig } from "./config.js";
import { Trace } from "./trace.js";
import type {
  EventLevel,
  StandaloneEvent,
  TraceOptions,
} from "./types.js";

/**
 * The main entry point for the NodeLoom SDK.
 *
 * Creates a client that manages telemetry collection, batching,
 * and delivery to the NodeLoom monitoring platform.
 *
 * Usage:
 * ```ts
 * const client = new NodeLoomClient({
 *   apiKey: "sdk_...",
 *   endpoint: "https://api.nodeloom.io",
 * });
 *
 * const trace = client.trace("my-agent", { input: { query: "hello" } });
 * // ... instrument your agent ...
 * trace.end("success", { output: { result: "world" } });
 *
 * // Before process exit:
 * await client.shutdown();
 * ```
 */
export class NodeLoomClient {
  private readonly config: ResolvedConfig;
  private readonly processor: BatchProcessor;
  private _api: ApiClient | null = null;
  private isShutdown = false;
  private readonly detectedFramework: { name: string; version: string | undefined } | null;

  constructor(config: NodeLoomConfig) {
    this.config = resolveConfig(config);
    this.processor = new BatchProcessor(this.config);
    this.detectedFramework = NodeLoomClient.detectFramework();

    if (!this.config.disabled) {
      this.processor.start();
    }
  }

  private static detectFramework(): { name: string; version: string | undefined } {
    let req: NodeRequire;
    try {
      req = createRequire(import.meta.url);
    } catch {
      return { name: "custom", version: undefined };
    }

    const frameworks = [
      { pkg: "langchain", name: "langchain" },
      { pkg: "@langchain/core", name: "langchain" },
      { pkg: "crewai", name: "crewai" },
      { pkg: "autogen", name: "autogen" },
    ];
    for (const fw of frameworks) {
      try {
        const mod = req(fw.pkg);
        return { name: fw.name, version: mod?.VERSION ?? mod?.version };
      } catch {
        // Not installed
      }
    }
    return { name: "custom", version: undefined };
  }

  /**
   * Access the REST API client.
   * Uses the same API key and endpoint as the telemetry client.
   */
  get api(): ApiClient {
    if (!this._api) {
      this._api = new ApiClient(this.config.apiKey, this.config.endpoint);
    }
    return this._api;
  }

  /**
   * Starts a new trace for the given agent.
   *
   * A trace represents a single execution of an AI agent and groups
   * together all the spans (LLM calls, tool invocations, etc.)
   * that occur during that execution.
   *
   * @param agentName - Identifier for the agent being traced.
   * @param options - Optional trace configuration (input, metadata, environment, etc.).
   * @returns A new Trace instance. Call `.end()` when the agent run completes.
   */
  trace(agentName: string, options?: TraceOptions): Trace {
    if (this.isShutdown) {
      throw new Error(
        "NodeLoom SDK: cannot create a trace after shutdown"
      );
    }

    return new Trace(agentName, this.processor, this.config, options, this.detectedFramework);
  }

  /**
   * Sends a standalone event (not tied to a specific span).
   *
   * Useful for logging guardrail triggers, custom checkpoints,
   * or any instrumentation point that does not map to a span.
   *
   * @param name - Event name (e.g. "guardrail_triggered").
   * @param level - Severity level.
   * @param data - Arbitrary event data.
   * @param traceId - Optional trace ID to associate the event with.
   */
  event(
    name: string,
    level: EventLevel = "info",
    data?: Record<string, unknown>,
    traceId?: string
  ): void {
    if (this.isShutdown || this.config.disabled) {
      return;
    }

    const event: StandaloneEvent = {
      type: "event",
      trace_id: traceId ?? null,
      name,
      level,
      timestamp: new Date().toISOString(),
    };

    if (data) {
      event.data = data;
    }

    this.processor.enqueue(event);
  }

  /**
   * Emit a custom metric event.
   */
  metric(
    name: string,
    value: number,
    options?: { unit?: string; tags?: Record<string, string>; traceId?: string }
  ): void {
    if (this.isShutdown || this.config.disabled) return;
    const event: Record<string, unknown> = {
      type: "metric",
      trace_id: options?.traceId ?? null,
      metric_name: name,
      metric_value: value,
      timestamp: new Date().toISOString(),
    };
    if (options?.unit) event.metric_unit = options.unit;
    if (options?.tags) event.metric_tags = options.tags;
    this.processor.enqueue(event as any);
  }

  /**
   * Emit a feedback event tied to a trace.
   */
  feedback(traceId: string, rating: number, comment?: string): void {
    if (this.isShutdown || this.config.disabled) return;
    const event: Record<string, unknown> = {
      type: "feedback",
      trace_id: traceId,
      rating,
      timestamp: new Date().toISOString(),
    };
    if (comment) event.comment = comment;
    this.processor.enqueue(event as any);
  }

  /**
   * Forces an immediate flush of all pending events.
   *
   * Normally the SDK flushes automatically on a timer and when
   * batch thresholds are reached. Call this if you need to guarantee
   * delivery before a specific point (e.g. before returning an HTTP response).
   */
  async flush(): Promise<void> {
    await this.processor.flush();
  }

  /**
   * Gracefully shuts down the client, flushing all pending events.
   *
   * After calling shutdown, no new traces or events can be created.
   * This should be called before process exit to avoid losing telemetry.
   *
   * This method is idempotent and safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    await this.processor.shutdown();
  }

  /**
   * Returns the number of events currently queued and waiting to be sent.
   */
  get pendingEvents(): number {
    return this.processor.pendingCount;
  }

  /**
   * Returns the total number of events that were dropped due to
   * queue capacity limits.
   */
  get droppedEvents(): number {
    return this.processor.droppedCount;
  }

  /**
   * Returns true if the client has been shut down.
   */
  get hasShutdown(): boolean {
    return this.isShutdown;
  }
}
