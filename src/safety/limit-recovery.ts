import type { BridgeConfig } from "../config.js";
import type { LimitRecoveryState, RecoverableLimitName } from "../sessions/store.js";
import { LimitExceededError } from "./limits.js";

const RECOVERABLE = new Set<RecoverableLimitName>([
  "MAX_SESSION_TOKENS",
  "MAX_REQUESTS_PER_SESSION",
  "MAX_TOOL_CALLS_PER_SESSION",
]);

export function buildLimitRecovery(
  error: LimitExceededError,
  config: BridgeConfig,
  now = new Date(),
): LimitRecoveryState {
  const recoverable = RECOVERABLE.has(error.limitName as RecoverableLimitName);
  return {
    limitName: error.limitName,
    current: error.current,
    limit: error.limit,
    blockedAt: now,
    recoverable,
    ...(recoverable ? { recommended: recommendedLimit(error.limitName as RecoverableLimitName, error.limit) } : {}),
  };
}

export function recommendedLimit(limitName: RecoverableLimitName, configured: number): number {
  const floor = limitName === "MAX_SESSION_TOKENS"
    ? 3_000_000
    : limitName === "MAX_REQUESTS_PER_SESSION"
      ? 120
      : 140;
  if (configured < floor) return floor;
  const scaled = configured * 1.5;
  if (limitName === "MAX_SESSION_TOKENS") {
    const magnitude = scaled >= 1_000_000 ? 100_000 : 10_000;
    return Math.ceil(scaled / magnitude) * magnitude;
  }
  return Math.ceil(scaled / 10) * 10;
}

export function configKeyForLimit(limitName: RecoverableLimitName): keyof BridgeConfig {
  if (limitName === "MAX_SESSION_TOKENS") return "maxSessionTokens";
  if (limitName === "MAX_REQUESTS_PER_SESSION") return "maxRequestsPerSession";
  return "maxToolCallsPerSession";
}

export function environmentNameForLimit(limitName: RecoverableLimitName): string {
  return limitName;
}
