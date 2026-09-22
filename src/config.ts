import { readFileSync } from "node:fs";

const defaults = JSON.parse(
  readFileSync(new URL("../config/defaults.json", import.meta.url), "utf8"),
) as BridgeConfig;

export interface BridgeConfig {
  host: "127.0.0.1";
  port: number;
  evrenBaseUrl: string;
  model: string;
  toolTransport: "native" | "textual";
  maxSessionTokens: number;
  maxDailyTokens: number;
  maxRequestsPerSession: number;
  maxToolCallsPerSession: number;
  maxEstimatedInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  sessionTtlMinutes: number;
  toolOutputMaxChars: number;
  pricingRefreshMinutes: number;
  requestTimeoutMs: number;
}

const ENV_NUMBERS: Record<string, keyof BridgeConfig> = {
  PORT: "port",
  MAX_SESSION_TOKENS: "maxSessionTokens",
  MAX_DAILY_TOKENS: "maxDailyTokens",
  MAX_REQUESTS_PER_SESSION: "maxRequestsPerSession",
  MAX_TOOL_CALLS_PER_SESSION: "maxToolCallsPerSession",
  MAX_ESTIMATED_INPUT_TOKENS_PER_CALL: "maxEstimatedInputTokensPerCall",
  MAX_OUTPUT_TOKENS_PER_CALL: "maxOutputTokensPerCall",
  SESSION_TTL_MINUTES: "sessionTtlMinutes",
  TOOL_OUTPUT_MAX_CHARS: "toolOutputMaxChars",
  PRICING_REFRESH_MINUTES: "pricingRefreshMinutes",
  EVREN_REQUEST_TIMEOUT_MS: "requestTimeoutMs",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const config = { ...defaults } as BridgeConfig;
  for (const [envName, key] of Object.entries(ENV_NUMBERS)) {
    const raw = env[envName];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${envName} must be a positive integer.`);
    }
    (config as unknown as Record<string, number>)[key] = parsed;
  }

  const toolTransport = env.EVREN_TOOL_TRANSPORT?.trim();
  if (toolTransport !== undefined && toolTransport !== "native" && toolTransport !== "textual") {
    throw new Error("EVREN_TOOL_TRANSPORT must be either native or textual.");
  }
  config.toolTransport = toolTransport ?? defaults.toolTransport;

  // Security-critical values intentionally cannot be overridden by environment.
  config.host = "127.0.0.1";
  config.evrenBaseUrl = defaults.evrenBaseUrl;
  config.model = defaults.model;
  return config;
}
