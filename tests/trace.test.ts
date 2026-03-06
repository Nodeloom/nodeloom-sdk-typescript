import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NodeLoomClient } from "../src/client.js";
import { SpanType } from "../src/types.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Trace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createClient() {
    return new NodeLoomClient({
      apiKey: "sdk_test",
      endpoint: "https://api.nodeloom.io",
      flushIntervalMs: 60_000,
    });
  }

  describe("creation", () => {
    it("should have a unique ID and timestamp", () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      expect(trace.id).toBeTruthy();
      expect(trace.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(trace.agentName).toBe("test-agent");
      expect(trace.timestamp).toBeTruthy();
    });

    it("should emit a trace_start event on creation", async () => {
      const client = createClient();
      client.trace("test-agent", {
        input: { query: "hello" },
        metadata: { user: "test" },
        agentVersion: "2.0.0",
        environment: "staging",
      });

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const event = body.events[0];

      expect(event.type).toBe("trace_start");
      expect(event.agent_name).toBe("test-agent");
      expect(event.input).toEqual({ query: "hello" });
      expect(event.metadata).toEqual({ user: "test" });
      expect(event.agent_version).toBe("2.0.0");
      expect(event.environment).toBe("staging");
      expect(event.timestamp).toBeTruthy();
    });

    it("should use the client-level environment as default", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
        environment: "development",
        flushIntervalMs: 60_000,
      });

      client.trace("test-agent");
      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events[0].environment).toBe("development");
    });
  });

  describe("span creation", () => {
    it("should create a span with the correct trace ID", () => {
      const client = createClient();
      const trace = client.trace("test-agent");
      const span = trace.span("openai-call", SpanType.LLM);

      expect(span.traceId).toBe(trace.id);
      expect(span.name).toBe("openai-call");
      expect(span.spanType).toBe("llm");
      expect(span.parentSpanId).toBeNull();
    });

    it("should create a span with a parent span ID", () => {
      const client = createClient();
      const trace = client.trace("test-agent");
      const parentSpan = trace.span("parent", SpanType.Chain);
      const childSpan = trace.span("child", SpanType.LLM, {
        parentSpanId: parentSpan.id,
      });

      expect(childSpan.parentSpanId).toBe(parentSpan.id);
    });

    it("should create nested spans via span.span()", () => {
      const client = createClient();
      const trace = client.trace("test-agent");
      const parent = trace.span("parent-chain", SpanType.Chain);
      const child = parent.span("child-llm", SpanType.LLM);

      expect(child.parentSpanId).toBe(parent.id);
      expect(child.traceId).toBe(trace.id);
    });

    it("should create spans of each type", () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      expect(trace.span("llm", SpanType.LLM).spanType).toBe("llm");
      expect(trace.span("tool", SpanType.Tool).spanType).toBe("tool");
      expect(trace.span("retrieval", SpanType.Retrieval).spanType).toBe("retrieval");
      expect(trace.span("chain", SpanType.Chain).spanType).toBe("chain");
      expect(trace.span("agent", SpanType.Agent).spanType).toBe("agent");
      expect(trace.span("custom", SpanType.Custom).spanType).toBe("custom");
    });
  });

  describe("span data", () => {
    it("should include input, output, and token usage in the span event", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      const span = trace.span("gpt-4o-call", SpanType.LLM);
      span.setInput({ messages: [{ role: "user", content: "hello" }] });
      span.setOutput({ text: "Hi there!" });
      span.setTokenUsage({
        promptTokens: 150,
        completionTokens: 200,
        model: "gpt-4o",
      });
      span.end();

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // events[0] is trace_start, events[1] is the span
      const spanEvent = body.events[1];

      expect(spanEvent.type).toBe("span");
      expect(spanEvent.trace_id).toBe(trace.id);
      expect(spanEvent.span_id).toBe(span.id);
      expect(spanEvent.name).toBe("gpt-4o-call");
      expect(spanEvent.span_type).toBe("llm");
      expect(spanEvent.status).toBe("success");
      expect(spanEvent.parent_span_id).toBeNull();
      expect(spanEvent.input).toEqual({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(spanEvent.output).toEqual({ text: "Hi there!" });
      expect(spanEvent.token_usage).toEqual({
        prompt_tokens: 150,
        completion_tokens: 200,
        total_tokens: 350,
        model: "gpt-4o",
      });
      expect(spanEvent.timestamp).toBeTruthy();
      expect(spanEvent.end_timestamp).toBeTruthy();
    });

    it("should compute total_tokens automatically if not provided", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");
      const span = trace.span("llm", SpanType.LLM);
      span.setTokenUsage({
        promptTokens: 100,
        completionTokens: 50,
      });
      span.end();

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const spanEvent = body.events[1];
      expect(spanEvent.token_usage.total_tokens).toBe(150);
    });

    it("should use provided total_tokens if given", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");
      const span = trace.span("llm", SpanType.LLM);
      span.setTokenUsage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 200, // Override
      });
      span.end();

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const spanEvent = body.events[1];
      expect(spanEvent.token_usage.total_tokens).toBe(200);
    });
  });

  describe("span error handling", () => {
    it("should set error status and message", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      const span = trace.span("failing-call", SpanType.LLM);
      span.setError("Rate limit exceeded");
      span.end();

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const spanEvent = body.events[1];

      expect(spanEvent.status).toBe("error");
      expect(spanEvent.error).toBe("Rate limit exceeded");
    });

    it("should allow overriding status in end()", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      const span = trace.span("call", SpanType.LLM);
      span.end("error");

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events[1].status).toBe("error");
    });
  });

  describe("span idempotency", () => {
    it("should only emit one event even if end() is called multiple times", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      const span = trace.span("call", SpanType.LLM);
      span.end();
      span.end();
      span.end();

      expect(span.isEnded).toBe(true);
      // 1 trace_start + 1 span = 2
      expect(client.pendingEvents).toBe(2);
    });
  });

  describe("trace end", () => {
    it("should emit a trace_end event with success", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      trace.end("success", {
        output: { response: "completed" },
      });

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // events[0] = trace_start, events[1] = trace_end
      const endEvent = body.events[1];

      expect(endEvent.type).toBe("trace_end");
      expect(endEvent.trace_id).toBe(trace.id);
      expect(endEvent.status).toBe("success");
      expect(endEvent.output).toEqual({ response: "completed" });
      expect(endEvent.timestamp).toBeTruthy();
    });

    it("should emit a trace_end event with error", async () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      trace.end("error", {
        error: "Agent crashed due to invalid input",
      });

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const endEvent = body.events[1];

      expect(endEvent.type).toBe("trace_end");
      expect(endEvent.status).toBe("error");
      expect(endEvent.error).toBe("Agent crashed due to invalid input");
    });

    it("should be idempotent", () => {
      const client = createClient();
      const trace = client.trace("test-agent");

      trace.end("success");
      trace.end("error");
      trace.end("success");

      expect(trace.isEnded).toBe(true);
      // 1 trace_start + 1 trace_end = 2
      expect(client.pendingEvents).toBe(2);
    });
  });

  describe("full trace lifecycle", () => {
    it("should produce correct events for a complete agent run", async () => {
      const client = createClient();
      const trace = client.trace("research-agent", {
        input: { query: "What is NodeLoom?" },
        metadata: { sessionId: "sess-123" },
      });

      // LLM call
      const llmSpan = trace.span("openai-chat", SpanType.LLM);
      llmSpan.setInput({
        messages: [{ role: "user", content: "What is NodeLoom?" }],
      });
      llmSpan.setOutput({ text: "NodeLoom is a workflow platform." });
      llmSpan.setTokenUsage({
        promptTokens: 15,
        completionTokens: 10,
        model: "gpt-4o",
      });
      llmSpan.end();

      // Tool call
      const toolSpan = trace.span("web-search", SpanType.Tool);
      toolSpan.setInput({ query: "NodeLoom features" });
      toolSpan.setOutput({ results: ["feature1", "feature2"] });
      toolSpan.end();

      // End trace
      trace.end("success", {
        output: { answer: "NodeLoom is a workflow automation platform." },
      });

      await client.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(4);
      expect(body.events[0].type).toBe("trace_start");
      expect(body.events[1].type).toBe("span");
      expect(body.events[1].span_type).toBe("llm");
      expect(body.events[2].type).toBe("span");
      expect(body.events[2].span_type).toBe("tool");
      expect(body.events[3].type).toBe("trace_end");

      // All events share the same trace ID
      const traceId = body.events[0].trace_id;
      for (const event of body.events) {
        expect(event.trace_id).toBe(traceId);
      }
    });
  });
});
