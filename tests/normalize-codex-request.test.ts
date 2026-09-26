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

  it("uses only allowlisted Codex turn metadata to classify dashboard foreground requests", () => {
    const foreground = normalizeCodexRequest({
      input: "user turn",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: "thread_main",
          token: "must-not-be-copied",
        }),
      },
    });
    const helper = normalizeCodexRequest({
      input: "internal helper",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "prewarm", thread_id: "thread_main" }),
      },
    });

    expect(foreground).toMatchObject({ requestKind: "turn", foreground: true });
    expect(helper).toMatchObject({ requestKind: "prewarm", foreground: false });
    expect(foreground.turnMetadata.threadId).toBe("thread_main");
    expect(JSON.stringify(foreground)).not.toContain("must-not-be-copied");
  });

  it("keeps legacy requests foreground while malformed or unknown metadata cannot steal focus", () => {
    expect(normalizeCodexRequest({ input: "legacy" }).foreground).toBe(true);
    expect(normalizeCodexRequest({
      input: "malformed",
      client_metadata: { "x-codex-turn-metadata": "not json" },
    }).foreground).toBe(false);
    expect(normalizeCodexRequest({
      input: "future helper",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "unknown_internal_kind" }) },
    }).foreground).toBe(false);
  });

  it("classifies canonical Codex 0.156.1 request kinds without guessing unknown values", () => {
    const normalize = (request_kind: string) => normalizeCodexRequest({
      input: "x",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind }) },
    });
    expect(normalize("turn").requestClassification).toBe("foreground");
    for (const kind of ["prewarm", "compaction", "memory"]) {
      expect(normalize(kind).requestClassification).toBe("internal");
    }
    expect(normalize("compact")).toMatchObject({ requestKind: "compact", requestClassification: "unclassified" });
    expect(normalize("future_kind")).toMatchObject({ requestKind: "future_kind", requestClassification: "unclassified" });
  });

  it("validates each typed metadata field independently", () => {
    const request = normalizeCodexRequest({
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        session_id: 123,
        thread_id: "thread_ok",
        turn_id: false,
        window_id: "window_ok",
        window_number: "2",
        context_window_id: "context_ok",
        has_changes: "yes",
        workspaces: [{ private: "not exposed" }],
      }) },
    });
    expect(request.turnMetadata).toEqual({
      requestKind: "turn",
      threadId: "thread_ok",
      windowId: "window_ok",
      contextWindowId: "context_ok",
    });
    expect(JSON.stringify(request)).not.toContain("workspaces");
  });
});
