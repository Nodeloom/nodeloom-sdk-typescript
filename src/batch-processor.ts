import { SDK_LANGUAGE, SDK_VERSION, type ResolvedConfig } from "./config.js";
import { EventQueue } from "./queue.js";
import { Transport } from "./transport.js";
import type { BatchPayload, TelemetryEvent } from "./types.js";

/**
 * Manages the batching and periodic flushing of telemetry events.
 *
 * Events are accumulated in a bounded queue. The processor drains
 * up to `maxBatchSize` events and sends them via the transport layer
 * either on a timer interval or when the batch size threshold is reached.
 */
export class BatchProcessor {
  private readonly config: ResolvedConfig;
  private readonly queue: EventQueue;
  private readonly transport: Transport;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private isShutdown = false;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.queue = new EventQueue(config.maxQueueSize);
    this.transport = new Transport(config);
  }

  /**
   * Starts the periodic flush timer. Must be called once after construction.
   */
  start(): void {
    if (this.isShutdown) {
      return;
    }

    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);

    // Allow the Node.js process to exit even if the timer is still running.
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  /**
   * Enqueues a telemetry event. If the queue size meets or exceeds
   * the batch threshold, an immediate flush is triggered.
   */
  enqueue(event: TelemetryEvent): void {
    if (this.isShutdown || this.config.disabled) {
      return;
    }

    const accepted = this.queue.enqueue(event);

    if (!accepted && !this.config.silent) {
      console.warn(
        `NodeLoom SDK: event queue is full (${this.config.maxQueueSize}). Event dropped. Total dropped: ${this.queue.totalDropped}`
      );
    }

    // Trigger an immediate flush if we have accumulated enough events
    if (this.queue.size >= this.config.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Flushes all pending events in the queue, sending them in
   * batches of `maxBatchSize`. This method is safe to call
   * concurrently (only one flush runs at a time).
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.queue.isEmpty) {
      return;
    }

    this.isFlushing = true;

    try {
      while (!this.queue.isEmpty) {
        const events = this.queue.drain(this.config.maxBatchSize);
        if (events.length === 0) break;

        const payload: BatchPayload = {
          events,
          sdk_version: SDK_VERSION,
          sdk_language: SDK_LANGUAGE,
        };

        await this.transport.send(payload);
      }
    } catch (error) {
      if (!this.config.silent) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.warn(`NodeLoom SDK: flush error: ${message}`);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Gracefully shuts down the processor: stops the timer, flushes
   * all remaining events, and prevents future enqueue calls.
   *
   * After shutdown, the processor cannot be restarted.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush of any remaining events
    // Reset isFlushing in case a concurrent flush is in progress
    // (we are shutting down, so we force one last drain)
    this.isFlushing = false;
    await this.flush();
  }

  /**
   * Returns the number of events currently waiting in the queue.
   */
  get pendingCount(): number {
    return this.queue.size;
  }

  /**
   * Returns the total number of events that were dropped because
   * the queue was at capacity.
   */
  get droppedCount(): number {
    return this.queue.totalDropped;
  }

  /**
   * Returns true if the processor has been shut down.
   */
  get hasShutdown(): boolean {
    return this.isShutdown;
  }
}
