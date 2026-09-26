import { createHash, randomUUID } from "node:crypto";
import type { NormalizedTool } from "../bridge/tool-protocol.js";
import type { NativeEvrenInputItem } from "../bridge/native-codex-to-evren.js";
import type { EvrenUsage } from "../evren/extract-response.js";
import type { TranscriptEntry } from "./transcript.js";
import {
  addUsage,
  emptyClassifiedUsageTotals,
  type ClassifiedUsageTotals,
  type RequestClassification,
} from "../usage/types.js";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PendingToolCall {
  callId: string;
  tool: NormalizedTool;
  stagedOutput?: string;
  pollIdentityHash?: string;
}

export interface ActiveToolPollSequence {
  toolName: string;
  identityHash: string;
  consecutivePolls: number;
  authoritativeTokensSpent: number;
  startedAt: Date;
  lastPollAt: Date;
  warningEmitted: boolean;
}

export interface SessionPolling {
  active?: ActiveToolPollSequence;
  totalPollInferences: number;
  totalAuthoritativeTokens: number;
}

export interface ContextWindowState {
  windowId?: string;
  windowNumber?: number;
  contextWindowId?: string;
  nativeHistory: NativeEvrenInputItem[];
  transcript: TranscriptEntry[];
  compactionGeneration: number;
}

export interface ContextObservability {
  totalUpstreamPayloadBytes: number;
  canonicalHistoryReplayBytes: number;
  currentInputBytes: number;
  toolCatalogBytes: number;
  acceptedToolOutputReplayBytes: number;
  currentActiveContextBytes: number;
  peakActiveContextBytes: number;
}

export type RecoverableLimitName =
  | "MAX_SESSION_TOKENS"
  | "MAX_REQUESTS_PER_SESSION"
  | "MAX_TOOL_CALLS_PER_SESSION";

export interface LimitRecoveryState {
  limitName: string;
  current: number;
  limit: number;
  recommended?: number;
  blockedAt: Date;
  recoverable: boolean;
  appliedAt?: Date;
  appliedLimit?: number;
}

export interface PendingCompaction {
  requestedAt: Date;
  windowId?: string;
  windowNumber?: number;
  contextWindowId?: string;
}

export interface CompletedToolCall {
  callId: string;
  toolName: string;
  outputDigest: string;
}

export interface IncomingToolOutput {
  callId: string;
  output: string;
}

export interface PreparedToolOutputs {
  active: Array<{
    callId: string;
    output: string;
    pending: PendingToolCall;
    firstReceipt: boolean;
  }>;
  historical: CompletedToolCall[];
}

export interface Session {
  id: string;
  threadIdentityHash?: string;
  createdAt: Date;
  lastActivity: Date;
  requestCount: number;
  inferenceCount: number;
  usage: SessionUsage;
  usageByClass: ClassifiedUsageTotals;
  lastUsage?: EvrenUsage;
  lastOutputBudgetSaturated: boolean;
  outputBudgetSaturationCount: number;
  toolCallCount: number;
  transcript: TranscriptEntry[];
  nativeHistory: NativeEvrenInputItem[];
  context: ContextWindowState;
  contextObservability: ContextObservability;
  acceptedCompactionCount: number;
  pendingCompaction?: PendingCompaction;
  limitRecovery?: LimitRecoveryState;
  responseIds: Set<string>;
  accountedEvrenResponseIds: Set<string>;
  pendingToolCalls: Map<string, PendingToolCall>;
  completedToolCalls: Map<string, CompletedToolCall>;
  tools: Map<string, NormalizedTool>;
  polling: SessionPolling;
}

export class UnknownPreviousResponseError extends Error {
  readonly code = "unknown_previous_response_id";
}

export class InvalidToolCallSessionError extends Error {
  readonly code = "invalid_request_error";
}

export class ConflictingSessionIdentityError extends Error {
  readonly code = "conflicting_session_identity";
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly responseToSession = new Map<string, string>();
  private readonly callToSession = new Map<string, string>();
  private readonly completedCallToSession = new Map<string, string>();
  private readonly threadToSession = new Map<string, string>();
  private currentSessionId: string | undefined;

