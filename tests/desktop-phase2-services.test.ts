import { describe, expect, it, vi } from "vitest";
import { CodexThreadService, CodexTurnService } from "../src/desktop/main/codex-services.js";

const projectPath = "C:\\work\\project";

function rawThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "019-thread",
    preview: "Build a feature",
    cwd: projectPath,
    model: "chat-model",
    modelProvider: "evren-desktop",
    updatedAt: 1_700_000_000,
    status: { type: "idle" },
    name: null,
    ...overrides,
  };
}

describe("Phase 2 Codex thread service", () => {
  it("creates exactly one persistent thread with the safe 0.157.1 defaults", async () => {
    const request = vi.fn(async () => ({
      thread: rawThread(), model: "chat-model", modelProvider: "evren-desktop", cwd: projectPath,
    }));
    const service = new CodexThreadService({ request });
    await expect(service.start(projectPath, "chat-model")).resolves.toMatchObject({ id: "019-thread", model: "chat-model" });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("thread/start", {
      model: "chat-model",
      modelProvider: "evren-desktop",
      cwd: projectPath,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: false,
      threadSource: "evren-codex-desktop",
    });
  });

  it("discovers persisted Desktop threads by provider without the incorrect App Server source filter", async () => {
    const request = vi.fn(async () => ({
      data: [
        rawThread({ source: "vscode", threadSource: null }),
        rawThread({ id: "other-provider", modelProvider: "openai" }),
        rawThread({ id: "other-project", cwd: "C:\\work\\other" }),
      ],
      nextCursor: null,
    }));
    const service = new CodexThreadService({ request });
    await expect(service.list("c:/WORK/project/")).resolves.toEqual([
      expect.objectContaining({ id: "019-thread", modelProvider: "evren-desktop" }),
    ]);
    expect(request).toHaveBeenCalledWith("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: ["evren-desktop"],
    });
  });

  it("resumes by threadId without eager turns, then hydrates a bounded page", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") return {
        thread: rawThread(), model: "chat-model", modelProvider: "evren-desktop", cwd: projectPath,
      };
      return {
        data: [{
          id: "turn-1", status: "completed", items: [
            { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "hello", text_elements: [] }] },
            { type: "reasoning", id: "secret", summary: ["hidden"], content: ["private"] },
            { type: "agentMessage", id: "a1", text: "done", phase: null },
          ],
        }],
        nextCursor: "older-cursor",
      };
    });
    const service = new CodexThreadService({ request });
    const expected = await new CodexThreadService({ request: async () => ({ data: [rawThread()] }) }).list().then((items) => items[0]!);
    const result = await service.resume("019-thread", expected, projectPath);
    expect(request).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "019-thread", excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, "thread/turns/list", {
      threadId: "019-thread", limit: 20, sortDirection: "desc", itemsView: "full",
    });
    expect(result.history.nextCursor).toBe("older-cursor");
    expect(result.history.items.map((item) => item.kind)).toEqual(["userMessage", "assistantMessage"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("validates and resumes a saved thread pointer when discovery is temporarily incomplete", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/resume") return {
        thread: rawThread({ source: "vscode", threadSource: "evren-codex-desktop" }),
        model: "chat-model",
        modelProvider: "evren-desktop",
        cwd: projectPath,
      };
      return { data: [], nextCursor: null };
    });
    const result = await new CodexThreadService({ request }).resumeSaved(
      "019-thread",
      projectPath,
      "chat-model",
      "chat-model",
    );
    expect(result.thread).toMatchObject({ id: "019-thread", cwd: projectPath, modelProvider: "evren-desktop" });
    expect(request).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "019-thread", excludeTurns: true });
    expect(request).toHaveBeenNthCalledWith(2, "thread/turns/list", expect.objectContaining({ threadId: "019-thread" }));
  });

  it("rejects model/provider/cwd disagreement instead of silently routing", async () => {
    const service = new CodexThreadService({ request: async () => ({
      thread: rawThread({ model: "other-model" }), model: "other-model", modelProvider: "evren-desktop", cwd: projectPath,
    }) });
    await expect(service.start(projectPath, "chat-model")).rejects.toMatchObject({ code: "THREAD_MODEL_MISMATCH" });
  });

  it("rejects a real provider mismatch even when the model agrees", async () => {
    const service = new CodexThreadService({ request: async () => ({
      thread: rawThread({ modelProvider: "openai" }), model: "chat-model", modelProvider: "openai", cwd: projectPath,
    }) });
    await expect(service.start(projectPath, "chat-model")).rejects.toMatchObject({ code: "THREAD_MODEL_MISMATCH" });
  });

  it("uses the authoritative start response while a nested lifecycle model is temporarily null", async () => {
    const diagnostics: unknown[] = [];
    const service = new CodexThreadService({ request: async () => ({
      thread: rawThread({ model: null }), model: "chat-model", modelProvider: "evren-desktop", cwd: projectPath,
    }) }, { onConsistencyDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

    await expect(service.start(projectPath, "chat-model", "chat-model")).resolves.toMatchObject({
      id: "019-thread", model: "chat-model", modelProvider: "evren-desktop",
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      transition: "thread_start_response",
      selectedModelId: "chat-model",
      bridgeModelId: "chat-model",
      responseModelId: "chat-model",
      expectedProviderId: "evren-desktop",
      responseProviderId: "evren-desktop",
      accepted: true,
    })]);
  });

  it("rejects a non-null nested thread model that conflicts with the authoritative response", async () => {
    const service = new CodexThreadService({ request: async () => ({
      thread: rawThread({ model: "other-model" }), model: "chat-model", modelProvider: "evren-desktop", cwd: projectPath,
    }) });
    await expect(service.start(projectPath, "chat-model")).rejects.toMatchObject({ code: "THREAD_MODEL_MISMATCH" });
  });

  it("loads earlier history with the opaque cursor and keeps chronological item order", async () => {
    const request = vi.fn(async () => ({
      data: [
        { id: "newer", status: "completed", items: [{ type: "agentMessage", id: "a2", text: "new", phase: null }] },
        { id: "older", status: "completed", items: [{ type: "agentMessage", id: "a1", text: "old", phase: null }] },
      ],
      nextCursor: null,
    }));
    const page = await new CodexThreadService({ request }).history("019-thread", projectPath, "cursor-1");
    expect(request).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ cursor: "cursor-1" }));
    expect(page.items.map((item) => item.kind === "assistantMessage" ? item.text : "")).toEqual(["old", "new"]);
  });
});

