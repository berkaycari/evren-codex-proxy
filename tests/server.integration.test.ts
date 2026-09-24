import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge/bridge-service.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import type { EvrenInferenceResult, EvrenNativeResult, EvrenTransport } from "../src/evren/client.js";
import type { NativeEvrenRequest } from "../src/bridge/native-codex-to-evren.js";
import { SessionStore } from "../src/sessions/store.js";
import { buildServer } from "../src/server/app.js";
import type { LogEvent } from "../src/ui/logger.js";
import { UsagePersistence } from "../src/usage/persistence.js";
import { UsageTracker } from "../src/usage/tracker.js";

class MockEvren implements EvrenTransport {
  readonly prompts: string[] = [];
  readonly maxOutputTokens: number[] = [];
  private index = 0;
  constructor(private readonly texts: Array<string | Error>) {}
  async getModels(): Promise<unknown> { return { data: [] }; }
  async infer(input: string, maxOutputTokens: number): Promise<EvrenInferenceResult> {
    this.prompts.push(input);
    this.maxOutputTokens.push(maxOutputTokens);
    const candidate = this.texts[this.index++] ?? this.texts.at(-1) ?? "invalid";
    if (candidate instanceof Error) throw candidate;
    return {
      id: `evren_${this.index}`,
      text: candidate,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      raw: {},
    };
  }
  async respond(_request: NativeEvrenRequest): Promise<EvrenNativeResult> {
    throw new Error("Native transport is not configured in the textual regression fixture.");
  }
}

const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(texts: Array<string | Error>, configOverride: Partial<BridgeConfig> = {}) {
  const config = { ...loadConfig({ EVREN_TOOL_TRANSPORT: "textual" }), ...configOverride };
  const client = new MockEvren(texts);
  const sessions = new SessionStore(config.sessionTtlMinutes * 60_000);
  const temp = await mkdtemp(path.join(os.tmpdir(), "evren-server-"));
  const usage = new UsageTracker(new UsagePersistence(temp));
  await usage.initialize();
  const events: LogEvent[] = [];
  const logger = { log: (event: LogEvent) => events.push(event) };
  const pricingGuard = {
    assertAllowed: () => undefined,
    getState: () => ({
      allowed: true,
      connected: true,
      checkedAt: "2026-09-21T00:00:00.000Z",
      pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    }),
  };
  const bridge = new BridgeService({ config, client, pricingGuard, sessions, usage, logger });
  const app = buildServer({ config, pricingGuard, sessions, usage, bridge, logger });
  apps.push(app);
  return { app, client, sessions, usage, config, events };
}

const tool = {
  type: "function",
  name: "shell",
  description: "Run a command",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
};

