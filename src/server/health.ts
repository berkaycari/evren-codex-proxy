import type { FastifyInstance } from "fastify";
import type { BridgeConfig } from "../config.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import type { SessionStore } from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EvrenCreditState } from "../evren/client.js";
import type { UpdateCheckState } from "../update/checker.js";

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
    return {
      status: pricing.allowed && daily.accountingCertain ? "online" : "blocked",
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
    };
  });
}
