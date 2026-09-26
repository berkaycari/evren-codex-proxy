import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { evaluateModelPricing } from "../src/evren/pricing.js";
import { assertRequestAllowed, LimitExceededError } from "../src/safety/limits.js";
import { SessionStore } from "../src/sessions/store.js";
import { redact } from "../src/ui/logger.js";
import { buildLimitRecovery, recommendedLimit } from "../src/safety/limit-recovery.js";
import { assertCreditPolicyAllowed, CreditBudgetUnsupportedError, CreditFloorExceededError } from "../src/safety/credit-policy.js";
import { extractUsage } from "../src/evren/extract-response.js";
import { PricingGuard } from "../src/safety/pricing-guard.js";

function loadRepositoryDefaults() {
  return loadConfig({}, { localConfigPath: path.join(os.tmpdir(), `evren-no-local-${process.pid}.json`) });
}

describe("pricing and safety", () => {
  it("uses the aligned platform quota while preserving local safety guards", () => {
    const config = loadRepositoryDefaults();
    expect(config).toMatchObject({
      toolTransport: "native",
      maxDailyTokens: 10_000_000,
      maxOutputTokensPerCall: 4_096,
      maxSessionTokens: 1_200_000,
      maxRequestsPerSession: 60,
      maxToolCallsPerSession: 80,
      maxEstimatedInputTokensPerCall: 80_000,
      requestTimeoutMs: 120_000,
    });
  });

  it("supports only the explicit textual transport fallback override", () => {
    expect(loadConfig({ EVREN_TOOL_TRANSPORT: "textual" }).toolTransport).toBe("textual");
    expect(loadConfig({ EVREN_TOOL_TRANSPORT: "native" }).toolTransport).toBe("native");
    expect(() => loadConfig({ EVREN_TOOL_TRANSPORT: "automatic" })).toThrow(/native or textual/);
  });

  it("accepts decimal credit configuration with environment precedence and rejects invalid values", () => {
    const config = loadConfig({
      MAX_SESSION_CREDITS: "12.5",
      MAX_DAILY_CREDITS: "99.75",
      MIN_CREDITS_REMAINING: "2.25",
    });
    expect(config).toMatchObject({ maxSessionCredits: 12.5, maxDailyCredits: 99.75, minCreditsRemaining: 2.25 });
    expect(() => loadConfig({ MAX_SESSION_CREDITS: "-1" })).toThrow(/finite non-negative/);
    expect(() => loadConfig({ MIN_CREDITS_REMAINING: "NaN" })).toThrow(/finite non-negative/);
  });

  it("redacts API keys and authorization headers recursively", () => {
    const key = "super-secret-key";
    expect(redact({
      headers: { "X-API-Key": key, Authorization: `Bearer ${key}` },
      note: `prefix ${key} suffix`,
    }, [key])).toEqual({
      headers: { "X-API-Key": "[REDACTED]", Authorization: "[REDACTED]" },
      note: "prefix [REDACTED] suffix",
    });
  });

  it("allows exact numeric zero CR pricing", () => {
    const result = evaluateModelPricing({
      data: [{
        id: "deepseek-v4.1-flash",
        pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
      }]
    }, "deepseek-v4.1-flash");
    expect(result.allowed).toBe(true);
  });

  it("preserves optional free-until visibility for valid pricing", () => {
    const result = evaluateModelPricing({
      data: [{
        id: "deepseek-v4.1-flash",
        pricing: {
          prompt_token_price: 0,
          completion_token_price: 0,
          currency: "CR",
          free_until: "2026-11-01",
        },
      }]
    }, "deepseek-v4.1-flash");
    expect(result).toMatchObject({ allowed: true, pricing: { freeUntil: "2026-11-01" } });
  });

  it("allows structurally valid positive CR pricing", () => {
    const result = evaluateModelPricing({
      data: [{
        id: "deepseek-v4.1-flash",
        pricing: { prompt_token_price: 0.001, completion_token_price: 0, currency: "CR" },
      }]
    }, "deepseek-v4.1-flash");
    expect(result.allowed).toBe(true);
  });

  it("emits a paid-pricing transition without blocking valid positive CR", async () => {
    const events: Array<{ event: string }> = [];
    const guard = new PricingGuard({
      getModels: async () => ({ data: [{
        id: "deepseek-v4.1-flash",
        pricing: { prompt_token_price: 0.001, completion_token_price: 0.002, currency: "CR" },
      }] }),
    }, "deepseek-v4.1-flash", { log: (event) => events.push(event) });
    await expect(guard.refresh()).resolves.toMatchObject({ allowed: true, pricing: { promptTokenPrice: 0.001 } });
    expect(events.map((event) => event.event)).toEqual(["PAID_PRICING_ACTIVE"]);
    expect(() => guard.assertAllowed()).not.toThrow();
  });

  it("blocks negative, malformed, and unrecognized pricing", () => {
    const catalog = (pricing: unknown) => ({ data: [{ id: "deepseek-v4.1-flash", pricing }] });
    expect(evaluateModelPricing(catalog({ prompt_token_price: -1, completion_token_price: 0, currency: "CR" }), "deepseek-v4.1-flash").allowed).toBe(false);
    expect(evaluateModelPricing(catalog({ prompt_token_price: "0", completion_token_price: 0, currency: "CR" }), "deepseek-v4.1-flash").allowed).toBe(false);
    expect(evaluateModelPricing(catalog({ prompt_token_price: 0, completion_token_price: 0, currency: "USD" }), "deepseek-v4.1-flash").allowed).toBe(false);
  });

  it("blocks missing pricing", () => {
    expect(evaluateModelPricing({ data: [{ id: "deepseek-v4.1-flash" }] }, "deepseek-v4.1-flash").allowed).toBe(false);
  });

  it("enforces session and daily token limits", () => {
    const config = loadRepositoryDefaults();
    const session = new SessionStore(60_000).resolve();
    session.usage.totalTokens = config.maxSessionTokens;
    expect(() => assertRequestAllowed(config, session, {
      date: "2026-09-21", inputTokens: 0, outputTokens: 0, totalTokens: 0, accountingCertain: true,
    }, "small")).toThrowError(LimitExceededError);

    session.usage.totalTokens = 0;
    expect(() => assertRequestAllowed(config, session, {
      date: "2026-09-21",
      inputTokens: config.maxDailyTokens,
      outputTokens: 0,
      totalTokens: config.maxDailyTokens,
      accountingCertain: true,
    }, "small")).toThrow(/MAX_DAILY_TOKENS/);
  });

  it("enforces request count limits", () => {
    const config = loadRepositoryDefaults();
    const session = new SessionStore(60_000).resolve();
    session.requestCount = config.maxRequestsPerSession;
    expect(() => assertRequestAllowed(config, session, {
      date: "2026-09-21", inputTokens: 0, outputTokens: 0, totalTokens: 0, accountingCertain: true,
    }, "small")).toThrow(/MAX_REQUESTS_PER_SESSION/);
  });

  it("calculates clean one-limit recovery recommendations", () => {
    expect(recommendedLimit("MAX_SESSION_TOKENS", 1_800_000)).toBe(3_000_000);
    expect(recommendedLimit("MAX_SESSION_TOKENS", 3_000_000)).toBe(4_500_000);
    expect(recommendedLimit("MAX_REQUESTS_PER_SESSION", 60)).toBe(120);
    expect(recommendedLimit("MAX_REQUESTS_PER_SESSION", 120)).toBe(180);
    expect(recommendedLimit("MAX_TOOL_CALLS_PER_SESSION", 80)).toBe(140);
    expect(recommendedLimit("MAX_TOOL_CALLS_PER_SESSION", 140)).toBe(210);
    expect(buildLimitRecovery(
      new LimitExceededError("MAX_SESSION_TOKENS", 1_759_374, 1_800_000),
      { ...loadRepositoryDefaults(), maxSessionTokens: 1_800_000 },
    )).toMatchObject({
      limitName: "MAX_SESSION_TOKENS",
      current: 1_759_374,
      limit: 1_800_000,
      recommended: 3_000_000,
      recoverable: true,
    });
  });

  it("blocks unsupported exact-spend budgets and enforces only authoritative remaining credit", () => {
    const config = loadRepositoryDefaults();
    config.maxSessionCredits = 1;
    expect(() => assertCreditPolicyAllowed(config, { remaining: 100, uncertain: false })).toThrow(CreditBudgetUnsupportedError);
    config.maxSessionCredits = 0;
    config.minCreditsRemaining = 10.5;
    expect(() => assertCreditPolicyAllowed(config, undefined)).not.toThrow();
    expect(() => assertCreditPolicyAllowed(config, { uncertain: true })).not.toThrow();
    expect(() => assertCreditPolicyAllowed(config, { remaining: 10.5, uncertain: false })).toThrow(CreditFloorExceededError);
    expect(() => assertCreditPolicyAllowed(config, { remaining: 10.51, uncertain: false })).not.toThrow();
  });

  it("preserves authoritative cached and reasoning token details without inventing them", () => {
    expect(extractUsage({ usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
    } })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 4, reasoningTokens: 2 });
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }))
      .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("ignores attempts to override the loopback bind address", () => {
    expect(loadConfig({ HOST: "0.0.0.0", EVREN_BASE_URL: "https://attacker.invalid" }).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0", EVREN_BASE_URL: "https://attacker.invalid" }).evrenBaseUrl)
      .toBe("https://evren-llmapi.ssyz.org.tr/v1");
  });
});
