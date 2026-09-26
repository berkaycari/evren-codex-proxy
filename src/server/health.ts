import type { FastifyInstance } from "fastify";
import type { BridgeConfig } from "../config.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import type { SessionStore } from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EvrenCreditState } from "../evren/client.js";
import type { UpdateCheckState } from "../update/checker.js";
import { createHash } from "node:crypto";

export function registerHealthRoute(
  app: FastifyInstance,
  deps: {
    config: BridgeConfig;
    pricingGuard: Pick<PricingGuard, "getState">;
    sessions: SessionStore;
    usage: UsageTracker;
    credits?: { getCreditState(): EvrenCreditState };
    updateCheck?: { getState(): UpdateCheckState };
  },
): void {
  app.get("/health", async () => {
    const pricing = deps.pricingGuard.getState();
    const daily = deps.usage.snapshot();
    const session = deps.sessions.getLatest();
    const credits = deps.credits?.getCreditState() ?? { uncertain: false };
    const update = deps.updateCheck?.getState() ?? { status: "disabled" as const };
    const creditPolicyAllowed = deps.config.maxSessionCredits === 0
      && deps.config.maxDailyCredits === 0
      && (deps.config.minCreditsRemaining === 0
        || credits.remaining === undefined
        || credits.remaining > deps.config.minCreditsRemaining);
    return {
      status: pricing.allowed && daily.accountingCertain && creditPolicyAllowed ? "online" : "blocked",
      listen: `${deps.config.host}:${deps.config.port}`,
      model: deps.config.model,
      evren: pricing.connected ? "connected" : "disconnected",
      pricing: {
        allowed: pricing.allowed,
        checked_at: pricing.checkedAt ?? null,
        input_cr: pricing.pricing?.promptTokenPrice ?? null,
        output_cr: pricing.pricing?.completionTokenPrice ?? null,
        currency: pricing.pricing?.currency ?? null,
        free_until: pricing.pricing?.freeUntil ?? null,
        reason: pricing.reason ?? null,
        mode: pricing.pricing
          ? pricing.pricing.promptTokenPrice > 0 || pricing.pricing.completionTokenPrice > 0 ? "paid" : "free"
          : "unknown",
      },
      credits: {
        held: credits.held ?? null,
        remaining: credits.remaining ?? null,
        uncertain: credits.uncertain,
        updated_at: credits.updatedAt ?? null,
      },
      update: {
        status: update.status,
        checked_at: update.checkedAt ?? null,
        available_version: update.updateAvailableVersion ?? null,
      },
      usage: {
        daily,
        session: session ? {
          requests: session.requestCount,
          tool_calls: session.toolCallCount,
          inferences: session.inferenceCount,
          input_tokens: session.usage.inputTokens,
          output_tokens: session.usage.outputTokens,
          total_tokens: session.usage.totalTokens,
          classified: session.usageByClass,
          active_context: {
            approximate_tokens: Math.ceil(session.contextObservability.currentActiveContextBytes / 3),
            current_bytes: session.contextObservability.currentActiveContextBytes,
            peak_bytes: session.contextObservability.peakActiveContextBytes,
            window_id_hash: hashIdentity(session.context.windowId),
            window_number: session.context.windowNumber ?? null,
            context_window_id_hash: hashIdentity(session.context.contextWindowId),
            accepted_compactions: session.acceptedCompactionCount,
          },
          replay_observability: {
            total_upstream_payload_bytes: session.contextObservability.totalUpstreamPayloadBytes,
            canonical_history_replay_bytes: session.contextObservability.canonicalHistoryReplayBytes,
            current_input_bytes: session.contextObservability.currentInputBytes,
            tool_catalog_bytes: session.contextObservability.toolCatalogBytes,
            accepted_tool_output_replay_bytes: session.contextObservability.acceptedToolOutputReplayBytes,
            replay_share: session.contextObservability.totalUpstreamPayloadBytes === 0
              ? 0
              : session.contextObservability.canonicalHistoryReplayBytes
                / session.contextObservability.totalUpstreamPayloadBytes,
          },
          limit_recovery: session.limitRecovery ? {
            limit_name: session.limitRecovery.limitName,
            current: session.limitRecovery.current,
            limit: session.limitRecovery.limit,
            recommended: session.limitRecovery.recommended ?? null,
            recoverable: session.limitRecovery.recoverable,
            blocked_at: session.limitRecovery.blockedAt.toISOString(),
          } : null,
          polling: {
            active: session.polling.active !== undefined,
            current_consecutive_polls: session.polling.active?.consecutivePolls ?? 0,
            current_authoritative_tokens: session.polling.active?.authoritativeTokensSpent ?? 0,
            total_poll_inferences: session.polling.totalPollInferences,
            total_authoritative_tokens: session.polling.totalAuthoritativeTokens,
          },
          output_budget_saturated: session.lastOutputBudgetSaturated,
          output_budget_saturation_count: session.outputBudgetSaturationCount,
          created_at: session.createdAt.toISOString(),
          last_activity: session.lastActivity.toISOString(),
        } : null,
      },
      credit_policy: {
        exact_spend_accounting: "unavailable",
        max_session_credits: deps.config.maxSessionCredits,
        max_daily_credits: deps.config.maxDailyCredits,
        min_credits_remaining: deps.config.minCreditsRemaining,
      },
    };
  });
}

function hashIdentity(value: string | undefined): string | null {
  return value === undefined ? null : createHash("sha256").update(value, "utf8").digest("hex");
}
