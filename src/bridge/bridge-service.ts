import type { BridgeConfig } from "../config.js";
import type {
  EvrenNativeResult,
  EvrenRequestContext,
  EvrenResponseTiming,
  EvrenTransport,
} from "../evren/client.js";
import type { EvrenUsage } from "../evren/extract-response.js";
import { assertPostUsageAllowed, assertRequestAllowed, assertToolCallAllowed, assertToolCallsAllowed, LimitExceededError } from "../safety/limits.js";
import { assertCreditPolicyAllowed } from "../safety/credit-policy.js";
import { buildLimitRecovery } from "../safety/limit-recovery.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import {
  DeterministicRetryCircuit,
  fingerprintNativeEvrenRequest,
  RetryCircuitBlockedError,
} from "../safety/deterministic-retry-circuit.js";
import { estimateInputTokens } from "../safety/token-estimator.js";
import {
  InvalidToolCallSessionError,
  type PreparedToolOutputs,
  type InferenceReason,
  type InferenceTraceSummary,
  type Session,
  type SessionStore,
  type VerifiedSessionModelIdentity,
} from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EventSink } from "../ui/logger.js";
import type { RequestClassification } from "../usage/types.js";
import { buildEvrenPrompt, buildRepairPrompt, truncateToolOutput } from "./codex-to-evren.js";
import { buildCodexParallelToolResponse, buildCodexResponse, type BuiltCodexResponse } from "./evren-to-codex.js";
import {
  buildNativeEvrenRequest,
  nativeFunctionCall,
  nativeFunctionCallOutput,
  nativeMessage,
  type NativeEvrenRequest,
} from "./native-codex-to-evren.js";
import { parseNativeEvrenResponse } from "./native-evren-to-codex.js";
import { normalizeCodexRequest, InvalidRequestError, type NormalizedCodexRequest } from "./normalize-codex-request.js";
import { parseModelDecision, ToolProtocolError, type ModelDecision, type NormalizedTool } from "./tool-protocol.js";
import {
  fingerprintToolCall,
  fingerprintToolResult,
  NoProgressLoopError,
  recognizeToolPoll,
  ToolPollLimitError,
} from "./tool-polling.js";

export interface BridgeResult extends BuiltCodexResponse {
  stream: boolean;
  session: Session;
}

type ContinuationKind = "new_request" | "previous_response" | "tool_output" | "historical_replay" | "canonical_replay" | "compaction_adoption";

interface IncomingClassification {
  continuation: ContinuationKind;
  prepared: PreparedToolOutputs;
  replayedMessageIndexes: Set<number>;
}

interface InferenceMetrics {
  requestNumber: number;
  payloadChars: number;
  payloadBytes: number;
  historyItems: number;
  toolCount: number;
  instructionBytes: number;
  canonicalHistoryItems: number;
  canonicalHistoryBytes: number;
  currentInputItems: number;
  currentInputBytes: number;
  toolCatalogBytes: number;
  acceptedToolOutputBytes: number;
  sessionMetadataBytes: number;
  protocolWrapperBytes: number;
  encodedImageBytes: number;
  sourceImageBytes: number;
  requestClassification: RequestClassification;
  reason: InferenceReason;
  requestKind?: string;
  startedAt: number;
  requestSerializationMs: number;
  providerReturnedAt?: number;
  clientResultProcessingMs: number;
  trace: InferenceTraceSummary;
}

interface ContextBoundary {
  nativeHistoryItems: number;
  transcriptItems: number;
}

export class BridgeService {
  private readonly retryCircuit: DeterministicRetryCircuit;

  constructor(private readonly deps: {
    config: BridgeConfig;
    client: EvrenTransport;
    pricingGuard: Pick<PricingGuard, "assertAllowed">;
    sessions: SessionStore;
    usage: UsageTracker;
    logger: EventSink;
    retryCircuit?: DeterministicRetryCircuit;
    requireRequestedModel?: boolean;
  }) {
    this.retryCircuit = deps.retryCircuit ?? new DeterministicRetryCircuit();
  }

  async handle(body: unknown, abortSignal?: AbortSignal): Promise<BridgeResult> {
    const request = normalizeCodexRequest(body);
    if (abortSignal) request.abortSignal = abortSignal;
    if (this.deps.requireRequestedModel && request.model === undefined) {
      throw new InvalidRequestError("Desktop Codex request did not include an explicit model.");
    }
    if (request.model !== undefined && request.model !== this.deps.config.model) {
      throw new InvalidRequestError("Requested model does not match the active Desktop Bridge model.");
    }
    const effectiveUpstreamModel = this.deps.client.getEffectiveModel?.();
    if (effectiveUpstreamModel !== undefined && effectiveUpstreamModel !== this.deps.config.model) {
      throw new InvalidRequestError("Effective upstream model does not match the active Desktop Bridge model.");
    }
    const resolved = this.resolveSession(request);
    const session = resolved.session;
    const modelIdentity = {
      source: "bridge_session",
      agentRuntime: "Codex",
      providerBridge: "EVREN",
      upstreamInferenceModel: effectiveUpstreamModel ?? this.deps.config.model,
    } as const;
    session.modelIdentity = modelIdentity;
    const compactionAdopted = this.adoptCompactedContext(session, request);
    const boundary: ContextBoundary = {
      nativeHistoryItems: session.nativeHistory.length,
      transcriptItems: session.transcript.length,
    };
    const classification = this.classifyIncoming(session, request, resolved.canonicalReplay, compactionAdopted);
    const inferenceReason = classifyInferenceReason(request, classification);
    this.recordNoProgressResult(session, classification);
    this.assertNoProgressContinuationAllowed(session, classification);
    this.assertPollContinuationAllowed(session, classification);

    let activeToolCallIds: string[] = [];
    if (classification.continuation === "tool_output") {
      activeToolCallIds = this.appendIncoming(session, request.entries, classification);
    }

    this.deps.usage.assertCertain();
    this.deps.pricingGuard.assertAllowed();
    assertCreditPolicyAllowed(this.deps.config, this.deps.client.getCreditState?.());
    const tools = request.tools.length > 0 ? request.tools : [...session.tools.values()];
    request.tools = tools;
    session.tools = new Map(tools.map((tool) => [tool.name, tool]));

    if (classification.continuation !== "tool_output") {
      if (this.deps.config.toolTransport === "native" && request.instructions) {
        this.appendNativeInstruction(session, request.instructions);
      }
      this.appendIncoming(session, request.entries, classification);
    }

    const inferenceCountBefore = session.inferenceCount;
    try {
      const result = await (this.deps.config.toolTransport === "native"
        ? this.handleNative(request, session, tools, activeToolCallIds, boundary, modelIdentity, inferenceReason)
        : this.handleTextual(request, session, tools, activeToolCallIds, boundary, inferenceReason));
      this.recordSuccessfulWindowState(session, request);
      this.clearSatisfiedRecovery(session);
      return result;
    } catch (error) {
      if (error instanceof LimitExceededError) {
        const recovery = buildLimitRecovery(error, this.deps.config);
        session.limitRecovery = recovery;
        error.recoverable = recovery.recoverable;
        error.inferenceMade = session.inferenceCount !== inferenceCountBefore;
        if (recovery.recommended !== undefined) error.recommended = recovery.recommended;
        this.deps.logger.log({
          event: "LIMIT_RECOVERY_REQUIRED",
          level: "warn",
          message: recovery.recoverable
            ? session.inferenceCount === inferenceCountBefore
              ? "Local Bridge limit reached. No additional EVREN inference was made; use R in the Bridge terminal or F1 -> C, then continue in Codex."
              : "Local Bridge limit was reached after authoritative usage was recorded; use R in the Bridge terminal or F1 -> C, then continue in Codex."
            : "Local Bridge safety limit reached; review Custom configuration before continuing.",
          data: {
            limitName: recovery.limitName,
            current: recovery.current,
            limit: recovery.limit,
            recoverable: recovery.recoverable,
            ...(recovery.recommended === undefined ? {} : { recommended: recovery.recommended }),
          },
        });
      }
      throw error;
    }
  }

