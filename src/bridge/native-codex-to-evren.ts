import type { NormalizedCodexRequest, NormalizedToolChoice } from "./normalize-codex-request.js";
import type { NormalizedTool } from "./tool-protocol.js";
import type { VerifiedSessionModelIdentity } from "../sessions/store.js";
import { renderVerifiedSessionModelIdentity } from "./codex-to-evren.js";

export type NativeEvrenInputItem = Record<string, unknown>;

export interface NativeEvrenFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type NativeEvrenToolChoice = "auto" | "required" | "none" | {
  type: "function";
  name: string;
};

export interface NativeEvrenRequest {
  model: string;
  input: NativeEvrenInputItem[];
  tools: NativeEvrenFunctionTool[];
  tool_choice: NativeEvrenToolChoice;
  parallel_tool_calls: boolean;
  max_output_tokens: number;
  stream: false;
}

const CUSTOM_COMPATIBILITY_NOTE = "Compatibility adapter: call this as a function with exactly one string field named input containing the raw custom tool input.";

export function buildNativeEvrenRequest(
  request: NormalizedCodexRequest,
  history: readonly NativeEvrenInputItem[],
  model: string,
  maxOutputTokens: number,
  modelIdentity: VerifiedSessionModelIdentity,
): NativeEvrenRequest {
  const tools = selectToolsForInference(request.toolChoice, request.tools);
  const identityMessage = nativeMessage("developer", renderVerifiedSessionModelIdentity(modelIdentity));
  const firstNonDeveloper = history.findIndex((item) => item.type !== "message" || item.role !== "developer");
  const identityIndex = firstNonDeveloper === -1 ? history.length : firstNonDeveloper;
  return {
    model,
    input: [
      ...history.slice(0, identityIndex),
      identityMessage,
      ...history.slice(identityIndex),
    ],
    tools: tools.map(toNativeFunctionTool),
    tool_choice: translateToolChoice(request.toolChoice, request.tools),
    parallel_tool_calls: request.parallelToolCalls,
    max_output_tokens: maxOutputTokens,
    stream: false,
  };
}

export function selectToolsForInference(
  choice: NormalizedToolChoice,
  tools: readonly NormalizedTool[],
): NormalizedTool[] {
  if (choice === "none") return [];
  if (typeof choice === "string") return [...tools];
  const tool = tools.find((candidate) => candidate.name === choice.name);
  if (!tool) throw new InvalidNativeToolChoiceError(`Named tool_choice references unknown tool: ${choice.name}`);
  if (tool.kind !== choice.type) {
    throw new InvalidNativeToolChoiceError(
      `Named tool_choice kind does not match ${choice.name}: expected ${tool.kind}, received ${choice.type}.`,
    );
  }
  return [tool];
}

export function toNativeFunctionTool(tool: NormalizedTool): NativeEvrenFunctionTool {
  if (tool.kind === "custom") {
    return {
      type: "function",
      name: tool.name,
      description: `${tool.description}\n\n${CUSTOM_COMPATIBILITY_NOTE}`,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Raw custom tool input" },
        },
        required: ["input"],
        additionalProperties: false,
      },
      strict: true,
    };
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
}

export function translateToolChoice(
  choice: NormalizedToolChoice,
  tools: readonly NormalizedTool[],
): NativeEvrenToolChoice {
  if (typeof choice === "string") return choice;
  const tool = tools.find((candidate) => candidate.name === choice.name);
  if (!tool) throw new InvalidNativeToolChoiceError(`Named tool_choice references unknown tool: ${choice.name}`);
  if (tool.kind !== choice.type) {
    throw new InvalidNativeToolChoiceError(
      `Named tool_choice kind does not match ${choice.name}: expected ${tool.kind}, received ${choice.type}.`,
    );
  }
  return { type: "function", name: choice.name };
}

export class InvalidNativeToolChoiceError extends Error {
  readonly code = "invalid_request_error";
}

export function nativeMessage(
  role: "developer" | "user" | "assistant",
  text: string,
  content?: Array<Record<string, unknown>>,
): NativeEvrenInputItem {
  return {
    type: "message",
    role,
    content: content?.length ? content : [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

export function nativeFunctionCall(
  callId: string,
  name: string,
  argumentsJson: string,
): NativeEvrenInputItem {
  return { type: "function_call", call_id: callId, name, arguments: argumentsJson };
}

export function nativeFunctionCallOutput(callId: string, output: string): NativeEvrenInputItem {
  return { type: "function_call_output", call_id: callId, output };
}
