import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("local bridge configuration", () => {
  it("uses environment overrides before local values and local values before defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-config-"));
    const localConfigPath = path.join(directory, "local.json");
    await writeFile(localConfigPath, JSON.stringify({
      maxSessionTokens: 123_456,
      maxDailyTokens: 654_321,
      maxRequestsPerSession: 25,
      maxToolCallsPerSession: 50,
      maxEstimatedInputTokensPerCall: 70_000,
      maxOutputTokensPerCall: 2_048,
      toolOutputMaxChars: 40_000,
      sessionTtlMinutes: 45,
      pricingRefreshMinutes: 15,
      requestTimeoutMs: 90_000,
    }), "utf8");

    const config = loadConfig({ MAX_SESSION_TOKENS: "222222" }, { localConfigPath });

    expect(config).toMatchObject({
      maxSessionTokens: 222_222,
      maxDailyTokens: 654_321,
      maxRequestsPerSession: 25,
      maxToolCallsPerSession: 50,
      maxEstimatedInputTokensPerCall: 70_000,
      maxOutputTokensPerCall: 2_048,
      toolOutputMaxChars: 40_000,
      sessionTtlMinutes: 45,
      pricingRefreshMinutes: 15,
      requestTimeoutMs: 90_000,
    });
    expect(config.port).toBe(8787);
  });

  it("does not require config/local.json to exist", () => {
    const missing = path.join(os.tmpdir(), `evren-missing-${Date.now()}`, "local.json");
    expect(loadConfig({}, { localConfigPath: missing }).maxSessionTokens).toBe(400_000);
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["unknown or secret-like key", JSON.stringify({ EVREN_API_KEY: "must-not-be-accepted" })],
    ["zero", JSON.stringify({ maxSessionTokens: 0 })],
    ["negative", JSON.stringify({ maxSessionTokens: -1 })],
    ["fraction", JSON.stringify({ maxSessionTokens: 1.5 })],
    ["unsafe integer", JSON.stringify({ maxSessionTokens: Number.MAX_SAFE_INTEGER + 1 })],
  ])("fails clearly for %s", async (_label, contents) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-config-invalid-"));
    const localConfigPath = path.join(directory, "local.json");
    await writeFile(localConfigPath, contents, "utf8");
    expect(() => loadConfig({}, { localConfigPath })).toThrow(/local configuration|configuration key|configuration value/i);
  });
});