  private async handleNative(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
    boundary: ContextBoundary,
    modelIdentity: VerifiedSessionModelIdentity,
    inferenceReason: InferenceReason,
  ): Promise<BridgeResult> {
    const upstream = buildNativeEvrenRequest(
      request,
      session.nativeHistory,
      this.deps.config.model,
      this.deps.config.maxOutputTokensPerCall,
      modelIdentity,
    );
    const serializationStartedAt = performance.now();
    const serializedUpstream = JSON.stringify(upstream);
    const requestSerializationMs = performance.now() - serializationStartedAt;
    const requestFingerprint = fingerprintNativeEvrenRequest(upstream, serializedUpstream);
    try {
      this.retryCircuit.assertAllowed(requestFingerprint);
    } catch (error) {
      if (error instanceof RetryCircuitBlockedError) {
        this.deps.logger.log({
          event: "RETRY_CIRCUIT_BLOCKED",
          level: "warn",
          message: "Repeated deterministic native protocol failure blocked before EVREN inference.",
          data: { failureCode: error.failureCode },
        });
      }
      throw error;
    }
    this.beginRequest(session, tools, serializedUpstream, request);
    const metrics = this.startInference(
      session,
      serializedUpstream,
      upstream.input.length,
      upstream.tools.length,
      request.requestClassification,
      nativePayloadBreakdown(upstream, boundary.nativeHistoryItems, serializedUpstream),
      inferenceReason,
      request.requestKind,
      requestSerializationMs,
    );
    const result = await this.respondAndAccount(session, upstream, serializedUpstream, metrics, request);
    const processingStartedAt = Date.now();
    try {
    let decision: ReturnType<typeof parseNativeEvrenResponse>;
    try {
      decision = parseNativeEvrenResponse(result.raw, session.tools, request.parallelToolCalls);
    } catch (error) {
      if (error instanceof ToolProtocolError) {
        this.retryCircuit.recordFailure(requestFingerprint, error.code);
        throw enrichSaturatedProtocolError(
          error,
          result.usage.outputTokens >= this.deps.config.maxOutputTokensPerCall,
          this.deps.config.maxOutputTokensPerCall,
        );
      }
      throw error;
    }
    this.retryCircuit.recordSuccess(requestFingerprint);
    if (decision.kind === "tool_call" && decision.returnedCallCount > 1) {
      this.deps.logger.log({
        event: "NATIVE_MULTI_TOOL_SERIALIZED",
        level: "warn",
        message: `${decision.returnedCallCount} calls → serialized to 1 because Codex disabled parallel tool calls.`,
        data: { returnedCallCount: decision.returnedCallCount, selectedTool: decision.name },
      });
    }
    if (decision.kind === "tool_calls" && !request.parallelToolCalls) {
      this.deps.logger.log({
        event: "NATIVE_MULTI_TOOL_SERIALIZED",
        level: "warn",
        message: `${decision.calls.length} calls → serialized to 1 because Codex disabled parallel tool calls.`,
        data: { returnedCallCount: decision.calls.length, selectedTool: decision.calls[0]!.name },
      });
      const first = decision.calls[0]!;
      decision = { kind: "tool_call", ...first, returnedCallCount: decision.calls.length };
    }
    if (decision.kind === "tool_call") assertToolCallAllowed(this.deps.config, session);
    if (decision.kind === "tool_calls") assertToolCallsAllowed(this.deps.config, session, decision.calls.length);

    if (decision.kind === "tool_calls") {
      delete session.polling.active;
      const built = buildCodexParallelToolResponse(
        decision.calls,
        this.deps.config.model,
        result.usage,
        session.tools,
      );
      this.deps.sessions.recordResponse(session, built.response.id);
      for (const call of decision.calls) {
        const tool = session.tools.get(call.name);
        if (!tool) throw new Error("Tool disappeared while recording a native parallel call.");
        this.deps.sessions.recordPendingToolCall(session, { callId: call.callId, tool });
        session.nativeHistory.push(nativeFunctionCall(call.callId, call.name, call.argumentsJson));
        session.transcript.push({
          role: "assistant",
          text: `Requested tool ${call.name} with arguments ${call.argumentsJson}`,
          toolName: call.name,
          callId: call.callId,
        });
        this.deps.logger.log({ event: "NATIVE_TOOL_REQUEST", data: { tool: call.name } });
        this.deps.logger.log({ event: "TOOL_REQUEST", data: { tool: call.name } });
      }
      session.toolCallCount += decision.calls.length;
      this.completeActiveCalls(session, activeToolCallIds);
      return { ...built, stream: request.stream, session };
    }

    const modelDecision: ModelDecision = decision.kind === "final"
      ? decision
      : { kind: "tool_call", name: decision.name, arguments: decision.arguments };
    const pollIdentityHash = this.recordPollDecision(session, modelDecision, result.usage);
    const built = buildCodexResponse(
      modelDecision,
      this.deps.config.model,
      result.usage,
      session.tools,
      decision.kind === "tool_call"
        ? { callId: decision.callId, argumentsJson: decision.argumentsJson }
        : {},
    );
    built.response.parallel_tool_calls = request.parallelToolCalls;
    this.deps.sessions.recordResponse(session, built.response.id);

    if (decision.kind === "tool_call" && built.callId) {
      const tool = session.tools.get(decision.name);
      if (!tool) throw new Error("Tool disappeared while recording the native call.");
      session.toolCallCount += 1;
      this.deps.sessions.recordPendingToolCall(session, {
        callId: built.callId,
        tool,
        toolCallFingerprint: fingerprintToolCall(decision.name, decision.arguments),
        ...(pollIdentityHash === undefined ? {} : { pollIdentityHash }),
      });
      session.nativeHistory.push(nativeFunctionCall(built.callId, decision.name, decision.argumentsJson));
      session.transcript.push({
        role: "assistant",
        text: `Requested tool ${decision.name} with arguments ${decision.argumentsJson}`,
        toolName: decision.name,
        callId: built.callId,
      });
      this.deps.logger.log({
        event: "NATIVE_TOOL_REQUEST",
        data: { tool: decision.name },
      });
      this.deps.logger.log({
        event: "TOOL_REQUEST",
        data: { tool: decision.name },
      });
    } else if (decision.kind === "final") {
      session.nativeHistory.push(nativeMessage("assistant", decision.content));
      session.transcript.push({ role: "assistant", text: decision.content });
      this.deps.logger.log({ event: "RESPONSE_FINALIZED" });
    }

    this.completeActiveCalls(session, activeToolCallIds);
    return { ...built, stream: request.stream, session };
    } finally {
      this.completeInferenceProcessing(session, metrics, Date.now() - processingStartedAt);
    }
  }

