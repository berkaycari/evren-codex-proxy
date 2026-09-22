import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge/bridge-service.js";
import {
  buildNativeEvrenRequest,
  toNativeFunctionTool,
  translateToolChoice,
  type NativeEvrenRequest,
} from "../src/bridge/native-codex-to-evren.js";
import { parseNativeEvrenResponse } from "../src/bridge/native-evren-to-codex.js";
import { normalizeCodexRequest } from "../src/bridge/normalize-codex-request.js";
import { normalizeTools, ToolProtocolError } from "../src/bridge/tool-protocol.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import type { EvrenInferenceResult, EvrenNativeResult, EvrenTransport } from "../src/evren/client.js";
import { SessionStore } from "../src/sessions/store.js";
import { buildServer } from "../src/server/app.js";
import type { LogEvent } from "../src/ui/logger.js";
import { UsagePersistence } from "../src/usage/persistence.js";
import { UsageTracker } from "../src/usage/tracker.js";

const functionTool = {
  type: "function",
  name: "get_current_directory",
  description: "Get cwd",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: true,
};

const customTool = {
  type: "custom",
  name: "shell",
  description: "Run a shell command",
};

function nativeResponse(output: unknown[], id = `evren_${Math.random()}`): Record<string, unknown> {
  return {
    id,
    output,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

class NativeMock implements EvrenTransport {
  readonly requests: NativeEvrenRequest[] = [];
  private index = 0;
  constructor(private readonly results: Array<Record<string, unknown> | Error>) {}
  async getModels(): Promise<unknown> { return { data: [] }; }
  async infer(_input: string, _maxOutputTokens: number): Promise<EvrenInferenceResult> {
    throw new Error("Textual inference must not run in native mode.");
  }
  async respond(request: NativeEvrenRequest): Promise<EvrenNativeResult> {
    this.requests.push(structuredClone(request));
    const candidate = this.results[this.index++] ?? this.results.at(-1);
    if (candidate instanceof Error) throw candidate;
    if (!candidate) throw new Error("No mock EVREN response configured.");
    return {
      id: String(candidate.id),
      ...(candidate.usage === undefined ? {} : {
        usage: {
          inputTokens: Number((candidate.usage as Record<string, unknown>).input_tokens),
          outputTokens: Number((candidate.usage as Record<string, unknown>).output_tokens),
          totalTokens: Number((candidate.usage as Record<string, unknown>).total_tokens),
        },
      }),
      raw: candidate,
    };
  }
}

const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(
  results: Array<Record<string, unknown> | Error>,
  configOverride: Partial<BridgeConfig> = {},
) {
  const config = { ...loadConfig({}), ...configOverride };
  const client = new NativeMock(results);
  const sessions = new SessionStore(config.sessionTtlMinutes * 60_000);
  const usage = new UsageTracker(new UsagePersistence(await mkdtemp(path.join(os.tmpdir(), "evren-native-"))));
  await usage.initialize();
  const events: LogEvent[] = [];
  const logger = { log: (event: LogEvent) => events.push(event) };
  const pricingGuard = {
    assertAllowed: () => undefined,
    getState: () => ({
      allowed: true,
      connected: true,
      checkedAt: "2026-09-22T00:00:00.000Z",
      pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    }),
  };
  const bridge = new BridgeService({ config, client, pricingGuard, sessions, usage, logger });
  const app = buildServer({ config, pricingGuard, sessions, usage, bridge, logger });
  apps.push(app);
  return { app, client, sessions, usage, events };
}

describe("native Codex to EVREN mapping", () => {
  it("maps function tools without changing their schema or strict flag", () => {
    const tool = normalizeTools([functionTool])[0]!;
    expect(toNativeFunctionTool(tool)).toEqual({
      type: "function",
      name: "get_current_directory",
      description: "Get cwd",
      parameters: functionTool.parameters,
      strict: true,
    });
  });

  it("maps custom tools to strict standard function wrappers", () => {
    const mapped = toNativeFunctionTool(normalizeTools([customTool])[0]!);
    expect(mapped.type).toBe("function");
    expect(mapped.strict).toBe(true);
    expect(mapped.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string", description: "Raw custom tool input" } },
      required: ["input"],
      additionalProperties: false,
    });
    expect(mapped.description).toContain("Compatibility adapter");
  });

  it("maps mixed catalogs entirely to function tools", () => {
    const request = normalizeCodexRequest({ input: "test", tools: [functionTool, customTool] });
    const native = buildNativeEvrenRequest(request, [], "deepseek-v4-flash", 4096);
    expect(native.tools.map((tool) => [tool.name, tool.type])).toEqual([
      ["get_current_directory", "function"],
      ["shell", "function"],
    ]);
  });

  it("turns named custom tool choice into a named function choice", () => {
    const tools = normalizeTools([customTool]);
    expect(translateToolChoice({ type: "custom", name: "shell" }, tools))
      .toEqual({ type: "function", name: "shell" });
  });

  it("rejects unknown and kind-mismatched named choices", () => {
    const tools = normalizeTools([customTool]);
    expect(() => translateToolChoice({ type: "custom", name: "missing" }, tools)).toThrow(/unknown tool/);
    expect(() => translateToolChoice({ type: "function", name: "shell" }, tools)).toThrow(/kind does not match/);
  });

  it("builds only the native allowlist with sequential and output limits", () => {
    const request = normalizeCodexRequest({
      input: "hello",
      tools: [functionTool],
      previous_response_id: "local_only",
      prompt_cache_key: "do-not-forward",
      metadata: { secret: true },
      reasoning: { effort: "high" },
    });
    const native = buildNativeEvrenRequest(request, [], "deepseek-v4-flash", 4096);
    expect(Object.keys(native).sort()).toEqual([
      "input", "max_output_tokens", "model", "parallel_tool_calls", "stream", "tool_choice", "tools",
    ]);
    expect(native).not.toHaveProperty("previous_response_id");
    expect(native).not.toHaveProperty("prompt_cache_key");
    expect(native).not.toHaveProperty("metadata");
    expect(native).not.toHaveProperty("reasoning");
    expect(native.parallel_tool_calls).toBe(false);
    expect(native.max_output_tokens).toBe(4096);
  });
});

describe("native EVREN response parsing", () => {
  const tools = new Map(normalizeTools([functionTool, customTool]).map((tool) => [tool.name, tool]));

  it("ignores reasoning and lets a function call beat a pre-tool message", () => {
    const raw = nativeResponse([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "private chain" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "premature" }] },
      { type: "function_call", call_id: "chatcmpl-tool-1", name: "get_current_directory", arguments: "{}" },
    ]);
    expect(parseNativeEvrenResponse(raw, tools)).toEqual({
      kind: "tool_call",
      callId: "chatcmpl-tool-1",
      name: "get_current_directory",
      arguments: {},
      argumentsJson: "{}",
    });
  });

  it("parses wrapped custom calls", () => {
    expect(parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_shell", name: "shell", arguments: '{"input":"pwd"}' },
    ]), tools)).toMatchObject({
      kind: "tool_call", callId: "call_shell", name: "shell", arguments: { input: "pwd" },
    });
  });

  it("rejects malformed custom wrapper arguments", () => {
    expect(() => parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_shell", name: "shell", arguments: '{"command":"pwd"}' },
    ]), tools)).toThrow(ToolProtocolError);
  });

  it("rejects unknown upstream tool names", () => {
    expect(() => parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_x", name: "invented", arguments: "{}" },
    ]), tools)).toThrow(/unknown tool/);
  });

  it("rejects multiple function calls in sequential mode", () => {
    expect(() => parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "get_current_directory", arguments: "{}" },
    ]), tools)).toThrow(/sequential mode/);
  });

  it("uses an assistant message only when there is no tool call", () => {
    expect(parseNativeEvrenResponse(nativeResponse([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "private" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] },
    ]), tools)).toEqual({ kind: "final", content: "finished" });
  });
});

