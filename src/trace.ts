import type { BatchProcessor } from "./batch-processor.js";
import type { ResolvedConfig } from "./config.js";
import { Span } from "./span.js";
import type {
  SpanOptions,
  SpanType,
  Status,
  TraceEndEvent,
  TraceEndOptions,
  TraceOptions,
  TraceStartEvent,
} from "./types.js";

/**
 * Represents a single execution trace of an AI agent.
 *
 * A trace groups together a sequence of spans (LLM calls, tool invocations,
 * retrieval steps, etc.) into a single logical operation. Each trace has
 * a unique ID and an associated agent name.
 *
 * Usage:
 * ```ts
 * const trace = client.trace("my-agent", { input: { query: "hello" } });
 * const span = trace.span("openai-call", SpanType.LLM);
 * span.setOutput({ text: "Hi there!" });
 * span.end();
 * trace.end("success", { output: { response: "Hi there!" } });
 * ```
 */
export class Trace {
  readonly id: string;
  readonly agentName: string;
  readonly timestamp: string;

  private ended = false;
  private readonly processor: BatchProcessor;

  constructor(
    agentName: string,
    processor: BatchProcessor,
    config: ResolvedConfig,
    options?: TraceOptions
  ) {
    this.id = crypto.randomUUID();
    this.agentName = agentName;
    this.timestamp = new Date().toISOString();
    this.processor = processor;

    // Immediately enqueue the trace_start event
    const startEvent: TraceStartEvent = {
      type: "trace_start",
      trace_id: this.id,
      agent_name: agentName,
      timestamp: this.timestamp,
    };

    if (options?.agentVersion) {
      startEvent.agent_version = options.agentVersion;
    }

    // Use the trace-level environment, falling back to the client-level default
    const environment = options?.environment ?? config.environment;
    if (environment) {
      startEvent.environment = environment;
    }

    if (options?.input) {
      startEvent.input = options.input;
    }

    if (options?.metadata) {
      startEvent.metadata = options.metadata;
    }

    if (options?.sessionId) {
      startEvent.session_id = options.sessionId;
    }

    this.processor.enqueue(startEvent);
  }

  /**
   * Submit feedback for this trace.
   */
  feedback(rating: number, comment?: string): void {
    const event: Record<string, unknown> = {
      type: "feedback",
      trace_id: this.id,
      rating,
      timestamp: new Date().toISOString(),
    };
    if (comment) event.comment = comment;
    this.processor.enqueue(event as any);
  }

  /**
   * Creates a new span within this trace.
   *
   * @param name - Human-readable name for the span (e.g. "openai-chat-completion").
   * @param spanType - The type of work this span represents.
   * @param options - Additional span configuration.
   * @returns A new Span instance. Call `.end()` when the work is complete.
   */
  span(name: string, spanType: SpanType, options?: SpanOptions): Span {
    return new Span(this.id, name, spanType, this.processor, options);
  }

  /**
   * Ends this trace with the given status and optional output/error data.
   *
   * Once ended, the trace is considered immutable. Calling end() again is a no-op.
   *
   * @param status - Whether the trace completed successfully or with an error.
   * @param options - Optional output data or error message.
   */
  end(status: Status, options?: TraceEndOptions): void {
    if (this.ended) {
      return;
    }

    this.ended = true;

    const endEvent: TraceEndEvent = {
      type: "trace_end",
      trace_id: this.id,
      status,
      timestamp: new Date().toISOString(),
    };

    if (options?.output) {
      endEvent.output = options.output;
    }

    if (options?.error) {
      endEvent.error = options.error;
    }

    this.processor.enqueue(endEvent);
  }

  /**
   * Returns true if this trace has been ended.
   */
  get isEnded(): boolean {
    return this.ended;
  }
}
