import type { TelemetryEvent } from "./types.js";

/**
 * A bounded in-memory queue for telemetry events.
 *
 * When the queue reaches its capacity, new events are silently dropped
 * to prevent unbounded memory growth. This is a deliberate design choice
 * for fire-and-forget telemetry: it is better to lose recent events
 * than to crash the host application.
 */
export class EventQueue {
  private readonly items: TelemetryEvent[] = [];
  private readonly maxSize: number;
  private droppedCount = 0;

  constructor(maxSize: number) {
    if (maxSize < 1) {
      throw new Error("EventQueue maxSize must be at least 1");
    }
    this.maxSize = maxSize;
  }

  /**
   * Enqueues an event. Returns true if the event was accepted,
   * false if the queue is full and the event was dropped.
   */
  enqueue(event: TelemetryEvent): boolean {
    if (this.items.length >= this.maxSize) {
      this.droppedCount++;
      return false;
    }
    this.items.push(event);
    return true;
  }

  /**
   * Drains up to `count` events from the front of the queue and returns them.
   * The drained events are removed from the queue.
   */
  drain(count: number): TelemetryEvent[] {
    return this.items.splice(0, count);
  }

  /**
   * Returns the current number of events in the queue.
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * Returns the total number of events that were dropped due to capacity limits.
   */
  get totalDropped(): number {
    return this.droppedCount;
  }

  /**
   * Returns true if the queue has no events.
   */
  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Removes all events from the queue.
   */
  clear(): void {
    this.items.length = 0;
  }
}