describe("Phase 2 Codex turn service", () => {
  it("uses exact text/localImage input, client message ID, and prevents duplicate send", async () => {
    let resolveRequest!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const service = new CodexTurnService({ request });
    const first = service.start("thread-1", [
      { type: "text", text: "inspect", text_elements: [] },
      { type: "localImage", path: "C:\\tmp\\image.png" },
    ], "client-1", "chat-model");
    await expect(service.start("thread-1", [{ type: "text", text: "duplicate", text_elements: [] }], "client-2", "chat-model"))
      .rejects.toMatchObject({ code: "TURN_ALREADY_ACTIVE" });
    resolveRequest({ turn: { id: "turn-1" } });
    await expect(first).resolves.toBe("turn-1");
    expect(request).toHaveBeenCalledWith("turn/start", {
      threadId: "thread-1",
      input: [
        { type: "text", text: "inspect", text_elements: [] },
        { type: "localImage", path: "C:\\tmp\\image.png" },
      ],
      clientUserMessageId: "client-1",
      model: "chat-model",
    });
  });

  it("interrupts the exact active thread and turn without stopping Codex", async () => {
    const request = vi.fn(async (method: string) => method === "turn/start" ? { turn: { id: "turn-1" } } : {});
    const service = new CodexTurnService({ request });
    await service.start("thread-1", [{ type: "text", text: "long task", text_elements: [] }], "client-1", "chat-model");
    await service.interrupt("thread-1", "turn-1");
    expect(request).toHaveBeenLastCalledWith("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
    service.noteCompleted("thread-1", "turn-1");
    await expect(service.start("thread-1", [{ type: "text", text: "continue", text_elements: [] }], "client-2", "chat-model")).resolves.toBe("turn-1");
  });
});