  private async handleTextual(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
    boundary: ContextBoundary,
    inferenceReason: InferenceReason,
  ): Promise<BridgeResult> {
    const prompt = buildEvrenPrompt(request, session);
    this.beginRequest(session, tools, prompt, request);
    let decision: ModelDecision;
    let aggregate: EvrenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const first = await this.inferAndAccount(session, prompt, tools.length, request, boundary, inferenceReason);
    aggregate = addUsage(aggregate, first.usage);
    const firstProcessingStartedAt = Date.now();
    let firstProcessingCompleted = false;
    const completeFirstProcessing = (): void => {
      if (firstProcessingCompleted) return;
      firstProcessingCompleted = true;
      this.completeInferenceProcessing(session, first.metrics, Date.now() - firstProcessingStartedAt);
    };
    try {
      decision = parseModelDecision(first.text, session.tools);
    } catch (error) {
      completeFirstProcessing();
      if (!(error instanceof ToolProtocolError)) throw error;
      if (!error.repairable) {
        throw enrichSaturatedProtocolError(
          error,
          first.usage.outputTokens >= this.deps.config.maxOutputTokensPerCall,
          this.deps.config.maxOutputTokensPerCall,
        );
      }
      const repairPrompt = buildRepairPrompt(first.text, error.message, tools);
      this.assertRepairAllowed(session, repairPrompt);
      this.deps.logger.log({ event: "PROTOCOL_REPAIR", level: "warn", message: error.message });
      const repaired = await this.inferAndAccount(
        session,
        repairPrompt,
        tools.length,
        request,
        boundary,
        "protocol_repair",
        opaqueCurrentInputBreakdown(repairPrompt),
      );
      aggregate = addUsage(aggregate, repaired.usage);
      const repairProcessingStartedAt = Date.now();
      try {
        decision = parseModelDecision(repaired.text, session.tools);
      } catch (repairError) {
        if (repairError instanceof ToolProtocolError) {
          throw enrichSaturatedProtocolError(
            repairError,
            repaired.usage.outputTokens >= this.deps.config.maxOutputTokensPerCall,
            this.deps.config.maxOutputTokensPerCall,
          );
        }
        throw repairError;
      } finally {
        this.completeInferenceProcessing(session, repaired.metrics, Date.now() - repairProcessingStartedAt);
      }
    }
    completeFirstProcessing();

    if (decision.kind === "tool_call") assertToolCallAllowed(this.deps.config, session);
    const pollIdentityHash = this.recordPollDecision(session, decision, aggregate);
    const built = buildCodexResponse(decision, this.deps.config.model, aggregate, session.tools);
    this.deps.sessions.recordResponse(session, built.response.id);
    if (decision.kind === "tool_call" && built.callId) {
      const tool = session.tools.get(decision.name);
      if (!tool) throw new Error("Tool disappeared while recording the call.");
      session.toolCallCount += 1;
      this.deps.sessions.recordPendingToolCall(session, {
        callId: built.callId,
        tool,
        toolCallFingerprint: fingerprintToolCall(decision.name, decision.arguments),
        ...(pollIdentityHash === undefined ? {} : { pollIdentityHash }),
      });
      session.transcript.push({
        role: "assistant",
        text: `Requested tool ${decision.name} with arguments ${JSON.stringify(decision.arguments)}`,
        toolName: decision.name,
        callId: built.callId,
      });
      this.deps.logger.log({
        event: "TOOL_REQUEST",
        data: { tool: decision.name },
      });
    } else if (decision.kind === "final") {
      session.transcript.push({ role: "assistant", text: decision.content });
      this.deps.logger.log({ event: "RESPONSE_FINALIZED" });
    }
    this.completeActiveCalls(session, activeToolCallIds);
    return { ...built, stream: request.stream, session };
  }

  private beginRequest(
    session: Session,
    tools: NormalizedTool[],
    estimatedInput: string,
    request: NormalizedCodexRequest,
  ): void {
    const estimate = assertRequestAllowed(this.deps.config, session, this.deps.usage.snapshot(), estimatedInput);
    session.requestCount += 1;
    session.lastActivity = new Date();
    if (request.foreground) this.deps.sessions.markForeground(session);
    this.deps.logger.log({
      event: "CODEX_REQUEST",
      data: {
        request: session.requestCount,
        transport: this.deps.config.toolTransport,
        toolCount: tools.length,
        inputEstimate: estimate,
        approximate: true,
        foreground: request.foreground,
        classification: request.requestClassification,
        ...(request.requestKind === undefined ? {} : { requestKind: request.requestKind }),
        unknownFields: request.unknownFields,
      },
    });
    this.deps.logger.log({
      event: "TOOL_CATALOG",
      level: "debug",
      data: {
        tools: tools.map((tool) => ({
          name: tool.name,
          kind: tool.kind,
        })),
      },
    });
  }

  private appendIncoming(
    session: Session,
    entries: NormalizedCodexRequest["entries"],
    classification: IncomingClassification,
  ): string[] {
    const { continuation, prepared, replayedMessageIndexes } = classification;

    for (const completed of prepared.historical) {
      this.deps.logger.log({
        event: "TOOL_HISTORY_REPLAY_IGNORED",
        level: "debug",
        data: { tool: completed.toolName },
      });
    }

    for (const [entryIndex, entry] of entries.entries()) {
      if (entry.role === "tool") {
        if (!entry.callId) throw new InvalidRequestError("Tool output is missing call_id.");
        const staged = prepared.active.find((active) => active.callId === entry.callId);
        if (!staged || !staged.firstReceipt) continue;
        const text = truncateToolOutput(entry.text, this.deps.config.toolOutputMaxChars);
        session.transcript.push({ role: "tool", text, toolName: staged.pending.tool.name, callId: entry.callId });
        if (this.deps.config.toolTransport === "native") {
          session.nativeHistory.push(nativeFunctionCallOutput(entry.callId, text));
          this.deps.logger.log({
            event: "NATIVE_TOOL_RESULT",
            data: { tool: staged.pending.tool.name, chars: text.length },
          });
        }
        this.deps.logger.log({
          event: "TOOL_RESULT",
          data: { tool: staged.pending.tool.name, chars: text.length },
        });
        continue;
      }
      if (continuation === "tool_output") continue;
      if (continuation === "compaction_adoption") continue;
      if (replayedMessageIndexes.has(entryIndex)) continue;
      if ((continuation === "previous_response" || continuation === "historical_replay" || continuation === "canonical_replay")
        && entry.role === "assistant") continue;
      session.transcript.push({ role: entry.role, text: entry.text });
      if (this.deps.config.toolTransport === "native") {
        session.nativeHistory.push(nativeMessage(entry.role, entry.text, entry.nativeContent));
      }
    }
    return prepared.active.map((active) => active.callId);
  }

