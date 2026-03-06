/**
 * LangChain.js integration for NodeLoom telemetry.
 *
 * This module provides a callback handler that automatically creates
 * spans for LLM calls, tool invocations, chain runs, and retriever
 * calls when using LangChain.js.
 *
 * Requires @langchain/core as a peer dependency. If @langchain/core
 * is not installed, constructing the handler will throw.
 *
 * Usage:
 * ```ts
 * import { NodeLoomClient } from "@nodeloom/sdk";
 * import { NodeLoomCallbackHandler } from "@nodeloom/sdk/integrations/langchain";
 *
 * const client = new NodeLoomClient({ apiKey: "sdk_..." });
 * const trace = client.trace("langchain-agent");
 * const handler = new NodeLoomCallbackHandler(trace);
 *
 * // Pass the handler to your LangChain chain/agent
 * const result = await chain.invoke(input, { callbacks: [handler] });
 *
 * trace.end("success", { output: result });
 * ```
 */

import type { Trace } from "../trace.js";
import type { Span } from "../span.js";
import { SpanType } from "../types.js";

/**
 * Minimal interface matching LangChain's serialized object shape.
 * Defined here to avoid depending on @langchain/core at compile time.
 */
interface SerializedObject {
  id: string[];
}

/**
 * Minimal interface for LLM output from LangChain callbacks.
 */
interface LLMResult {
  generations: Array<Array<{ text: string }>>;
  llmOutput?: {
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
}

/**
 * Minimal interface for retriever documents.
 */
interface RetrievedDocument {
  pageContent: string;
  metadata?: Record<string, unknown>;
}

/**
 * Map of active run IDs to their corresponding spans.
 * This allows us to match LangChain's handleEnd callbacks
 * to the correct span.
 */
type RunMap = Map<string, Span>;

/**
 * A LangChain-compatible callback handler that automatically instruments
 * LLM calls, chain runs, tool calls, and retriever queries as NodeLoom
 * spans within a trace.
 *
 * This class does not extend BaseCallbackHandler directly. Instead, it
 * implements the same interface and can be used anywhere LangChain
 * accepts a callback handler. This avoids requiring @langchain/core
 * at compile time.
 */
export class NodeLoomCallbackHandler {
  readonly name = "NodeLoomCallbackHandler";

  private readonly trace: Trace;
  private readonly runSpans: RunMap = new Map();

  constructor(trace: Trace) {
    this.trace = trace;
  }

  // ------------------------------------------------------------------
  // LLM callbacks
  // ------------------------------------------------------------------

  async handleLLMStart(
    llm: SerializedObject,
    prompts: string[],
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const llmName = llm.id[llm.id.length - 1] ?? "llm";
    const span = this.trace.span(llmName, SpanType.LLM, {
      parentSpanId: parentRunId
        ? this.runSpans.get(parentRunId)?.id
        : undefined,
      input: { prompts },
    });
    this.runSpans.set(runId, span);
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    const texts = output.generations.flat().map((g) => g.text);
    span.setOutput({ generations: texts });

    const usage = output.llmOutput?.tokenUsage;
    if (
      usage &&
      usage.promptTokens != null &&
      usage.completionTokens != null
    ) {
      span.setTokenUsage({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      });
    }

    span.end("success");
    this.runSpans.delete(runId);
  }

  async handleLLMError(error: Error, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setError(error.message);
    span.end("error");
    this.runSpans.delete(runId);
  }

  // ------------------------------------------------------------------
  // Chain callbacks
  // ------------------------------------------------------------------

  async handleChainStart(
    chain: SerializedObject,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const chainName = chain.id[chain.id.length - 1] ?? "chain";
    const span = this.trace.span(chainName, SpanType.Chain, {
      parentSpanId: parentRunId
        ? this.runSpans.get(parentRunId)?.id
        : undefined,
      input: inputs,
    });
    this.runSpans.set(runId, span);
  }

  async handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string
  ): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setOutput(outputs);
    span.end("success");
    this.runSpans.delete(runId);
  }

  async handleChainError(error: Error, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setError(error.message);
    span.end("error");
    this.runSpans.delete(runId);
  }

  // ------------------------------------------------------------------
  // Tool callbacks
  // ------------------------------------------------------------------

  async handleToolStart(
    tool: SerializedObject,
    input: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const toolName = tool.id[tool.id.length - 1] ?? "tool";
    const span = this.trace.span(toolName, SpanType.Tool, {
      parentSpanId: parentRunId
        ? this.runSpans.get(parentRunId)?.id
        : undefined,
      input: { input },
    });
    this.runSpans.set(runId, span);
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setOutput({ output });
    span.end("success");
    this.runSpans.delete(runId);
  }

  async handleToolError(error: Error, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setError(error.message);
    span.end("error");
    this.runSpans.delete(runId);
  }

  // ------------------------------------------------------------------
  // Retriever callbacks
  // ------------------------------------------------------------------

  async handleRetrieverStart(
    retriever: SerializedObject,
    query: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const retrieverName =
      retriever.id[retriever.id.length - 1] ?? "retriever";
    const span = this.trace.span(retrieverName, SpanType.Retrieval, {
      parentSpanId: parentRunId
        ? this.runSpans.get(parentRunId)?.id
        : undefined,
      input: { query },
    });
    this.runSpans.set(runId, span);
  }

  async handleRetrieverEnd(
    documents: RetrievedDocument[],
    runId: string
  ): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setOutput({
      documents: documents.map((d) => ({
        content: d.pageContent,
        metadata: d.metadata,
      })),
    });
    span.end("success");
    this.runSpans.delete(runId);
  }

  async handleRetrieverError(error: Error, runId: string): Promise<void> {
    const span = this.runSpans.get(runId);
    if (!span) return;

    span.setError(error.message);
    span.end("error");
    this.runSpans.delete(runId);
  }
}
