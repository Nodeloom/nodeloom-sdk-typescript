import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api.js";
import { NodeLoomClient } from "../src/client.js";
import {
  AgentHaltedError,
  ControlRegistry,
} from "../src/control.js";

describe("ControlRegistry", () => {
  it("returns default not-halted state for unknown agents", () => {
    const registry = new ControlRegistry();
    const state = registry.get("unknown");
    expect(state.halted).toBe(false);
    expect(state.haltSource).toBe("none");
    expect(state.revision).toBe(0);
    expect(state.requireGuardrails).toBe("OFF");
  });

  it("marks an agent halted from a control payload", () => {
    const registry = new ControlRegistry();
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: true,
      halt_source: "agent",
      halt_reason: "policy violation",
      revision: 7,
      require_guardrails: "OFF",
    });
    const state = registry.get("agent-1");
    expect(state.halted).toBe(true);
    expect(state.haltSource).toBe("agent");
    expect(state.haltReason).toBe("policy violation");
    expect(state.revision).toBe(7);
  });

  it("propagates a team-wide halt to every known and unknown agent", () => {
    const registry = new ControlRegistry();
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: false,
      halt_source: "none",
      revision: 1,
      require_guardrails: "OFF",
    });
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: true,
      halt_source: "team",
      halt_reason: "incident",
      revision: 1_000_000,
      require_guardrails: "OFF",
    });

    for (const name of ["agent-1", "never-seen-agent"]) {
      const state = registry.get(name);
      expect(state.halted).toBe(true);
      expect(state.haltSource).toBe("team");
      expect(state.haltReason).toBe("incident");
    }
  });

  it("ignores stale revisions", () => {
    const registry = new ControlRegistry();
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: true,
      halt_source: "agent",
      halt_reason: "current",
      revision: 10,
      require_guardrails: "OFF",
    });
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: false,
      halt_source: "none",
      revision: 3,
      require_guardrails: "OFF",
    });
    expect(registry.get("agent-1").halted).toBe(true);
  });

  it("round-trips a guardrail session id within its TTL", () => {
    const registry = new ControlRegistry();
    const now = Date.now();
    registry.recordGuardrailSession("agent-1", "sess-abc", 300, now);
    expect(registry.takeGuardrailSession("agent-1", now + 1_000)).toBe("sess-abc");
  });

  it("expires the cached session id past TTL", () => {
    const registry = new ControlRegistry();
    const now = Date.now();
    registry.recordGuardrailSession("agent-1", "sess-abc", 5, now);
    expect(registry.takeGuardrailSession("agent-1", now + 6_000)).toBeNull();
  });

  it("clamps a nonsensical TTL from the backend to the default", () => {
    const registry = new ControlRegistry();
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: false,
      halt_source: "none",
      revision: 1,
      require_guardrails: "OFF",
      guardrail_session_ttl_seconds: -5,
    });
    expect(registry.get("agent-1").guardrailSessionTtlSeconds).toBe(300);

    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: false,
      halt_source: "none",
      revision: 2,
      require_guardrails: "OFF",
      guardrail_session_ttl_seconds: 1e12,
    });
    expect(registry.get("agent-1").guardrailSessionTtlSeconds).toBe(300);
  });

  it("does not let an agent-source payload clear a team halt", () => {
    const registry = new ControlRegistry();
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: true,
      halt_source: "team",
      halt_reason: "incident",
      revision: 1_000_000,
      require_guardrails: "OFF",
    });
    registry.updateFromPayload({
      agent_name: "agent-1",
      halted: false,
      halt_source: "agent",
      revision: 2_000_000, // higher, but agent-source must not touch team flag
      require_guardrails: "OFF",
    });
    expect(registry.get("agent-1").halted).toBe(true);
    expect(registry.get("agent-1").haltSource).toBe("team");
  });
});

describe("NodeLoomClient.trace halt enforcement", () => {
  let client: NodeLoomClient;

  beforeEach(() => {
    client = new NodeLoomClient({
      apiKey: "sdk_test",
      controlPollIntervalMs: 0,
      silent: true,
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it("throws AgentHaltedError when the agent is halted", () => {
    client.control.updateFromPayload({
      agent_name: "halted-agent",
      halted: true,
      halt_source: "agent",
      halt_reason: "manual",
      revision: 1,
      require_guardrails: "OFF",
    });
    expect(() => client.trace("halted-agent")).toThrowError(AgentHaltedError);
  });

  it("throws AgentHaltedError on team-wide halt for unknown agents", () => {
    client.control.updateFromPayload({
      agent_name: null,
      halted: true,
      halt_source: "team",
      halt_reason: "incident",
      revision: 99_999,
      require_guardrails: "OFF",
    });
    expect(() => client.trace("brand-new-agent")).toThrowError(AgentHaltedError);
  });

  it("attaches the cached guardrail session id to trace_start", async () => {
    const enqueueSpy = vi.spyOn(client["processor"] as unknown as { enqueue: (e: unknown) => void }, "enqueue");
    client.control.recordGuardrailSession("ok-agent", "sess-xyz", 300);

    const trace = client.trace("ok-agent");
    trace.end("success");

    const calls = enqueueSpy.mock.calls.map((c) => c[0]);
    const startEvent = calls.find(
      (e: any) => e.type === "trace_start" && e.agent_name === "ok-agent",
    );
    expect(startEvent).toBeDefined();
    expect((startEvent as any).guardrail_session_id).toBe("sess-xyz");
  });
});

describe("ApiClient guardrail session minting", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches the guardrailSessionId returned by check_guardrails", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        passed: true,
        violations: [],
        redactedContent: "ok",
        checks: [],
        guardrailSessionId: "sess-321",
      }),
    });

    const registry = new ControlRegistry();
    const api = new ApiClient("sdk_test", "https://api.example.com", registry);
    const response = await api.checkGuardrails("team-1", "ok", { agentName: "agent-1" });
    expect(response.guardrailSessionId).toBe("sess-321");
    expect(registry.takeGuardrailSession("agent-1")).toBe("sess-321");
  });

  it("getAgentControl updates the registry", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        agent_name: "agent-1",
        halted: true,
        halt_source: "team",
        halt_reason: "incident",
        revision: 1_000_000,
        require_guardrails: "OFF",
      }),
    });

    const registry = new ControlRegistry();
    const api = new ApiClient("sdk_test", "https://api.example.com", registry);
    await api.getAgentControl("agent-1");

    expect(registry.get("agent-1").halted).toBe(true);
    expect(registry.get("never-seen-agent").halted).toBe(true);
  });
});

describe("BatchProcessor → ControlRegistry piggy-back", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the response.control field into the registry", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        accepted: 1,
        rejected: 0,
        errors: [],
        control: {
          agent_name: "agent-1",
          halted: true,
          halt_source: "agent",
          halt_reason: "policy",
          revision: 5,
          require_guardrails: "HARD",
          guardrail_session_ttl_seconds: 300,
        },
      }),
    });

    const client = new NodeLoomClient({
      apiKey: "sdk_test",
      flushIntervalMs: 50,
      controlPollIntervalMs: 0,
      silent: true,
    });

    try {
      const trace = client.trace("agent-1");
      trace.end("success");
      await client.flush();

      expect(client.control.isHalted("agent-1")).toBe(true);
      expect(client.control.get("agent-1").requireGuardrails).toBe("HARD");
    } finally {
      await client.shutdown();
    }
  });
});
