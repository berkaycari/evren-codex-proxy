export const LOCAL_BRIDGE_TOKEN_ENV = "EVREN_DESKTOP_BRIDGE_TOKEN";
export const DESKTOP_PROVIDER_ID = "evren-desktop";

export interface CodexLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildCodexLaunchSpec(options: {
  executable?: string;
  cwd: string;
  host: "127.0.0.1";
  port: number;
  model: string;
  localBridgeToken: string;
  baseEnv?: NodeJS.ProcessEnv;
}): CodexLaunchSpec {
  if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    throw new Error("Codex provider port is invalid.");
  }
  const model = safeConfigText(options.model, "model");
  const providerBaseUrl = `http://127.0.0.1:${options.port}/v1`;
  const overrides = [
    `model=${tomlString(model)}`,
    `model_provider=${tomlString(DESKTOP_PROVIDER_ID)}`,
    `model_providers.${DESKTOP_PROVIDER_ID}.name=${tomlString("EVREN Desktop")}`,
    `model_providers.${DESKTOP_PROVIDER_ID}.base_url=${tomlString(providerBaseUrl)}`,
    `model_providers.${DESKTOP_PROVIDER_ID}.wire_api=${tomlString("responses")}`,
    `model_providers.${DESKTOP_PROVIDER_ID}.env_key=${tomlString(LOCAL_BRIDGE_TOKEN_ENV)}`,
    `model_providers.${DESKTOP_PROVIDER_ID}.requires_openai_auth=false`,
  ];
  return {
    executable: options.executable ?? "codex",
    args: [
      "app-server",
      "--listen",
      "stdio://",
      ...overrides.flatMap((value) => ["-c", value]),
    ],
    cwd: options.cwd,
    env: buildCodexChildEnvironment(options.baseEnv ?? process.env, options.localBridgeToken),
  };
}

export function buildCodexChildEnvironment(baseEnv: NodeJS.ProcessEnv, localBridgeToken: string): NodeJS.ProcessEnv {
  if (!localBridgeToken || localBridgeToken.length < 32) throw new Error("Local Bridge token is invalid.");
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || looksSensitive(key)) continue;
    result[key] = value;
  }
  result[LOCAL_BRIDGE_TOKEN_ENV] = localBridgeToken;
  return result;
}

function looksSensitive(key: string): boolean {
  return /(api.?key|token|secret|password|credential|authorization)/i.test(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeConfigText(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`Codex ${label} is invalid.`);
  }
  return result;
}