  private classifyIncoming(
    session: Session,
    request: NormalizedCodexRequest,
    canonicalReplay: boolean,
    compactionAdopted: boolean,
  ): IncomingClassification {
    const toolEntries = request.entries.filter((entry) => entry.role === "tool");
    if (toolEntries.length === 0) {
      const detectedReplayIndexes = this.findReplayedMessageIndexes(session, request.entries);
      const threadReplay = request.turnMetadata.threadId !== undefined && detectedReplayIndexes.size > 0;
      const continuation = compactionAdopted
        ? "compaction_adoption"
        : request.previousResponseId
        ? "previous_response"
        : canonicalReplay || threadReplay
          ? "canonical_replay"
          : "new_request";
      const replayedMessageIndexes = continuation === "compaction_adoption"
        ? new Set(request.entries.map((_entry, index) => index))
        : continuation === "previous_response" || continuation === "canonical_replay"
        ? detectedReplayIndexes
        : new Set<number>();
      if (continuation === "canonical_replay" && request.requestClassification !== "internal") {
        const hasNewUserInput = request.entries.some((entry, index) =>
          entry.role === "user" && entry.text.trim().length > 0 && !replayedMessageIndexes.has(index),
        );
        if (!hasNewUserInput) {
          throw new InvalidToolCallSessionError("Canonical replay contains no new user message.");
        }
      }
      return {
        continuation,
        prepared: { active: [], historical: [] },
        replayedMessageIndexes,
      };
    }

    const prepared = this.deps.sessions.prepareIncomingToolOutputs(session, toolEntries.map((entry) => {
      if (!entry.callId) throw new InvalidRequestError("Tool output is missing call_id.");
      return { callId: entry.callId, output: entry.text };
    }), this.deps.config.toolTransport === "native");
    if (prepared.active.length > 0) {
      return { continuation: "tool_output", prepared, replayedMessageIndexes: new Set<number>() };
    }

    const replayedMessageIndexes = this.findReplayedMessageIndexes(session, request.entries);
    let lastToolIndex = -1;
    for (const [index, entry] of request.entries.entries()) {
      if (entry.role === "tool") lastToolIndex = index;
    }
    const hasNewUserInput = request.entries.some((entry, index) =>
      index > lastToolIndex
      && entry.role === "user"
      && entry.text.trim().length > 0
      && !replayedMessageIndexes.has(index),
    );
    if (!hasNewUserInput) {
      throw new InvalidToolCallSessionError(
        "Tool output continuation contains only completed historical call_ids.",
      );
    }
    return { continuation: "historical_replay", prepared, replayedMessageIndexes };
  }

  private resolveSession(request: NormalizedCodexRequest): { session: Session; canonicalReplay: boolean } {
    const threadId = request.turnMetadata.threadId;
    if (request.previousResponseId) {
      const session = this.deps.sessions.resolve(request.previousResponseId);
      if (threadId) this.deps.sessions.assertThreadAssociation(session, threadId);
      return { session, canonicalReplay: false };
    }
    if (threadId) {
      const threaded = this.deps.sessions.resolveByThreadId(threadId);
      if (threaded) {
        if (request.toolOutputCallIds.length === 0) return { session: threaded, canonicalReplay: false };
        try {
          const byCalls = this.deps.sessions.resolveByToolCallIds(request.toolOutputCallIds);
          this.deps.sessions.assertThreadAssociation(byCalls, threadId);
          return { session: byCalls, canonicalReplay: false };
        } catch (error) {
          if (this.adoptHistoricalToolReplay(threaded, request)) return { session: threaded, canonicalReplay: true };
          throw error;
        }
      }
    }
    if (request.toolOutputCallIds.length > 0) {
      try {
        const session = this.deps.sessions.resolveByToolCallIds(request.toolOutputCallIds);
        if (threadId) this.deps.sessions.assertThreadAssociation(session, threadId);
        return { session, canonicalReplay: false };
      } catch (error) {
        if (!threadId) throw error;
        const session = this.deps.sessions.resolve();
        this.deps.sessions.associateThread(session, threadId);
        if (this.adoptHistoricalToolReplay(session, request)) return { session, canonicalReplay: true };
        throw error;
      }
    }
    const replay = this.deps.sessions.resolveByCanonicalReplay(
      request.entries.flatMap((entry) => entry.role === "tool"
        ? []
        : [{ role: entry.role, text: entry.text }]),
    );
    if (replay) {
      if (threadId) this.deps.sessions.associateThread(replay, threadId);
      return { session: replay, canonicalReplay: true };
    }
    const session = this.deps.sessions.resolve();
    if (threadId) this.deps.sessions.associateThread(session, threadId);
    return { session, canonicalReplay: false };
  }

  private adoptHistoricalToolReplay(session: Session, request: NormalizedCodexRequest): boolean {
    if (!request.foreground
      || request.requestClassification !== "foreground"
      || session.pendingToolCalls.size > 0
      || session.completedToolCalls.size > 0
      || session.transcript.length > 0) return false;
    const outputs = request.entries.filter((entry) => entry.role === "tool" && entry.callId);
    if (outputs.length === 0 || outputs.length !== request.toolOutputCallIds.length) return false;
    const lastOutputIndex = Math.max(...outputs.map((entry) => entry.inputIndex));
    const currentUser = [...request.entries].reverse().find((entry) =>
      entry.role === "user" && entry.inputIndex > lastOutputIndex && entry.text.trim().length > 0,
    );
    if (!currentUser) return false;

    const calls = new Map<string, typeof request.historicalToolCalls[number]>();
    for (const call of request.historicalToolCalls) {
      if (calls.has(call.callId)) return false;
      calls.set(call.callId, call);
    }
    for (const output of outputs) {
      const call = calls.get(output.callId!);
      if (!call || call.inputIndex >= output.inputIndex || output.inputIndex >= currentUser.inputIndex) return false;
    }

    const replayItems = [
      ...request.entries
        .filter((entry) => entry.inputIndex < currentUser.inputIndex)
        .map((entry) => ({ inputIndex: entry.inputIndex, kind: "entry" as const, entry })),
      ...request.historicalToolCalls
        .filter((call) => call.inputIndex < currentUser.inputIndex && outputs.some((entry) => entry.callId === call.callId))
        .map((call) => ({ inputIndex: call.inputIndex, kind: "call" as const, call })),
    ].sort((left, right) => left.inputIndex - right.inputIndex);

    for (const item of replayItems) {
      if (item.kind === "call") {
        session.nativeHistory.push(nativeFunctionCall(item.call.callId, item.call.name, item.call.argumentsJson));
        continue;
      }
      const entry = item.entry;
      if (entry.role === "tool") {
        const call = calls.get(entry.callId!);
        if (!call) return false;
        const text = truncateToolOutput(entry.text, this.deps.config.toolOutputMaxChars);
        session.transcript.push({ role: "tool", text, toolName: call.name, callId: entry.callId! });
        session.nativeHistory.push(nativeFunctionCallOutput(entry.callId!, text));
        this.deps.sessions.adoptHistoricalToolCall(session, {
          callId: entry.callId!,
          toolName: call.name,
          output: entry.text,
        });
        continue;
      }
      session.transcript.push({ role: entry.role, text: entry.text });
      session.nativeHistory.push(nativeMessage(entry.role, entry.text, entry.nativeContent));
    }
    this.deps.logger.log({
      event: "TOOL_HISTORY_ADOPTED",
      level: "info",
      data: { completedToolCalls: outputs.length },
    });
    return true;
  }

