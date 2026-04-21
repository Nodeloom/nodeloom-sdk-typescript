import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManagedAgentsHandler } from "../src/integrations/anthropic";

function makeClient() {
  const span = {
    setInput: vi.fn().mockReturnThis(),
    setOutput: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  const trace = {
    span: vi.fn().mockReturnValue(span),
    end: vi.fn(),
  };
  const client = {
    trace: vi.fn().mockReturnValue(trace),
    event: vi.fn(),
    api: {
      checkGuardrails: vi.fn().mockResolvedValue({ passed: true, violations: [] }),
    },
  } as any;
  return { client, trace, span };
}

describe("ManagedAgentsHandler", () => {
  it("creates handler with defaults", () => {
    const { client } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test-agent");
    expect(handler).toBeDefined();
  });

  it("creates handler with guardrails disabled", () => {
    const { client } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    expect(handler).toBeDefined();
  });
});

describe("SessionContext", () => {
  it("creates trace on traceSession", () => {
    const { client, trace } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");
    expect(client.trace).toHaveBeenCalledWith("test", { sessionId: "sess_123" });
    expect(ctx.trace).toBe(trace);
  });

  it("handles agent.message events", () => {
    const { client, trace, span } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "agent.message", content: [{ text: "Hello!" }] });

    expect(trace.span).toHaveBeenCalledWith("llm-response", "llm");
    expect(span.setOutput).toHaveBeenCalledWith({ text: "Hello!" });
    expect(span.end).toHaveBeenCalled();
  });

  it("handles agent.tool_use events", () => {
    const { client, trace, span } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "agent.tool_use", name: "bash", input: { command: "ls" } });

    expect(trace.span).toHaveBeenCalledWith("bash", "tool");
    expect(span.setInput).toHaveBeenCalledWith({ command: "ls" });
  });

  it("handles agent.thinking events", () => {
    const { client, trace, span } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "agent.thinking", content: [{ text: "Let me think..." }] });

    expect(trace.span).toHaveBeenCalledWith("thinking", "custom");
  });

  it("ignores unknown event types", () => {
    const { client, trace } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "unknown.event" });

    expect(trace.span).not.toHaveBeenCalled();
  });

  it("ends trace with success", () => {
    const { client, trace } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.end();

    expect(trace.end).toHaveBeenCalledWith("success", { output: undefined });
  });

  it("checks input guardrails", async () => {
    const { client } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test");
    const ctx = handler.traceSession("sess_123");

    await ctx.checkInput("test input");

    expect(client.api.checkGuardrails).toHaveBeenCalledWith("", "test input", {
      detectPromptInjection: true,
      redactPii: true,
      agentName: "test",
    });
  });

  it("skips guardrails when disabled", async () => {
    const { client } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    const result = await ctx.checkInput("test");

    expect(result.passed).toBe(true);
    expect(client.api.checkGuardrails).not.toHaveBeenCalled();
  });

  it("logs and continues when background guardrail check rejects", async () => {
    // A rejected checkGuardrails promise during agent.message handling must
    // never propagate up to crash the event stream, but must also not be
    // swallowed silently — operators need the signal to diagnose outages.
    const { client, span } = makeClient();
    client.api.checkGuardrails.mockRejectedValueOnce(new Error("backend 503"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler = new ManagedAgentsHandler(client, "test");
      const ctx = handler.traceSession("sess_fail");

      ctx.onEvent({ type: "agent.message", content: [{ text: "hello" }] });

      // Let the background promise settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(span.end).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Anthropic guardrail output check failed"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