describe("HTTP server", () => {
  it("binds to loopback and serves health over a real local socket", async () => {
    const { app } = await fixture(['{"kind":"final","content":"ok"}']);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = app.server.address();
    expect(socket && typeof socket === "object" ? socket.address : "").toBe("127.0.0.1");
    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "online", listen: "127.0.0.1:8787" });
  });

  it("serves safe health and Codex 0.156.1 model catalog responses", async () => {
    const { app } = await fixture(['{"kind":"final","content":"ok"}']);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "online", model: "deepseek-v4.1-flash", evren: "connected" });
    expect(JSON.stringify(health.json())).not.toContain("apiKey");
    const models = await app.inject({ method: "GET", url: "/v1/models?client_version=0.156.1" });
    expect(models.json()).toEqual({ models: [] });
  });

  it("returns a normal Responses API final text response", async () => {
    const { app, usage, events } = await fixture(['{"kind":"final","content":"finished"}']);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { model: "deepseek-v4.1-flash", input: "hello", stream: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    expect(usage.snapshot().totalTokens).toBe(15);
    expect(events.some((event) => event.event === "RESPONSE_FINALIZED")).toBe(true);
  });

  it("turns a model tool decision into a Codex function_call", async () => {
    const { app } = await fixture(['{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}']);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().output[0]).toMatchObject({
      type: "function_call", name: "shell", arguments: '{"command":"pwd"}', status: "completed",
    });
    expect(response.json().output[0].call_id).toMatch(/^call_/);
  });

  it("connects tool output to the previous session and passes it to EVREN", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      '{"kind":"final","content":"done"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: false },
    });
    const firstJson = first.json();
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        previous_response_id: firstJson.id,
        input: [{ type: "function_call_output", call_id: firstJson.output[0].call_id, output: "C:\\work" }],
        tools: [tool],
        stream: false,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().output[0].content[0].text).toBe("done");
    expect(client.prompts[1]).toContain("TOOL shell");
    expect(client.prompts[1]).toContain("C:\\work");
  });

  it("resolves a fresh tool-output request by call_id without previous_response_id", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"(Get-Location).Path"}}',
      '{"kind":"final","content":"C:\\\\work confirmed"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "show cwd", tools: [tool], stream: false },
    });
    const firstJson = first.json();
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [{ type: "function_call_output", call_id: firstJson.output[0].call_id, output: "C:\\work" }],
        stream: false,
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().output[0].content[0].text).toBe("C:\\work confirmed");
    expect(client.prompts[1]).toContain("TOOL shell");
    expect(client.prompts[1]).toContain("C:\\work");
  });

  it("rejects an unknown tool-output call_id", async () => {
    const { app, client } = await fixture(['{"kind":"final","content":"must not run"}']);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [{ type: "function_call_output", call_id: "call_unknown", output: "result" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(response.json().error.message).toContain("unknown call_id: call_unknown");
    expect(client.prompts).toHaveLength(0);
  });

  it("rejects tool outputs that reference different sessions", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"whoami"}}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "user", tools: [tool], stream: false },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          { type: "function_call_output", call_id: first.json().output[0].call_id, output: "C:\\work" },
          { type: "function_call_output", call_id: second.json().output[0].call_id, output: "berkay" },
        ],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(response.json().error.message).toContain("different sessions");
    expect(client.prompts).toHaveLength(2);
  });

  it("rejects a completed call from one session mixed with a pending call from another", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"session-a"}}',
      '{"kind":"final","content":"session A done"}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"session-b"}}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const firstA = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "A", tools: [tool], stream: false },
    });
    const callA = firstA.json().output[0].call_id;
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callA, output: "A result" }], stream: false },
    });
    const firstB = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "B", tools: [tool], stream: false },
    });
    const callB = firstB.json().output[0].call_id;
    const rejected = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "function_call_output", call_id: callA, output: "A result" },
        { type: "function_call_output", call_id: callB, output: "B result" },
      ], stream: false },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("different sessions");
    expect(client.prompts).toHaveLength(3);
  });

  it("rejects a historical-only replay without inference, accounting, or request growth", async () => {
    const { app, client, sessions, usage } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      '{"kind":"final","content":"done"}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });
    const callId = first.json().output[0].call_id;
    const output = [{ type: "function_call_output", call_id: callId, output: "C:\\work" }];
    const continuation = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });
    const session = sessions.getByResponseId(continuation.json().id);
    const requestCountBeforeReplay = session?.requestCount;
    const usageBeforeReplay = usage.snapshot().totalTokens;
    const replay = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });

    expect(continuation.statusCode).toBe(200);
    expect(continuation.json().output[0].content[0].text).toBe("done");
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.type).toBe("invalid_request_error");
    expect(replay.json().error.message).toContain("only completed historical call_ids");
    expect(client.prompts).toHaveLength(2);
    expect(session?.requestCount).toBe(requestCountBeforeReplay);
    expect(usage.snapshot().totalTokens).toBe(usageBeforeReplay);
  });

  it("keeps a staged call_id after protocol failure and accepts an identical retry", async () => {
    const { app, client, sessions } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      "broken continuation",
      "still broken",
      '{"kind":"final","content":"retry completed"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });
    const callId = first.json().output[0].call_id;
    const output = [{ type: "function_call_output", call_id: callId, output: "C:\\work" }];

    const failed = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });
    expect(failed.statusCode).toBe(502);
    expect(sessions.resolveByToolCallIds([callId]).pendingToolCalls.get(callId)?.stagedOutput).toBe("C:\\work");

    const retried = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().output[0].content[0].text).toBe("retry completed");
    expect(((client.prompts.at(3) ?? "").match(/TOOL shell/g) ?? [])).toHaveLength(1);
    const completedSession = sessions.resolveByToolCallIds([callId]);
    expect(completedSession.pendingToolCalls.has(callId)).toBe(false);
    expect(completedSession.completedToolCalls.get(callId)).toMatchObject({ callId, toolName: "shell" });
    expect(completedSession.completedToolCalls.get(callId)?.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a staged call_id after an EVREN network error", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      new Error("EVREN request timed out."),
      '{"kind":"final","content":"retry completed"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });
    const callId = first.json().output[0].call_id;
    const output = [{ type: "function_call_output", call_id: callId, output: "C:\\work" }];

    const failed = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });
    expect(failed.statusCode).toBe(500);

    const retried = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: output, stream: false },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().output[0].content[0].text).toBe("retry completed");
    expect(((client.prompts.at(2) ?? "").match(/TOOL shell/g) ?? [])).toHaveLength(1);
  });

  it("rejects changed output for a staged call_id without calling EVREN", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      "broken continuation",
      "still broken",
      '{"kind":"final","content":"must not run"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });
    const callId = first.json().output[0].call_id;
    const failed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callId, output: "first" }], stream: false },
    });
    expect(failed.statusCode).toBe(502);

    const changed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callId, output: "different" }], stream: false },
    });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.message).toContain("changed while retrying");
    expect(client.prompts).toHaveLength(3);
  });

  it("does not duplicate replayed conversation history in call_id continuation prompts", async () => {
    const original = "UNIQUE ORIGINAL USER MESSAGE";
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
      '{"kind":"final","content":"done"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: original, tools: [tool], stream: false },
    });
    const callId = first.json().output[0].call_id;
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          { type: "message", role: "user", content: original },
          { type: "function_call", call_id: callId, name: "shell", arguments: '{"command":"pwd"}' },
          { type: "function_call_output", call_id: callId, output: "C:\\work" },
        ],
        stream: false,
      },
    });

    expect(second.statusCode).toBe(200);
    expect(((client.prompts.at(1) ?? "").match(new RegExp(original, "g")) ?? [])).toHaveLength(1);
    expect(client.prompts.at(1)).toContain("TOOL shell");
  });

  it("accepts completed history replay plus one pending output across a real multi-tool chain", async () => {
    const original = "INSPECT PROJECT READ ONLY";
    const outputA = "package.json contents";
    const outputB = "src tree contents";
    const { app, client, sessions, events } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"type package.json"}}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"dir src"}}',
      '{"kind":"final","content":"inspection complete"}',
    ]);

    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: original, tools: [tool], stream: false },
    });
    const firstJson = first.json();
    const callA = firstJson.output[0].call_id as string;
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callA, output: outputA }], stream: false },
    });
    const secondJson = second.json();
    const callB = secondJson.output[0].call_id as string;
    const session = sessions.getByResponseId(secondJson.id);
    expect(session?.completedToolCalls.has(callA)).toBe(true);
    expect(session?.pendingToolCalls.has(callB)).toBe(true);

    const third = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        input: [
          { type: "message", role: "user", content: original },
          { type: "function_call", call_id: callA, name: "shell", arguments: '{"command":"type package.json"}' },
          { type: "function_call_output", call_id: callA, output: outputA },
          { type: "function_call", call_id: callB, name: "shell", arguments: '{"command":"dir src"}' },
          { type: "function_call_output", call_id: callB, output: outputB },
        ],
        stream: false,
      },
    });

    expect(third.statusCode).toBe(200);
    expect(third.json().output[0].content[0].text).toBe("inspection complete");
    expect(sessions.getByResponseId(third.json().id)).toBe(session);
    expect(session?.pendingToolCalls.size).toBe(0);
    expect([...session?.completedToolCalls.keys() ?? []]).toEqual([callA, callB]);
    const finalPrompt = client.prompts.at(2) ?? "";
    expect((finalPrompt.match(new RegExp(original, "g")) ?? [])).toHaveLength(1);
    expect((finalPrompt.match(new RegExp(outputA, "g")) ?? [])).toHaveLength(1);
    expect((finalPrompt.match(new RegExp(outputB, "g")) ?? [])).toHaveLength(1);
    expect(events.filter((event) => event.event === "TOOL_RESULT")).toHaveLength(2);
  });

  it("rejects changed completed history even when the current pending output is valid", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"first"}}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"second"}}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: false },
    });
    const callA = first.json().output[0].call_id;
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callA, output: "original" }], stream: false },
    });
    const callB = second.json().output[0].call_id;
    const rejected = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "function_call_output", call_id: callA, output: "changed" },
        { type: "function_call_output", call_id: callB, output: "current" },
      ], stream: false },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("Completed tool output changed while replaying");
    expect(client.prompts).toHaveLength(2);
  });

  it("rejects two active pending outputs from the same session", async () => {
    const { app, client, sessions } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"first"}}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: false },
    });
    const callA = first.json().output[0].call_id as string;
    const session = sessions.getByResponseId(first.json().id);
    expect(session).toBeDefined();
    sessions.recordPendingToolCall(session!, {
      callId: "call_same_session_second",
      tool: session!.pendingToolCalls.get(callA)!.tool,
    });

    const rejected = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [
        { type: "function_call_output", call_id: callA, output: "one" },
        { type: "function_call_output", call_id: "call_same_session_second", output: "two" },
      ], stream: false },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("Parallel tool outputs are not supported");
    expect(client.prompts).toHaveLength(1);
    expect(session?.pendingToolCalls.get(callA)?.stagedOutput).toBeUndefined();
  });

  it("accepts completed history plus pending output with a same-session previous_response_id", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":{"command":"first"}}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"second"}}',
      '{"kind":"final","content":"done"}',
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: false },
    });
    const callA = first.json().output[0].call_id;
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: callA, output: "one" }], stream: false },
    });
    const callB = second.json().output[0].call_id;
    const third = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        previous_response_id: second.json().id,
        input: [
          { type: "function_call_output", call_id: callA, output: "one" },
          { type: "function_call_output", call_id: callB, output: "two" },
        ],
        stream: false,
      },
    });

    expect(third.statusCode).toBe(200);
    expect(third.json().output[0].content[0].text).toBe("done");
    expect(client.prompts).toHaveLength(3);
  });

  it("does not let previous_response_id authorize a tool output from another session", async () => {
    const { app, client } = await fixture([
      '{"kind":"final","content":"session A"}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"session-b"}}',
      '{"kind":"final","content":"must not run"}',
    ]);
    const sessionA = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "A", tools: [tool], stream: false },
    });
    const sessionB = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "B", tools: [tool], stream: false },
    });
    const rejected = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: {
        previous_response_id: sessionA.json().id,
        input: [{ type: "function_call_output", call_id: sessionB.json().output[0].call_id, output: "B result" }],
        stream: false,
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("different sessions");
    expect(client.prompts).toHaveLength(2);
  });

  it("passes the 4096 default output budget to EVREN", async () => {
    const { app, client } = await fixture(['{"kind":"final","content":"ok"}']);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "hello", stream: false },
    });
    expect(response.statusCode).toBe(200);
    expect(client.maxOutputTokens).toEqual([4096]);
  });

  it("uses a bounded repair prompt and can normalize plain final text", async () => {
    const largeMarker = `BEGIN_LARGE_${"x".repeat(80_000)}_END_LARGE`;
    const { app, client } = await fixture([
      "C:\\projects\\evren-codex-smoke",
      '{"kind":"final","content":"C:\\\\projects\\\\evren-codex-smoke"}',
    ], { maxEstimatedInputTokensPerCall: 100_000 });
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: largeMarker, stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().output[0].content[0].text).toBe("C:\\projects\\evren-codex-smoke");
    expect((client.prompts.at(0) ?? "").length).toBeGreaterThan(80_000);
    expect((client.prompts.at(1) ?? "").length).toBeLessThan(8_000);
    expect(client.prompts.at(1)).not.toContain("BEGIN_LARGE_");
    expect(client.prompts.at(1)).toContain("REQUIRED OUTPUT CONTRACT");
  });

  it("repairs a malformed tool call as a tool call", async () => {
    const { app, client } = await fixture([
      '{"kind":"tool_call","name":"shell","arguments":}',
      '{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}',
    ]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "cwd", tools: [tool], stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().output[0]).toMatchObject({ type: "function_call", name: "shell" });
    expect(client.prompts[1]).toContain('Available tool names:\n["shell"]');
    expect(client.prompts[1]).toContain("never reinterpret a malformed tool call as a final answer");
  });

  it("retries invalid JSON exactly once and then fails", async () => {
    const { app, client } = await fixture(["not json", "still not json"]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "hello", stream: false },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("invalid_tool_protocol");
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("FORMAT REPAIR REQUIRED");
  });

  it("streams final text with Codex-compatible completion events", async () => {
    const { app } = await fixture(['{"kind":"final","content":"streamed"}']);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "hello", stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: response.output_text.delta");
    expect(response.body).toContain("event: response.output_item.done");
    expect(response.body).toContain("event: response.completed");
  });

  it("streams function calls with argument and completion events", async () => {
    const { app } = await fixture(['{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}']);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "inspect", tools: [tool], stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: response.function_call_arguments.delta");
    expect(response.body).toContain('\\"command\\":\\"pwd\\"');
    expect(response.body).toContain("event: response.completed");
  });
});
