import { randomUUID } from "node:crypto";
import type { EvrenUsage } from "../evren/extract-response.js";
import type { ModelDecision, NormalizedTool } from "./tool-protocol.js";

export interface CodexResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<Record<string, unknown>>;
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
  error: null;
  incomplete_details: null;
  parallel_tool_calls: false;
}

export interface BuiltCodexResponse {
  response: CodexResponse;
  item: Record<string, unknown>;
  callId?: string;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function buildCodexResponse(
  decision: ModelDecision,
  model: string,
  usage: EvrenUsage,
  tools: Map<string, NormalizedTool>,
  options: { callId?: string; argumentsJson?: string } = {},
): BuiltCodexResponse {
  let item: Record<string, unknown>;
  let callId: string | undefined;
  if (decision.kind === "final") {
    item = {
      id: id("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: decision.content, annotations: [] }],
    };
  } else {
    const tool = tools.get(decision.name);
    if (!tool) throw new Error(`Normalized tool disappeared: ${decision.name}`);
    callId = options.callId ?? id("call");
    if (tool.kind === "custom") {
      item = {
        id: id("ctc"),
        type: "custom_tool_call",
        status: "completed",
        call_id: callId,
        name: decision.name,
        input: typeof decision.arguments.input === "string"
          ? decision.arguments.input
          : JSON.stringify(decision.arguments),
      };
    } else {
      item = {
        id: id("fc"),
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: decision.name,
        arguments: options.argumentsJson ?? JSON.stringify(decision.arguments),
      };
    }
  }

  const response: CodexResponse = {
    id: id("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [item],
    usage: {
      input_tokens: usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.totalTokens,
    },
    error: null,
    incomplete_details: null,
    parallel_tool_calls: false,
  };
  return { response, item, ...(callId === undefined ? {} : { callId }) };
}
