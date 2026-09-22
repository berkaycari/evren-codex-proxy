import { describe, expect, it } from "vitest";
import { normalizeCodexRequest } from "../src/bridge/normalize-codex-request.js";

describe("Codex request normalization", () => {
  it("exposes call_ids from every supported tool output type", () => {
    const request = normalizeCodexRequest({
      input: [
        { type: "function_call_output", call_id: "call_function", output: "one" },
        { type: "custom_tool_call_output", call_id: "call_custom", output: "two" },
        { type: "mcp_tool_call_output", call_id: "call_mcp", output: "three" },
      ],
    });

    expect(request.toolOutputCallIds).toEqual(["call_function", "call_custom", "call_mcp"]);
    expect(request.entries).toEqual([
      { role: "tool", callId: "call_function", text: "one" },
      { role: "tool", callId: "call_custom", text: "two" },
      { role: "tool", callId: "call_mcp", text: "three" },
    ]);
  });

  it("drops reasoning and reasoning_text items instead of replaying them upstream", () => {
    const request = normalizeCodexRequest({
      input: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "private chain" }] },
        { type: "reasoning_text", text: "also private" },
        { type: "message", role: "user", content: "safe user text" },
      ],
    });
    expect(request.entries).toEqual([{ role: "user", text: "safe user text" }]);
    expect(JSON.stringify(request)).not.toContain("private chain");
  });
});
