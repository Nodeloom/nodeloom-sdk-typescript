# NodeLoom TypeScript SDK

TypeScript/JavaScript SDK for instrumenting AI agents and sending telemetry to [NodeLoom](https://nodeloom.io).

## Features

- Fire-and-forget telemetry that never blocks your application
- Automatic batching and retry with exponential backoff
- Full TypeScript support with strict types
- Built-in LangChain integration
- Dual output: ESM and CommonJS
- Bounded in-memory queue prevents unbounded memory growth
- Zero hard runtime dependencies

## Requirements

- Node.js 18+

## Installation

```bash
npm install @nodeloom/sdk
```

## Quick Start

```typescript
import { NodeLoomClient, SpanType } from "@nodeloom/sdk";

const client = new NodeLoomClient({
  apiKey: "sdk_your_api_key",
});

const trace = client.trace("my-agent", {
  input: { query: "What is NodeLoom?" },
});

const span = trace.span("openai-call", SpanType.LLM);
span.setInput({ messages: [{ role: "user", content: "What is NodeLoom?" }] });
span.setOutput({ text: "NodeLoom is an AI agent operations platform." });
span.setTokenUsage({ promptTokens: 15, completionTokens: 20, model: "gpt-4o" });
span.end();

trace.end("success", {
  output: { response: "NodeLoom is an AI agent operations platform." },
});

await client.shutdown();
```

## Traces and Spans

A **trace** represents a single end-to-end agent execution. A **span** represents a unit of work within a trace.

### Span Types

| Type | Description |
|------|-------------|
| `SpanType.LLM` | Language model call |
| `SpanType.Tool` | Tool or function invocation |
| `SpanType.Retrieval` | Vector search or data retrieval |
| `SpanType.Chain` | Pipeline or chain of steps |
| `SpanType.Agent` | Sub-agent invocation |
| `SpanType.Custom` | User-defined operation |

### Nested Spans

```typescript
const parentSpan = trace.span("agent-step", SpanType.Agent);
const childSpan = parentSpan.span("llm-call", SpanType.LLM);
childSpan.setOutput({ response: "..." });
childSpan.setTokenUsage({ promptTokens: 10, completionTokens: 20, model: "gpt-4o" });
childSpan.end();
parentSpan.end();
```

### Standalone Events

```typescript
client.event("guardrail_triggered", "warn", { rule: "pii_detected" });
```

### Error Handling

```typescript
span.setError("Connection timeout");
span.end(); // status is automatically set to "error"

trace.end("error", { error: "Agent failed" });
```

### Trace Options

```typescript
const trace = client.trace("my-agent", {
  input: { query: "hello" },
  metadata: { userId: "user-123" },
  agentVersion: "1.0.0",
  environment: "production",
});
```

## LangChain Integration

```typescript
import { NodeLoomClient } from "@nodeloom/sdk";
import { NodeLoomCallbackHandler } from "@nodeloom/sdk/integrations/langchain";

const client = new NodeLoomClient({ apiKey: "sdk_your_api_key" });
const handler = new NodeLoomCallbackHandler(client);

const result = await chain.invoke(input, { callbacks: [handler] });

await client.shutdown();
```

The callback handler automatically instruments LLM calls, chain runs, tool invocations, and retriever queries with proper parent-child span relationships.

Requires `@langchain/core` >= 0.1.0 as an optional peer dependency.

## Configuration

```typescript
const client = new NodeLoomClient({
  apiKey: "sdk_your_api_key",      // required
  endpoint: "https://api.nodeloom.io", // default
  maxBatchSize: 100,               // events per batch
  flushIntervalMs: 5000,           // ms between flushes
  maxQueueSize: 10000,             // max queued events
  maxRetries: 3,                   // retry attempts
  disabled: false,                 // set true to disable
});
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `apiKey` | *required* | SDK API key (starts with `sdk_`) |
| `endpoint` | `https://api.nodeloom.io` | NodeLoom API base URL |
| `maxBatchSize` | `100` | Max events per batch |
| `flushIntervalMs` | `5000` | Milliseconds between automatic flushes |
| `maxQueueSize` | `10000` | Max queued events before dropping |
| `maxRetries` | `3` | Retry attempts for failed requests |
| `disabled` | `false` | Set to `true` to disable telemetry |

## Development

```bash
npm install
npm run build      # Build ESM + CJS
npm test           # Run tests
npm run test:watch # Watch mode
npm run lint       # Type check
```

## License

MIT