  private adoptCompactedContext(session: Session, request: NormalizedCodexRequest): boolean {
    const pending = session.pendingCompaction;
    if (!pending || request.requestKind === "compaction") return false;
    const metadata = request.turnMetadata;
    const transitioned = changedIdentity(pending.windowId ?? session.context.windowId, metadata.windowId)
      || changedIdentity(pending.contextWindowId ?? session.context.contextWindowId, metadata.contextWindowId)
      || advancedWindow(pending.windowNumber ?? session.context.windowNumber, metadata.windowNumber);
    if (!transitioned) return false;
    if (request.entries.some((entry) => entry.role === "tool")) return false;
    const canonicalEntries = request.entries.filter(
      (entry): entry is typeof entry & { role: "developer" | "user" | "assistant" } => entry.role !== "tool",
    );
    if (canonicalEntries.length === 0) return false;

    const transcript = canonicalEntries.map((entry) => ({ role: entry.role, text: entry.text }));
    const nativeHistory = [
      ...(request.instructions ? [nativeMessage("developer", request.instructions)] : []),
      ...canonicalEntries.map((entry) => nativeMessage(entry.role, entry.text, entry.nativeContent)),
    ];
    const previousItems = session.nativeHistory.length;
    const previousBytes = jsonBytes(session.nativeHistory);
    this.deps.sessions.replaceActiveContext(session, {
      transcript,
      nativeHistory,
      ...(metadata.windowId === undefined ? {} : { windowId: metadata.windowId }),
      ...(metadata.windowNumber === undefined ? {} : { windowNumber: metadata.windowNumber }),
      ...(metadata.contextWindowId === undefined ? {} : { contextWindowId: metadata.contextWindowId }),
    });
    this.deps.logger.log({
      event: "CONTEXT_WINDOW_COMPACTED",
      data: {
        previousItemCount: previousItems,
        newItemCount: nativeHistory.length,
        previousBytes,
        newBytes: jsonBytes(nativeHistory),
        compactionCount: session.acceptedCompactionCount,
      },
    });
    return true;
  }

  private recordSuccessfulWindowState(session: Session, request: NormalizedCodexRequest): void {
    const metadata = request.turnMetadata;
    if (request.requestKind === "compaction") {
      session.pendingCompaction = {
        requestedAt: new Date(),
        ...(metadata.windowId === undefined ? {} : { windowId: metadata.windowId }),
        ...(metadata.windowNumber === undefined ? {} : { windowNumber: metadata.windowNumber }),
        ...(metadata.contextWindowId === undefined ? {} : { contextWindowId: metadata.contextWindowId }),
      };
      return;
    }
    if (metadata.windowId !== undefined) session.context.windowId = metadata.windowId;
    if (metadata.windowNumber !== undefined) session.context.windowNumber = metadata.windowNumber;
    if (metadata.contextWindowId !== undefined) session.context.contextWindowId = metadata.contextWindowId;
  }

  private clearSatisfiedRecovery(session: Session): void {
    const recovery = session.limitRecovery;
    if (!recovery) return;
    const limit = recovery.limitName === "MAX_SESSION_TOKENS"
      ? this.deps.config.maxSessionTokens
      : recovery.limitName === "MAX_REQUESTS_PER_SESSION"
        ? this.deps.config.maxRequestsPerSession
        : recovery.limitName === "MAX_TOOL_CALLS_PER_SESSION"
          ? this.deps.config.maxToolCallsPerSession
          : recovery.limit;
    if (limit > recovery.current) delete session.limitRecovery;
  }

  private findReplayedMessageIndexes(
    session: Session,
    entries: NormalizedCodexRequest["entries"],
  ): Set<number> {
    const includesToolOutput = entries.some((entry) => entry.role === "tool");
    const canonical = session.transcript.filter((entry) => entry.role === "tool" || (
      (entry.role === "developer" || entry.role === "user" || entry.role === "assistant")
      && entry.callId === undefined
      && entry.toolName === undefined
    ));
    if (includesToolOutput) {
      let best = new Set<number>();
      for (let start = 0; start < canonical.length; start += 1) {
        const candidate = new Set<number>();
        let matchedTool = false;
        let matchedCount = 0;
        for (const [entryIndex, entry] of entries.entries()) {
          const expected = canonical[start + matchedCount];
          if (!expected || !replayedEntryMatches(entry, expected)) break;
          if (entry.role === "tool") matchedTool = true;
          else candidate.add(entryIndex);
          matchedCount += 1;
        }
        if (matchedTool && candidate.size > best.size) best = candidate;
      }
      return best;
    }

    if (!entries.some((entry) => entry.role === "assistant")) return new Set();
    const canonicalMessages = canonical.filter((entry) => entry.role !== "tool");
    const replayed = new Set<number>();
    let canonicalIndex = 0;
    for (const [entryIndex, entry] of entries.entries()) {
      if (entry.role === "tool") break;
      const expected = canonicalMessages[canonicalIndex];
      if (!expected || entry.role !== expected.role || entry.text !== expected.text) break;
      replayed.add(entryIndex);
      canonicalIndex += 1;
    }
    return replayed;
  }

  private appendNativeInstruction(session: Session, instruction: string): void {
    const exists = session.nativeHistory.some((item) => {
      if (item.type !== "message" || item.role !== "developer" || !Array.isArray(item.content)) return false;
      return item.content.some((block) => Boolean(block) && typeof block === "object"
        && (block as { text?: unknown }).text === instruction);
    });
    if (!exists) session.nativeHistory.push(nativeMessage("developer", instruction));
  }

  private completeActiveCalls(session: Session, callIds: readonly string[]): void {
    for (const callId of callIds) {
      if (!this.deps.sessions.completePendingToolCall(session, callId)) {
        throw new Error(`Staged tool call disappeared before commit: ${callId}`);
      }
    }
  }

