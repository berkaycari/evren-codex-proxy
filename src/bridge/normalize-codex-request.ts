import { z } from "zod";
import { normalizeTools, type NormalizedTool } from "./tool-protocol.js";
import type { RequestClassification } from "../usage/types.js";

const requestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().optional(),
  input: z.unknown().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  previous_response_id: z.string().optional(),
  client_metadata: z.unknown().optional(),
  stream: z.boolean().optional(),
}).passthrough();

const FOREGROUND_REQUEST_KINDS = new Set(["turn"]);
const INTERNAL_REQUEST_KINDS = new Set(["prewarm", "compaction", "memory"]);

export interface CodexTurnMetadata {
  requestKind?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  windowId?: string;
  windowNumber?: number;
  contextWindowId?: string;
  parentThreadId?: string;
  parentTurnId?: string;
  threadSource?: string;
  turnTrigger?: string;
  latestGitCommitHash?: string;
  hasChanges?: boolean;
}

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
  parallelToolCalls: boolean;
  previousResponseId?: string;
  requestKind?: string;
  turnMetadata: CodexTurnMetadata;
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
  const turnMetadata = normalizeCodexTurnMetadata(value.client_metadata);
  const requestKind = turnMetadata.requestKind;
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    instructions: value.instructions ?? "",
    entries,
    toolOutputCallIds: entries.flatMap((entry) => entry.role === "tool" && entry.callId ? [entry.callId] : []),
    tools: normalizeTools(value.tools),
    toolChoice: normalizeToolChoice(value.tool_choice),
    parallelToolCalls: value.parallel_tool_calls ?? false,
    ...(value.previous_response_id === undefined ? {} : { previousResponseId: value.previous_response_id }),
    ...(requestKind === undefined ? {} : { requestKind }),
    turnMetadata,
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

export function normalizeCodexTurnMetadata(clientMetadata: unknown): CodexTurnMetadata {
  if (!clientMetadata || typeof clientMetadata !== "object" || Array.isArray(clientMetadata)) return {};
  const encoded = (clientMetadata as Record<string, unknown>)["x-codex-turn-metadata"];
  if (typeof encoded !== "string") return {};
  try {
    const metadata = JSON.parse(encoded) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    const record = metadata as Record<string, unknown>;
    const requestKind = optionalTrimmedString(record.request_kind);
    return {
      ...(requestKind === undefined ? {} : { requestKind }),
      ...optionalStringField(record, "session_id", "sessionId"),
      ...optionalStringField(record, "thread_id", "threadId"),
      ...optionalStringField(record, "turn_id", "turnId"),
      ...optionalStringField(record, "window_id", "windowId"),
      ...(Number.isSafeInteger(record.window_number) && (record.window_number as number) >= 0
        ? { windowNumber: record.window_number as number }
        : {}),
      ...optionalStringField(record, "context_window_id", "contextWindowId"),
      ...optionalStringField(record, "parent_thread_id", "parentThreadId"),
      ...optionalStringField(record, "parent_turn_id", "parentTurnId"),
      ...optionalStringField(record, "thread_source", "threadSource"),
      ...optionalStringField(record, "turn_trigger", "turnTrigger"),
      ...optionalStringField(record, "latest_git_commit_hash", "latestGitCommitHash"),
      ...(typeof record.has_changes === "boolean" ? { hasChanges: record.has_changes } : {}),
    };
  } catch {
    return {};
  }
}

function optionalStringField(
  record: Record<string, unknown>,
  source: string,
  target: keyof CodexTurnMetadata,
): Partial<CodexTurnMetadata> {
  const value = optionalTrimmedString(record[source]);
  return value === undefined ? {} : { [target]: value } as Partial<CodexTurnMetadata>;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 1_000 ? trimmed : undefined;
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
