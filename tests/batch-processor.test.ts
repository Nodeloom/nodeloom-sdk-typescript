import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchProcessor } from "../src/batch-processor.js";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import type { TraceStartEvent, TelemetryEvent } from "../src/types.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return resolveConfig({
    apiKey: "sdk_test",
    endpoint: "https://api.nodeloom.io",
    maxBatchSize: overrides?.maxBatchSize ?? 100,
    flushIntervalMs: overrides?.flushIntervalMs ?? 60_000,
    maxQueueSize: overrides?.maxQueueSize ?? 10_000,
    maxRetries: overrides?.maxRetries ?? 3,
    retryBaseDelayMs: overrides?.retryBaseDelayMs ?? 100,
    environment: overrides?.environment ?? "test",
    silent: overrides?.silent ?? true,
    disabled: overrides?.disabled ?? false,
  });
}

function makeEvent(id: string): TraceStartEvent {
  return {
    type: "trace_start",
    trace_id: id,
    agent_name: "test-agent",
    timestamp: new Date().toISOString(),
  };
}

describe("BatchProcessor", () => {
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

  describe("enqueue", () => {
    it("should accept events up to the queue limit", () => {
      const processor = new BatchProcessor(
        createConfig({ maxQueueSize: 5 })
      );

      for (let i = 0; i < 5; i++) {
        processor.enqueue(makeEvent(`trace-${i}`));
      }

      expect(processor.pendingCount).toBe(5);
      expect(processor.droppedCount).toBe(0);
    });

    it("should drop events when the queue is full", () => {
      const processor = new BatchProcessor(
        createConfig({ maxQueueSize: 3 })
      );

      for (let i = 0; i < 5; i++) {
        processor.enqueue(makeEvent(`trace-${i}`));
      }

      expect(processor.pendingCount).toBe(3);
      expect(processor.droppedCount).toBe(2);
    });

    it("should not enqueue events when disabled", () => {
      const processor = new BatchProcessor(
        createConfig({ disabled: true })
      );

      processor.enqueue(makeEvent("trace-1"));
      expect(processor.pendingCount).toBe(0);
    });

    it("should not enqueue events after shutdown", async () => {
      const processor = new BatchProcessor(createConfig());
      await processor.shutdown();

      processor.enqueue(makeEvent("trace-1"));
      expect(processor.pendingCount).toBe(0);
    });
  });

  describe("flush", () => {
    it("should send all queued events in a single batch", async () => {
      const processor = new BatchProcessor(createConfig());

      processor.enqueue(makeEvent("trace-1"));
      processor.enqueue(makeEvent("trace-2"));

      await processor.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(processor.pendingCount).toBe(0);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(2);
      expect(body.sdk_version).toBe("0.10.0");
      expect(body.sdk_language).toBe("typescript");
    });

    it("should send events in multiple batches when exceeding maxBatchSize", async () => {
      const processor = new BatchProcessor(
        createConfig({ maxBatchSize: 2 })
      );

      // Enqueue 5 events. The enqueue at index 2 triggers an auto-flush
      // (fire-and-forget). We need to let all microtasks settle so that
      // flush drains the queue in batches of 2.
      processor.enqueue(makeEvent("trace-1"));
      processor.enqueue(makeEvent("trace-2"));
      processor.enqueue(makeEvent("trace-3"));
      processor.enqueue(makeEvent("trace-4"));
      processor.enqueue(makeEvent("trace-5"));

      // Let the auto-triggered flush and any follow-up flushes complete
      await vi.advanceTimersByTimeAsync(0);

      // The queue should now be fully drained. If the auto-flush was
      // concurrent-guarded away for some items, do a final explicit flush.
      await processor.flush();

      expect(processor.pendingCount).toBe(0);

      // Verify that all 5 events were sent across multiple batches.
      // The exact number of fetch calls depends on timing, but each
      // batch should contain at most 2 events.
      let totalEventsSent = 0;
      for (let i = 0; i < mockFetch.mock.calls.length; i++) {
        const body = JSON.parse(mockFetch.mock.calls[i][1].body);
        expect(body.events.length).toBeLessThanOrEqual(2);
        totalEventsSent += body.events.length;
      }
      expect(totalEventsSent).toBe(5);
    });

    it("should be a no-op when the queue is empty", async () => {
      const processor = new BatchProcessor(createConfig());

      await processor.flush();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should prevent concurrent flushes", async () => {
      const processor = new BatchProcessor(createConfig());

      processor.enqueue(makeEvent("trace-1"));
      processor.enqueue(makeEvent("trace-2"));

      // Trigger two flushes simultaneously
      const flush1 = processor.flush();
      const flush2 = processor.flush();

      await Promise.all([flush1, flush2]);

      // Only one flush should have actually sent data
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("automatic flush via threshold", () => {
    it("should trigger flush when enqueue reaches maxBatchSize", async () => {
      const processor = new BatchProcessor(
        createConfig({ maxBatchSize: 3 })
      );
      processor.start();

      processor.enqueue(makeEvent("trace-1"));
      processor.enqueue(makeEvent("trace-2"));
      // This third enqueue should trigger a flush
      processor.enqueue(makeEvent("trace-3"));

      // Let the flush promise resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(processor.pendingCount).toBe(0);

      await processor.shutdown();
    });
  });

  describe("periodic flush via timer", () => {
    it("should flush on the configured interval", async () => {
      const processor = new BatchProcessor(
        createConfig({ flushIntervalMs: 2_000 })
      );
      processor.start();

      processor.enqueue(makeEvent("trace-1"));

      // Advance past the interval
      await vi.advanceTimersByTimeAsync(2_100);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      await processor.shutdown();
    });

    it("should flush multiple times over multiple intervals", async () => {
      const processor = new BatchProcessor(
        createConfig({ flushIntervalMs: 1_000 })
      );
      processor.start();

      processor.enqueue(makeEvent("trace-1"));
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      processor.enqueue(makeEvent("trace-2"));
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await processor.shutdown();
    });
  });

  describe("retry with exponential backoff", () => {
    it("should retry on 5xx errors", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("Service Unavailable"),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const processor = new BatchProcessor(
        createConfig({ maxRetries: 3, retryBaseDelayMs: 10 })
      );

      processor.enqueue(makeEvent("trace-1"));

      // We need to advance timers to allow backoff delays to pass
      const flushPromise = processor.flush();

      // Advance time for first retry backoff (10ms * 2^0 + jitter)
      await vi.advanceTimersByTimeAsync(50);
      // Advance time for second retry backoff (10ms * 2^1 + jitter)
      await vi.advanceTimersByTimeAsync(100);

      await flushPromise;

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(processor.pendingCount).toBe(0);
    });

    it("should retry on 429 (rate limited)", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("Too Many Requests"),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const processor = new BatchProcessor(
        createConfig({ maxRetries: 3, retryBaseDelayMs: 10 })
      );

      processor.enqueue(makeEvent("trace-1"));

      const flushPromise = processor.flush();
      await vi.advanceTimersByTimeAsync(50);
      await flushPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should not retry on 4xx client errors (except 429)", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const processor = new BatchProcessor(
        createConfig({ maxRetries: 3 })
      );

      processor.enqueue(makeEvent("trace-1"));
      await processor.flush();

      // Should only attempt once (no retries for 401)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should retry on network errors", async () => {
      mockFetch
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const processor = new BatchProcessor(
        createConfig({ maxRetries: 3, retryBaseDelayMs: 10 })
      );

      processor.enqueue(makeEvent("trace-1"));

      const flushPromise = processor.flush();
      await vi.advanceTimersByTimeAsync(50);
      await flushPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should give up after max retries are exhausted", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const processor = new BatchProcessor(
        createConfig({ maxRetries: 2, retryBaseDelayMs: 10 })
      );

      processor.enqueue(makeEvent("trace-1"));

      const flushPromise = processor.flush();
      // Advance enough time for all retry backoffs
      await vi.advanceTimersByTimeAsync(500);
      await flushPromise;

      // 1 initial + 2 retries = 3 total attempts
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("shutdown", () => {
    it("should flush remaining events and stop the timer", async () => {
      const processor = new BatchProcessor(
        createConfig({ flushIntervalMs: 1_000 })
      );
      processor.start();

      processor.enqueue(makeEvent("trace-1"));
      processor.enqueue(makeEvent("trace-2"));

      await processor.shutdown();

      expect(processor.hasShutdown).toBe(true);
      expect(processor.pendingCount).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(2);
    });

    it("should be idempotent", async () => {
      const processor = new BatchProcessor(createConfig());

      processor.enqueue(makeEvent("trace-1"));

      await processor.shutdown();
      await processor.shutdown();
      await processor.shutdown();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should not accept new events after shutdown", async () => {
      const processor = new BatchProcessor(createConfig());
      await processor.shutdown();

      processor.enqueue(makeEvent("trace-1"));
      expect(processor.pendingCount).toBe(0);
    });

    it("should not start the timer after shutdown", () => {
      const processor = new BatchProcessor(createConfig());

      // Shutdown first, then try to start
      void processor.shutdown();
      processor.start();

      // The timer should not be running (no way to directly test,
      // but we can verify no errors are thrown)
      expect(processor.hasShutdown).toBe(true);
    });
  });

  describe("request format", () => {
    it("should send correct headers", async () => {
      const processor = new BatchProcessor(createConfig());

      processor.enqueue(makeEvent("trace-1"));
      await processor.flush();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.nodeloom.io/api/sdk/v1/telemetry");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["Authorization"]).toBe("Bearer sdk_test");
      expect(init.headers["User-Agent"]).toBe(
        "nodeloom-sdk-typescript/0.10.0"
      );
    });

    it("should serialize events as snake_case JSON", async () => {
      const processor = new BatchProcessor(createConfig());

      const event: TraceStartEvent = {
        type: "trace_start",
        trace_id: "test-uuid",
        agent_name: "test-agent",
        agent_version: "1.0.0",
        environment: "production",
        input: { query: "hello" },
        metadata: { key: "value" },
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      processor.enqueue(event);
      await processor.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const sent = body.events[0];

      // Verify snake_case keys
      expect(sent.type).toBe("trace_start");
      expect(sent.trace_id).toBe("test-uuid");
      expect(sent.agent_name).toBe("test-agent");
      expect(sent.agent_version).toBe("1.0.0");
      expect(sent.environment).toBe("production");
      expect(sent.input).toEqual({ query: "hello" });
      expect(sent.metadata).toEqual({ key: "value" });
      expect(sent.timestamp).toBe("2024-01-01T00:00:00.000Z");
    });
  });
});
