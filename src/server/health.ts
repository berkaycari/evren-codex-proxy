import type { FastifyInstance } from "fastify";
import type { BridgeConfig } from "../config.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import type { SessionStore } from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EvrenCreditState } from "../evren/client.js";

export function registerHealthRoute(
  app: FastifyInstance,
  deps: {
    config: BridgeConfig;
    pricingGuard: Pick<PricingGuard, "getState">;
    sessions: SessionStore;
    usage: UsageTracker;
    credits?: { getCreditState(): EvrenCreditState };
  },
): void {
  app.get("/health", async () => {
    const pricing = deps.pricingGuard.getState();
    const daily = deps.usage.snapshot();
    const session = deps.sessions.getLatest();
    const credits = deps.credits?.getCreditState() ?? { uncertain: false };
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
      usage: {
        daily,
        session: session ? {
          id: session.id,
          requests: session.requestCount,
          tool_calls: session.toolCallCount,
          input_tokens: session.usage.inputTokens,
          output_tokens: session.usage.outputTokens,
          total_tokens: session.usage.totalTokens,
          created_at: session.createdAt.toISOString(),
          last_activity: session.lastActivity.toISOString(),
        } : null,
      },
    };
  });
}
