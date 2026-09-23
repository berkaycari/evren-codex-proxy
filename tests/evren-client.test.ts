import { describe, expect, it, vi } from "vitest";
import { EvrenClient, parseEvrenCreditHeaders } from "../src/evren/client.js";
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
});
