import type { BridgeConfig } from "../config.js";
import type { EvrenNativeResult, EvrenTransport } from "../evren/client.js";
import type { EvrenUsage } from "../evren/extract-response.js";
import { assertPostUsageAllowed, assertRequestAllowed, assertToolCallAllowed, LimitExceededError } from "../safety/limits.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import { estimateInputTokens } from "../safety/token-estimator.js";
import type { Session, SessionStore } from "../sessions/store.js";
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

export class BridgeService {
  constructor(private readonly deps: {
    config: BridgeConfig;
    client: EvrenTransport;
    pricingGuard: Pick<PricingGuard, "assertAllowed">;
    sessions: SessionStore;
    usage: UsageTracker;
    logger: EventSink;
  }) {}

  async handle(body: unknown): Promise<BridgeResult> {
    const request = normalizeCodexRequest(body);
    const session = request.previousResponseId
      ? this.deps.sessions.resolve(request.previousResponseId)
      : request.toolOutputCallIds.length > 0
        ? this.deps.sessions.resolveByToolCallIds(request.toolOutputCallIds)
        : this.deps.sessions.resolve();
    const continuation = request.toolOutputCallIds.length > 0
      ? "tool_output"
      : request.previousResponseId
        ? "previous_response"
        : "new_request";

    let activeToolCallIds: string[] = [];
    if (continuation === "tool_output") {
      activeToolCallIds = this.appendIncoming(session, request.entries, continuation);
    }

    this.deps.usage.assertCertain();
    this.deps.pricingGuard.assertAllowed();
    const tools = request.tools.length > 0 ? request.tools : [...session.tools.values()];
    request.tools = tools;
    session.tools = new Map(tools.map((tool) => [tool.name, tool]));

    if (continuation !== "tool_output") {
      if (this.deps.config.toolTransport === "native" && request.instructions) {
        this.appendNativeInstruction(session, request.instructions);
      }
      this.appendIncoming(session, request.entries, continuation);
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
    this.beginRequest(session, tools, JSON.stringify(upstream), request);
    const result = await this.respondAndAccount(session, upstream);
    const decision = parseNativeEvrenResponse(result.raw, session.tools);
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
    const first = await this.inferAndAccount(session, prompt);
    aggregate = addUsage(aggregate, first.usage);
    try {
      decision = parseModelDecision(first.text, session.tools);
    } catch (error) {
      if (!(error instanceof ToolProtocolError) || !error.repairable) throw error;
      const repairPrompt = buildRepairPrompt(first.text, error.message, tools);
      this.assertRepairAllowed(session, repairPrompt);
      this.deps.logger.log({ event: "PROTOCOL_REPAIR", level: "warn", message: error.message });
      const repaired = await this.inferAndAccount(session, repairPrompt);
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
    this.deps.logger.log({
      event: "CODEX_REQUEST",
      data: {
        sessionId: session.id,
        request: session.requestCount,
        transport: this.deps.config.toolTransport,
        toolCount: tools.length,
        inputEstimate: estimate,
        approximate: true,
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
    continuation: "new_request" | "previous_response" | "tool_output",
  ): string[] {
    const replayedMessageIndexes = continuation === "previous_response"
      ? this.findReplayedMessageIndexes(session, entries)
      : new Set<number>();
    const toolEntries = entries.filter((entry) => entry.role === "tool");
    const prepared = toolEntries.length > 0
      ? this.deps.sessions.prepareIncomingToolOutputs(session, toolEntries.map((entry) => {
        if (!entry.callId) throw new InvalidRequestError("Tool output is missing call_id.");
        return { callId: entry.callId, output: entry.text };
      }))
      : { active: [], historical: [] };

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
      if (continuation === "previous_response" && entry.role === "assistant") continue;
      const last = session.transcript.at(-1);
      if (last?.role === entry.role && last.text === entry.text) continue;
      session.transcript.push({ role: entry.role, text: entry.text });
      if (this.deps.config.toolTransport === "native") {
        session.nativeHistory.push(nativeMessage(entry.role, entry.text));
      }
    }
    return prepared.active.map((active) => active.callId);
  }

  private findReplayedMessageIndexes(
    session: Session,
    entries: NormalizedCodexRequest["entries"],
  ): Set<number> {
    if (!entries.some((entry) => entry.role === "assistant")) return new Set();
    const canonical = session.transcript.filter((entry) =>
      (entry.role === "user" || entry.role === "assistant") && entry.callId === undefined && entry.toolName === undefined,
    );
    const replayed = new Set<number>();
    let canonicalIndex = 0;
    for (const [entryIndex, entry] of entries.entries()) {
      if (entry.role === "tool") break;
      const expected = canonical[canonicalIndex];
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

  private async inferAndAccount(session: Session, prompt: string): Promise<{ text: string; usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const result = await this.deps.client.infer(prompt, this.deps.config.maxOutputTokensPerCall);
    const usage = await this.accountUsage(session, result.id, result.usage);
    return { text: result.text, usage };
  }

  private async respondAndAccount(
    session: Session,
    request: Parameters<EvrenTransport["respond"]>[0],
  ): Promise<EvrenNativeResult & { usage: EvrenUsage }> {
    this.deps.pricingGuard.assertAllowed();
    this.deps.usage.assertCertain();
    const result = await this.deps.client.respond(request);
    const usage = await this.accountUsage(session, result.id, result.usage);
    return { ...result, usage };
  }

  private async accountUsage(
    session: Session,
    responseId: string,
    usage: EvrenUsage | undefined,
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
    assertPostUsageAllowed(this.deps.config, session, this.deps.usage.snapshot());
    return usage;
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
