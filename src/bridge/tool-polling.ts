import { createHash } from "node:crypto";

const POLL_TOOL_NAME = "write_stdin";

export interface RecognizedToolPoll {
  toolName: string;
  identityHash: string;
}

export function recognizeToolPoll(
  toolName: string,
  argumentsValue: Record<string, unknown>,
): RecognizedToolPoll | undefined {
  if (toolName !== POLL_TOOL_NAME) return undefined;
  const args = unwrapCustomArguments(argumentsValue);
  if (!args) return undefined;
  const sessionId = args.session_id;
  if ((typeof sessionId !== "string" && typeof sessionId !== "number")
    || String(sessionId).trim().length === 0) return undefined;
  const identityHash = createHash("sha256")
    .update(`${toolName}\0session_id\0${String(sessionId)}`, "utf8")
    .digest("hex");
  return { toolName, identityHash };
}

function unwrapCustomArguments(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(value).length !== 1 || typeof value.input !== "string") return value;
  try {
    const parsed = JSON.parse(value.input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export class ToolPollLimitError extends Error {
  readonly code = "tool_poll_limit_reached";

  constructor(readonly consecutivePolls: number, readonly limit: number) {
    super(
      `Long-running tool polling reached the local safety cap (${consecutivePolls}/${limit}). `
      + "No additional EVREN inference was made; raise or disable the cap only after reviewing the running tool.",
    );
  }
}

export class NoProgressLoopError extends Error {
  readonly code = "no_progress_loop";

  constructor(readonly consecutiveResults: number, readonly limit: number) {
    super(
      "Bu görev aynı durumda tekrar etmeye başladı. Gereksiz model kullanımını önlemek için otomatik devam durduruldu. "
      + "Çalışan işlemi inceleyip görevi açıkça yeniden deneyin veya devam ettirin.",
    );
  }
}

export function fingerprintToolCall(toolName: string, argumentsValue: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${toolName}\0${stableSerialize(argumentsValue)}`, "utf8")
    .digest("hex");
}

export function fingerprintToolResult(toolCallFingerprint: string, output: string): string {
  return createHash("sha256")
    .update(`${toolCallFingerprint}\0${output}`, "utf8")
    .digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
