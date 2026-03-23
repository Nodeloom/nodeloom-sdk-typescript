/**
 * REST API client for NodeLoom.
 *
 * SDK tokens can authenticate against all NodeLoom API endpoints.
 * This module provides a typed client for common operations.
 */

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number>;
}

export interface ApiErrorResponse {
  error: string;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly response?: unknown,
  ) {
    super(`API error ${statusCode}: ${message}`);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(apiKey: string, endpoint: string = "https://api.nodeloom.io") {
    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  /**
   * Make an authenticated API request.
   *
   * @param path - API path (e.g., "/api/workflows")
   * @param options - Request options (method, body, params)
   * @returns Parsed JSON response
   * @throws {ApiError} If the request fails with a non-2xx status code
   */
  async request<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const { method = "GET", body, params } = options;

    let url = `${this.endpoint}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        searchParams.set(key, String(value));
      }
      url += `?${searchParams.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = undefined;
      }
      const message =
        errorBody && typeof errorBody === "object" && "error" in errorBody
          ? String((errorBody as ApiErrorResponse).error)
          : response.statusText;
      throw new ApiError(response.status, message, errorBody);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Workflow Operations ──────────────────────────────────────

  /** List all workflows for a team. */
  async listWorkflows(teamId: string): Promise<unknown[]> {
    return this.request<unknown[]>("/api/workflows", {
      params: { teamId },
    });
  }

  /** Get a workflow by ID. */
  async getWorkflow(workflowId: string): Promise<unknown> {
    return this.request(`/api/workflows/${workflowId}`);
  }

  /** Execute a workflow. */
  async executeWorkflow(
    workflowId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(`/api/workflows/${workflowId}/execute`, {
      method: "POST",
      body: input ?? {},
    });
  }

  // ── Execution Operations ─────────────────────────────────────

  /** List executions for a team. */
  async listExecutions(
    teamId: string,
    page = 0,
    size = 20,
  ): Promise<unknown> {
    return this.request("/api/executions", {
      params: { teamId, page, size },
    });
  }

  /** Get an execution by ID. */
  async getExecution(executionId: string): Promise<unknown> {
    return this.request(`/api/executions/${executionId}`);
  }

  // ── Credential Operations ────────────────────────────────────

  /** List credentials for a team. */
  async listCredentials(teamId: string): Promise<unknown[]> {
    return this.request<unknown[]>("/api/credentials", {
      params: { teamId },
    });
  }

  // ── Guardrail Operations ────────────────────────────────────

  /** Run guardrail checks on text content. */
  async checkGuardrails(
    teamId: string,
    text: string,
    options: {
      detectPromptInjection?: boolean;
      redactPii?: boolean;
      filterContent?: boolean;
      applyCustomRules?: boolean;
      detectSemanticManipulation?: boolean;
      onViolation?: "BLOCKED" | "WARNED" | "LOGGED";
      [key: string]: unknown;
    } = {},
  ): Promise<{
    passed: boolean;
    violations: Array<{
      type: string;
      severity: string;
      action: string;
      message: string;
      confidence: number;
      details: Record<string, unknown>;
    }>;
    redactedContent: string;
    checks: Array<{
      type: string;
      passed: boolean;
      violationsFound: number;
      durationMs: number;
    }>;
  }> {
    return this.request("/api/guardrails/check", {
      method: "POST",
      params: { teamId },
      body: { text, ...options },
    });
  }

  // ── Feedback Operations ────────────────────────────────────

  async submitFeedback(request: {
    execution_id: string;
    rating: number;
    comment?: string;
    tags?: Record<string, string>;
    trace_id?: string;
    span_id?: string;
    user_identifier?: string;
  }): Promise<unknown> {
    return this.request("/api/sdk/v1/feedback", { method: "POST", body: request });
  }

  async listFeedback(executionId?: string, page = 0, size = 20): Promise<unknown> {
    const params: Record<string, string | number> = { page, size };
    if (executionId) params.execution_id = executionId;
    return this.request("/api/sdk/v1/feedback", { params });
  }

  // ── Sentiment Operations ─────────────────────────────────

  async analyzeSentiment(text: string, traceId?: string): Promise<unknown> {
    const body: Record<string, unknown> = { text };
    if (traceId) body.trace_id = traceId;
    return this.request("/api/sdk/v1/sentiment", { method: "POST", body });
  }

  // ── Cost Operations ──────────────────────────────────────

  async getCosts(options?: { from?: string; to?: string; workflowId?: string }): Promise<unknown> {
    const params: Record<string, string> = {};
    if (options?.from) params.from = options.from;
    if (options?.to) params.to = options.to;
    if (options?.workflowId) params.workflow_id = options.workflowId;
    return this.request("/api/sdk/v1/costs", { params });
  }

  // ── Webhook Operations ───────────────────────────────────

  async registerWebhook(url: string, secret?: string, eventTypes?: string[]): Promise<unknown> {
    const body: Record<string, unknown> = { url };
    if (secret) body.secret = secret;
    if (eventTypes) body.event_types = eventTypes;
    return this.request("/api/sdk/v1/alerts/webhooks", { method: "POST", body });
  }

  async listWebhooks(): Promise<unknown[]> {
    return this.request<unknown[]>("/api/sdk/v1/alerts/webhooks");
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    return this.request(`/api/sdk/v1/alerts/webhooks/${webhookId}`, { method: "DELETE" });
  }

  // ── Prompt Operations ────────────────────────────────────

  async createPrompt(request: {
    name: string;
    content: string;
    description?: string;
    variables?: Record<string, unknown>;
    model_hint?: string;
  }): Promise<unknown> {
    return this.request("/api/sdk/v1/prompts", { method: "POST", body: request });
  }

  async getPrompt(name: string, version?: number): Promise<unknown> {
    const params: Record<string, string | number> = {};
    if (version !== undefined) params.version = version;
    return this.request(`/api/sdk/v1/prompts/${name}`, { params });
  }

  async listPrompts(): Promise<unknown[]> {
    return this.request<unknown[]>("/api/sdk/v1/prompts");
  }

  // ── Red Team Operations ──────────────────────────────────

  async startRedTeamScan(workflowId: string, categories?: string[]): Promise<unknown> {
    const body: Record<string, unknown> = { workflow_id: workflowId };
    if (categories) body.categories = categories;
    return this.request("/api/sdk/v1/redteam/scan", { method: "POST", body });
  }

  async getRedTeamScan(scanId: string): Promise<unknown> {
    return this.request(`/api/sdk/v1/redteam/scan/${scanId}`);
  }

  // ── Evaluation Operations ────────────────────────────────

  async triggerEvaluation(executionId: string): Promise<unknown> {
    return this.request("/api/sdk/v1/evaluate", { method: "POST", body: { execution_id: executionId } });
  }

  // ── Metrics Operations ───────────────────────────────────

  async getMetrics(options?: { name?: string; from?: string; to?: string }): Promise<unknown> {
    const params: Record<string, string> = {};
    if (options?.name) params.name = options.name;
    if (options?.from) params.from = options.from;
    if (options?.to) params.to = options.to;
    return this.request("/api/sdk/v1/metrics", { params });
  }
}