  private async inferAndAccount(
    session: Session,
    prompt: string,
    toolCount: number,
    request: NormalizedCodexRequest,
    boundary: ContextBoundary,
    reason: InferenceReason,
    breakdown?: Pick<InferenceMetrics,
      "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
      | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"
      | "sessionMetadataBytes" | "protocolWrapperBytes" | "encodedImageBytes" | "sourceImageBytes">,
  ): Promise<{ text: string; usage: EvrenUsage; metrics: InferenceMetrics }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const serializationStartedAt = performance.now();
    const serialized = JSON.stringify({
      model: this.deps.config.model,
      input: prompt,
      max_output_tokens: this.deps.config.maxOutputTokensPerCall,
      stream: false,
    });
    const requestSerializationMs = performance.now() - serializationStartedAt;
    const metrics = this.startInference(
      session,
      serialized,
      session.transcript.length,
      toolCount,
      request.requestClassification,
      breakdown ?? textualPayloadBreakdown(request, session, boundary),
      reason,
      request.requestKind,
      requestSerializationMs,
    );
    const providerStartedAt = Date.now();
    try {
      const result = await this.deps.client.infer(
        prompt,
        this.deps.config.maxOutputTokensPerCall,
        this.modelRequestContext(request, metrics.requestNumber),
        { serializedBody: serialized },
      );
      metrics.providerReturnedAt = Date.now();
      this.recordProviderTiming(session, metrics, result.timing, metrics.providerReturnedAt - providerStartedAt);
      const usage = await this.accountUsage(session, result.id, result.usage, metrics);
      return { text: result.text, usage, metrics };
    } catch (error) {
      this.recordFailedInference(session, metrics, error, Date.now() - providerStartedAt);
      throw error;
    }
  }

  private async respondAndAccount(
    session: Session,
    request: Parameters<EvrenTransport["respond"]>[0],
    serializedRequest: string,
    metrics: InferenceMetrics,
    codexRequest: NormalizedCodexRequest,
  ): Promise<EvrenNativeResult & { usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const providerStartedAt = Date.now();
    try {
      const result = await this.deps.client.respond(
        request,
        this.modelRequestContext(codexRequest, metrics.requestNumber),
        { serializedBody: serializedRequest },
      );
      metrics.providerReturnedAt = Date.now();
      this.recordProviderTiming(session, metrics, result.timing, metrics.providerReturnedAt - providerStartedAt);
      const usage = await this.accountUsage(session, result.id, result.usage, metrics);
      return { ...result, usage };
    } catch (error) {
      this.recordFailedInference(session, metrics, error, Date.now() - providerStartedAt);
      throw error;
    }
  }

  private modelRequestContext(request: NormalizedCodexRequest, inferenceNumber: number): EvrenRequestContext {
    return {
      bridgeModel: this.deps.config.model,
      ...(request.model === undefined ? {} : { codexRequestedModel: request.model }),
      ...(request.turnMetadata.threadId === undefined ? {} : { threadId: request.turnMetadata.threadId }),
      ...(request.turnMetadata.turnId === undefined ? {} : { turnId: request.turnMetadata.turnId }),
      ...(request.requestKind === undefined ? {} : { requestKind: request.requestKind }),
      inferenceNumber,
      ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
    };
  }

  private async accountUsage(
    session: Session,
    responseId: string,
    usage: EvrenUsage | undefined,
    metrics: InferenceMetrics,
  ): Promise<EvrenUsage> {
    if (!usage) {
      this.deps.usage.markUncertain();
      throw new UsageMissingError();
    }
    try {
      const addedToSession = this.deps.sessions.recordUsage(
        session,
        responseId,
        usage,
        metrics.requestClassification,
      );
      await this.deps.usage.record(responseId, usage, metrics.requestClassification);
      if (!addedToSession) this.deps.logger.log({ event: "USAGE_DEDUPLICATED" });
    } catch (error) {
      this.deps.usage.markUncertain();
      throw error;
    }
    metrics.trace.inputTokens = usage.inputTokens;
    metrics.trace.outputTokens = usage.outputTokens;
    metrics.trace.totalTokens = usage.totalTokens;
    if (usage.cachedTokens !== undefined) metrics.trace.cachedTokens = usage.cachedTokens;
    session.performanceObservability.peakInferenceInputTokens = Math.max(
      session.performanceObservability.peakInferenceInputTokens,
      usage.inputTokens,
    );
    this.deps.logger.log({
      event: "EVREN_USAGE",
      data: {
        request: metrics.requestNumber,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        payloadChars: metrics.payloadChars,
        payloadBytes: metrics.payloadBytes,
        historyItems: metrics.historyItems,
        toolCount: metrics.toolCount,
        instructionBytes: metrics.instructionBytes,
        canonicalHistoryItems: metrics.canonicalHistoryItems,
        canonicalHistoryBytes: metrics.canonicalHistoryBytes,
        currentInputItems: metrics.currentInputItems,
        currentInputBytes: metrics.currentInputBytes,
        toolCatalogBytes: metrics.toolCatalogBytes,
        acceptedToolOutputBytes: metrics.acceptedToolOutputBytes,
        sessionMetadataBytes: metrics.sessionMetadataBytes,
        protocolWrapperBytes: metrics.protocolWrapperBytes,
        encodedImageBytes: metrics.encodedImageBytes,
        sourceImageBytes: metrics.sourceImageBytes,
        reason: metrics.reason,
        requestSerializationMs: metrics.requestSerializationMs,
        providerWaitMs: metrics.trace.providerWaitMs,
        responseParseMs: metrics.trace.responseParseMs,
        classification: metrics.requestClassification,
      },
    });
    session.lastOutputBudgetSaturated = usage.outputTokens >= this.deps.config.maxOutputTokensPerCall;
    if (session.lastOutputBudgetSaturated) {
      session.outputBudgetSaturationCount += 1;
      this.deps.logger.log({
        event: "OUTPUT_BUDGET_SATURATED",
        level: "warn",
        message: `Output budget reached: ${usage.outputTokens} / ${this.deps.config.maxOutputTokensPerCall}. This is saturation evidence, not proof of truncation.`,
        data: {
          outputTokens: usage.outputTokens,
          maxOutputTokens: this.deps.config.maxOutputTokensPerCall,
        },
      });
    }
    assertPostUsageAllowed(this.deps.config, session, this.deps.usage.snapshot());
    return usage;
  }

  private startInference(
    session: Session,
    serializedPayload: string,
    historyItems: number,
    toolCount: number,
    requestClassification: RequestClassification,
    breakdown: Omit<InferenceMetrics,
      "requestNumber" | "payloadChars" | "payloadBytes" | "historyItems" | "toolCount" | "requestClassification"
      | "reason" | "requestKind" | "startedAt" | "requestSerializationMs" | "providerReturnedAt"
      | "clientResultProcessingMs" | "trace">,
    reason: InferenceReason,
    requestKind: string | undefined,
    requestSerializationMs: number,
  ): InferenceMetrics {
    session.inferenceCount += 1;
    requestSerializationMs = Math.max(0, Math.round(requestSerializationMs));
    const payloadBytes = Buffer.byteLength(serializedPayload, "utf8");
    breakdown.protocolWrapperBytes = Math.max(0, payloadBytes
      - breakdown.instructionBytes
      - breakdown.sessionMetadataBytes
      - breakdown.canonicalHistoryBytes
      - breakdown.currentInputBytes
      - breakdown.toolCatalogBytes);
    const activeContextBytes = breakdown.instructionBytes
      + breakdown.canonicalHistoryBytes
      + breakdown.currentInputBytes;
    session.contextObservability.totalUpstreamPayloadBytes += payloadBytes;
    session.contextObservability.canonicalHistoryReplayBytes += breakdown.canonicalHistoryBytes;
    session.contextObservability.currentInputBytes += breakdown.currentInputBytes;
    session.contextObservability.toolCatalogBytes += breakdown.toolCatalogBytes;
    session.contextObservability.acceptedToolOutputReplayBytes += breakdown.acceptedToolOutputBytes;
    session.contextObservability.instructionBytes += breakdown.instructionBytes;
    session.contextObservability.sessionMetadataBytes += breakdown.sessionMetadataBytes;
    session.contextObservability.protocolWrapperBytes += breakdown.protocolWrapperBytes;
    session.contextObservability.encodedImageBytes += breakdown.encodedImageBytes;
    session.contextObservability.sourceImageBytes += breakdown.sourceImageBytes;
    session.contextObservability.currentActiveContextBytes = activeContextBytes;
    session.contextObservability.peakActiveContextBytes = Math.max(
      session.contextObservability.peakActiveContextBytes,
      activeContextBytes,
    );
    session.contextObservability.peakPayloadBytes = Math.max(
      session.contextObservability.peakPayloadBytes,
      payloadBytes,
    );
    session.performanceObservability.requestSerializationMs += requestSerializationMs;
    session.performanceObservability.reasonCounts[reason] += 1;
    const trace: InferenceTraceSummary = {
      inferenceNumber: session.inferenceCount,
      reason,
      requestClassification,
      ...(requestKind === undefined ? {} : { requestKind }),
      startedAt: Date.now(),
      payloadBytes,
      instructionBytes: breakdown.instructionBytes,
      canonicalHistoryBytes: breakdown.canonicalHistoryBytes,
      currentInputBytes: breakdown.currentInputBytes,
      toolCatalogBytes: breakdown.toolCatalogBytes,
      acceptedToolOutputBytes: breakdown.acceptedToolOutputBytes,
      sessionMetadataBytes: breakdown.sessionMetadataBytes,
      protocolWrapperBytes: breakdown.protocolWrapperBytes,
      encodedImageBytes: breakdown.encodedImageBytes,
      sourceImageBytes: breakdown.sourceImageBytes,
      requestSerializationMs,
    };
    session.performanceObservability.traces.push(trace);
    session.performanceObservability.traces = session.performanceObservability.traces.slice(-128);
    return {
      requestNumber: session.inferenceCount,
      payloadChars: serializedPayload.length,
      payloadBytes,
      historyItems,
      toolCount,
      requestClassification,
      reason,
      ...(requestKind === undefined ? {} : { requestKind }),
      startedAt: trace.startedAt,
      requestSerializationMs,
      clientResultProcessingMs: 0,
      trace,
      ...breakdown,
    };
  }

  private recordProviderTiming(
    session: Session,
    metrics: InferenceMetrics,
    timing: EvrenResponseTiming | undefined,
    fallbackElapsedMs: number,
  ): void {
    const providerWaitMs = timing?.providerWaitMs ?? fallbackElapsedMs;
    const responseParseMs = timing?.responseParseMs ?? 0;
    metrics.clientResultProcessingMs = timing?.resultProcessingMs ?? 0;
    metrics.trace.providerWaitMs = providerWaitMs;
    metrics.trace.responseParseMs = responseParseMs;
    session.performanceObservability.providerWaitMs += providerWaitMs;
    session.performanceObservability.responseParseMs += responseParseMs;
  }

  private completeInferenceProcessing(session: Session, metrics: InferenceMetrics, bridgeProcessingMs: number): void {
    if (metrics.trace.totalElapsedMs !== undefined) return;
    const bridgeAfterProviderMs = metrics.providerReturnedAt === undefined
      ? bridgeProcessingMs
      : Date.now() - metrics.providerReturnedAt;
    const resultProcessingMs = metrics.clientResultProcessingMs + Math.max(0, bridgeAfterProviderMs);
    metrics.trace.resultProcessingMs = resultProcessingMs;
    metrics.trace.totalElapsedMs = Math.max(0, Date.now() - metrics.startedAt);
    session.performanceObservability.resultProcessingMs += resultProcessingMs;
  }

  private recordFailedInference(
    session: Session,
    metrics: InferenceMetrics,
    error: unknown,
    providerElapsedMs: number,
  ): void {
    if (metrics.trace.providerWaitMs === undefined) {
      this.recordProviderTiming(session, metrics, undefined, providerElapsedMs);
    }
    metrics.trace.failureCode = safeFailureCode(error);
    this.completeInferenceProcessing(session, metrics, 0);
  }

  private assertPollContinuationAllowed(session: Session, classification: IncomingClassification): void {
    const limit = this.deps.config.maxConsecutiveToolPollInferences;
    if (limit === 0) return;
    const activeOutput = classification.prepared.active[0];
    const sequence = session.polling.active;
    if (!activeOutput?.pending.pollIdentityHash || !sequence
      || activeOutput.pending.pollIdentityHash !== sequence.identityHash
      || sequence.consecutivePolls < limit) return;
    this.deps.logger.log({
      event: "TOOL_POLL_LIMIT",
      level: "error",
      message: "Long-running tool polling reached the configured local safety cap; EVREN inference was not called.",
      data: {
        toolName: sequence.toolName,
        consecutivePolls: sequence.consecutivePolls,
        authoritativeTokensSpent: sequence.authoritativeTokensSpent,
        elapsedSeconds: elapsedSeconds(sequence.startedAt, sequence.lastPollAt),
      },
    });
    throw new ToolPollLimitError(sequence.consecutivePolls, limit);
  }

  private recordNoProgressResult(session: Session, classification: IncomingClassification): void {
    if (classification.prepared.active.length !== 1) {
      delete session.noProgress;
      return;
    }
    const active = classification.prepared.active[0]!;
    if (!active.firstReceipt || !active.pending.toolCallFingerprint) return;
    const fingerprint = fingerprintToolResult(active.pending.toolCallFingerprint, active.output);
    const previous = session.noProgress;
    session.noProgress = previous?.fingerprint === fingerprint
      ? {
        fingerprint,
        consecutiveResults: previous.consecutiveResults + 1,
      }
      : { fingerprint, consecutiveResults: 1 };
  }

  private assertNoProgressContinuationAllowed(session: Session, classification: IncomingClassification): void {
    const limit = this.deps.config.maxConsecutiveNoProgressInferences;
    if (limit === 0 || classification.prepared.active.length !== 1) return;
    const active = classification.prepared.active[0]!;
    if (!active.pending.toolCallFingerprint || !session.noProgress) return;
    const fingerprint = fingerprintToolResult(active.pending.toolCallFingerprint, active.output);
    if (session.noProgress.fingerprint !== fingerprint || session.noProgress.consecutiveResults < limit) return;
    this.deps.logger.log({
      event: "NO_PROGRESS_LOOP",
      level: "error",
      message: "Deterministic no-progress loop blocked before another EVREN inference.",
      data: { consecutiveResults: session.noProgress.consecutiveResults },
    });
    throw new NoProgressLoopError(session.noProgress.consecutiveResults, limit);
  }

  private recordPollDecision(
    session: Session,
    decision: ModelDecision,
    usage: EvrenUsage,
  ): string | undefined {
    if (decision.kind !== "tool_call") {
      delete session.polling.active;
      return undefined;
    }
    const recognized = recognizeToolPoll(decision.name, decision.arguments);
    if (!recognized) {
      delete session.polling.active;
      return undefined;
    }

    const now = new Date();
    const previous = session.polling.active;
    const active = previous?.identityHash === recognized.identityHash
      ? {
        ...previous,
        consecutivePolls: previous.consecutivePolls + 1,
        authoritativeTokensSpent: previous.authoritativeTokensSpent + usage.totalTokens,
        lastPollAt: now,
      }
      : {
        toolName: recognized.toolName,
        identityHash: recognized.identityHash,
        consecutivePolls: 1,
        authoritativeTokensSpent: usage.totalTokens,
        startedAt: now,
        lastPollAt: now,
        warningEmitted: false,
      };
    session.polling.active = active;
    session.polling.totalPollInferences += 1;
    session.polling.totalAuthoritativeTokens += usage.totalTokens;
    this.deps.logger.log({
      event: "TOOL_POLL",
      data: {
        toolName: active.toolName,
        consecutivePolls: active.consecutivePolls,
        authoritativeTokensSpent: active.authoritativeTokensSpent,
        elapsedSeconds: elapsedSeconds(active.startedAt, active.lastPollAt),
      },
    });
    if (!active.warningEmitted && active.consecutivePolls >= this.deps.config.toolPollWarningThreshold) {
      active.warningEmitted = true;
      this.deps.logger.log({
        event: "TOOL_POLL_WARNING",
        level: "warn",
        message: "Long-running tool polling is consuming model tokens.",
        data: {
          toolName: active.toolName,
          consecutivePolls: active.consecutivePolls,
          authoritativeTokensSpent: active.authoritativeTokensSpent,
          elapsedSeconds: elapsedSeconds(active.startedAt, active.lastPollAt),
        },
      });
    }
    return recognized.identityHash;
  }

  private assertRepairAllowed(session: Session, prompt: string): void {
    const config = this.deps.config;
    const daily = this.deps.usage.snapshot();
    if (session.usage.totalTokens >= config.maxSessionTokens) {
      throw new LimitExceededError("MAX_SESSION_TOKENS", session.usage.totalTokens, config.maxSessionTokens);
    }
    if (daily.totalTokens >= config.maxDailyTokens) {
      throw new LimitExceededError("MAX_DAILY_TOKENS", daily.totalTokens, config.maxDailyTokens);
    }
    const estimate = estimateInputTokens(prompt).tokens;
    if (estimate > config.maxEstimatedInputTokensPerCall) {
      throw new LimitExceededError("MAX_ESTIMATED_INPUT_TOKENS_PER_CALL", estimate, config.maxEstimatedInputTokensPerCall);
    }
    const reservedTokens = estimate + config.maxOutputTokensPerCall;
    if (session.usage.totalTokens + reservedTokens > config.maxSessionTokens) {
      throw new LimitExceededError("MAX_SESSION_TOKENS", session.usage.totalTokens, config.maxSessionTokens);
    }
    if (daily.totalTokens + reservedTokens > config.maxDailyTokens) {
      throw new LimitExceededError("MAX_DAILY_TOKENS", daily.totalTokens, config.maxDailyTokens);
    }
  }
}

