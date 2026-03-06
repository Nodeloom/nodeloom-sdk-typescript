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
  private isShutdown = false;

  constructor(config: NodeLoomConfig) {
    this.config = resolveConfig(config);
    this.processor = new BatchProcessor(this.config);

    if (!this.config.disabled) {
      this.processor.start();
    }
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

    return new Trace(agentName, this.processor, this.config, options);
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
