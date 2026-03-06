/**
 * Span type classification for telemetry spans.
 */
export enum SpanType {
  LLM = "llm",
  Tool = "tool",
  Retrieval = "retrieval",
  Chain = "chain",
  Agent = "agent",
  Custom = "custom",
}

/**
 * Status of a trace or span upon completion.
 */
export type Status = "success" | "error";

/**
 * Log level for standalone events.
 */
export type EventLevel = "info" | "warn" | "error";

/**
 * Token usage information for LLM spans.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  model?: string;
}

/**
 * Serialized token usage in snake_case for the wire format.
 */
export interface TokenUsageWire {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  model?: string;
}

/**
 * A trace_start event sent when a trace begins.
 */
export interface TraceStartEvent {
  type: "trace_start";
  trace_id: string;
  agent_name: string;
  agent_version?: string;
  environment?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * A span event sent when a span completes.
 */
export interface SpanEvent {
  type: "span";
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string;
  status: Status;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  token_usage?: TokenUsageWire;
  timestamp: string;
  end_timestamp: string;
}

/**
 * A trace_end event sent when a trace completes.
 */
export interface TraceEndEvent {
  type: "trace_end";
  trace_id: string;
  status: Status;
  output?: Record<string, unknown>;
  error?: string;
  timestamp: string;
}

/**
 * A standalone event (e.g. guardrail triggers, custom instrumentation points).
 */
export interface StandaloneEvent {
  type: "event";
  trace_id: string | null;
  name: string;
  level: EventLevel;
  data?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Union of all telemetry event types.
 */
export type TelemetryEvent =
  | TraceStartEvent
  | SpanEvent
  | TraceEndEvent
  | StandaloneEvent;

/**
 * Batch payload sent to the telemetry endpoint.
 */
export interface BatchPayload {
  events: TelemetryEvent[];
  sdk_version: string;
  sdk_language: "typescript";
}

/**
 * Options passed when creating a trace.
 */
export interface TraceOptions {
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  agentVersion?: string;
  environment?: string;
}

/**
 * Options passed when ending a trace.
 */
export interface TraceEndOptions {
  output?: Record<string, unknown>;
  error?: string;
}

/**
 * Options passed when creating a span.
 */
export interface SpanOptions {
  parentSpanId?: string;
  input?: Record<string, unknown>;
}
