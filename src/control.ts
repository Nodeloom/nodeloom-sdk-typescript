/**
 * Remote-control state shared across the TypeScript SDK.
 *
 * The SDK keeps a tiny, in-memory registry of agent control state so that:
 *   - The transport can update it from every telemetry batch response.
 *   - An optional poller can refresh it for sparse-traffic agents.
 *   - {@link ApiClient.checkGuardrails} can stash a short-lived
 *     `guardrailSessionId` that the next trace_start will attach for HARD
 *     required-guardrail enforcement on the backend.
 *   - {@link Trace} can throw {@link AgentHaltedError} synchronously when
 *     a halted agent attempts to start a new trace.
 */
export interface AgentControlPayload {
  agent_name?: string | null;
  halted: boolean;
  halt_source?: string;
  halt_reason?: string | null;
  halted_at?: string | null;
  revision?: number;
  require_guardrails?: string;
  guardrail_session_ttl_seconds?: number;
  polled_at?: string;
}

export interface AgentControlState {
  halted: boolean;
  haltReason: string | null;
  haltSource: string;
  revision: number;
  requireGuardrails: string;
  guardrailSessionTtlSeconds: number;
  guardrailSessionId: string | null;
  /** Date.now() value at which the cached session id expires. */
  guardrailSessionExpiresAt: number;
  rawPayload: AgentControlPayload | null;
}

function defaultState(): AgentControlState {
  return {
    halted: false,
    haltReason: null,
    haltSource: "none",
    revision: 0,
    requireGuardrails: "OFF",
    guardrailSessionTtlSeconds: 300,
    guardrailSessionId: null,
    guardrailSessionExpiresAt: 0,
    rawPayload: null,
  };
}

export class AgentHaltedError extends Error {
  readonly agentName: string;
  readonly reason: string | null;
  readonly source: string;
  readonly revision: number;
  readonly payload: AgentControlPayload | null;

  constructor(state: AgentControlState, agentName: string) {
    const base = state.haltReason
      ? `Agent '${agentName}' is halted (source=${state.haltSource}, revision=${state.revision}): ${state.haltReason}`
      : `Agent '${agentName}' is halted (source=${state.haltSource}, revision=${state.revision})`;
    super(base);
    this.name = "AgentHaltedError";
    this.agentName = agentName;
    this.reason = state.haltReason;
    this.source = state.haltSource;
    this.revision = state.revision;
    this.payload = state.rawPayload;
  }
}

export class ControlRegistry {
  private readonly agents = new Map<string, AgentControlState>();
  private teamHalted = false;
  private teamHaltReason: string | null = null;
  private teamRevision = 0;

  /** Read a snapshot of an agent's control state. */
  get(agentName: string): AgentControlState {
    const base = this.agents.get(agentName) ?? defaultState();
    const snapshot: AgentControlState = { ...base, rawPayload: base.rawPayload };

    if (this.teamHalted) {
      snapshot.halted = true;
      snapshot.haltSource = "team";
      snapshot.haltReason = this.teamHaltReason;
    }
    return snapshot;
  }

  isHalted(agentName: string): boolean {
    if (this.teamHalted) return true;
    const state = this.agents.get(agentName);
    return Boolean(state?.halted);
  }

  knownAgents(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Merge a backend control payload into the registry. Stale revisions are
   * ignored to avoid an out-of-order piggy-backed copy clobbering a fresher
   * standalone poll result.
   */
  updateFromPayload(payload: AgentControlPayload | null | undefined): void {
    if (!payload) return;

    const revision = Number(payload.revision ?? 0);
    const halted = Boolean(payload.halted);
    const haltSource = payload.halt_source ?? "none";
    const haltReason = payload.halt_reason ?? null;
    const requireGuardrails = (payload.require_guardrails ?? "OFF").toUpperCase();
    // Clamp TTL to a sane range (1s–24h). Protects against a buggy server.
    const rawTtl = Number(payload.guardrail_session_ttl_seconds ?? 300);
    const ttl = Number.isFinite(rawTtl) && rawTtl >= 1 && rawTtl <= 86_400 ? rawTtl : 300;

    // Team-wide flag is only mutated by team-source payloads with fresh
    // revisions. Agent-source payloads never touch team state — otherwise a
    // late piggy-backed agent response could clobber a team halt issued after it.
    if (haltSource === "team" && revision >= this.teamRevision) {
      this.teamHalted = halted;
      this.teamHaltReason = haltReason;
      this.teamRevision = revision;
    }

    const agentName = payload.agent_name ?? null;
    if (!agentName) return;

    const existing = this.agents.get(agentName) ?? defaultState();
    if (revision < existing.revision) return;

    existing.halted = halted && haltSource !== "team";
    existing.haltSource = haltSource;
    existing.haltReason = haltSource === "team" ? null : haltReason;
    existing.revision = revision;
    existing.requireGuardrails = requireGuardrails;
    existing.guardrailSessionTtlSeconds = ttl;
    existing.rawPayload = payload;
    this.agents.set(agentName, existing);
  }

  /** Cache a guardrail session id returned by checkGuardrails. */
  recordGuardrailSession(
    agentName: string | null | undefined,
    sessionId: string | null | undefined,
    ttlSeconds: number,
    nowMs: number = Date.now(),
  ): void {
    if (!agentName || !sessionId) return;
    const existing = this.agents.get(agentName) ?? defaultState();
    existing.guardrailSessionId = sessionId;
    existing.guardrailSessionExpiresAt = nowMs + Math.max(1, ttlSeconds) * 1000;
    this.agents.set(agentName, existing);
  }

  /** Return the cached guardrail session id while it is still within TTL. */
  takeGuardrailSession(agentName: string, nowMs: number = Date.now()): string | null {
    const state = this.agents.get(agentName);
    if (!state || !state.guardrailSessionId) return null;
    if (nowMs >= state.guardrailSessionExpiresAt) {
      state.guardrailSessionId = null;
      state.guardrailSessionExpiresAt = 0;
      return null;
    }
    return state.guardrailSessionId;
  }
}

export function raiseIfHalted(registry: ControlRegistry, agentName: string): void {
  const state = registry.get(agentName);
  if (state.halted) {
    throw new AgentHaltedError(state, agentName);
  }
}
