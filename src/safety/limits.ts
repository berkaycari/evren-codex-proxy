import type { BridgeConfig } from "../config.js";
import type { Session } from "../sessions/store.js";
import type { DailyUsageSnapshot } from "../usage/tracker.js";
import { estimateInputTokens } from "./token-estimator.js";

export class LimitExceededError extends Error {
  readonly code = "usage_limit_exceeded";
  recoverable = false;
  recommended?: number;
  inferenceMade = false;
  constructor(
    public readonly limitName: string,
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`${limitName} limit reached: current ${current.toLocaleString()}, limit ${limit.toLocaleString()}.`);
  }
}

export function assertRequestAllowed(
  config: BridgeConfig,
  session: Session,
  daily: DailyUsageSnapshot,
  prompt: string,
): number {
  if (session.requestCount >= config.maxRequestsPerSession) {
    throw new LimitExceededError("MAX_REQUESTS_PER_SESSION", session.requestCount, config.maxRequestsPerSession);
  }
  if (session.toolCallCount >= config.maxToolCallsPerSession) {
    throw new LimitExceededError("MAX_TOOL_CALLS_PER_SESSION", session.toolCallCount, config.maxToolCallsPerSession);
  }
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
  return estimate;
}

export function assertToolCallAllowed(config: BridgeConfig, session: Session): void {
  assertToolCallsAllowed(config, session, 1);
}

export function assertToolCallsAllowed(config: BridgeConfig, session: Session, additionalCalls: number): void {
  if (!Number.isSafeInteger(additionalCalls) || additionalCalls <= 0) throw new Error("additionalCalls must be positive.");
  if (session.toolCallCount >= config.maxToolCallsPerSession) {
    throw new LimitExceededError("MAX_TOOL_CALLS_PER_SESSION", session.toolCallCount, config.maxToolCallsPerSession);
  }
  if (session.toolCallCount + additionalCalls > config.maxToolCallsPerSession) {
    throw new LimitExceededError(
      "MAX_TOOL_CALLS_PER_SESSION",
      session.toolCallCount,
      config.maxToolCallsPerSession,
    );
  }
}

export function assertPostUsageAllowed(config: BridgeConfig, session: Session, daily: DailyUsageSnapshot): void {
  if (session.usage.totalTokens > config.maxSessionTokens) {
    throw new LimitExceededError("MAX_SESSION_TOKENS", session.usage.totalTokens, config.maxSessionTokens);
  }
  if (daily.totalTokens > config.maxDailyTokens) {
    throw new LimitExceededError("MAX_DAILY_TOKENS", daily.totalTokens, config.maxDailyTokens);
  }
}
