import { extractResponseText } from "../evren/extract-response.js";
import type { NormalizedTool } from "./tool-protocol.js";
import { ToolProtocolError } from "./tool-protocol.js";

export type NativeEvrenDecision = {
  kind: "final";
  content: string;
} | {
  kind: "tool_call";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson: string;
};

export function parseNativeEvrenResponse(
  raw: unknown,
  tools: ReadonlyMap<string, NormalizedTool>,
): NativeEvrenDecision {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { output?: unknown }).output)) {
    throw protocolError("EVREN native response does not contain an output array.");
  }
  const output = (raw as { output: unknown[] }).output;
  const calls = output.filter((item) => isRecord(item) && item.type === "function_call") as Record<string, unknown>[];
  if (calls.length > 1) {
    throw protocolError(`EVREN returned ${calls.length} function calls; sequential mode permits exactly one.`);
  }
  if (calls.length === 1) return parseFunctionCall(calls[0]!, tools);

  try {
    return { kind: "final", content: extractResponseText(raw) };
  } catch (error) {
    throw protocolError(error instanceof Error ? error.message : "EVREN native response has no usable output.");
  }
}

function parseFunctionCall(
  call: Record<string, unknown>,
  tools: ReadonlyMap<string, NormalizedTool>,
): NativeEvrenDecision {
  if (typeof call.name !== "string" || typeof call.call_id !== "string" || !call.call_id
    || typeof call.arguments !== "string") {
    throw protocolError("EVREN native function_call is missing name, call_id, or JSON arguments.");
  }
  const tool = tools.get(call.name);
  if (!tool) throw protocolError(`EVREN requested unknown tool: ${call.name}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    throw protocolError(`EVREN returned malformed JSON arguments for ${call.name}.`);
  }
  if (!isRecord(parsed)) throw protocolError(`EVREN arguments for ${call.name} must be a JSON object.`);
  if (tool.kind === "custom") {
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "input" || typeof parsed.input !== "string") {
      throw protocolError(`EVREN returned malformed custom wrapper arguments for ${call.name}.`);
    }
  }
  return {
    kind: "tool_call",
    callId: call.call_id,
    name: call.name,
    arguments: parsed,
    argumentsJson: call.arguments,
  };
}

function protocolError(message: string): ToolProtocolError {
  return new ToolProtocolError(message, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
