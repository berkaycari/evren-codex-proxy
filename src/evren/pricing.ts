export interface ModelPricing {
  promptTokenPrice: number;
  completionTokenPrice: number;
  currency: string;
  freeUntil?: string;
}

export type PricingEvaluation =
  | { allowed: true; pricing: ModelPricing }
  | { allowed: false; reason: string; pricing?: ModelPricing };

export function evaluateModelPricing(payload: unknown, model: string): PricingEvaluation {
  if (!payload || typeof payload !== "object") return { allowed: false, reason: "Pricing response is not an object." };
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return { allowed: false, reason: "Pricing response is missing the data array." };
  const entry = data.find(
    (candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === model,
  ) as { pricing?: unknown; free_until?: unknown } | undefined;
  if (!entry) return { allowed: false, reason: `Model ${model} was not found in the EVREN catalog.` };
  if (!entry.pricing || typeof entry.pricing !== "object") {
    return { allowed: false, reason: `Pricing metadata is missing for ${model}.` };
  }
  const raw = entry.pricing as Record<string, unknown>;
  const freeUntil = raw.free_until ?? entry.free_until;
  if (
    typeof raw.prompt_token_price !== "number" ||
    !Number.isFinite(raw.prompt_token_price) ||
    raw.prompt_token_price < 0 ||
    typeof raw.completion_token_price !== "number" ||
    !Number.isFinite(raw.completion_token_price) ||
    raw.completion_token_price < 0 ||
    raw.currency !== "CR"
  ) {
    return { allowed: false, reason: `Pricing metadata is invalid for ${model}.` };
  }
  const pricing: ModelPricing = {
    promptTokenPrice: raw.prompt_token_price,
    completionTokenPrice: raw.completion_token_price,
    currency: raw.currency,
    ...(typeof freeUntil === "string" && freeUntil.trim().length > 0
      ? { freeUntil: freeUntil.trim().slice(0, 100) }
      : {}),
  };
  return { allowed: true, pricing };
}

export function isPaidPricing(pricing: ModelPricing): boolean {
  return pricing.promptTokenPrice > 0 || pricing.completionTokenPrice > 0;
}
