import { z } from "zod";
import { createHash } from "node:crypto";
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
  role: "developer" | "user" | "assistant" | "tool";
  text: string;
  inputIndex: number;
  callId?: string;
  nativeContent?: Array<Record<string, unknown>>;
}

export interface NormalizedHistoricalToolCall {
  inputIndex: number;
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface NormalizedCodexRequest {
  model?: string;
  instructions: string;
  entries: NormalizedInputEntry[];
  historicalToolCalls: NormalizedHistoricalToolCall[];
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
  abortSignal?: AbortSignal;
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
  const normalizedInput = normalizeInput(value.input);
  const entries = normalizedInput.entries;
  const turnMetadata = normalizeCodexTurnMetadata(value.client_metadata);
  const requestKind = turnMetadata.requestKind;
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    instructions: value.instructions ?? "",
    entries,
    historicalToolCalls: normalizedInput.historicalToolCalls,
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

function normalizeInput(input: unknown): {
  entries: NormalizedInputEntry[];
  historicalToolCalls: NormalizedHistoricalToolCall[];
} {
  if (typeof input === "string") return { entries: [{ role: "user", text: input, inputIndex: 0 }], historicalToolCalls: [] };
  if (input === undefined) return { entries: [], historicalToolCalls: [] };
  if (!Array.isArray(input)) throw new InvalidRequestError("input must be a string or an array of supported Responses input items.");
  const entries: NormalizedInputEntry[] = [];
  const historicalToolCalls: NormalizedHistoricalToolCall[] = [];
  for (const [inputIndex, item] of input.entries()) {
    if (typeof item === "string") {
      entries.push({ role: "user", text: item, inputIndex });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new InvalidRequestError(`input[${inputIndex}] must be a supported Responses input item.`);
    }
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "mcp_tool_call_output") {
      const text = contentToText(record.output);
      const callId = typeof record.call_id === "string" ? record.call_id.trim() : "";
      if (!callId || text === undefined) throw new InvalidRequestError(`${type} must contain call_id and output.`);
      entries.push({ role: "tool", text, inputIndex, callId });
      continue;
    }
    if (type === "message" || typeof record.role === "string") {
      const role = normalizeMessageRole(record.role, inputIndex);
      const content = contentToNormalized(record.content, role);
      if (content !== undefined) {
        const containsImage = content.nativeContent.some((part) => part.type === "input_image");
        entries.push({ role, text: content.text, inputIndex, ...(containsImage ? { nativeContent: content.nativeContent } : {}) });
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const callId = typeof record.call_id === "string" ? record.call_id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const rawArguments = type === "function_call" ? record.arguments : record.input;
      const argumentsJson = typeof rawArguments === "string" ? rawArguments : safeStringify(rawArguments ?? {});
      if (!callId || !name) throw new InvalidRequestError(`${type} must contain call_id and name.`);
      historicalToolCalls.push({ inputIndex, callId, name, argumentsJson });
      continue;
    }
    if (type === "reasoning" || type === "reasoning_text") continue;
    throw new InvalidRequestError(`Unsupported Responses input item at input[${inputIndex}]: ${type || "unknown"}.`);
  }
  return { entries, historicalToolCalls };
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
      else if (record.type === "input_image" || record.type === "input_audio") {
        throw new InvalidRequestError(`${String(record.type)} is not supported inside a tool output.`);
      }
      else parts.push(safeStringify(record));
    }
  }
  return parts.join("\n");
}

function contentToNormalized(
  content: unknown,
  role: "developer" | "user" | "assistant",
): { text: string; nativeContent: Array<Record<string, unknown>> } | undefined {
  if (typeof content === "string") {
    return {
      text: content,
      nativeContent: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }],
    };
  }
  if (!Array.isArray(content)) {
    if (content === undefined) return undefined;
    const text = safeStringify(content);
    return { text, nativeContent: [{ type: role === "assistant" ? "output_text" : "input_text", text }] };
  }
  const textParts: string[] = [];
  const nativeContent: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      nativeContent.push({ type: role === "assistant" ? "output_text" : "input_text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if ((type === undefined && typeof record.text === "string")
      || ((type === "input_text" || type === "output_text" || type === "text") && typeof record.text === "string")) {
      textParts.push(record.text);
      nativeContent.push({ type: role === "assistant" ? "output_text" : "input_text", text: record.text });
      continue;
    }
    if (record.type === "input_image" && role === "user") {
      const imageUrl = typeof record.image_url === "string" && record.image_url
        ? validateImageReference(record.image_url)
        : undefined;
      const fileId = typeof record.file_id === "string" && record.file_id ? record.file_id : undefined;
      if (!imageUrl && !fileId) throw new InvalidRequestError("input_image must contain image_url or file_id.");
      const detail = record.detail === "low" || record.detail === "high" || record.detail === "auto"
        ? record.detail : undefined;
      nativeContent.push({
        type: "input_image",
        ...(imageUrl ? { image_url: imageUrl } : { file_id: fileId }),
        ...(detail ? { detail } : {}),
      });
      textParts.push(`[input_image sha256:${imageFingerprint(imageUrl ?? fileId!)}]`);
      continue;
    }
    if (record.type === "input_audio") {
      throw new InvalidRequestError("input_audio is not supported by this Bridge version.");
    }
    throw new InvalidRequestError(`Unsupported message content item: ${type ?? "unknown"}.`);
  }
  return { text: textParts.join("\n"), nativeContent };
}

function normalizeMessageRole(value: unknown, inputIndex: number): "developer" | "user" | "assistant" {
  if (value === "user" || value === "assistant") return value;
  if (value === "developer" || value === "system") return "developer";
  throw new InvalidRequestError(`Unsupported message role at input[${inputIndex}].`);
}

function imageFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function validateImageReference(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new InvalidRequestError("input_image image_url must be an HTTP(S) URL or a base64 data URL.");
  const mimeType = match[1]!.toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new InvalidRequestError("input_image supports only PNG, JPEG, or WebP data URLs.");
  }
  if (match[2]!.length % 4 !== 0) throw new InvalidRequestError("input_image contains malformed base64 data.");
  return value;
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
