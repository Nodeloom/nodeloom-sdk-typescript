import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NodeLoomClient } from "../src/client.js";
import { Trace } from "../src/trace.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("NodeLoomClient", () => {
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

  describe("constructor", () => {
    it("should create a client with valid config", () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test_key",
        endpoint: "https://api.nodeloom.io",
      });

      expect(client).toBeInstanceOf(NodeLoomClient);
      expect(client.hasShutdown).toBe(false);
      expect(client.pendingEvents).toBe(0);
      expect(client.droppedEvents).toBe(0);
    });

    it("should throw if apiKey is missing", () => {
      expect(() => {
        new NodeLoomClient({ apiKey: "" });
      }).toThrow("apiKey is required");
    });

    it("should create a client with minimal config (only apiKey)", () => {
      const client = new NodeLoomClient({ apiKey: "sdk_minimal" });
      expect(client).toBeInstanceOf(NodeLoomClient);
    });

    it("should not start the processor when disabled", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        disabled: true,
      });

      client.event("test_event");
      expect(client.pendingEvents).toBe(0);

      await client.shutdown();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("trace", () => {
    it("should create a new Trace instance", () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
      });

      const trace = client.trace("my-agent");
      expect(trace).toBeInstanceOf(Trace);
      expect(trace.agentName).toBe("my-agent");
      expect(trace.id).toBeTruthy();

      // The trace_start event should be enqueued
      expect(client.pendingEvents).toBe(1);
    });

    it("should create a trace with options", () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
      });

      const trace = client.trace("my-agent", {
        input: { query: "hello" },
        metadata: { userId: "user-1" },
        agentVersion: "1.0.0",
        environment: "staging",
      });

      expect(trace).toBeInstanceOf(Trace);
      expect(client.pendingEvents).toBe(1);
    });

    it("should throw when creating a trace after shutdown", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
      });

      await client.shutdown();

      expect(() => {
        client.trace("my-agent");
      }).toThrow("cannot create a trace after shutdown");
    });
  });

  describe("event", () => {
    it("should enqueue a standalone event", () => {
      const client = new NodeLoomClient({ apiKey: "sdk_test" });

      client.event("guardrail_triggered", "warn", { rule: "no-pii" });
      expect(client.pendingEvents).toBe(1);
    });

    it("should enqueue an event with a trace ID", () => {
      const client = new NodeLoomClient({ apiKey: "sdk_test" });

      const trace = client.trace("my-agent");
      client.event("custom_checkpoint", "info", { step: 3 }, trace.id);

      // 1 trace_start + 1 event = 2
      expect(client.pendingEvents).toBe(2);
    });

    it("should not enqueue events after shutdown", async () => {
      const client = new NodeLoomClient({ apiKey: "sdk_test" });
      await client.shutdown();

      client.event("test_event");
      expect(client.pendingEvents).toBe(0);
    });

    it("should not enqueue events when disabled", () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        disabled: true,
      });

      client.event("test_event");
      expect(client.pendingEvents).toBe(0);
    });
  });

  describe("flush", () => {
    it("should flush pending events", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
      });

      client.trace("my-agent");
      expect(client.pendingEvents).toBe(1);

      await client.flush();
      expect(client.pendingEvents).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the request details
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.nodeloom.io/api/sdk/v1/telemetry");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["Authorization"]).toBe("Bearer sdk_test");

      const body = JSON.parse(init.body);
      expect(body.sdk_version).toBe("0.10.0");
      expect(body.sdk_language).toBe("typescript");
      expect(body.events).toHaveLength(1);
      expect(body.events[0].type).toBe("trace_start");
    });
  });

  describe("shutdown", () => {
    it("should flush remaining events and mark as shutdown", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
      });

      client.trace("agent-1");
      client.trace("agent-2");
      expect(client.pendingEvents).toBe(2);

      await client.shutdown();

      expect(client.hasShutdown).toBe(true);
      expect(client.pendingEvents).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
      });

      await client.shutdown();
      await client.shutdown();
      await client.shutdown();

      expect(client.hasShutdown).toBe(true);
    });
  });

  describe("automatic flush on batch threshold", () => {
    it("should trigger a flush when maxBatchSize is reached", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
        maxBatchSize: 3,
        flushIntervalMs: 60_000, // Long interval so only threshold triggers flush
      });

      // Create 3 traces (each enqueues 1 trace_start event)
      client.trace("agent-1");
      client.trace("agent-2");
      client.trace("agent-3");

      // Allow the flush microtask to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      await client.shutdown();
    });
  });

  describe("periodic flush via timer", () => {
    it("should flush on the configured interval", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io",
        flushIntervalMs: 1_000,
      });

      client.trace("agent-1");

      // Advance the timer past the flush interval
      await vi.advanceTimersByTimeAsync(1_100);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      await client.shutdown();
    });
  });

  describe("endpoint normalization", () => {
    it("should strip trailing slashes from the endpoint", async () => {
      const client = new NodeLoomClient({
        apiKey: "sdk_test",
        endpoint: "https://api.nodeloom.io///",
      });

      client.trace("agent-1");
      await client.flush();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.nodeloom.io/api/sdk/v1/telemetry");

      await client.shutdown();
    });
  });
});