describe("native bridge lifecycle", () => {
  it("uses native function calling, preserves call_id, and never emits reasoning", async () => {
    const { app, client, events } = await fixture([nativeResponse([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "DO NOT EXPOSE" }] },
      { type: "function_call", call_id: "chatcmpl-tool-native", name: "get_current_directory", arguments: "{}" },
    ])]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: "cwd", tools: [functionTool], tool_choice: "required", stream: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().output).toEqual([expect.objectContaining({
      type: "function_call", call_id: "chatcmpl-tool-native", name: "get_current_directory", arguments: "{}",
    })]);
    expect(JSON.stringify(response.json())).not.toContain("DO NOT EXPOSE");
    expect(JSON.stringify(events)).not.toContain("DO NOT EXPOSE");
    expect(client.requests[0]).toMatchObject({
      tool_choice: "required", parallel_tool_calls: false, max_output_tokens: 4096,
    });
  });

  it("converts a wrapped native function call back to custom_tool_call", async () => {
    const { app, client } = await fixture([nativeResponse([
      { type: "function_call", call_id: "call_custom", name: "shell", arguments: '{"input":"pwd"}' },
    ])]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: "cwd", tools: [customTool], tool_choice: { type: "custom", name: "shell" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().output[0]).toMatchObject({
      type: "custom_tool_call", call_id: "call_custom", name: "shell", input: "pwd",
    });
    expect(client.requests[0]?.tools[0]?.type).toBe("function");
    expect(client.requests[0]?.tool_choice).toEqual({ type: "function", name: "shell" });
  });

  it("sends function output as full-history continuation without previous_response_id", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_cwd", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [functionTool] },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        previous_response_id: first.json().id,
        input: [{ type: "function_call_output", call_id: "call_cwd", output: "C:\\work" }],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(client.requests[1]).not.toHaveProperty("previous_response_id");
    expect(client.requests[1]?.input).toEqual([
      expect.objectContaining({ type: "message", role: "user" }),
      { type: "function_call", call_id: "call_cwd", name: "get_current_directory", arguments: "{}" },
      { type: "function_call_output", call_id: "call_cwd", output: "C:\\work" },
    ]);
  });

  it("translates custom tool output to wrapper function_call_output", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_shell", name: "shell", arguments: '{"input":"pwd"}' }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [customTool] } });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "custom_tool_call_output", call_id: "call_shell", output: "C:\\work" }] },
    });
    expect(client.requests[1]?.input.at(-1)).toEqual({
      type: "function_call_output", call_id: "call_shell", output: "C:\\work",
    });
  });

  it("deduplicates completed full-history replay and does not grow native history", async () => {
    const { app, client, events } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_a", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "function_call", call_id: "call_b", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [functionTool] } });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_a", output: "one" }] },
    });
    const final = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: "inspect" },
        { type: "function_call", call_id: "call_a", name: "get_current_directory", arguments: "{}" },
        { type: "function_call_output", call_id: "call_a", output: "one" },
        { type: "function_call", call_id: "call_b", name: "get_current_directory", arguments: "{}" },
        { type: "function_call_output", call_id: "call_b", output: "two" },
      ] },
    });
    expect(final.statusCode).toBe(200);
    const serialized = JSON.stringify(client.requests[2]?.input);
    expect(serialized.match(/"output":"one"/g)).toHaveLength(1);
    expect(serialized.match(/"output":"two"/g)).toHaveLength(1);
    expect(events.some((event) => event.event === "TOOL_HISTORY_REPLAY_IGNORED")).toBe(true);
  });

  it("does not duplicate replayed message history on previous_response_id continuation", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "second answer" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "original question" },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        previous_response_id: first.json().id,
        input: [
          { type: "message", role: "user", content: "original question" },
          { type: "message", role: "assistant", content: "first answer" },
          { type: "message", role: "user", content: "follow up" },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    const serialized = JSON.stringify(client.requests[1]?.input);
    expect(serialized.match(/original question/g)).toHaveLength(1);
    expect(serialized.match(/first answer/g)).toHaveLength(1);
    expect(serialized.match(/follow up/g)).toHaveLength(1);
  });

  it("rejects changed completed replay and historical-only replay without EVREN calls", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_done", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [functionTool] } });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_done", output: "same" }] },
    });
    const changed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_done", output: "changed" }] },
    });
    const historicalOnly = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_done", output: "same" }] },
    });
    expect(changed.statusCode).toBe(400);
    expect(historicalOnly.statusCode).toBe(400);
    expect(client.requests).toHaveLength(2);
  });

  it("keeps a staged output retryable after timeout and rejects a changed retry", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_retry", name: "get_current_directory", arguments: "{}" }]),
      new Error("EVREN request timed out."),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "retried" }] }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [functionTool] } });
    const output = [{ type: "function_call_output", call_id: "call_retry", output: "same" }];
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } })).statusCode).toBe(500);
    const changed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_retry", output: "changed" }] },
    });
    expect(changed.statusCode).toBe(400);
    const retry = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } });
    expect(retry.statusCode).toBe(200);
    expect(client.requests).toHaveLength(3);
    expect(JSON.stringify(client.requests[2]?.input).match(/"output":"same"/g)).toHaveLength(1);
  });

  it("fails closed when native usage is missing", async () => {
    const missing = nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "no usage" }] }]);
    delete missing.usage;
    const { app, usage } = await fixture([missing]);
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "hello" } });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("usage_missing");
    expect(usage.snapshot().accountingCertain).toBe(false);
  });

  it("deduplicates repeated EVREN response ids within a session", async () => {
    const duplicateId = "evren_duplicate";
    const { app, sessions, events } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_dup", name: "get_current_directory", arguments: "{}" }], duplicateId),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], duplicateId),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [functionTool] },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_dup", output: "C:\\work" }] },
    });
    expect(second.statusCode).toBe(200);
    expect(sessions.getByResponseId(first.json().id)?.usage.totalTokens).toBe(15);
    expect(events.some((event) => event.event === "USAGE_DEDUPLICATED")).toBe(true);
  });

  it("never invokes textual protocol repair in native mode", async () => {
    const { app, events } = await fixture([nativeResponse([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "plain final" }] },
    ])]);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "hello" } })).statusCode).toBe(200);
    expect(events.some((event) => event.event === "PROTOCOL_REPAIR")).toBe(false);
  });

  it.each([
    ["malformed custom wrapper", customTool, {
      type: "function_call", call_id: "call_bad_custom", name: "shell", arguments: '{"command":"pwd"}',
    }],
    ["unknown tool", functionTool, {
      type: "function_call", call_id: "call_unknown", name: "invented", arguments: "{}",
    }],
  ])("returns 502 for %s", async (_label, tool, upstreamCall) => {
    const { app } = await fixture([nativeResponse([upstreamCall])]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "test", tools: [tool] },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.type).toBe("upstream_protocol_error");
  });

  it("returns 502 when EVREN violates the sequential one-call invariant", async () => {
    const { app } = await fixture([nativeResponse([
      { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "get_current_directory", arguments: "{}" },
    ])]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "test", tools: [functionTool] },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("sequential mode");
  });

  it("rejects cross-session call ids before making another EVREN request", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_session_a", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "function_call", call_id: "call_session_b", name: "get_current_directory", arguments: "{}" }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "A", tools: [functionTool] } });
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "B", tools: [functionTool] } });
    const rejected = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "function_call_output", call_id: "call_session_a", output: "A" },
        { type: "function_call_output", call_id: "call_session_b", output: "B" },
      ] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("different sessions");
    expect(client.requests).toHaveLength(2);
  });
});
