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
import { DeterministicRetryCircuit } from "../src/safety/deterministic-retry-circuit.js";
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

function nativeResponse(
  output: unknown[],
  id = `evren_${Math.random()}`,
  usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
): Record<string, unknown> {
  return {
    id,
    output,
    usage,
  };
}

function codexMetadata(requestKind: string): Record<string, unknown> {
  return {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: requestKind,
      thread_id: "thread_live_acceptance",
      turn_id: `turn_${requestKind}`,
    }),
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
  retryCircuit?: DeterministicRetryCircuit,
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
  const bridge = new BridgeService({
    config,
    client,
    pricingGuard,
    sessions,
    usage,
    logger,
    ...(retryCircuit === undefined ? {} : { retryCircuit }),
  });
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
    const native = buildNativeEvrenRequest(request, [], "deepseek-v4.1-flash", 4096);
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
      client_metadata: codexMetadata("turn"),
      metadata: { secret: true },
      reasoning: { effort: "high" },
    });
    const native = buildNativeEvrenRequest(request, [], "deepseek-v4.1-flash", 4096);
    expect(Object.keys(native).sort()).toEqual([
      "input", "max_output_tokens", "model", "parallel_tool_calls", "stream", "tool_choice", "tools",
    ]);
    expect(native).not.toHaveProperty("previous_response_id");
    expect(native).not.toHaveProperty("prompt_cache_key");
    expect(native).not.toHaveProperty("client_metadata");
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
      returnedCallCount: 1,
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

  it("selects only the first of multiple function calls in output order", () => {
    expect(parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "shell", arguments: '{"input":"pwd"}' },
    ]), tools)).toMatchObject({
      kind: "tool_call",
      callId: "call_1",
      name: "get_current_directory",
      returnedCallCount: 2,
    });
  });

  it("rejects a malformed first call instead of selecting a later valid call", () => {
    expect(() => parseNativeEvrenResponse(nativeResponse([
      { type: "function_call", call_id: "call_bad", name: "invented", arguments: "{}" },
      { type: "function_call", call_id: "call_valid", name: "get_current_directory", arguments: "{}" },
    ]), tools)).toThrow(/unknown tool/);
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

  it("reuses one logical session for a unique canonical replay while preserving repeated user text", async () => {
    const repeated = "repeat this exact question";
    const { app, client, sessions } = await fixture([
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "second answer" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "unrelated answer" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: repeated },
    });
    const firstSession = sessions.getByResponseId(first.json().id);
    const continuation = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: repeated },
        { type: "message", role: "assistant", content: "first answer" },
        { type: "message", role: "user", content: repeated },
      ] },
    });
    const latestAfterContinuation = sessions.getLatest();
    const pureReplay = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: repeated },
        { type: "message", role: "assistant", content: "first answer" },
        { type: "message", role: "user", content: repeated },
        { type: "message", role: "assistant", content: "second answer" },
      ] },
    });
    const unrelated = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "different conversation" },
    });

    expect(continuation.statusCode).toBe(200);
    expect(pureReplay.statusCode).toBe(400);
    expect(sessions.getByResponseId(continuation.json().id)).toBe(firstSession);
    expect(latestAfterContinuation).toBe(firstSession);
    expect(firstSession?.requestCount).toBe(2);
    expect(client.requests).toHaveLength(3);
    expect(JSON.stringify(client.requests[1]?.input).match(/repeat this exact question/g)).toHaveLength(2);
    expect(sessions.getByResponseId(unrelated.json().id)).not.toBe(firstSession);
    expect(sessions.getByResponseId(unrelated.json().id)?.requestCount).toBe(1);
  });

  it("keeps the active foreground logical session selected after a later internal tools=0 request", async () => {
    const tools = Array.from({ length: 13 }, (_, index) => ({
      ...functionTool,
      name: `acceptance_tool_${index}`,
    }));
    const { app, sessions, usage, events } = await fixture([
      nativeResponse(
        [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "initial answer" }] }],
        "evren_main_1",
        { input_tokens: 14_631, output_tokens: 6, total_tokens: 14_637 },
      ),
      nativeResponse(
        [{ type: "function_call", call_id: "call_live", name: "acceptance_tool_0", arguments: "{}" }],
        "evren_main_2",
        { input_tokens: 14_722, output_tokens: 158, total_tokens: 14_880 },
      ),
      nativeResponse(
        [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "tool answer" }] }],
        "evren_main_3",
        { input_tokens: 14_865, output_tokens: 14, total_tokens: 14_879 },
      ),
      nativeResponse(
        [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "CONTINUATION_V11_OK" }] }],
        "evren_main_4",
        { input_tokens: 14_898, output_tokens: 9, total_tokens: 14_907 },
      ),
      nativeResponse(
        [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "internal result" }] }],
        "evren_helper_1",
        { input_tokens: 1_199, output_tokens: 307, total_tokens: 1_506 },
      ),
    ]);
    const turnMetadata = codexMetadata("turn");

    const initial = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: "initial user", tools, client_metadata: turnMetadata },
    });
    const toolRequest = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        input: [
          { type: "message", role: "user", content: "initial user" },
          { type: "message", role: "assistant", content: "initial answer" },
          { type: "message", role: "user", content: "use one tool" },
        ],
        tools,
        client_metadata: turnMetadata,
      },
    });
    const toolResult = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        input: [{ type: "function_call_output", call_id: "call_live", output: "tool result" }],
        tools,
        client_metadata: turnMetadata,
      },
    });
    const mainAfterThree = sessions.getByResponseId(toolResult.json().id);

    expect(initial.statusCode).toBe(200);
    expect(toolRequest.statusCode).toBe(200);
    expect(toolResult.statusCode).toBe(200);
    expect(mainAfterThree).toMatchObject({
      requestCount: 3,
      toolCallCount: 1,
      usage: { inputTokens: 44_218, outputTokens: 178, totalTokens: 44_396 },
    });

    const continuation = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        input: [
          { type: "message", role: "user", content: "initial user" },
          { type: "message", role: "assistant", content: "initial answer" },
          { type: "message", role: "user", content: "use one tool" },
          { type: "function_call", call_id: "call_live", name: "acceptance_tool_0", arguments: "{}" },
          { type: "function_call_output", call_id: "call_live", output: "tool result" },
          { type: "message", role: "assistant", content: "tool answer" },
          { type: "message", role: "user", content: "Without calling any tool, reply exactly." },
        ],
        tools,
        client_metadata: turnMetadata,
      },
    });
    const main = sessions.getByResponseId(continuation.json().id);
    expect(main).toBe(mainAfterThree);
    expect(main).toMatchObject({
      requestCount: 4,
      toolCallCount: 1,
      usage: { inputTokens: 59_116, outputTokens: 187, totalTokens: 59_303 },
    });
    expect(sessions.getCurrent()).toBe(main);

    const helper = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        input: "independent internal helper",
        tools: [],
        client_metadata: codexMetadata("prewarm"),
      },
    });
    const helperSession = sessions.getByResponseId(helper.json().id);

    expect(helper.statusCode).toBe(200);
    expect(helperSession).not.toBe(main);
    expect(helperSession).toMatchObject({
      requestCount: 1,
      toolCallCount: 0,
      usage: { inputTokens: 1_199, outputTokens: 307, totalTokens: 1_506 },
    });
    expect(sessions.getLatest()).toBe(helperSession);
    expect(sessions.getCurrent()).toBe(main);
    expect(usage.snapshot()).toMatchObject({
      inputTokens: 60_315,
      outputTokens: 494,
      totalTokens: 60_809,
    });
    expect(events.filter((event) => event.event === "CODEX_REQUEST").map((event) => ({
      request: event.data?.request,
      foreground: event.data?.foreground,
      requestKind: event.data?.requestKind,
    }))).toEqual([
      { request: 1, foreground: true, requestKind: "turn" },
      { request: 2, foreground: true, requestKind: "turn" },
      { request: 3, foreground: true, requestKind: "turn" },
      { request: 4, foreground: true, requestKind: "turn" },
      { request: 1, foreground: false, requestKind: "prewarm" },
    ]);
  });

  it("lets an unrelated real tools=0 foreground turn become current without merging sessions", async () => {
    const { app, sessions } = await fixture([
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: "first independent turn", tools: [], client_metadata: codexMetadata("turn") },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: "second independent turn", tools: [], client_metadata: codexMetadata("turn") },
    });
    const firstSession = sessions.getByResponseId(first.json().id);
    const secondSession = sessions.getByResponseId(second.json().id);

    expect(firstSession).not.toBe(secondSession);
    expect(firstSession?.requestCount).toBe(1);
    expect(secondSession?.requestCount).toBe(1);
    expect(sessions.getCurrent()).toBe(secondSession);
  });

  it("makes the full multi-tool token-cost structure observable without replay duplication", async () => {
    const { app, client, sessions, events } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_cost_1", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "function_call", call_id: "call_cost_2", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first final" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued final" }] }]),
    ]);

    const initial = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "initial user", tools: [functionTool] },
    });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_cost_1", output: "result one" }] },
    });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: "initial user" },
        { type: "function_call_output", call_id: "call_cost_1", output: "result one" },
        { type: "function_call_output", call_id: "call_cost_2", output: "result two" },
      ] },
    });
    const continued = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: "initial user" },
        { type: "function_call_output", call_id: "call_cost_1", output: "result one" },
        { type: "function_call_output", call_id: "call_cost_2", output: "result two" },
        { type: "message", role: "assistant", content: "first final" },
        { type: "message", role: "user", content: "new user continuation" },
      ] },
    });

    const session = sessions.getByResponseId(initial.json().id);
    expect(continued.statusCode).toBe(200);
    expect(sessions.getByResponseId(continued.json().id)).toBe(session);
    expect(session).toMatchObject({ requestCount: 4, inferenceCount: 4, toolCallCount: 2 });
    expect(client.requests.map((request) => request.tools.length)).toEqual([1, 1, 1, 1]);
    expect(client.requests.map((request) => request.input.length)).toEqual([1, 3, 5, 7]);
    expect(client.requests[3]?.input.map((item) => [item.type, item.call_id ?? item.role])).toEqual([
      ["message", "user"],
      ["function_call", "call_cost_1"],
      ["function_call_output", "call_cost_1"],
      ["function_call", "call_cost_2"],
      ["function_call_output", "call_cost_2"],
      ["message", "assistant"],
      ["message", "user"],
    ]);
    const finalPayload = JSON.stringify(client.requests[3]);
    expect(finalPayload.match(/result one/g)).toHaveLength(1);
    expect(finalPayload.match(/result two/g)).toHaveLength(1);
    expect(finalPayload.match(/new user continuation/g)).toHaveLength(1);

    const usageEvents = events.filter((event) => event.event === "EVREN_USAGE");
    expect(usageEvents).toHaveLength(4);
    expect(usageEvents.map((event) => event.data?.request)).toEqual([1, 2, 3, 4]);
    expect(usageEvents.map((event) => event.data?.historyItems)).toEqual([1, 3, 5, 7]);
    expect(usageEvents.map((event) => event.data?.toolCount)).toEqual([1, 1, 1, 1]);
    for (const [index, event] of usageEvents.entries()) {
      const serialized = JSON.stringify(client.requests[index]);
      expect(event.data).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        payloadChars: serialized.length,
        payloadBytes: Buffer.byteLength(serialized, "utf8"),
      });
    }
  });

  it("treats completed tool output replay plus a new user message as a new turn", async () => {
    const nextQuestion = "what changed next?";
    const { app, client, sessions, events } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_completed", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "C:\\work confirmed" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "nothing else" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "show cwd", tools: [functionTool] },
    });
    const completedOutput = {
      type: "function_call_output", call_id: "call_completed", output: "C:\\work",
    };
    const toolTurn = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: [completedOutput] },
    });
    const session = sessions.getByResponseId(toolTurn.json().id);
    const requestCountBeforeNewTurn = session?.requestCount;

    const nextTurn = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          completedOutput,
          { type: "message", role: "user", content: nextQuestion },
        ],
      },
    });

    expect(first.statusCode).toBe(200);
    expect(toolTurn.statusCode).toBe(200);
    expect(nextTurn.statusCode).toBe(200);
    expect(nextTurn.json().output[0].content[0].text).toBe("nothing else");
    expect(sessions.getByResponseId(nextTurn.json().id)).toBe(session);
    expect(session?.requestCount).toBe((requestCountBeforeNewTurn ?? 0) + 1);
    expect(session?.pendingToolCalls.size).toBe(0);
    expect([...session?.completedToolCalls.keys() ?? []]).toEqual(["call_completed"]);
    expect(client.requests).toHaveLength(3);
    const newTurnInput = JSON.stringify(client.requests[2]?.input);
    expect(newTurnInput.match(/show cwd/g)).toHaveLength(1);
    expect(newTurnInput.match(/C:\\\\work confirmed/g)).toHaveLength(1);
    expect(newTurnInput.match(/"call_id":"call_completed","output":"C:\\\\work"/g)).toHaveLength(1);
    expect(newTurnInput.match(new RegExp(nextQuestion.replace("?", "\\?"), "g"))).toHaveLength(1);
    expect(events.filter((event) => event.event === "TOOL_RESULT"
      && event.data?.tool === "get_current_directory")).toHaveLength(1);
  });

  it("deduplicates canonical history around completed output replay on a new turn", async () => {
    const { app, client } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_history", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "history done" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "new answer" }] }]),
    ]);
    await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "original question", tools: [functionTool] },
    });
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_history", output: "original output" }] },
    });
    const nextTurn = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "message", role: "user", content: "original question" },
        { type: "function_call", call_id: "call_history", name: "get_current_directory", arguments: "{}" },
        { type: "function_call_output", call_id: "call_history", output: "original output" },
        { type: "message", role: "assistant", content: "history done" },
        { type: "message", role: "user", content: "new question" },
      ] },
    });

    expect(nextTurn.statusCode).toBe(200);
    const newTurnInput = JSON.stringify(client.requests[2]?.input);
    expect(newTurnInput.match(/original question/g)).toHaveLength(1);
    expect(newTurnInput.match(/original output/g)).toHaveLength(1);
    expect(newTurnInput.match(/history done/g)).toHaveLength(1);
    expect(newTurnInput.match(/new question/g)).toHaveLength(1);
  });

  it("rejects changed completed replay and historical-only replay without EVREN calls", async () => {
    const { app, client, sessions, usage } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_done", name: "get_current_directory", arguments: "{}" }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]),
    ]);
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [functionTool] } });
    const completed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_done", output: "same" }] },
    });
    const session = sessions.getByResponseId(completed.json().id);
    const requestCountBeforeReplays = session?.requestCount;
    const usageBeforeReplays = usage.snapshot().totalTokens;
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
    expect(session?.requestCount).toBe(requestCountBeforeReplays);
    expect(usage.snapshot().totalTokens).toBe(usageBeforeReplays);
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

  it("serializes multiple native calls to the first call without persisting or executing the rest", async () => {
    const { app, client, sessions, events } = await fixture([
      nativeResponse([
        { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
        { type: "function_call", call_id: "call_2", name: "shell", arguments: '{"input":"pwd"}' },
      ]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "after first" }] }]),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "test", tools: [functionTool] },
    });
    const session = sessions.getByResponseId(first.json().id);

    expect(first.statusCode).toBe(200);
    expect(first.json().output).toHaveLength(1);
    expect(first.json().output[0]).toMatchObject({
      type: "function_call", call_id: "call_1", name: "get_current_directory",
    });
    expect([...session?.pendingToolCalls.keys() ?? []]).toEqual(["call_1"]);
    expect(session?.nativeHistory.filter((item) => item.type === "function_call")).toEqual([
      { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
    ]);
    expect(JSON.stringify(session)).not.toContain("call_2");

    const discarded = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_2", output: "must not run" }] },
    });
    expect(discarded.statusCode).toBe(400);
    expect(client.requests).toHaveLength(1);

    const continued = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "call_1", output: "C:\\work" }] },
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().output[0].content[0].text).toBe("after first");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "test" }] },
      { type: "function_call", call_id: "call_1", name: "get_current_directory", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "C:\\work" },
    ]);
    expect(JSON.stringify(client.requests[1])).not.toContain("call_2");
    expect(events).toContainEqual({
      event: "NATIVE_MULTI_TOOL_SERIALIZED",
      level: "warn",
      message: "2 calls → serialized to 1",
      data: { returnedCallCount: 2, selectedTool: "get_current_directory" },
    });
  });

  it("blocks the third identical deterministic protocol failure without new inference or usage", async () => {
    let now = 1_000_000;
    const retryCircuit = new DeterministicRetryCircuit({ now: () => now });
    const protocolFailure = () => nativeResponse([
      { type: "function_call", call_id: "call_bad", name: "invented", arguments: "{}" },
    ]);
    const { app, client, sessions, usage, events } = await fixture([
      nativeResponse([{ type: "function_call", call_id: "call_retry", name: "get_current_directory", arguments: "{}" }]),
      protocolFailure(),
      protocolFailure(),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "different" }] }]),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "after expiry" }] }]),
    ], {}, retryCircuit);
    const started = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "start", tools: [functionTool] },
    });
    const output = [{ type: "function_call_output", call_id: "call_retry", output: "same" }];

    const firstFailure = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } });
    const secondFailure = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } });
    const session = sessions.getByResponseId(started.json().id);
    const beforeBlocked = {
      clientCalls: client.requests.length,
      dailyTokens: usage.snapshot().totalTokens,
      sessionTokens: session?.usage.totalTokens,
      toolCalls: session?.toolCallCount,
      requestCount: session?.requestCount,
    };
    const blocked = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } });

    expect(firstFailure.statusCode).toBe(502);
    expect(secondFailure.statusCode).toBe(502);
    expect(blocked.statusCode).toBe(502);
    expect(blocked.json().error).toMatchObject({
      type: "upstream_protocol_error", code: "retry_circuit_blocked",
    });
    expect(client.requests).toHaveLength(beforeBlocked.clientCalls);
    expect(usage.snapshot().totalTokens).toBe(beforeBlocked.dailyTokens);
    expect(session?.usage.totalTokens).toBe(beforeBlocked.sessionTokens);
    expect(session?.toolCallCount).toBe(beforeBlocked.toolCalls);
    expect(session?.requestCount).toBe(beforeBlocked.requestCount);
    expect(events.some((event) => event.event === "RETRY_CIRCUIT_BLOCKED")).toBe(true);

    const different = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "different", tools: [functionTool] },
    });
    expect(different.statusCode).toBe(200);
    expect(client.requests).toHaveLength(beforeBlocked.clientCalls + 1);

    now += 60_001;
    const afterExpiry = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: output } });
    expect(afterExpiry.statusCode).toBe(200);
    expect(afterExpiry.json().output[0].content[0].text).toBe("after expiry");
    expect(client.requests).toHaveLength(beforeBlocked.clientCalls + 2);
  });

  it("clears a deterministic failure after successful handling of the same fingerprint", async () => {
    const protocolFailure = () => nativeResponse([
      { type: "function_call", call_id: "call_bad", name: "invented", arguments: "{}" },
    ]);
    const { app, client } = await fixture([
      protocolFailure(),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }]),
      protocolFailure(),
      protocolFailure(),
    ]);
    const payload = { input: "identical", tools: [functionTool] };

    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(502);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(502);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(502);
    const blocked = await app.inject({ method: "POST", url: "/v1/responses", payload });

    expect(blocked.json().error.code).toBe("retry_circuit_blocked");
    expect(client.requests).toHaveLength(4);
  });

  it("does not arm the deterministic circuit for transient EVREN failures", async () => {
    const { app, client, usage } = await fixture([
      new Error("EVREN returned HTTP 503."),
      new Error("EVREN returned HTTP 503."),
      new Error("EVREN returned HTTP 503."),
      nativeResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }]),
    ]);
    const payload = { input: "retry transient", tools: [functionTool] };

    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(500);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(500);
    expect((await app.inject({ method: "POST", url: "/v1/responses", payload })).statusCode).toBe(500);
    const recovered = await app.inject({ method: "POST", url: "/v1/responses", payload });

    expect(recovered.statusCode).toBe(200);
    expect(client.requests).toHaveLength(4);
    expect(usage.snapshot().totalTokens).toBe(15);
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