  constructor(
    private ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  setTtlMs(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Session TTL must be a positive integer.");
    }
    this.ttlMs = ttlMs;
    this.prune();
  }

  resolve(previousResponseId?: string): Session {
    this.prune();
    if (previousResponseId) {
      const sessionId = this.responseToSession.get(previousResponseId);
      const existing = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!existing) throw new UnknownPreviousResponseError(`Unknown or expired previous_response_id: ${previousResponseId}`);
      existing.lastActivity = this.now();
      return existing;
    }
    const now = this.now();
    const nativeHistory: NativeEvrenInputItem[] = [];
    const transcript: TranscriptEntry[] = [];
    const session: Session = {
      id: `sess_${randomUUID().replaceAll("-", "")}`,
      createdAt: now,
      lastActivity: now,
      requestCount: 0,
      inferenceCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageByClass: emptyClassifiedUsageTotals(),
      lastOutputBudgetSaturated: false,
      outputBudgetSaturationCount: 0,
      toolCallCount: 0,
      transcript,
      nativeHistory,
      context: {
        nativeHistory,
        transcript,
        compactionGeneration: 0,
      },
      contextObservability: {
        totalUpstreamPayloadBytes: 0,
        canonicalHistoryReplayBytes: 0,
        currentInputBytes: 0,
        toolCatalogBytes: 0,
        acceptedToolOutputReplayBytes: 0,
        currentActiveContextBytes: 0,
        peakActiveContextBytes: 0,
      },
      acceptedCompactionCount: 0,
      responseIds: new Set(),
      accountedEvrenResponseIds: new Set(),
      pendingToolCalls: new Map(),
      completedToolCalls: new Map(),
      tools: new Map(),
      polling: { totalPollInferences: 0, totalAuthoritativeTokens: 0 },
    };
    this.sessions.set(session.id, session);
    return session;
  }

  resolveByThreadId(threadId: string): Session | undefined {
    this.prune();
    const sessionId = this.threadToSession.get(threadId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session && sessionId) this.threadToSession.delete(threadId);
    if (session) session.lastActivity = this.now();
    return session;
  }

  associateThread(session: Session, threadId: string): void {
    const existingSessionId = this.threadToSession.get(threadId);
    if (existingSessionId && existingSessionId !== session.id) {
      throw new ConflictingSessionIdentityError("Codex thread identity conflicts with another Bridge session.");
    }
    if (session.threadIdentityHash && session.threadIdentityHash !== digestIdentity(threadId)) {
      throw new ConflictingSessionIdentityError("Bridge session is already associated with a different Codex thread.");
    }
    this.threadToSession.set(threadId, session.id);
    session.threadIdentityHash = digestIdentity(threadId);
    session.lastActivity = this.now();
  }

  assertThreadAssociation(session: Session, threadId: string): void {
    const mapped = this.resolveByThreadId(threadId);
    if (mapped && mapped.id !== session.id) {
      throw new ConflictingSessionIdentityError("Codex thread identity conflicts with response or tool continuation identity.");
    }
    this.associateThread(session, threadId);
  }

  replaceActiveContext(
    session: Session,
    replacement: {
      nativeHistory: NativeEvrenInputItem[];
      transcript: TranscriptEntry[];
      windowId?: string;
      windowNumber?: number;
      contextWindowId?: string;
    },
  ): void {
    session.nativeHistory = replacement.nativeHistory;
    session.transcript = replacement.transcript;
    session.context = {
      nativeHistory: replacement.nativeHistory,
      transcript: replacement.transcript,
      compactionGeneration: session.context.compactionGeneration + 1,
      ...(replacement.windowId === undefined ? {} : { windowId: replacement.windowId }),
      ...(replacement.windowNumber === undefined ? {} : { windowNumber: replacement.windowNumber }),
      ...(replacement.contextWindowId === undefined ? {} : { contextWindowId: replacement.contextWindowId }),
    };
    session.acceptedCompactionCount += 1;
    delete session.pendingCompaction;
    session.lastActivity = this.now();
  }

  recordResponse(session: Session, responseId: string): void {
    session.responseIds.add(responseId);
    session.lastActivity = this.now();
    this.responseToSession.set(responseId, session.id);
  }

  recordPendingToolCall(session: Session, pending: PendingToolCall): void {
    const existingSessionId = this.callToSession.get(pending.callId);
    const completedSessionId = this.completedCallToSession.get(pending.callId);
    if (existingSessionId || completedSessionId) {
      throw new Error(`Tool call_id collision: ${pending.callId}`);
    }
    session.pendingToolCalls.set(pending.callId, pending);
    session.lastActivity = this.now();
    this.callToSession.set(pending.callId, session.id);
  }

  resolveByToolCallIds(callIds: readonly string[]): Session {
    this.prune();
    if (callIds.length === 0) {
      throw new InvalidToolCallSessionError("Tool output continuation is missing call_id.");
    }

    let resolved: Session | undefined;
    const seen = new Set<string>();
    for (const callId of callIds) {
      if (seen.has(callId)) {
        throw new InvalidToolCallSessionError(`Tool output repeats call_id: ${callId}`);
      }
      seen.add(callId);
      const sessionId = this.callToSession.get(callId) ?? this.completedCallToSession.get(callId);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session || (!session.pendingToolCalls.has(callId) && !session.completedToolCalls.has(callId))) {
        throw new InvalidToolCallSessionError(`Tool output references unknown call_id: ${callId}`);
      }
      if (resolved && resolved.id !== session.id) {
        throw new InvalidToolCallSessionError("Tool outputs reference call_ids from different sessions.");
      }
      resolved = session;
    }

    if (!resolved) throw new InvalidToolCallSessionError("Tool output continuation is missing call_id.");
    resolved.lastActivity = this.now();
    return resolved;
  }

  resolveByCanonicalReplay(entries: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): Session | undefined {
    this.prune();
    if (!entries.some((entry) => entry.role === "assistant")) return undefined;

    const candidates = [...this.sessions.values()].filter((session) => {
      const canonical = session.transcript.filter((entry) =>
        (entry.role === "user" || entry.role === "assistant")
        && entry.callId === undefined
        && entry.toolName === undefined,
      );
      if (canonical.length === 0 || entries.length < canonical.length) return false;
      return canonical.every((expected, index) => {
        const incoming = entries[index];
        return incoming?.role === expected.role && incoming.text === expected.text;
      });
    });
    if (candidates.length !== 1) return undefined;
    candidates[0]!.lastActivity = this.now();
    return candidates[0];
  }

  prepareIncomingToolOutputs(
    session: Session,
    outputs: readonly IncomingToolOutput[],
    allowParallel = false,
  ): PreparedToolOutputs {
    if (outputs.length === 0) {
      throw new InvalidToolCallSessionError("Tool output continuation is missing call_id.");
    }

    const pendingOutputs: Array<{ callId: string; output: string; pending: PendingToolCall }> = [];
    const historical: CompletedToolCall[] = [];
    const seen = new Set<string>();

    for (const incoming of outputs) {
      if (seen.has(incoming.callId)) {
        throw new InvalidToolCallSessionError(`Tool output repeats call_id: ${incoming.callId}`);
      }
      seen.add(incoming.callId);

      const pendingSessionId = this.callToSession.get(incoming.callId);
      const completedSessionId = this.completedCallToSession.get(incoming.callId);
      if (pendingSessionId !== undefined) {
        if (pendingSessionId !== session.id) {
          throw new InvalidToolCallSessionError("Tool outputs reference call_ids from different sessions.");
        }
        const pending = this.validatePendingToolOutput(session, incoming.callId, incoming.output);
        pendingOutputs.push({ ...incoming, pending });
        continue;
      }
      if (completedSessionId !== undefined) {
        if (completedSessionId !== session.id) {
          throw new InvalidToolCallSessionError("Tool outputs reference call_ids from different sessions.");
        }
        const completed = session.completedToolCalls.get(incoming.callId);
        if (!completed) {
          throw new InvalidToolCallSessionError(`Tool output references unknown call_id: ${incoming.callId}`);
        }
        if (completed.outputDigest !== digestToolOutput(incoming.output)) {
          throw new InvalidToolCallSessionError(
            `Completed tool output changed while replaying call_id: ${incoming.callId}`,
          );
        }
        historical.push(completed);
        continue;
      }
      throw new InvalidToolCallSessionError(`Tool output references unknown call_id: ${incoming.callId}`);
    }

    if (!allowParallel && pendingOutputs.length > 1) {
      throw new InvalidToolCallSessionError(
        `Parallel tool outputs are not supported; received ${pendingOutputs.length} active pending call_ids.`,
      );
    }

    const active = pendingOutputs.map(({ callId, output }) => {
      const { pending, firstReceipt } = this.stagePendingToolOutput(session, callId, output);
      return { callId, output, pending, firstReceipt };
    });
    return { active, historical };
  }

  validatePendingToolOutput(session: Session, callId: string, output: string): PendingToolCall {
    const sessionId = this.callToSession.get(callId);
    const pending = session.pendingToolCalls.get(callId);
    if (sessionId !== session.id || !pending) {
      throw new InvalidToolCallSessionError(`Tool output references unknown call_id: ${callId}`);
    }
    if (pending.stagedOutput !== undefined && pending.stagedOutput !== output) {
      throw new InvalidToolCallSessionError(`Tool output changed while retrying call_id: ${callId}`);
    }
    return pending;
  }

  stagePendingToolOutput(session: Session, callId: string, output: string): { pending: PendingToolCall; firstReceipt: boolean } {
    const pending = this.validatePendingToolOutput(session, callId, output);
    const firstReceipt = pending.stagedOutput === undefined;
    if (firstReceipt) pending.stagedOutput = output;
    session.lastActivity = this.now();
    return { pending, firstReceipt };
  }

  completePendingToolCall(session: Session, callId: string): CompletedToolCall | undefined {
    const sessionId = this.callToSession.get(callId);
    const pending = session.pendingToolCalls.get(callId);
    if (sessionId !== session.id || !pending) return undefined;
    if (pending.stagedOutput === undefined) {
      throw new Error(`Cannot complete unstaged tool call: ${callId}`);
    }
    const completed: CompletedToolCall = {
      callId,
      toolName: pending.tool.name,
      outputDigest: digestToolOutput(pending.stagedOutput),
    };
    session.pendingToolCalls.delete(callId);
    this.callToSession.delete(callId);
    session.completedToolCalls.set(callId, completed);
    this.completedCallToSession.set(callId, session.id);
    session.lastActivity = this.now();
    return completed;
  }

  recordUsage(
    session: Session,
    evrenResponseId: string,
    usage: EvrenUsage,
    classification: RequestClassification = "unclassified",
  ): boolean {
    session.lastUsage = { ...usage };
    if (session.accountedEvrenResponseIds.has(evrenResponseId)) return false;
    session.accountedEvrenResponseIds.add(evrenResponseId);
    session.usage.inputTokens += usage.inputTokens;
    session.usage.outputTokens += usage.outputTokens;
    session.usage.totalTokens += usage.totalTokens;
    addUsage(session.usageByClass[classification], usage);
    session.lastActivity = this.now();
    return true;
  }

  markForeground(session: Session): void {
    if (this.sessions.get(session.id) !== session) {
      throw new Error(`Cannot focus unknown session: ${session.id}`);
    }
    this.currentSessionId = session.id;
  }

  getCurrent(): Session | undefined {
    this.prune();
    const current = this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
    return current ?? this.getLatest();
  }

  getLatest(): Session | undefined {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())[0];
  }

  getByResponseId(responseId: string): Session | undefined {
    const sessionId = this.responseToSession.get(responseId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  prune(): number {
    const cutoff = this.now().getTime() - this.ttlMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastActivity.getTime() >= cutoff) continue;
      for (const responseId of session.responseIds) this.responseToSession.delete(responseId);
      for (const callId of session.pendingToolCalls.keys()) this.callToSession.delete(callId);
      for (const callId of session.completedToolCalls.keys()) this.completedCallToSession.delete(callId);
      for (const [threadId, sessionId] of this.threadToSession) {
        if (sessionId === id) this.threadToSession.delete(threadId);
      }
      this.sessions.delete(id);
      if (this.currentSessionId === id) this.currentSessionId = undefined;
      removed += 1;
    }
    return removed;
  }
}

function digestToolOutput(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}

function digestIdentity(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
