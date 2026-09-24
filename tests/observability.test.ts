import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge/bridge-service.js";
import type { NativeEvrenRequest } from "../src/bridge/native-codex-to-evren.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import type { EvrenInferenceResult, EvrenNativeResult, EvrenTransport } from "../src/evren/client.js";
import { SessionStore } from "../src/sessions/store.js";
import { buildServer } from "../src/server/app.js";
import type { LogEvent } from "../src/ui/logger.js";
import { UsagePersistence } from "../src/usage/persistence.js";
import { UsageTracker } from "../src/usage/tracker.js";

const writeStdinTool = {
  type: "function",
  name: "write_stdin",
  description: "Poll a running process",
  parameters: {
    type: "object",
    properties: { session_id: { type: "string" }, chars: { type: "string" } },
    required: ["session_id"],
    additionalProperties: false,
  },
};

const ordinaryTool = {
  type: "function",
  name: "exec_command",
  description: "Run a command",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function nativeResponse(
  output: unknown[],
  id: string,
  inputTokens = 100,
  outputTokens = 10,
): Record<string, unknown> {
  return {
    id,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function poll(callId: string, processId: string): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: callId,
    name: "write_stdin",
    arguments: JSON.stringify({ session_id: processId, chars: "" }),
  };
}

function final(text = "done"): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

class NativeMock implements EvrenTransport {
  readonly requests: NativeEvrenRequest[] = [];
  private index = 0;

  constructor(private readonly results: Record<string, unknown>[]) {}
  async getModels(): Promise<unknown> { return { data: [] }; }
  async infer(): Promise<EvrenInferenceResult> { throw new Error("textual inference not expected"); }
  async respond(request: NativeEvrenRequest): Promise<EvrenNativeResult> {
    this.requests.push(structuredClone(request));
    const raw = this.results[this.index++]!;
    const usage = raw.usage as Record<string, number>;
    return {
      id: String(raw.id),
      usage: {
        inputTokens: usage.input_tokens!,
        outputTokens: usage.output_tokens!,
        totalTokens: usage.total_tokens!,
      },
      raw,
    };
  }
}

const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function fixture(results: Record<string, unknown>[], override: Partial<BridgeConfig> = {}) {
  const config = { ...loadConfig({}), ...override };
  const client = new NativeMock(results);
  const sessions = new SessionStore(60_000);
  const usage = new UsageTracker(new UsagePersistence(await mkdtemp(path.join(os.tmpdir(), "evren-observe-"))));
  await usage.initialize();
  const events: LogEvent[] = [];
  const logger = { log: (event: LogEvent) => events.push(event) };
  const pricingGuard = {
    assertAllowed: () => undefined,
    getState: () => ({
      allowed: true,
      connected: true,
      pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    }),
  };
  const bridge = new BridgeService({ config, client, sessions, usage, logger, pricingGuard });
  const app = buildServer({
    config,
    sessions,
    usage,
    logger,
    pricingGuard,
    bridge,
    updateCheck: { getState: () => ({ status: "offline" }) },
  });
  apps.push(app);
  return { app, client, sessions, usage, events };
}

describe("polling and usage observability", () => {
  it("keeps readiness and inference independent from update-check failure", async () => {
    const { app } = await fixture([nativeResponse([final()], "evren_ready")]);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({ status: "online", update: { status: "offline" } });
    const inference = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "hello" } });
    expect(inference.statusCode).toBe(200);
  });

  it("tracks recognized consecutive write_stdin polling, warning usage, and reset", async () => {
    const { app, sessions, events } = await fixture([
      nativeResponse([poll("poll_1", "process-private")], "evren_poll_1", 100, 10),
      nativeResponse([poll("poll_2", "process-private")], "evren_poll_2", 200, 20),
      nativeResponse([final()], "evren_final", 50, 5),
    ], { toolPollWarningThreshold: 2 });

    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "start", tools: [writeStdinTool] },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_1", output: "still running" }] },
    });
    const session = sessions.getByResponseId(second.json().id)!;
    expect(session.polling.active).toMatchObject({
      toolName: "write_stdin",
      consecutivePolls: 2,
      authoritativeTokensSpent: 330,
    });
    expect(session.polling).toMatchObject({ totalPollInferences: 2, totalAuthoritativeTokens: 330 });
    expect(events.filter((event) => event.event === "TOOL_POLL").map((event) => event.data?.consecutivePolls))
      .toEqual([1, 2]);
    expect(events.filter((event) => event.event === "TOOL_POLL_WARNING")).toHaveLength(1);
    expect(JSON.stringify(events.filter((event) => event.event.startsWith("TOOL_POLL"))))
      .not.toContain("process-private");

    const completed = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_2", output: "finished" }] },
    });
    expect(first.statusCode).toBe(200);
    expect(completed.statusCode).toBe(200);
    expect(session.polling.active).toBeUndefined();
    expect(session.polling.totalAuthoritativeTokens).toBeLessThanOrEqual(session.usage.totalTokens);
  });

  it("does not merge unrelated poll identities or classify repeated ordinary tools as polls", async () => {
    const { app, sessions, events } = await fixture([
      nativeResponse([poll("poll_a", "process-a")], "evren_a"),
      nativeResponse([poll("poll_b", "process-b")], "evren_b"),
      nativeResponse([{ type: "function_call", call_id: "exec_1", name: "exec_command", arguments: "{}" }], "evren_exec_1"),
      nativeResponse([{ type: "function_call", call_id: "exec_2", name: "exec_command", arguments: "{}" }], "evren_exec_2"),
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "poll", tools: [writeStdinTool, ordinaryTool] },
    });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_a", output: "running" }] },
    });
    const session = sessions.getByResponseId(second.json().id)!;
    expect(session.polling.active?.consecutivePolls).toBe(1);
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_b", output: "done" }] },
    });
    expect(session.polling.active).toBeUndefined();
    await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "exec_1", output: "done" }] },
    });
    expect(first.statusCode).toBe(200);
    expect(events.filter((event) => event.event === "TOOL_POLL")).toHaveLength(2);
  });

  it("blocks an optional hard cap locally before inference or usage growth", async () => {
    const { app, client, sessions, usage, events } = await fixture([
      nativeResponse([poll("poll_1", "process-cap")], "evren_cap_1"),
      nativeResponse([poll("poll_2", "process-cap")], "evren_cap_2"),
    ], { maxConsecutiveToolPollInferences: 2 });
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "start", tools: [writeStdinTool] } });
    const second = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_1", output: "running" }] },
    });
    const session = sessions.getByResponseId(second.json().id)!;
    const before = {
      requests: client.requests.length,
      daily: usage.snapshot().totalTokens,
      session: session.usage.totalTokens,
      requestCount: session.requestCount,
      inferenceCount: session.inferenceCount,
    };
    const blocked = await app.inject({
      method: "POST", url: "/v1/responses",
      payload: { input: [{ type: "function_call_output", call_id: "poll_2", output: "still running" }] },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("tool_poll_limit_reached");
    expect(client.requests).toHaveLength(before.requests);
    expect(usage.snapshot().totalTokens).toBe(before.daily);
    expect(session.usage.totalTokens).toBe(before.session);
    expect(session.requestCount).toBe(before.requestCount);
    expect(session.inferenceCount).toBe(before.inferenceCount);
    expect(events.some((event) => event.event === "TOOL_POLL_LIMIT")).toBe(true);
  });

  it.each([
    [4095, false],
    [4096, true],
    [4097, true],
  ])("reports output budget usage %i safely", async (outputTokens, saturated) => {
    const { app, events, sessions } = await fixture([
      nativeResponse([final()], `evren_saturation_${outputTokens}`, 10, outputTokens),
    ]);
    const response = await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "generate" } });
    expect(response.statusCode).toBe(200);
    expect(events.some((event) => event.event === "OUTPUT_BUDGET_SATURATED")).toBe(saturated);
    expect(sessions.getByResponseId(response.json().id)?.lastOutputBudgetSaturated).toBe(saturated);
  });

  it("enriches a saturated protocol failure without treating saturation itself as invalid", async () => {
    const { app, events } = await fixture([
      nativeResponse([{
        type: "function_call", call_id: "bad", name: "unknown_tool", arguments: "{}",
      }], "evren_saturated_bad", 10, 4096),
    ]);
    const response = await app.inject({
      method: "POST", url: "/v1/responses", payload: { input: "test", tools: [ordinaryTool] },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("saturation evidence");
    expect(events.some((event) => event.event === "OUTPUT_BUDGET_SATURATED")).toBe(true);
  });

  it("classifies usage only from recognized Codex metadata and keeps unmarked usage unclassified", async () => {
    const { app, usage } = await fixture([
      nativeResponse([final("foreground")], "evren_foreground"),
      nativeResponse([final("internal")], "evren_internal"),
      nativeResponse([final("unknown")], "evren_unclassified"),
    ]);
    const metadata = (requestKind: string) => ({
      "x-codex-turn-metadata": JSON.stringify({ request_kind: requestKind, private: "never copied" }),
    });
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "one", client_metadata: metadata("turn") } });
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "two", client_metadata: metadata("prewarm") } });
    await app.inject({ method: "POST", url: "/v1/responses", payload: { input: "three" } });
    expect(usage.snapshot()).toMatchObject({
      totalTokens: 330,
      classified: {
        foreground: { totalTokens: 110 },
        internal: { totalTokens: 110 },
        unclassified: { totalTokens: 110 },
      },
    });
  });
});
