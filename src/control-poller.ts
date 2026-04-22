import type { ApiClient } from "./api.js";
import type { ControlRegistry } from "./control.js";

/**
 * Background poller that periodically refreshes the control registry by
 * calling GET /api/sdk/v1/agents/&#123;name&#125;/control for every agent that
 * has been observed. Telemetry batch responses already carry the control
 * payload, so this is mainly useful for sparse-traffic agents that may go
 * minutes between traces.
 */
export class ControlPoller {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly registry: ControlRegistry,
    private readonly apiFactory: () => ApiClient,
    intervalMs: number,
  ) {
    this.intervalMs = Math.max(1_000, intervalMs);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    let api: ApiClient;
    try {
      api = this.apiFactory();
    } catch {
      return;
    }
    for (const agentName of this.registry.knownAgents()) {
      try {
        await api.getAgentControl(agentName);
      } catch {
        // Best effort. Failures are silently retried on the next tick.
      }
    }
  }
}
