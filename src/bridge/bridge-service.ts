import type { BridgeConfig } from "../config.js";
import type { EvrenNativeResult, EvrenTransport } from "../evren/client.js";
import type { EvrenUsage } from "../evren/extract-response.js";
import { assertPostUsageAllowed, assertRequestAllowed, assertToolCallAllowed, LimitExceededError } from "../safety/limits.js";
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
  type Session,
  type SessionStore,
} from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EventSink } from "../ui/logger.js";
import type { RequestClassification } from "../usage/types.js";
import { buildEvrenPrompt, buildRepairPrompt, truncateToolOutput } from "./codex-to-evren.js";
import { buildCodexResponse, type BuiltCodexResponse } from "./evren-to-codex.js";
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
import { recognizeToolPoll, ToolPollLimitError } from "./tool-polling.js";

export interface BridgeResult extends BuiltCodexResponse {
  stream: boolean;
  session: Session;
}

type ContinuationKind = "new_request" | "previous_response" | "tool_output" | "historical_replay" | "canonical_replay";

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
  requestClassification: RequestClassification;
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
  }) {
    this.retryCircuit = deps.retryCircuit ?? new DeterministicRetryCircuit();
  }

  async handle(body: unknown): Promise<BridgeResult> {
    const request = normalizeCodexRequest(body);
    const resolved = this.resolveSession(request);
    const session = resolved.session;
    const boundary: ContextBoundary = {
      nativeHistoryItems: session.nativeHistory.length,
      transcriptItems: session.transcript.length,
    };
    const classification = this.classifyIncoming(session, request, resolved.canonicalReplay);
    this.assertPollContinuationAllowed(session, classification);

    let activeToolCallIds: string[] = [];
    if (classification.continuation === "tool_output") {
      activeToolCallIds = this.appendIncoming(session, request.entries, classification);
    }

    this.deps.usage.assertCertain();
    this.deps.pricingGuard.assertAllowed();
    const tools = request.tools.length > 0 ? request.tools : [...session.tools.values()];
    request.tools = tools;
    session.tools = new Map(tools.map((tool) => [tool.name, tool]));

    if (classification.continuation !== "tool_output") {
      if (this.deps.config.toolTransport === "native" && request.instructions) {
        this.appendNativeInstruction(session, request.instructions);
      }
      this.appendIncoming(session, request.entries, classification);
    }

    return this.deps.config.toolTransport === "native"
      ? this.handleNative(request, session, tools, activeToolCallIds, boundary)
      : this.handleTextual(request, session, tools, activeToolCallIds, boundary);
  }

  private async handleNative(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
    boundary: ContextBoundary,
  ): Promise<BridgeResult> {
    const upstream = buildNativeEvrenRequest(
      request,
      session.nativeHistory,
      this.deps.config.model,
      this.deps.config.maxOutputTokensPerCall,
    );
    const requestFingerprint = fingerprintNativeEvrenRequest(upstream);
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
    const serializedUpstream = JSON.stringify(upstream);
    this.beginRequest(session, tools, serializedUpstream, request);
    const metrics = this.startInference(
      session,
      serializedUpstream,
      upstream.input.length,
      upstream.tools.length,
      request.requestClassification,
      nativePayloadBreakdown(upstream, boundary.nativeHistoryItems),
    );
    const result = await this.respondAndAccount(session, upstream, metrics);
    let decision: ReturnType<typeof parseNativeEvrenResponse>;
    try {
      decision = parseNativeEvrenResponse(result.raw, session.tools);
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
        message: `${decision.returnedCallCount} calls → serialized to 1`,
        data: { returnedCallCount: decision.returnedCallCount, selectedTool: decision.name },
      });
    }
    if (decision.kind === "tool_call") assertToolCallAllowed(this.deps.config, session);

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
    this.deps.sessions.recordResponse(session, built.response.id);

    if (decision.kind === "tool_call" && built.callId) {
      const tool = session.tools.get(decision.name);
      if (!tool) throw new Error("Tool disappeared while recording the native call.");
      session.toolCallCount += 1;
      this.deps.sessions.recordPendingToolCall(session, {
        callId: built.callId,
        tool,
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
  }

  private async handleTextual(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
    boundary: ContextBoundary,
  ): Promise<BridgeResult> {
    const prompt = buildEvrenPrompt(request, session);
    this.beginRequest(session, tools, prompt, request);
    let decision: ModelDecision;
    let aggregate: EvrenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const first = await this.inferAndAccount(session, prompt, tools.length, request, boundary);
    aggregate = addUsage(aggregate, first.usage);
    try {
      decision = parseModelDecision(first.text, session.tools);
    } catch (error) {
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
        opaqueCurrentInputBreakdown(repairPrompt),
      );
      aggregate = addUsage(aggregate, repaired.usage);
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
      }
    }

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
          description: tool.description,
          inputSchema: tool.inputSchema,
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
      if (replayedMessageIndexes.has(entryIndex)) continue;
      if ((continuation === "previous_response" || continuation === "historical_replay" || continuation === "canonical_replay")
        && entry.role === "assistant") continue;
      session.transcript.push({ role: entry.role, text: entry.text });
      if (this.deps.config.toolTransport === "native") {
        session.nativeHistory.push(nativeMessage(entry.role, entry.text));
      }
    }
    return prepared.active.map((active) => active.callId);
  }

  private classifyIncoming(
    session: Session,
    request: NormalizedCodexRequest,
    canonicalReplay: boolean,
  ): IncomingClassification {
    const toolEntries = request.entries.filter((entry) => entry.role === "tool");
    if (toolEntries.length === 0) {
      const continuation = request.previousResponseId
        ? "previous_response"
        : canonicalReplay
          ? "canonical_replay"
          : "new_request";
      const replayedMessageIndexes = continuation === "previous_response" || continuation === "canonical_replay"
        ? this.findReplayedMessageIndexes(session, request.entries)
        : new Set<number>();
      if (continuation === "canonical_replay") {
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
    }));
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
    if (request.previousResponseId) {
      return { session: this.deps.sessions.resolve(request.previousResponseId), canonicalReplay: false };
    }
    if (request.toolOutputCallIds.length > 0) {
      return {
        session: this.deps.sessions.resolveByToolCallIds(request.toolOutputCallIds),
        canonicalReplay: false,
      };
    }
    const replay = this.deps.sessions.resolveByCanonicalReplay(
      request.entries.flatMap((entry) => entry.role === "tool"
        ? []
        : [{ role: entry.role, text: entry.text }]),
    );
    return replay
      ? { session: replay, canonicalReplay: true }
      : { session: this.deps.sessions.resolve(), canonicalReplay: false };
  }

  private findReplayedMessageIndexes(
    session: Session,
    entries: NormalizedCodexRequest["entries"],
  ): Set<number> {
    const includesToolOutput = entries.some((entry) => entry.role === "tool");
    const canonical = session.transcript.filter((entry) => entry.role === "tool" || (
      (entry.role === "user" || entry.role === "assistant")
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
    breakdown?: Pick<InferenceMetrics,
      "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
      | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes">,
  ): Promise<{ text: string; usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const serialized = JSON.stringify({
      model: this.deps.config.model,
      input: prompt,
      max_output_tokens: this.deps.config.maxOutputTokensPerCall,
      stream: false,
    });
    const metrics = this.startInference(
      session,
      serialized,
      session.transcript.length,
      toolCount,
      request.requestClassification,
      breakdown ?? textualPayloadBreakdown(request, session, boundary),
    );
    const result = await this.deps.client.infer(prompt, this.deps.config.maxOutputTokensPerCall);
    const usage = await this.accountUsage(session, result.id, result.usage, metrics);
    return { text: result.text, usage };
  }

  private async respondAndAccount(
    session: Session,
    request: Parameters<EvrenTransport["respond"]>[0],
    metrics: InferenceMetrics,
  ): Promise<EvrenNativeResult & { usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const result = await this.deps.client.respond(request);
    const usage = await this.accountUsage(session, result.id, result.usage, metrics);
    return { ...result, usage };
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
      "requestNumber" | "payloadChars" | "payloadBytes" | "historyItems" | "toolCount" | "requestClassification">,
  ): InferenceMetrics {
    session.inferenceCount += 1;
    return {
      requestNumber: session.inferenceCount,
      payloadChars: serializedPayload.length,
      payloadBytes: Buffer.byteLength(serializedPayload, "utf8"),
      historyItems,
      toolCount,
      requestClassification,
      ...breakdown,
    };
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
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function nativePayloadBreakdown(
  request: NativeEvrenRequest,
  historyBoundary: number,
): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"> {
  const instructions = request.input.filter(isDeveloperMessage);
  const canonicalHistory = request.input.slice(0, historyBoundary).filter((item) => !isDeveloperMessage(item));
  const currentInput = request.input.slice(historyBoundary).filter((item) => !isDeveloperMessage(item));
  return {
    instructionBytes: jsonBytes(instructions),
    canonicalHistoryItems: canonicalHistory.length,
    canonicalHistoryBytes: jsonBytes(canonicalHistory),
    currentInputItems: currentInput.length,
    currentInputBytes: jsonBytes(currentInput),
    toolCatalogBytes: jsonBytes(request.tools),
    acceptedToolOutputBytes: jsonBytes(canonicalHistory.filter((item) => item.type === "function_call_output")),
  };
}

function textualPayloadBreakdown(
  request: NormalizedCodexRequest,
  session: Session,
  boundary: ContextBoundary,
): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"> {
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
  };
}

function opaqueCurrentInputBreakdown(prompt: string): Pick<InferenceMetrics,
  "instructionBytes" | "canonicalHistoryItems" | "canonicalHistoryBytes"
  | "currentInputItems" | "currentInputBytes" | "toolCatalogBytes" | "acceptedToolOutputBytes"> {
  return {
    instructionBytes: 0,
    canonicalHistoryItems: 0,
    canonicalHistoryBytes: 0,
    currentInputItems: 1,
    currentInputBytes: Buffer.byteLength(prompt, "utf8"),
    toolCatalogBytes: 0,
    acceptedToolOutputBytes: 0,
  };
}

function isDeveloperMessage(item: Record<string, unknown>): boolean {
  return item.type === "message" && item.role === "developer";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
