import { z } from "zod";
import { normalizeTools, type NormalizedTool } from "./tool-protocol.js";
import type { RequestClassification } from "../usage/types.js";

const requestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().optional(),
  input: z.unknown().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  previous_response_id: z.string().optional(),
  client_metadata: z.unknown().optional(),
  stream: z.boolean().optional(),
}).passthrough();

const FOREGROUND_REQUEST_KINDS = new Set(["turn", "review"]);
const INTERNAL_REQUEST_KINDS = new Set([
  "compact",
  "memory",
  "memory_consolidation",
  "prewarm",
  "thread_spawn",
]);

export interface NormalizedInputEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  callId?: string;
}

export interface NormalizedCodexRequest {
  model?: string;
  instructions: string;
  entries: NormalizedInputEntry[];
  toolOutputCallIds: string[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  previousResponseId?: string;
  requestKind?: string;
  requestClassification: RequestClassification;
  foreground: boolean;
  stream: boolean;
  unknownFields: string[];
}

export type NormalizedToolChoice = "auto" | "required" | "none" | {
  type: "function" | "custom";
  name: string;
};

const KNOWN_FIELDS = new Set([
  "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls",
  "previous_response_id", "client_metadata", "stream", "reasoning", "metadata", "store", "include", "text",
]);

export function normalizeCodexRequest(body: unknown): NormalizedCodexRequest {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new InvalidRequestError("Request body must be a JSON object with valid field types.");
  const value = parsed.data;
  const entries = normalizeInput(value.input);
  const requestKind = normalizeRequestKind(value.client_metadata);
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    instructions: value.instructions ?? "",
    entries,
    toolOutputCallIds: entries.flatMap((entry) => entry.role === "tool" && entry.callId ? [entry.callId] : []),
    tools: normalizeTools(value.tools),
    toolChoice: normalizeToolChoice(value.tool_choice),
    ...(value.previous_response_id === undefined ? {} : { previousResponseId: value.previous_response_id }),
    ...(requestKind === undefined ? {} : { requestKind }),
    requestClassification: classifyRequest(requestKind),
    foreground: requestKind === undefined ? value.client_metadata === undefined : isForegroundRequest(requestKind),
    stream: value.stream ?? false,
    unknownFields: Object.keys(value).filter((key) => !KNOWN_FIELDS.has(key)),
  };
}

function classifyRequest(requestKind: string | undefined): RequestClassification {
  if (requestKind !== undefined && INTERNAL_REQUEST_KINDS.has(requestKind)) return "internal";
  if (requestKind !== undefined && FOREGROUND_REQUEST_KINDS.has(requestKind)) return "foreground";
  return "unclassified";
}

function normalizeRequestKind(clientMetadata: unknown): string | undefined {
  if (!clientMetadata || typeof clientMetadata !== "object" || Array.isArray(clientMetadata)) return undefined;
  const encoded = (clientMetadata as Record<string, unknown>)["x-codex-turn-metadata"];
  if (typeof encoded !== "string") return undefined;
  try {
    const metadata = JSON.parse(encoded) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const requestKind = (metadata as Record<string, unknown>).request_kind;
    if (typeof requestKind !== "string") return undefined;
    const normalized = requestKind.trim();
    return FOREGROUND_REQUEST_KINDS.has(normalized) || INTERNAL_REQUEST_KINDS.has(normalized)
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function isForegroundRequest(requestKind: string | undefined): boolean {
  if (requestKind === undefined) return true;
  if (FOREGROUND_REQUEST_KINDS.has(requestKind)) return true;
  if (INTERNAL_REQUEST_KINDS.has(requestKind)) return false;
  return false;
}

function normalizeToolChoice(value: unknown): NormalizedToolChoice {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "required" || value === "none") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("tool_choice must be auto, required, none, or a named function/custom tool.");
  }
  const record = value as Record<string, unknown>;
  if ((record.type !== "function" && record.type !== "custom")
    || typeof record.name !== "string" || !record.name.trim()) {
    throw new InvalidRequestError("Named tool_choice must contain type function/custom and a non-empty name.");
  }
  return { type: record.type, name: record.name.trim() };
}

function normalizeInput(input: unknown): NormalizedInputEntry[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  if (!Array.isArray(input)) return input === undefined ? [] : [{ role: "user", text: safeStringify(input) }];
  const entries: NormalizedInputEntry[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      entries.push({ role: "user", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "mcp_tool_call_output") {
      const text = contentToText(record.output);
      if (text !== undefined) {
        entries.push({ role: "tool", text, ...(typeof record.call_id === "string" ? { callId: record.call_id } : {}) });
      }
      continue;
    }
    if (type === "message" || typeof record.role === "string") {
      const text = contentToText(record.content);
      if (text !== undefined) {
        const role = record.role === "assistant" ? "assistant" : "user";
        entries.push({ role, text });
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call" || type === "reasoning" || type === "reasoning_text") continue;
    entries.push({ role: "user", text: `[Unsupported input item ${type || "unknown"}: ${safeStringify(record)}]` });
  }
  return entries;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? undefined : safeStringify(content);
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      else if (record.type === "input_image" || record.type === "input_audio") parts.push(`[${String(record.type)} omitted]`);
      else parts.push(safeStringify(record));
    }
  }
  return parts.join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable input]";
  }
}

export class InvalidRequestError extends Error {
  readonly code = "invalid_request_error";
}
