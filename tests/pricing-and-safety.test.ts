import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { evaluateModelPricing } from "../src/evren/pricing.js";
import { assertRequestAllowed, LimitExceededError } from "../src/safety/limits.js";
import { SessionStore } from "../src/sessions/store.js";
import { redact } from "../src/ui/logger.js";

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

  it("allows only exact numeric zero CR pricing", () => {
    const result = evaluateModelPricing({
      data: [{
        id: "deepseek-v4.1-flash",
        pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
      }]
    }, "deepseek-v4.1-flash");
    expect(result.allowed).toBe(true);
  });

  it("preserves optional free-until visibility without changing the zero-price guard", () => {
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

  it("blocks positive pricing", () => {
    const result = evaluateModelPricing({
      data: [{
        id: "deepseek-v4.1-flash",
        pricing: { prompt_token_price: 0.001, completion_token_price: 0, currency: "CR" },
      }]
    }, "deepseek-v4.1-flash");
    expect(result.allowed).toBe(false);
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

  it("ignores attempts to override the loopback bind address", () => {
    expect(loadConfig({ HOST: "0.0.0.0", EVREN_BASE_URL: "https://attacker.invalid" }).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0", EVREN_BASE_URL: "https://attacker.invalid" }).evrenBaseUrl)
      .toBe("https://evren-llmapi.ssyz.org.tr/v1");
  });
});
