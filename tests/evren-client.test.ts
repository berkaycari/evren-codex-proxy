import { describe, expect, it, vi } from "vitest";
import { EvrenClient } from "../src/evren/client.js";
import { nullLogger } from "../src/ui/logger.js";

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
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      logger: nullLogger,
      fetch: fetchMock as typeof fetch,
    });
    await client.infer("prompt with textual catalog", 100);
    expect(captured).toEqual({
      model: "deepseek-v4-flash",
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
      model: "deepseek-v4-flash",
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
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 4096,
      stream: false,
    });
  });
});
