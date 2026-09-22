import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { evaluateModelPricing } from "../src/evren/pricing.js";
import { assertRequestAllowed, LimitExceededError } from "../src/safety/limits.js";
import { SessionStore } from "../src/sessions/store.js";
import { redact } from "../src/ui/logger.js";

describe("pricing and safety", () => {
  it("uses the aligned platform quota while preserving local safety guards", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      toolTransport: "native",
      maxDailyTokens: 10_000_000,
      maxOutputTokensPerCall: 4_096,
      maxSessionTokens: 400_000,
      maxRequestsPerSession: 20,
      maxToolCallsPerSession: 40,
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
    const result = evaluateModelPricing({ data: [{
      id: "deepseek-v4-flash",
      pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
    }] }, "deepseek-v4-flash");
    expect(result.allowed).toBe(true);
  });

  it("blocks positive pricing", () => {
    const result = evaluateModelPricing({ data: [{
      id: "deepseek-v4-flash",
      pricing: { prompt_token_price: 0.001, completion_token_price: 0, currency: "CR" },
    }] }, "deepseek-v4-flash");
    expect(result.allowed).toBe(false);
  });

  it("blocks missing pricing", () => {
    expect(evaluateModelPricing({ data: [{ id: "deepseek-v4-flash" }] }, "deepseek-v4-flash").allowed).toBe(false);
  });

  it("enforces session and daily token limits", () => {
    const config = loadConfig({});
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
    const config = loadConfig({});
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
