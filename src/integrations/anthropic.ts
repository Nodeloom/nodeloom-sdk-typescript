/**
 * Anthropic Managed Agents integration for NodeLoom.
 *
 * Auto-instruments Anthropic Managed Agent sessions with traces, spans,
 * guardrail checks, and token tracking.
 *
 * @example
 * ```typescript
 * import { NodeLoomClient } from "@nodeloom/sdk";
 * import { ManagedAgentsHandler } from "@nodeloom/sdk/integrations/anthropic";
 *
 * const nodeloom = new NodeLoomClient({ apiKey: "sdk_..." });
 * const handler = new ManagedAgentsHandler(nodeloom, "my-agent");
 *
 * const ctx = handler.traceSession(session.id);
 * // Send events, process stream...
 * for await (const event of stream) {
 *   ctx.onEvent(event);
 * }
 * ctx.end();
 * ```
 */

import { NodeLoomClient } from "../client";
import { Trace } from "../trace";
import { Span } from "../span";
import { SpanType, Status } from "../types";

export interface ManagedAgentsHandlerOptions {
  guardrails?: boolean;
  agentVersion?: string;
}

export interface SessionContext {
  trace: Trace;
  onEvent: (event: AnthropicEvent) => void;
  checkInput: (text: string) => Promise<GuardrailResult>;
  checkOutput: (text: string) => Promise<GuardrailResult>;
  end: (status?: Status) => void;
}

export interface AnthropicEvent {
  type: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  tool_use_id?: string;
}

export interface GuardrailResult {
  passed: boolean;
  violations: Array<Record<string, unknown>>;
  redactedContent?: string;
}

export class ManagedAgentsHandler {
  private client: NodeLoomClient;
  private agentName: string;
  private guardrails: boolean;
  private options?: ManagedAgentsHandlerOptions;

  constructor(
    client: NodeLoomClient,
    agentName: string,
    options?: ManagedAgentsHandlerOptions
  ) {
    this.client = client;
    this.agentName = agentName;
    this.guardrails = options?.guardrails !== false;
    this.options = options;
  }

  /**
   * Create a session context that auto-instruments Anthropic events.
   */
  traceSession(sessionId: string): SessionContext {
    const traceOptions: Record<string, unknown> = { sessionId };
    if (this.options?.agentVersion) {
      traceOptions.agentVersion = this.options.agentVersion;
    }
    const trace = this.client.trace(this.agentName, traceOptions);

    const activeSpans = new Map<string, Span>();
    let lastOutput: Record<string, unknown> | undefined;
    const self = this;

    return {
      trace,

      onEvent(event: AnthropicEvent): void {
        if (!event?.type) return;

        switch (event.type) {
          case "agent.message": {
            const text = extractText(event);
            const span = trace.span("llm-response", SpanType.LLM);
            if (text) {
              span.setOutput({ text });
              lastOutput = { text };
              if (self.guardrails) {
                self.client.api
                  .checkGuardrails("", text, { redactPii: true, filterContent: true })
                  .then((result: GuardrailResult) => {
                    if (!result.passed) {
                      self.client.event("guardrail_violation", "warn", {
                        source: "anthropic-managed-agents",
                        direction: "output",
                        violations: result.violations,
                      });
                    }
                  })
                  .catch(() => {});
              }
            }
            span.end("success");
            break;
          }

          case "agent.tool_use": {
            const name = event.name || "tool";
            const span = trace.span(name, SpanType.Tool);
            if (event.input) span.setInput(event.input);
            if (event.id) {
              activeSpans.set(event.id, span);
            } else {
              span.end("success");
            }
            break;
          }

          case "agent.tool_result": {
            const toolId = event.tool_use_id;
            if (toolId && activeSpans.has(toolId)) {
              const span = activeSpans.get(toolId)!;
              const text = extractText(event);
              if (text) span.setOutput({ result: text });
              span.end("success");
              activeSpans.delete(toolId);
            }
            break;
          }

          case "agent.thinking": {
            const text = extractText(event);
            const span = trace.span("thinking", SpanType.Custom);
            if (text) span.setInput({ thinking: text });
            span.end("success");
            break;
          }
        }
      },

      async checkInput(text: string): Promise<GuardrailResult> {
        if (!self.guardrails) return { passed: true, violations: [] };
        return self.client.api.checkGuardrails("", text, {
          detectPromptInjection: true,
          redactPii: true,
        });
      },

      async checkOutput(text: string): Promise<GuardrailResult> {
        if (!self.guardrails) return { passed: true, violations: [] };
        return self.client.api.checkGuardrails("", text, {
          redactPii: true,
          filterContent: true,
        });
      },

      end(status?: Status): void {
        for (const span of activeSpans.values()) {
          span.end("success");
        }
        activeSpans.clear();
        trace.end(status || "success", { output: lastOutput });
      },
    };
  }
}

function extractText(event: AnthropicEvent): string | undefined {
  if (!event.content || !Array.isArray(event.content)) return undefined;
  const texts = event.content
    .filter((b) => b.text)
    .map((b) => b.text!);
  return texts.length > 0 ? texts.join(" ") : undefined;
}
