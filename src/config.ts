import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  maxSessionCredits: number;
  maxDailyCredits: number;
  minCreditsRemaining: number;
  maxRequestsPerSession: number;
  maxToolCallsPerSession: number;
  maxEstimatedInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  sessionTtlMinutes: number;
  toolOutputMaxChars: number;
  toolPollWarningThreshold: number;
  maxConsecutiveToolPollInferences: number;
  pricingRefreshMinutes: number;
  requestTimeoutMs: number;
  updateCheckEnabled: boolean;
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
  TOOL_POLL_WARNING_THRESHOLD: "toolPollWarningThreshold",
  MAX_CONSECUTIVE_TOOL_POLL_INFERENCES: "maxConsecutiveToolPollInferences",
  PRICING_REFRESH_MINUTES: "pricingRefreshMinutes",
  EVREN_REQUEST_TIMEOUT_MS: "requestTimeoutMs",
};

const ENV_NON_NEGATIVE_DECIMALS: Record<string, keyof BridgeConfig> = {
  MAX_SESSION_CREDITS: "maxSessionCredits",
  MAX_DAILY_CREDITS: "maxDailyCredits",
  MIN_CREDITS_REMAINING: "minCreditsRemaining",
};

const LOCAL_NUMBER_KEYS = [
  "maxSessionTokens",
  "maxDailyTokens",
  "maxRequestsPerSession",
  "maxToolCallsPerSession",
  "maxEstimatedInputTokensPerCall",
  "maxOutputTokensPerCall",
  "toolOutputMaxChars",
  "toolPollWarningThreshold",
  "sessionTtlMinutes",
  "pricingRefreshMinutes",
  "requestTimeoutMs",
] as const satisfies ReadonlyArray<keyof BridgeConfig>;

const LOCAL_NON_NEGATIVE_NUMBER_KEYS = [
  "maxConsecutiveToolPollInferences",
] as const satisfies ReadonlyArray<keyof BridgeConfig>;

const LOCAL_NON_NEGATIVE_DECIMAL_KEYS = [
  "maxSessionCredits",
  "maxDailyCredits",
  "minCreditsRemaining",
] as const satisfies ReadonlyArray<keyof BridgeConfig>;

const localNumberKeys = new Set<string>(LOCAL_NUMBER_KEYS);
const localNonNegativeNumberKeys = new Set<string>(LOCAL_NON_NEGATIVE_NUMBER_KEYS);
const localNonNegativeDecimalKeys = new Set<string>(LOCAL_NON_NEGATIVE_DECIMAL_KEYS);

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { localConfigPath?: string } = {},
): BridgeConfig {
  const localConfigPath = options.localConfigPath
    ?? fileURLToPath(new URL("../config/local.json", import.meta.url));
  const config = { ...defaults, ...readLocalConfig(localConfigPath) } as BridgeConfig;
  for (const [envName, key] of Object.entries(ENV_NUMBERS)) {
    const raw = env[envName];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) throw new Error(`${envName} must be a positive integer.`);
    const parsed = Number(raw);
    const nonNegative = key === "maxConsecutiveToolPollInferences";
    if (!Number.isSafeInteger(parsed) || (nonNegative ? parsed < 0 : parsed <= 0)) {
      throw new Error(`${envName} must be a ${nonNegative ? "non-negative" : "positive"} integer.`);
    }
    (config as unknown as Record<string, number>)[key] = parsed;
  }
  for (const [envName, key] of Object.entries(ENV_NON_NEGATIVE_DECIMALS)) {
    const raw = env[envName];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) throw new Error(`${envName} must be a finite non-negative number.`);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${envName} must be a finite non-negative number.`);
    }
    (config as unknown as Record<string, number>)[key] = parsed;
  }

  const toolTransport = env.EVREN_TOOL_TRANSPORT?.trim();
  if (toolTransport !== undefined && toolTransport !== "native" && toolTransport !== "textual") {
    throw new Error("EVREN_TOOL_TRANSPORT must be either native or textual.");
  }
  config.toolTransport = toolTransport ?? defaults.toolTransport;

  const updateCheckEnabled = env.UPDATE_CHECK_ENABLED?.trim().toLowerCase();
  if (updateCheckEnabled !== undefined && updateCheckEnabled !== "true" && updateCheckEnabled !== "false") {
    throw new Error("UPDATE_CHECK_ENABLED must be true or false.");
  }
  if (updateCheckEnabled !== undefined) config.updateCheckEnabled = updateCheckEnabled === "true";

  // Security-critical values intentionally cannot be overridden by environment.
  config.host = "127.0.0.1";
  config.evrenBaseUrl = defaults.evrenBaseUrl;
  config.model = defaults.model;
  return config;
}

function readLocalConfig(path: string): Partial<BridgeConfig> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`Unable to read local configuration at ${path}.`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Local configuration at ${path} is not valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local configuration at ${path} must be a JSON object.`);
  }

  const result: Partial<BridgeConfig> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "updateCheckEnabled") {
      if (typeof raw !== "boolean") {
        throw new Error("Local configuration value updateCheckEnabled must be true or false.");
      }
      result.updateCheckEnabled = raw;
      continue;
    }
    if (!localNumberKeys.has(key) && !localNonNegativeNumberKeys.has(key) && !localNonNegativeDecimalKeys.has(key)) {
      throw new Error(`Unsupported local configuration key: ${key}. Secrets and runtime endpoints are not allowed.`);
    }
    if (localNonNegativeDecimalKeys.has(key)) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        throw new Error(`Local configuration value ${key} must be a finite non-negative number.`);
      }
      (result as Record<string, number>)[key] = raw;
      continue;
    }
    const nonNegative = localNonNegativeNumberKeys.has(key);
    if (!Number.isSafeInteger(raw) || (nonNegative ? (raw as number) < 0 : (raw as number) <= 0)) {
      throw new Error(`Local configuration value ${key} must be a ${nonNegative ? "non-negative" : "positive"} integer.`);
    }
    (result as Record<string, number>)[key] = raw as number;
  }
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
