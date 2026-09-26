import type { BridgeConfig } from "../config.js";
import type { EvrenCreditState } from "../evren/client.js";

export function assertCreditPolicyAllowed(config: BridgeConfig, credits: EvrenCreditState | undefined): void {
  if (config.maxSessionCredits > 0 || config.maxDailyCredits > 0) {
    throw new CreditBudgetUnsupportedError();
  }
  if (config.minCreditsRemaining === 0 || credits?.remaining === undefined) return;
  if (credits.remaining <= config.minCreditsRemaining) {
    throw new CreditFloorExceededError(credits.remaining, config.minCreditsRemaining);
  }
}

export class CreditBudgetUnsupportedError extends Error {
  readonly code = "credit_spend_accounting_unavailable";
  constructor() {
    super("Exact EVREN credit-spend semantics are unavailable; non-zero session/daily credit budgets cannot be enforced safely.");
  }
}

export class CreditFloorExceededError extends Error {
  readonly code = "minimum_credits_remaining_reached";
  constructor(
    readonly remaining: number,
    readonly minimum: number,
  ) {
    super(`EVREN remaining-credit floor reached: remaining ${remaining} CR, configured minimum ${minimum} CR.`);
  }
}
