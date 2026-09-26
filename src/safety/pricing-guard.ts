import type { EvrenTransport } from "../evren/client.js";
import { evaluateModelPricing, isPaidPricing, type ModelPricing } from "../evren/pricing.js";
import type { EventSink } from "../ui/logger.js";

export interface PricingState {
  allowed: boolean;
  connected: boolean;
  checkedAt?: string;
  reason?: string;
  pricing?: ModelPricing;
}

export class PricingGuard {
  private state: PricingState = { allowed: false, connected: false, reason: "Pricing has not been checked." };
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: Pick<EvrenTransport, "getModels">,
    private readonly model: string,
    private readonly logger: EventSink,
  ) {}

  getState(): PricingState {
    return { ...this.state };
  }

  assertAllowed(): void {
    if (!this.state.allowed) throw new PricingBlockedError(this.state.reason ?? "Pricing guard blocked inference.");
  }

  async refresh(): Promise<PricingState> {
    const checkedAt = new Date().toISOString();
    try {
      const payload = await this.client.getModels();
      const evaluation = evaluateModelPricing(payload, this.model);
      const wasAllowed = this.state.allowed;
      const wasPaid = this.state.pricing ? isPaidPricing(this.state.pricing) : false;
      this.state = {
        allowed: evaluation.allowed,
        connected: true,
        checkedAt,
        ...(evaluation.allowed ? { pricing: evaluation.pricing } : { reason: evaluation.reason }),
        ...(!evaluation.allowed && evaluation.pricing ? { pricing: evaluation.pricing } : {}),
      };
      if (evaluation.allowed) {
        const paid = isPaidPricing(evaluation.pricing);
        this.logger.log({
          event: paid && (!wasAllowed || !wasPaid) ? "PAID_PRICING_ACTIVE" : "PRICING_CHECK_OK",
          data: {
            model: this.model,
            currency: "CR",
            mode: paid ? "PAID" : "FREE",
            promptTokenPrice: evaluation.pricing.promptTokenPrice,
            completionTokenPrice: evaluation.pricing.completionTokenPrice,
          },
        });
      } else {
        this.logger.log({
          event: wasAllowed ? "PRICING_CHANGED" : "PRICING_CHECK_BLOCKED",
          level: "error",
          message: evaluation.reason,
        });
      }
    } catch (error) {
      this.state = {
        allowed: false,
        connected: false,
        checkedAt,
        reason: error instanceof Error ? error.message : "EVREN pricing check failed.",
      };
      this.logger.log({
        event: "PRICING_CHECK_ERROR",
        level: "error",
        message: this.state.reason ?? "EVREN pricing check failed.",
      });
    }
    return this.getState();
  }

  startPeriodic(minutes: number): void {
    this.stopPeriodic();
    this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
    this.timer.unref();
  }

  stopPeriodic(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class PricingBlockedError extends Error {
  readonly code = "pricing_blocked";
}
