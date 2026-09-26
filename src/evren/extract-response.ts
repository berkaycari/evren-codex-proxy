export interface EvrenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("EVREN response is not an object.");
  const object = payload as Record<string, unknown>;
  if (typeof object.output_text === "string" && object.output_text.trim()) return object.output_text;
  if (!Array.isArray(object.output)) throw new Error("EVREN response does not contain output items.");
  const parts: string[] = [];
  for (const item of object.output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" && record.role !== "assistant") continue;
    if (!Array.isArray(record.content)) continue;
    for (const content of record.content) {
      if (!content || typeof content !== "object") continue;
      const block = content as Record<string, unknown>;
      if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  const text = parts.join("\n").trim();
  if (!text) throw new Error("EVREN response contains no assistant text.");
  return text;
}

export function extractUsage(payload: unknown): EvrenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = record.input_tokens;
  const output = record.output_tokens;
  const total = record.total_tokens;
  if (
    typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 ||
    typeof output !== "number" || !Number.isSafeInteger(output) || output < 0 ||
    typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
    total !== input + output
  ) return undefined;
  const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : undefined;
  const outputDetails = isRecord(record.output_tokens_details) ? record.output_tokens_details : undefined;
  const cachedTokens = validOptionalTokenCount(inputDetails?.cached_tokens);
  const reasoningTokens = validOptionalTokenCount(outputDetails?.reasoning_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function validOptionalTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
