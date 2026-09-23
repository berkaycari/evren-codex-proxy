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
import { buildEvrenPrompt, buildRepairPrompt, truncateToolOutput } from "./codex-to-evren.js";
import { buildCodexResponse, type BuiltCodexResponse } from "./evren-to-codex.js";
import {
  buildNativeEvrenRequest,
  nativeFunctionCall,
  nativeFunctionCallOutput,
  nativeMessage,
} from "./native-codex-to-evren.js";
import { parseNativeEvrenResponse } from "./native-evren-to-codex.js";
import { normalizeCodexRequest, InvalidRequestError, type NormalizedCodexRequest } from "./normalize-codex-request.js";
import { parseModelDecision, ToolProtocolError, type ModelDecision, type NormalizedTool } from "./tool-protocol.js";

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
    const classification = this.classifyIncoming(session, request, resolved.canonicalReplay);

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
      ? this.handleNative(request, session, tools, activeToolCallIds)
      : this.handleTextual(request, session, tools, activeToolCallIds);
  }

  private async handleNative(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
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
    const metrics = this.startInference(session, serializedUpstream, upstream.input.length, upstream.tools.length);
    const result = await this.respondAndAccount(session, upstream, metrics);
    let decision: ReturnType<typeof parseNativeEvrenResponse>;
    try {
      decision = parseNativeEvrenResponse(result.raw, session.tools);
    } catch (error) {
      if (error instanceof ToolProtocolError) {
        this.retryCircuit.recordFailure(requestFingerprint, error.code);
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
      this.deps.sessions.recordPendingToolCall(session, { callId: built.callId, tool });
      session.nativeHistory.push(nativeFunctionCall(built.callId, decision.name, decision.argumentsJson));
      session.transcript.push({
        role: "assistant",
        text: `Requested tool ${decision.name} with arguments ${decision.argumentsJson}`,
        toolName: decision.name,
        callId: built.callId,
      });
      this.deps.logger.log({
        event: "NATIVE_TOOL_REQUEST",
        data: { sessionId: session.id, tool: decision.name, callId: built.callId },
      });
      this.deps.logger.log({
        event: "TOOL_REQUEST",
        data: { sessionId: session.id, tool: decision.name, callId: built.callId },
      });
    } else if (decision.kind === "final") {
      session.nativeHistory.push(nativeMessage("assistant", decision.content));
      session.transcript.push({ role: "assistant", text: decision.content });
      this.deps.logger.log({ event: "RESPONSE_FINALIZED", data: { sessionId: session.id } });
    }

    this.completeActiveCalls(session, activeToolCallIds);
    return { ...built, stream: request.stream, session };
  }

  private async handleTextual(
    request: NormalizedCodexRequest,
    session: Session,
    tools: NormalizedTool[],
    activeToolCallIds: string[],
  ): Promise<BridgeResult> {
    const prompt = buildEvrenPrompt(request, session);
    this.beginRequest(session, tools, prompt, request);
    let decision: ModelDecision;
    let aggregate: EvrenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const first = await this.inferAndAccount(session, prompt, tools.length);
    aggregate = addUsage(aggregate, first.usage);
    try {
      decision = parseModelDecision(first.text, session.tools);
    } catch (error) {
      if (!(error instanceof ToolProtocolError) || !error.repairable) throw error;
      const repairPrompt = buildRepairPrompt(first.text, error.message, tools);
      this.assertRepairAllowed(session, repairPrompt);
      this.deps.logger.log({ event: "PROTOCOL_REPAIR", level: "warn", message: error.message });
      const repaired = await this.inferAndAccount(session, repairPrompt, tools.length);
      aggregate = addUsage(aggregate, repaired.usage);
      decision = parseModelDecision(repaired.text, session.tools);
    }

    if (decision.kind === "tool_call") assertToolCallAllowed(this.deps.config, session);
    const built = buildCodexResponse(decision, this.deps.config.model, aggregate, session.tools);
    this.deps.sessions.recordResponse(session, built.response.id);
    if (decision.kind === "tool_call" && built.callId) {
      const tool = session.tools.get(decision.name);
      if (!tool) throw new Error("Tool disappeared while recording the call.");
      session.toolCallCount += 1;
      this.deps.sessions.recordPendingToolCall(session, { callId: built.callId, tool });
      session.transcript.push({
        role: "assistant",
        text: `Requested tool ${decision.name} with arguments ${JSON.stringify(decision.arguments)}`,
        toolName: decision.name,
        callId: built.callId,
      });
      this.deps.logger.log({
        event: "TOOL_REQUEST",
        data: { sessionId: session.id, tool: decision.name, callId: built.callId },
      });
    } else if (decision.kind === "final") {
      session.transcript.push({ role: "assistant", text: decision.content });
      this.deps.logger.log({ event: "RESPONSE_FINALIZED", data: { sessionId: session.id } });
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
        sessionId: session.id,
        request: session.requestCount,
        transport: this.deps.config.toolTransport,
        toolCount: tools.length,
        inputEstimate: estimate,
        approximate: true,
        foreground: request.foreground,
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
        data: { sessionId: session.id, tool: completed.toolName, callId: completed.callId },
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
            data: { sessionId: session.id, tool: staged.pending.tool.name, callId: entry.callId, chars: text.length },
          });
        }
        this.deps.logger.log({
          event: "TOOL_RESULT",
          data: { sessionId: session.id, tool: staged.pending.tool.name, callId: entry.callId, chars: text.length },
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
  ): Promise<{ text: string; usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const serialized = JSON.stringify({
      model: this.deps.config.model,
      input: prompt,
      max_output_tokens: this.deps.config.maxOutputTokensPerCall,
      stream: false,
    });
    const metrics = this.startInference(session, serialized, session.transcript.length, toolCount);
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
      const addedToSession = this.deps.sessions.recordUsage(session, responseId, usage);
      await this.deps.usage.record(responseId, usage);
      if (!addedToSession) this.deps.logger.log({ event: "USAGE_DEDUPLICATED", data: { responseId } });
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
      },
    });
    assertPostUsageAllowed(this.deps.config, session, this.deps.usage.snapshot());
    return usage;
  }

  private startInference(
    session: Session,
    serializedPayload: string,
    historyItems: number,
    toolCount: number,
  ): InferenceMetrics {
    session.inferenceCount += 1;
    return {
      requestNumber: session.inferenceCount,
      payloadChars: serializedPayload.length,
      payloadBytes: Buffer.byteLength(serializedPayload, "utf8"),
      historyItems,
      toolCount,
    };
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

export class UsageMissingError extends Error {
  readonly code = "usage_missing";
  constructor() {
    super("EVREN response omitted valid authoritative usage; accounting is now fail-closed.");
  }
}
