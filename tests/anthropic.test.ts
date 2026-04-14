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

    expect(trace.span).toHaveBeenCalledWith("llm-response", { spanType: "llm" });
    expect(span.setOutput).toHaveBeenCalledWith({ text: "Hello!" });
    expect(span.end).toHaveBeenCalled();
  });

  it("handles agent.tool_use events", () => {
    const { client, trace, span } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "agent.tool_use", name: "bash", input: { command: "ls" } });

    expect(trace.span).toHaveBeenCalledWith("bash", { spanType: "tool" });
    expect(span.setInput).toHaveBeenCalledWith({ command: "ls" });
  });

  it("handles agent.thinking events", () => {
    const { client, trace, span } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test", { guardrails: false });
    const ctx = handler.traceSession("sess_123");

    ctx.onEvent({ type: "agent.thinking", content: [{ text: "Let me think..." }] });

    expect(trace.span).toHaveBeenCalledWith("thinking", { spanType: "custom" });
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

    expect(trace.end).toHaveBeenCalledWith({ status: "success", output: undefined });
  });

  it("checks input guardrails", async () => {
    const { client } = makeClient();
    const handler = new ManagedAgentsHandler(client, "test");
    const ctx = handler.traceSession("sess_123");

    await ctx.checkInput("test input");

    expect(client.api.checkGuardrails).toHaveBeenCalledWith({
      text: "test input",
      detectPromptInjection: true,
      redactPii: true,
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
});
