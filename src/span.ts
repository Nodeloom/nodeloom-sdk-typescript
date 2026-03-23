import type { BatchProcessor } from "./batch-processor.js";
import type {
  SpanEvent,
  SpanOptions,
  SpanType,
  Status,
  TokenUsage,
  TokenUsageWire,
} from "./types.js";

/**
 * Represents a single unit of work within a trace (e.g. an LLM call,
 * a tool invocation, or a retrieval step).
 *
 * Spans are created via `Trace.span()` and must be ended with `.end()`.
 * Failing to call `.end()` means the span will never be reported.
 *
 * Spans support nesting: a child span can reference its parent
 * via `parentSpanId`.
 */
export class Span {
  readonly id: string;
  readonly traceId: string;
  readonly name: string;
  readonly spanType: SpanType;
  readonly parentSpanId: string | null;
  readonly timestamp: string;

  private inputData?: Record<string, unknown>;
  private outputData?: Record<string, unknown>;
  private tokenUsageData?: TokenUsage;
  private errorMessage?: string;
  private promptTemplate?: string;
  private promptVersionNum?: number;
  private status: Status = "success";
  private ended = false;

  private readonly processor: BatchProcessor;

  constructor(
    traceId: string,
    name: string,
    spanType: SpanType,
    processor: BatchProcessor,
    options?: SpanOptions
  ) {
    this.id = crypto.randomUUID();
    this.traceId = traceId;
    this.name = name;
    this.spanType = spanType;
    this.parentSpanId = options?.parentSpanId ?? null;
    this.timestamp = new Date().toISOString();
    this.processor = processor;

    if (options?.input) {
      this.inputData = options.input;
    }
  }

  /**
   * Sets the input data for this span. Can be called multiple times;
   * the last value wins.
   */
  setInput(input: Record<string, unknown>): this {
    this.inputData = input;
    return this;
  }

  /**
   * Sets the output data for this span.
   */
  setOutput(output: Record<string, unknown>): this {
    this.outputData = output;
    return this;
  }

  /**
   * Records token usage information (typically for LLM spans).
   */
  setTokenUsage(usage: TokenUsage): this {
    this.tokenUsageData = usage;
    return this;
  }

  /**
   * Marks this span as errored with an error message.
   * The status is automatically set to "error".
   */
  setError(error: string): this {
    this.errorMessage = error;
    this.status = "error";
    return this;
  }

  /**
   * Marks this span as having the given status.
   */
  setStatus(status: Status): this {
    this.status = status;
    return this;
  }

  /**
   * Record which prompt template and version was used.
   */
  setPrompt(template: string, version: number): this {
    this.promptTemplate = template;
    this.promptVersionNum = version;
    return this;
  }

  /**
   * Emit a custom metric tied to this span's trace.
   */
  metric(name: string, value: number, unit?: string, tags?: Record<string, string>): this {
    const event: Record<string, unknown> = {
      type: "metric",
      trace_id: this.traceId,
      metric_name: name,
      metric_value: value,
      timestamp: new Date().toISOString(),
    };
    if (unit) event.metric_unit = unit;
    if (tags) event.metric_tags = tags;
    this.processor.enqueue(event as any);
    return this;
  }

  /**
   * Creates a child span nested under this span.
   * The child's `parentSpanId` will be set to this span's id.
   */
  span(name: string, spanType: SpanType, options?: Omit<SpanOptions, "parentSpanId">): Span {
    return new Span(this.traceId, name, spanType, this.processor, {
      ...options,
      parentSpanId: this.id,
    });
  }

  /**
   * Ends this span and enqueues its event for sending.
   *
   * Once ended, the span is immutable. Calling end() again is a no-op.
   *
   * @param status - Override the span status. Defaults to the status set via setStatus/setError, or "success".
   */
  end(status?: Status): void {
    if (this.ended) {
      return;
    }

    this.ended = true;

    if (status) {
      this.status = status;
    }

    const event: SpanEvent = {
      type: "span",
      trace_id: this.traceId,
      span_id: this.id,
      parent_span_id: this.parentSpanId,
      name: this.name,
      span_type: this.spanType,
      status: this.status,
      timestamp: this.timestamp,
      end_timestamp: new Date().toISOString(),
    };

    if (this.inputData) {
      event.input = this.inputData;
    }

    if (this.outputData) {
      event.output = this.outputData;
    }

    if (this.errorMessage) {
      event.error = this.errorMessage;
    }

    if (this.tokenUsageData) {
      event.token_usage = this.serializeTokenUsage(this.tokenUsageData);
    }

    if (this.promptTemplate) {
      event.prompt_template = this.promptTemplate;
    }

    if (this.promptVersionNum !== undefined) {
      event.prompt_version = this.promptVersionNum;
    }

    this.processor.enqueue(event);
  }

  /**
   * Returns true if this span has been ended.
   */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Converts the SDK-facing TokenUsage (camelCase) to the wire format (snake_case).
   */
  private serializeTokenUsage(usage: TokenUsage): TokenUsageWire {
    const wire: TokenUsageWire = {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens:
        usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
    };

    if (usage.model) {
      wire.model = usage.model;
    }

    return wire;
  }
}
