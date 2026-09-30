import { describe, expect, it, vi } from "vitest";
import { EvrenClient, EvrenUpstreamError, parseEvrenCreditHeaders } from "../src/evren/client.js";
import { nullLogger, type LogEvent } from "../src/ui/logger.js";

describe("EVREN client", () => {
  it("never includes native tools or tool_choice in the EVREN request body", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "evren_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"kind":"final","content":"ok"}' }] }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: fetchMock as typeof fetch,
    });
    await client.infer("prompt with textual catalog", 100);
    expect(captured).toEqual({
      model: "deepseek-v4.1-flash",
      input: "prompt with textual catalog",
      max_output_tokens: 100,
      stream: false,
    });
    expect(captured).not.toHaveProperty("tools");
    expect(captured).not.toHaveProperty("tool_choice");
  });

  it("sends only the native allowlist and safe fixed transport fields", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "evren_native_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: fetchMock as typeof fetch,
    });
    await client.respond({
      model: "caller-cannot-override-production-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      stream: false,
    });
    expect(captured).toEqual({
      model: "deepseek-v4.1-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      stream: false,
    });
  });

  it("reuses a Bridge-prepared native body and reports separated client timings", async () => {
    let capturedBody = "";
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: (async (_url, init) => {
        capturedBody = String(init?.body);
        return new Response(JSON.stringify({
          id: "evren_prepared",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        }), { status: 200 });
      }) as typeof fetch,
    });
    const request = {
      model: "deepseek-v4.1-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [],
      tool_choice: "auto" as const,
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      stream: false as const,
    };
    const serializedBody = JSON.stringify(request);

    const result = await client.respond(request, undefined, { serializedBody });

    expect(capturedBody).toBe(serializedBody);
    expect(result.timing).toEqual({
      providerWaitMs: expect.any(Number),
      responseParseMs: expect.any(Number),
      resultProcessingMs: expect.any(Number),
    });
  });

  it("reports the model from the dispatched upstream body with safe thread and turn identity", async () => {
    let fetchStarted = false;
    const observations: unknown[] = [];
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: (async () => {
        fetchStarted = true;
        return new Response(JSON.stringify({
          id: "evren_route_1",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
      }) as typeof fetch,
      onUpstreamRequest: (observation) => {
        expect(fetchStarted).toBe(true);
        observations.push(observation);
      },
    });

    await client.respond({
      model: "ignored-caller-model",
      input: [],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 128,
      stream: false,
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      requestKind: "turn",
      bridgeModel: "deepseek-v4.1-flash",
      codexRequestedModel: "deepseek-v4.1-flash",
      inferenceNumber: 1,
    });

    expect(observations).toEqual([expect.objectContaining({
      threadId: "thread-1",
      turnId: "turn-1",
      bridgeModel: "deepseek-v4.1-flash",
      codexRequestedModel: "deepseek-v4.1-flash",
      upstreamModel: "deepseek-v4.1-flash",
      inferenceNumber: 1,
      observedAt: expect.any(Number),
    })]);
    expect(client.getEffectiveModel()).toBe("deepseek-v4.1-flash");
  });

  it("reports real upstream lifecycle transitions with only safe turn identity", async () => {
    const activities: unknown[] = [];
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: (async () => new Response(JSON.stringify({
        id: "evren_activity_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200 })) as typeof fetch,
      onUpstreamActivity: (activity) => activities.push(activity),
    });
    await client.infer("private prompt", 16, {
      threadId: "thread-1",
      turnId: "turn-1",
      bridgeModel: "deepseek-v4.1-flash",
      codexRequestedModel: "deepseek-v4.1-flash",
      inferenceNumber: 1,
    });
    expect(activities).toEqual([
      expect.objectContaining({ phase: "sending", threadId: "thread-1", turnId: "turn-1" }),
      expect.objectContaining({ phase: "waiting", threadId: "thread-1", turnId: "turn-1" }),
      expect.objectContaining({ phase: "processing", threadId: "thread-1", turnId: "turn-1" }),
      expect.objectContaining({ phase: "completed", threadId: "thread-1", turnId: "turn-1", inferenceNumber: 1, elapsedMs: expect.any(Number) }),
    ]);
    expect(JSON.stringify(activities)).not.toContain("private prompt");
    expect(JSON.stringify(activities)).not.toContain("secret");
  });

  it("blocks a context model mismatch before dispatch", async () => {
    const fetchMock = vi.fn();
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.infer("hello", 32, {
      bridgeModel: "other-model",
      codexRequestedModel: "other-model",
      inferenceNumber: 1,
    })).rejects.toThrow("Effective upstream model does not match the requested Bridge route.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures both valid credit headers case-insensitively", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "evren_credits",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }), {
      status: 200,
      headers: {
        "x-EvReN-cReDiTs-HeLd": "0.0000",
        "X-EVREN-CREDITS-REMAINING": "1000.0000",
      },
    }));
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: fetchMock as typeof fetch,
    });

    await client.respond({
      model: "deepseek-v4.1-flash",
      input: [],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      stream: false,
    });

    expect(client.getCreditState()).toMatchObject({ held: 0, remaining: 1_000, uncertain: false });
  });

  it("treats missing credit headers as unavailable without breaking a valid response", async () => {
    const parsed = parseEvrenCreditHeaders(new Headers());
    expect(parsed).toEqual({ invalidHeld: false, invalidRemaining: false });
  });

  it.each([
    ["malformed", "not-a-number"],
    ["non-decimal", "0x10"],
    ["negative", "-1"],
    ["NaN", "NaN"],
    ["positive infinity", "Infinity"],
    ["negative infinity", "-Infinity"],
    ["empty", "   "],
  ])("rejects %s credit header values", (_label, value) => {
    const parsed = parseEvrenCreditHeaders(new Headers({
      "X-Evren-Credits-Held": value,
      "X-Evren-Credits-Remaining": "12.5",
    }));
    expect(parsed).toEqual({
      remaining: 12.5,
      invalidHeld: true,
      invalidRemaining: false,
    });
  });

  it("emits only a safe warning for invalid credit headers", async () => {
    const events: LogEvent[] = [];
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: { log: (event) => events.push(event) },
      fetch: (async () => new Response(JSON.stringify({
        id: "evren_invalid_credit",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "X-Evren-Credits-Held": "NaN" } })) as typeof fetch,
    });

    await client.infer("safe", 10);

    expect(client.getCreditState()).toMatchObject({ uncertain: true });
    expect(client.getCreditState()).not.toHaveProperty("held");
    expect(events).toContainEqual(expect.objectContaining({
      event: "EVREN_CREDIT_HEADERS_INVALID",
      level: "warn",
      data: { invalidHeld: true, invalidRemaining: false },
    }));
    expect(JSON.stringify(events)).not.toContain("NaN");
  });

  it("classifies HTTP 429 with Retry-After and never retries the inference", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "rate_limit", message: "too many requests", secret: "must-not-escape" },
    }), { status: 429, headers: { "retry-after": "2" } }));
    const client = testClient(fetchMock as typeof fetch);
    const error = await client.infer("one request", 16).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EvrenUpstreamError);
    expect(error).toMatchObject({
      category: "rate_limit",
      code: "upstream_rate_limit",
      options: { httpStatus: 429, retryAfterMs: 2_000, retryable: true },
    });
    expect(String(error)).not.toContain("must-not-escape");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies provider 5xx separately and does not replay the request", async () => {
    const fetchMock = vi.fn(async () => new Response("temporary outage", { status: 500 }));
    const error = await testClient(fetchMock as typeof fetch).infer("one request", 16).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ category: "provider_error", code: "upstream_provider_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes request timeout from an explicit Stop abort", async () => {
    const waitForAbort = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    })) as typeof fetch;
    const timedOut = await testClient(waitForAbort, 5).infer("slow", 16).catch((reason: unknown) => reason);
    expect(timedOut).toMatchObject({ category: "timeout", code: "upstream_timeout" });

    const stop = new AbortController();
    const stoppedPromise = testClient(waitForAbort, 1_000).infer("stop", 16, {
      bridgeModel: "deepseek-v4.1-flash",
      inferenceNumber: 1,
      signal: stop.signal,
    }).catch((reason: unknown) => reason);
    stop.abort();
    await expect(stoppedPromise).resolves.toMatchObject({ category: "aborted", code: "upstream_aborted" });
  });

  it("classifies malformed success JSON as a provider response error", async () => {
    const fetchMock = vi.fn(async () => new Response("not-json", { status: 200 }));
    const error = await testClient(fetchMock as typeof fetch).infer("one request", 16).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ category: "malformed_response", code: "upstream_malformed_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps image request data intact while diagnostics contain only safe counts", async () => {
    const events: LogEvent[] = [];
    let body = "";
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAA==";
    const client = new EvrenClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
      timeoutMs: 1_000,
      logger: { log: (event) => events.push(event) },
      fetch: (async (_url, init) => {
        body = String(init?.body);
        return new Response(JSON.stringify({
          id: "evren_image",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
      }) as typeof fetch,
    });
    await client.respond({
      model: "deepseek-v4.1-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
      tools: [], tool_choice: "none", parallel_tool_calls: false, max_output_tokens: 16, stream: false,
    });
    expect(body).toContain(imageUrl);
    expect(JSON.stringify(events)).not.toContain(imageUrl);
    expect(JSON.stringify(events)).not.toContain("iVBOR");
  });
});

function testClient(fetchImpl: typeof fetch, timeoutMs = 1_000): EvrenClient {
  return new EvrenClient({
    baseUrl: "https://example.invalid/v1",
    apiKey: "secret",
    model: "deepseek-v4.1-flash",
    timeoutMs,
    logger: nullLogger,
    fetch: fetchImpl,
  });
}