function replayedEntryMatches(
  entry: NormalizedCodexRequest["entries"][number],
  canonical: Session["transcript"][number],
): boolean {
  if (entry.role !== canonical.role) return false;
  if (entry.role === "tool") return Boolean(entry.callId) && entry.callId === canonical.callId;
  return entry.text === canonical.text;
}

function addUsage(left: EvrenUsage, right: EvrenUsage): EvrenUsage {
  const cachedTokens = addOptionalUsage(left.cachedTokens, right.cachedTokens);
  const reasoningTokens = addOptionalUsage(left.reasoningTokens, right.reasoningTokens);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function addOptionalUsage(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function nativePayloadBreakdown(
  request: NativeEvrenRequest,
  historyBoundary: number,
  _serializedRequest: string,
): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"
  | "sessionMetadataBytes" | "protocolWrapperBytes" | "encodedImageBytes" | "sourceImageBytes"> {
  const identity = request.input.filter(isVerifiedModelIdentityMessage);
  const inputWithoutIdentity = request.input.filter((item) => !isVerifiedModelIdentityMessage(item));
  const instructions = inputWithoutIdentity.filter(isDeveloperMessage);
  const canonicalHistory = inputWithoutIdentity.slice(0, historyBoundary).filter((item) => !isDeveloperMessage(item));
  const currentInput = inputWithoutIdentity.slice(historyBoundary).filter((item) => !isDeveloperMessage(item));
  const images = imagePayloadSizes(request.input);
  return {
    instructionBytes: jsonBytes(instructions),
    canonicalHistoryItems: canonicalHistory.length,
    canonicalHistoryBytes: jsonBytes(canonicalHistory),
    currentInputItems: currentInput.length,
    currentInputBytes: jsonBytes(currentInput),
    toolCatalogBytes: jsonBytes(request.tools),
    acceptedToolOutputBytes: jsonBytes(canonicalHistory.filter((item) => item.type === "function_call_output")),
    sessionMetadataBytes: jsonBytes(identity),
    protocolWrapperBytes: 0,
    encodedImageBytes: images.encodedBytes,
    sourceImageBytes: images.sourceBytes,
  };
}

function textualPayloadBreakdown(
  request: NormalizedCodexRequest,
  session: Session,
  boundary: ContextBoundary,
): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"
  | "sessionMetadataBytes" | "protocolWrapperBytes" | "encodedImageBytes" | "sourceImageBytes"> {
  const canonicalHistory = session.transcript.slice(0, boundary.transcriptItems);
  const currentInput = session.transcript.slice(boundary.transcriptItems);
  return {
    instructionBytes: Buffer.byteLength(request.instructions, "utf8"),
    canonicalHistoryItems: canonicalHistory.length,
    canonicalHistoryBytes: jsonBytes(canonicalHistory),
    currentInputItems: currentInput.length,
    currentInputBytes: jsonBytes(currentInput),
    toolCatalogBytes: jsonBytes(request.tools),
    acceptedToolOutputBytes: jsonBytes(canonicalHistory.filter((entry) => entry.role === "tool")),
    sessionMetadataBytes: 0,
    protocolWrapperBytes: 0,
    encodedImageBytes: 0,
    sourceImageBytes: 0,
  };
}

function opaqueCurrentInputBreakdown(prompt: string): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"
  | "sessionMetadataBytes" | "protocolWrapperBytes" | "encodedImageBytes" | "sourceImageBytes"> {
  return {
    instructionBytes: 0,
    canonicalHistoryItems: 0,
    canonicalHistoryBytes: 0,
    currentInputItems: 1,
    currentInputBytes: Buffer.byteLength(prompt, "utf8"),
    toolCatalogBytes: 0,
    acceptedToolOutputBytes: 0,
    sessionMetadataBytes: 0,
    protocolWrapperBytes: 0,
    encodedImageBytes: 0,
    sourceImageBytes: 0,
  };
}

function isDeveloperMessage(item: Record<string, unknown>): boolean {
  return item.type === "message" && item.role === "developer";
}

function isVerifiedModelIdentityMessage(item: Record<string, unknown>): boolean {
  return isDeveloperMessage(item)
    && Array.isArray(item.content)
    && item.content.some((block) => Boolean(block) && typeof block === "object"
      && typeof (block as { text?: unknown }).text === "string"
      && (block as { text: string }).text.includes("BRIDGE-VERIFIED LIVE SESSION MODEL METADATA"));
}

function imagePayloadSizes(items: readonly Record<string, unknown>[]): { encodedBytes: number; sourceBytes: number } {
  let encodedBytes = 0;
  let sourceBytes = 0;
  for (const item of items) {
    if (!Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "input_image") continue;
      encodedBytes += jsonBytes(block);
      const imageUrl = (block as { image_url?: unknown }).image_url;
      if (typeof imageUrl === "string") sourceBytes += decodedDataUrlBytes(imageUrl);
    }
  }
  return { encodedBytes, sourceBytes };
}

function decodedDataUrlBytes(value: string): number {
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) return 0;
  const encoded = match[1]!;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

function classifyInferenceReason(
  request: NormalizedCodexRequest,
  classification: IncomingClassification,
): InferenceReason {
  if (request.requestKind === "compaction") return "compaction";
  if (request.requestKind === "prewarm") return "prewarm";
  if (request.requestKind === "memory") return "memory";
  if (classification.continuation === "tool_output") return "tool_result";
  if (classification.continuation === "compaction_adoption") return "compaction_continuation";
  if (classification.continuation === "new_request" && request.requestClassification !== "internal") return "initial_turn";
  if (classification.continuation === "previous_response"
    || classification.continuation === "historical_replay"
    || classification.continuation === "canonical_replay") return "conversation_continuation";
  return "other";
}

function safeFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown_error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9_]{1,80}$/i.test(code) ? code : "inference_failed";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function changedIdentity(previous: string | undefined, next: string | undefined): boolean {
  return previous !== undefined && next !== undefined && previous !== next;
}

function advancedWindow(previous: number | undefined, next: number | undefined): boolean {
  return previous !== undefined && next !== undefined && next > previous;
}

function elapsedSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1_000));
}

function enrichSaturatedProtocolError(
  error: ToolProtocolError,
  saturated: boolean,
  maxOutputTokens: number,
): ToolProtocolError {
  if (!saturated) return error;
  return new ToolProtocolError(
    `${error.message} The EVREN response also reached the configured output budget (${maxOutputTokens}/${maxOutputTokens}); `
    + "this is saturation evidence and may have contributed, but it does not prove truncation.",
    error.repairable,
  );
}

export class UsageMissingError extends Error {
  readonly code = "usage_missing";
  constructor() {
    super("EVREN response omitted valid authoritative usage; accounting is now fail-closed.");
  }
}
