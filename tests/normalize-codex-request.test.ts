import { describe, expect, it } from "vitest";
import { normalizeCodexRequest } from "../src/bridge/normalize-codex-request.js";
import { buildNativeEvrenRequest, nativeMessage } from "../src/bridge/native-codex-to-evren.js";

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
      { role: "tool", callId: "call_function", text: "one", inputIndex: 0 },
      { role: "tool", callId: "call_custom", text: "two", inputIndex: 1 },
      { role: "tool", callId: "call_mcp", text: "three", inputIndex: 2 },
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
    expect(request.entries).toEqual([{ role: "user", text: "safe user text", inputIndex: 2 }]);
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

  it("preserves supported input_image data in the native Responses request", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const request = normalizeCodexRequest({
      model: "image-model",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Bu görseli incele" },
          { type: "input_image", image_url: imageUrl, detail: "auto" },
        ],
      }],
    });
    expect(request.entries[0]?.text).toContain("[input_image sha256:");
    expect(request.entries[0]?.text).not.toContain(imageUrl);
    const entry = request.entries[0]!;
    const native = buildNativeEvrenRequest(
      request,
      [nativeMessage("user", entry.text, entry.nativeContent)],
      "image-model",
      1_000,
      {
        source: "bridge_session",
        agentRuntime: "Codex",
        providerBridge: "EVREN",
        upstreamInferenceModel: "image-model",
      },
    );
    expect(native.input.find((item) => item.role === "user")).toMatchObject({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Bu görseli incele" },
        { type: "input_image", image_url: imageUrl, detail: "auto" },
      ],
    });
    expect(JSON.stringify(native)).not.toContain("input_image omitted");
  });

  it("preserves image-only and multiple-image requests without inserting prompt placeholders", () => {
    const first = "data:image/png;base64,iVBORw0KGgoAAA==";
    const second = "data:image/webp;base64,UklGRgAAAAA=";
    const request = normalizeCodexRequest({
      input: [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: first },
        { type: "input_image", image_url: second, detail: "low" },
      ] }],
    });
    expect(request.entries[0]?.nativeContent).toEqual([
      { type: "input_image", image_url: first },
      { type: "input_image", image_url: second, detail: "low" },
    ]);
    expect(JSON.stringify(request.entries[0]?.nativeContent)).not.toContain("omitted");
  });

  it("rejects unsupported image MIME and malformed base64 before upstream inference", () => {
    expect(() => normalizeCodexRequest({ input: [{
      type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/gif;base64,R0lGODlh" }],
    }] })).toThrow("supports only PNG, JPEG, or WebP");
    expect(() => normalizeCodexRequest({ input: [{
      type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,%%%" }],
    }] })).toThrow("base64 data URL");
  });

  it("preserves developer/system semantics and fails unknown input structures explicitly", () => {
    const request = normalizeCodexRequest({ input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "policy" }] },
      { type: "message", role: "developer", content: "contract" },
      { type: "message", role: "user", content: "task" },
    ] });
    expect(request.entries.map((entry) => entry.role)).toEqual(["developer", "developer", "user"]);
    expect(() => normalizeCodexRequest({ input: [{ type: "future_magic", payload: "do not stringify" }] }))
      .toThrow("Unsupported Responses input item");
    expect(() => normalizeCodexRequest({ input: { prompt: "do not coerce" } }))
      .toThrow("input must be a string or an array");
  });

  it("rejects multimodal tool outputs instead of silently replacing them with text", () => {
    expect(() => normalizeCodexRequest({ input: [{
      type: "function_call_output",
      call_id: "call-1",
      output: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAA==" }],
    }] })).toThrow("not supported inside a tool output");
  });
});
