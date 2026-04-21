/**
 * @nodeloom/sdk - NodeLoom TypeScript SDK
 *
 * Instrument external AI agents and send telemetry to NodeLoom's
 * monitoring pipeline.
 *
 * @example
 * ```ts
 * import { NodeLoomClient, SpanType } from "@nodeloom/sdk";
 *
 * const client = new NodeLoomClient({
 *   apiKey: "sdk_...",
 *   endpoint: "https://api.nodeloom.io",
 * });
 *
 * const trace = client.trace("my-agent", {
 *   input: { query: "What is NodeLoom?" },
 * });
 *
 * const span = trace.span("openai-call", SpanType.LLM);
 * span.setInput({ messages: [{ role: "user", content: "What is NodeLoom?" }] });
 * span.setOutput({ text: "NodeLoom is a workflow automation platform." });
 * span.setTokenUsage({ promptTokens: 15, completionTokens: 20, model: "gpt-4o" });
 * span.end();
 *
 * trace.end("success", {
 *   output: { response: "NodeLoom is a workflow automation platform." },
 * });
 *
 * await client.shutdown();
 * ```
 *
 * @packageDocumentation
 */

// Core client
export { NodeLoomClient } from "./client.js";

// API client
export { ApiClient, ApiError } from "./api.js";
export type { ApiRequestOptions } from "./api.js";

// Remote control (kill switch + required guardrails)
export {
  AgentHaltedError,
  ControlRegistry,
  type AgentControlPayload,
  type AgentControlState,
} from "./control.js";

// Trace and span
export { Trace } from "./trace.js";
export { Span } from "./span.js";

// Configuration
export { type NodeLoomConfig, SDK_VERSION } from "./config.js";

// Types
export {
  SpanType,
  type Status,
  type EventLevel,
  type TokenUsage,
  type TraceOptions,
  type TraceEndOptions,
  type SpanOptions,
  type TelemetryEvent,
  type TraceStartEvent,
  type SpanEvent,
  type TraceEndEvent,
  type StandaloneEvent,
  type BatchPayload,
} from "./types.js";
