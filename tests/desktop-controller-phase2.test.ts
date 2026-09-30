import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeRuntime, BridgeRuntimeOptions, BridgeRuntimeSnapshot } from "../src/runtime/bridge-runtime.js";
import type { UpstreamModelObservation } from "../src/evren/client.js";
import type { AttachmentService } from "../src/desktop/main/attachment-service.js";
import type { CodexAppServerManager } from "../src/desktop/main/codex-app-server.js";
import { DesktopController } from "../src/desktop/main/desktop-controller.js";
import { CredentialService, type CredentialEncryption } from "../src/desktop/main/credential-service.js";
import { EvrenCatalogService } from "../src/desktop/main/model-catalog.js";
import { DesktopSettingsStore } from "../src/desktop/main/settings-service.js";
import type { JsonRpcServerRequest } from "../src/desktop/main/json-rpc-stdio.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

class FakeEncryption implements CredentialEncryption {
  isAvailable(): boolean { return true; }
  encrypt(value: string): Buffer { return Buffer.from(value); }
  decrypt(value: Buffer): string { return value.toString(); }
}

class FakeManager {
  notifications = new Set<(method: string, params: unknown) => void>();
  serverRequests = new Set<(request: JsonRpcServerRequest) => void>();
  request = vi.fn(async (method: string, params: unknown) => this.handle(method, params));
  start = vi.fn(async () => undefined);
  stop = vi.fn(async () => undefined);
  respondToServerRequest = vi.fn();
  rejectServerRequest = vi.fn();
  threads: Array<Record<string, unknown>> = [];
  historyTurns: Array<Record<string, unknown>> = [];
  hideThreadsFromList = false;
  readonly lifecycleEvents: string[] = [];
  private turnNumber = 0;

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener); return () => this.notifications.delete(listener);
  }
  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void {
    this.serverRequests.add(listener); return () => this.serverRequests.delete(listener);
  }
  emit(method: string, params: unknown): void { for (const listener of this.notifications) listener(method, params); }

  private handle(method: string, params: unknown): unknown {
    const input = params as Record<string, unknown>;
    if (method === "thread/list") return { data: this.hideThreadsFromList ? [] : this.threads, nextCursor: null };
    if (method === "thread/start") {
      this.lifecycleEvents.push(`thread-start:${String(input.model)}`);
      const thread = {
        id: `thread-${this.threads.length + 1}`,
        preview: "",
        cwd: input.cwd,
        model: input.model,
        modelProvider: "evren-desktop",
        updatedAt: 1_700_000_000 + this.threads.length,
        status: { type: "idle" },
        name: null,
      };
      this.threads.unshift(thread);
      return { thread, model: input.model, modelProvider: "evren-desktop", cwd: input.cwd };
    }
    if (method === "thread/resume") {
      const thread = this.threads.find((candidate) => candidate.id === input.threadId)!;
      return { thread, model: thread.model, modelProvider: "evren-desktop", cwd: thread.cwd };
    }
    if (method === "thread/name/set") {
      const thread = this.threads.find((candidate) => candidate.id === input.threadId)!;
      thread.name = input.name;
      return {};
    }
    if (method === "thread/turns/list") return { data: this.historyTurns, nextCursor: null };
    if (method === "turn/start") return { turn: { id: `turn-${++this.turnNumber}` } };
    return {};
  }
}

async function fixture(attachmentService?: AttachmentService, options: {
  beforeRuntimeReady?: (model: string) => Promise<void>;
  runtimeReportedModel?: (requested: string) => string;
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-controller-phase2-"));
  directories.push(directory);
  const credentialService = new CredentialService(path.join(directory, "credentials.json"), new FakeEncryption());
  const manager = new FakeManager();
  let onExit: () => void = () => undefined;
  let publishUpstreamModel: (observation: UpstreamModelObservation) => void = () => undefined;
  const runtimeModels: string[] = [];
  const controller = new DesktopController({
    version: "1.3.0",
    userDataDir: directory,
    cwd: directory,
    credentialService,
    settingsStore: new DesktopSettingsStore(path.join(directory, "settings.json")),
    catalogService: new EvrenCatalogService({
      baseUrl: "https://example.invalid/v1",
      timeoutMs: 1_000,
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [
        { id: "text-model", task: "chat", modalities: ["text"], pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" } },
        { id: "image-model", task: "chat", modalities: ["text", "image"], pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" } },
      ] }), { status: 200 })) as typeof fetch,
    }),
    detectCodex: async () => ({ found: true, version: "0.157.1", testedVersion: "0.157.1", compatibility: "tested", ready: false }),
    createRuntime: ((runtimeOptions: BridgeRuntimeOptions) => {
      runtimeModels.push(runtimeOptions.modelOverride!);
      const requestedModel = runtimeOptions.modelOverride!;
      const snapshot: BridgeRuntimeSnapshot = {
        status: "running", host: "127.0.0.1", port: 45454, model: options.runtimeReportedModel?.(requestedModel) ?? requestedModel,
        pricing: { allowed: true, connected: true, pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" } },
        credits: { remaining: 1, uncertain: false }, update: { status: "disabled" },
      };
      const listeners = new Set<(value: BridgeRuntimeSnapshot) => void>();
      publishUpstreamModel = (observation) => {
        snapshot.upstreamModelObservations = [observation];
        for (const listener of listeners) listener(snapshot);
      };
      return {
        start: async () => {
          await options.beforeRuntimeReady?.(requestedModel);
          manager.lifecycleEvents.push(`bridge-ready:${snapshot.model}`);
          return snapshot;
        },
        stop: async () => undefined,
        snapshot: () => snapshot,
        subscribe: (listener: (value: BridgeRuntimeSnapshot) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as BridgeRuntime;
    }) as typeof import("../src/runtime/bridge-runtime.js").createBridgeRuntime,
    createCodexManager: (callback) => { onExit = callback; return manager as unknown as CodexAppServerManager; },
    pickProject: async () => directory,
    pickImage: async () => path.join(directory, "image.png"),
    ...(attachmentService ? { attachmentService } : {}),
  });
  await controller.initialize();
  await controller.saveCredential({ apiKey: "secret", persistence: "secure" });
  await controller.openProject();
  return { controller, manager, runtimeModels, publishUpstreamModel, crash: () => onExit(), directory };
}

async function restartController(directory: string, manager: FakeManager): Promise<DesktopController> {
  const controller = new DesktopController({
    version: "1.3.0",
    userDataDir: directory,
    cwd: directory,
    credentialService: new CredentialService(path.join(directory, "credentials.json"), new FakeEncryption()),
    settingsStore: new DesktopSettingsStore(path.join(directory, "settings.json")),
    catalogService: new EvrenCatalogService({
      baseUrl: "https://example.invalid/v1",
      timeoutMs: 1_000,
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [
        { id: "text-model", task: "chat", modalities: ["text"], pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" } },
        { id: "image-model", task: "chat", modalities: ["text", "image"], pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" } },
      ] }), { status: 200 })) as typeof fetch,
    }),
    detectCodex: async () => ({ found: true, version: "0.157.1", testedVersion: "0.157.1", compatibility: "tested", ready: false }),
    createRuntime: ((runtimeOptions: BridgeRuntimeOptions) => {
      const model = runtimeOptions.modelOverride!;
      const snapshot: BridgeRuntimeSnapshot = {
        status: "running", host: "127.0.0.1", port: 45454, model,
        pricing: { allowed: true, connected: true, pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" } },
        credits: { remaining: 1, uncertain: false }, update: { status: "disabled" },
      };
      return { start: async () => snapshot, stop: async () => undefined, snapshot: () => snapshot } as unknown as BridgeRuntime;
    }) as typeof import("../src/runtime/bridge-runtime.js").createBridgeRuntime,
    createCodexManager: () => manager as unknown as CodexAppServerManager,
  });
  await controller.initialize();
  return controller;
}

async function createRealThread(controller: DesktopController, text = "first real turn") {
  const draft = await controller.startThread();
  expect(draft.workspace).toMatchObject({ draftActive: true, threads: [] });
  expect(draft.workspace.selectedThreadId).toBeUndefined();
  expect(draft.history).toEqual([]);
  return controller.sendChat({ text, attachmentIds: [], clientUserMessageId: `client-${text}` });
}

describe("Phase 2 Desktop controller integration", () => {
  it("renames the Codex thread before updating local history", async () => {
    const { controller, manager } = await fixture();
    const started = await createRealThread(controller, "rename me");
    const threadId = started.workspace.selectedThreadId!;
    manager.request.mockClear();

    const renamed = await controller.renameHistory({ threadId, title: "Renamed conversation" });

    expect(manager.request).toHaveBeenCalledWith("thread/name/set", {
      threadId,
      name: "Renamed conversation",
    });
    expect(renamed.history.find((record) => record.threadId === threadId)?.title).toBe("Renamed conversation");
    expect(controller.getState().history.find((record) => record.threadId === threadId)?.title).toBe("Renamed conversation");
  });

  it("does not reactivate a terminal turn from a stale Codex notification", async () => {
    const { controller, manager } = await fixture();
    const started = await createRealThread(controller, "terminal state");
    const threadId = started.workspace.selectedThreadId!;
    const turnId = started.workspace.turn.id!;

    manager.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    expect(controller.getState().workspace.turn).toMatchObject({ phase: "completed", outcome: "success", id: turnId });

    manager.emit("turn/started", { threadId, turn: { id: "stale-turn" } });
    expect(controller.getState().workspace.turn).toMatchObject({ phase: "completed", id: turnId });
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it("keeps a non-retrying upstream 429 terminal even when Codex subsequently reports completed", async () => {
    const { controller, manager } = await fixture();
    const started = await createRealThread(controller, "rate limited image request");
    const threadId = started.workspace.selectedThreadId!;
    const turnId = started.workspace.turn.id!;

    manager.emit("error", {
      threadId,
      turnId,
      willRetry: false,
      error: { message: "EVREN rate limited the request (HTTP 429).", code: "upstream_rate_limit" },
    });
    expect(controller.getState().workspace).toMatchObject({
      turn: { phase: "failed", outcome: "failed", id: turnId, errorCode: "UPSTREAM_RATE_LIMIT" },
      error: { code: "UPSTREAM_RATE_LIMIT", detail: "HTTP 429 · Too Many Requests" },
    });

    manager.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    expect(controller.getState().workspace.turn).toMatchObject({
      phase: "failed", outcome: "failed", id: turnId, errorCode: "UPSTREAM_RATE_LIMIT",
    });
    expect(controller.getState().codex.ready).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it("does not leak stale or retrying provider errors into the active turn outcome", async () => {
    const { controller, manager } = await fixture();
    const started = await createRealThread(controller, "current turn");
    const threadId = started.workspace.selectedThreadId!;
    const turnId = started.workspace.turn.id!;
    const error = { willRetry: false, error: { code: "upstream_rate_limit", message: "HTTP 429" } };

    manager.emit("error", { ...error, threadId, turnId: "different-turn" });
    manager.emit("error", { ...error, threadId, turnId, willRetry: true });
    expect(controller.getState().workspace.turn).toMatchObject({ phase: "running", id: turnId });
    expect(controller.getState().workspace.error).toBeUndefined();

    manager.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    expect(controller.getState().workspace.turn).toMatchObject({ phase: "completed", outcome: "success", id: turnId });
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it("preserves an explicit interrupt outcome", async () => {
    const { controller } = await fixture();
    const started = await createRealThread(controller, "interrupt me");
    const threadId = started.workspace.selectedThreadId!;
    const turnId = started.workspace.turn.id!;

    await controller.interruptChat({ threadId, turnId });

    expect(controller.getState().workspace.turn).toMatchObject({ phase: "interrupted", outcome: "interrupted", id: turnId });
  });

  it("rediscovers and resumes the same persistent Desktop thread after a complete controller restart", async () => {
    const { controller: runA, manager, directory } = await fixture();
    const started = await createRealThread(runA, "persist me");
    manager.historyTurns = [{
      id: "turn-persisted",
      status: "completed",
      items: [
        { type: "userMessage", id: "user-persisted", clientId: null, content: [{ type: "text", text: "persist me", text_elements: [] }] },
        { type: "agentMessage", id: "assistant-persisted", text: "persisted", phase: null },
      ],
    }];
    const threadId = started.workspace.selectedThreadId!;
    await runA.shutdown();

    const runB = await restartController(directory, manager);
    expect(runB.getState()).toMatchObject({
      workspace: {
        activeProject: { path: directory },
        selectedThreadId: threadId,
        selectedThreadModel: "text-model",
        threads: [expect.objectContaining({ id: threadId, modelProvider: "evren-desktop" })],
        items: [
          expect.objectContaining({ kind: "userMessage", text: "persist me" }),
          expect.objectContaining({ kind: "assistantMessage", text: "persisted" }),
        ],
      },
    });
    const listCall = manager.request.mock.calls.find(([method]) => method === "thread/list");
    expect(listCall?.[1]).toEqual(expect.objectContaining({ modelProviders: ["evren-desktop"] }));
    expect(listCall?.[1]).not.toHaveProperty("sourceKinds");
    expect(listCall?.[1]).not.toHaveProperty("cwd");

    manager.hideThreadsFromList = true;
    await runB.listThreads();
    expect(runB.getState().workspace.threads.map((thread) => thread.id)).toContain(threadId);
    await runB.shutdown();
  });

  it("uses a validated saved-thread resume fallback and clears an invalid stale pointer", async () => {
    const { controller: runA, manager, directory } = await fixture();
    const threadId = (await createRealThread(runA)).workspace.selectedThreadId!;
    await runA.shutdown();

    manager.hideThreadsFromList = true;
    const recovered = await restartController(directory, manager);
    expect(recovered.getState().workspace).toMatchObject({
      selectedThreadId: threadId,
      threads: [expect.objectContaining({ id: threadId, cwd: directory, modelProvider: "evren-desktop" })],
    });
    await recovered.shutdown();

    manager.threads = [];
    manager.hideThreadsFromList = false;
    const stale = await restartController(directory, manager);
    expect(stale.getState().workspace.selectedThreadId).toBeUndefined();
    const saved = await new DesktopSettingsStore(path.join(directory, "settings.json")).load();
    expect(saved.lastSelectedThreadId).toBeUndefined();
    await stale.shutdown();
  });

  it("keeps New Chat local through repeated model changes and creates exactly one thread on first send", async () => {
    const { controller, manager, runtimeModels } = await fixture();
    const first = await controller.startThread();
    expect(first.workspace).toMatchObject({ draftActive: true, threads: [] });
    expect(first.history).toEqual([]);
    expect(manager.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(0);
    await controller.selectModel({ modelId: "image-model" });
    await controller.selectModel({ modelId: "text-model" });
    await controller.selectModel({ modelId: "image-model" });
    expect(controller.getState().workspace.draftActive).toBe(true);
    expect(controller.getState().selectedModelId).toBe("image-model");
    const second = await controller.sendChat({ text: "bind once", attachmentIds: [], clientUserMessageId: "client-bind" });
    expect(second.workspace.selectedThreadModel).toBe("image-model");
    expect(manager.threads).toHaveLength(1);
    expect(second.history).toHaveLength(1);
    expect(runtimeModels.at(-1)).toBe("image-model");
    expect(second.workspace.threads.find((thread) => thread.id === second.workspace.selectedThreadId)?.model)
      .toBe("image-model");
  });

  it("keeps an existing thread bound to its original model until a new draft is opened", async () => {
    const { controller, manager, runtimeModels } = await fixture();
    const started = await createRealThread(controller, "keep original model");
    const threadId = started.workspace.selectedThreadId!;
    manager.emit("turn/completed", { thread: { id: threadId }, turn: { id: "turn-1", status: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const selected = await controller.selectModel({ modelId: "image-model" });

    expect(selected.selectedModelId).toBe("image-model");
    expect(selected.workspace).toMatchObject({ selectedThreadId: threadId, selectedThreadModel: "text-model" });
    expect(runtimeModels.at(-1)).toBe("text-model");
    const continued = await controller.sendChat({
      threadId,
      text: "continue existing",
      attachmentIds: [],
      clientUserMessageId: "client-existing",
    });
    expect(continued.workspace.selectedThreadModel).toBe("text-model");
    expect(manager.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(manager.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1])
      .toMatchObject({ threadId, model: "text-model" });
  });

  it("keeps a successful new thread in sidebar and main state across a lagging thread/list", async () => {
    const { controller, manager } = await fixture();
    manager.hideThreadsFromList = true;

    const started = await controller.startThread();
    expect(started.workspace).toMatchObject({ draftActive: true, threads: [] });
    expect(started.history).toEqual([]);

    const refreshedWhileLagging = await controller.listThreads();
    expect(refreshedWhileLagging.workspace.threads).toEqual([]);
    await expect(controller.sendChat({
      text: "first real turn", attachmentIds: [], clientUserMessageId: "client-lag",
    })).resolves.toMatchObject({ workspace: { turn: { phase: "running", id: "turn-1" } } });

    manager.hideThreadsFromList = false;
    await controller.listThreads();
    manager.hideThreadsFromList = true;
    const refreshedAgain = await controller.listThreads();
    expect(refreshedAgain.workspace.threads.map((thread) => thread.id)).toContain("thread-1");
  });

  it("awaits Bridge model rebind before thread/start", async () => {
    let releaseRebind!: () => void;
    let noteRebindStarted!: () => void;
    const rebindStarted = new Promise<void>((resolve) => { noteRebindStarted = resolve; });
    const rebindGate = new Promise<void>((resolve) => { releaseRebind = resolve; });
    const { controller, manager } = await fixture(undefined, {
      beforeRuntimeReady: async (model) => {
        if (model !== "image-model") return;
        noteRebindStarted();
        await rebindGate;
      },
    });
    await controller.startThread();
    const selecting = controller.selectModel({ modelId: "image-model" });
    await rebindStarted;
    expect(manager.lifecycleEvents).not.toContain("thread-start:image-model");
    releaseRebind();
    await selecting;
    await controller.startThread();
    await controller.sendChat({ text: "image draft", attachmentIds: [], clientUserMessageId: "client-image" });

    expect(manager.lifecycleEvents.indexOf("bridge-ready:image-model"))
      .toBeLessThan(manager.lifecycleEvents.indexOf("thread-start:image-model"));
  });

  it("serializes rapid model selection and New Chat onto the newly selected model", async () => {
    const { controller, manager, runtimeModels } = await fixture();
    await controller.startThread();

    const selecting = controller.selectModel({ modelId: "image-model" });
    const starting = controller.startThread();
    const [, state] = await Promise.all([selecting, starting]);

    expect(state.selectedModelId).toBe("image-model");
    expect(state.workspace.draftActive).toBe(true);
    expect(state.workspace.selectedThreadModel).toBeUndefined();
    expect(runtimeModels.at(-1)).toBe("image-model");
    expect(manager.lifecycleEvents).not.toContain("thread-start:image-model");
    await expect(controller.sendChat({ text: "new thread", attachmentIds: [], clientUserMessageId: "client-new" }))
      .resolves.toMatchObject({ workspace: { draftActive: false, selectedThreadModel: "image-model", turn: { phase: "running" } } });
    expect(manager.lifecycleEvents.at(-1)).toBe("thread-start:image-model");
  });

  it("exposes the model actually dispatched upstream for the exact thread and turn", async () => {
    const { controller, manager, publishUpstreamModel } = await fixture();
    const started = await createRealThread(controller, "route check");
    const threadId = started.workspace.selectedThreadId!;

    expect(manager.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({
      threadId,
      model: "text-model",
    });
    expect(controller.getState().workspace.modelRoutes.at(-1)).toMatchObject({
      threadId,
      turnId: "turn-1",
      codexRequestedModel: "text-model",
      status: "pending",
    });

    publishUpstreamModel({
      threadId,
      turnId: "turn-1",
      requestKind: "turn",
      bridgeModel: "text-model",
      codexRequestedModel: "text-model",
      upstreamModel: "text-model",
      inferenceNumber: 1,
      observedAt: 1_700_000_001_000,
    });

    expect(controller.getState().workspace.modelRoutes.at(-1)).toEqual({
      threadId,
      turnId: "turn-1",
      desktopSelectedModel: "text-model",
      codexRequestedModel: "text-model",
      bridgeEffectiveModel: "text-model",
      upstreamEffectiveModel: "text-model",
      providerId: "evren-desktop",
      status: "verified",
      inferenceNumber: 1,
      observedAt: 1_700_000_001_000,
    });
    expect(controller.getDiagnostics()).toContain("Upstream effective model: text-model");
    expect(controller.getDiagnostics()).toContain("Provider ID: evren-desktop");
  });

  it("fails before thread/start when Bridge reports a conflicting effective model", async () => {
    const { controller, manager } = await fixture(undefined, {
      runtimeReportedModel: (requested) => requested === "image-model" ? "text-model" : requested,
    });
    await controller.startThread();
    await controller.selectModel({ modelId: "image-model" });

    await controller.startThread();
    await expect(controller.sendChat({ text: "must fail", attachmentIds: [], clientUserMessageId: "client-mismatch" }))
      .rejects.toMatchObject({ code: "BRIDGE_MODEL_MISMATCH" });
    expect(manager.lifecycleEvents).not.toContain("thread-start:image-model");
    expect(controller.getState()).toMatchObject({ stage: "ERROR", error: { code: "BRIDGE_MODEL_MISMATCH" } });
  });

  it("blocks image input before inference when catalog modalities do not advertise image", async () => {
    const attachmentService = {
      resolve: () => [{ id: "image-1", name: "x.png", sizeBytes: 12, mimeType: "image/png", path: "C:\\tmp\\x.png" }],
      remove: vi.fn(), clear: vi.fn(), addImage: vi.fn(),
    } as unknown as AttachmentService;
    const { controller, manager } = await fixture(attachmentService);
    await controller.startThread();
    await expect(controller.sendChat({
      text: "inspect", attachmentIds: ["image-1"], clientUserMessageId: "client-1",
    })).rejects.toMatchObject({ code: "MODEL_IMAGE_UNSUPPORTED" });
    expect(manager.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(controller.getState().workspace).toMatchObject({
      turn: { phase: "failed" },
      error: { code: "MODEL_IMAGE_UNSUPPORTED", message: "Seçili model görsel girdiyi desteklediğini bildirmiyor." },
    });
  });

  it("sends image-only and text-plus-image input through localImage for an image-capable model", async () => {
    const attachmentService = {
      resolve: vi.fn(async () => [{ id: "image-1", name: "görsel bir.png", sizeBytes: 128, mimeType: "image/png", path: "C:\\tmp\\görsel bir.png" }]),
      remove: vi.fn(), clear: vi.fn(), addImage: vi.fn(),
    } as unknown as AttachmentService;
    const { controller, manager } = await fixture(attachmentService);
    await controller.startThread();
    await controller.selectModel({ modelId: "image-model" });
    await controller.sendChat({ text: "", attachmentIds: ["image-1"], clientUserMessageId: "client-image-only" });
    expect(manager.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [{ type: "localImage", path: "C:\\tmp\\görsel bir.png" }],
    }));

    const state = controller.getState();
    manager.emit("turn/completed", { threadId: state.workspace.selectedThreadId, turn: { id: state.workspace.turn.id, status: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await controller.startThread();
    await controller.sendChat({ text: "incele", attachmentIds: ["image-1"], clientUserMessageId: "client-image-text" });
    expect(manager.request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      input: [
        { type: "text", text: "incele", text_elements: [] },
        { type: "localImage", path: "C:\\tmp\\görsel bir.png" },
      ],
    }));
  });

  it("rejects oversized aggregate image input before turn/start", async () => {
    const attachmentService = {
      resolve: vi.fn(async () => [
        { id: "image-1", name: "one.png", sizeBytes: 11 * 1024 * 1024, mimeType: "image/png", path: "C:\\tmp\\one.png" },
        { id: "image-2", name: "two.png", sizeBytes: 11 * 1024 * 1024, mimeType: "image/png", path: "C:\\tmp\\two.png" },
      ]),
      remove: vi.fn(), clear: vi.fn(), addImage: vi.fn(),
    } as unknown as AttachmentService;
    const { controller, manager } = await fixture(attachmentService);
    await controller.startThread();
    await controller.selectModel({ modelId: "image-model" });
    await expect(controller.sendChat({
      text: "incele", attachmentIds: ["image-1", "image-2"], clientUserMessageId: "client-too-large",
    })).rejects.toMatchObject({ code: "IMAGE_TOTAL_SIZE_INVALID" });
    expect(manager.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("marks an active turn failed on Codex crash, keeps projected history, and resumes after Retry", async () => {
    const { controller, manager, crash } = await fixture();
    const started = await createRealThread(controller, "work");
    const threadId = started.workspace.selectedThreadId!;
    manager.emit("item/agentMessage/delta", { threadId, turnId: "turn-1", itemId: "a1", delta: "partial" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    crash();
    expect(controller.getState()).toMatchObject({
      stage: "READY_NO_CODEX",
      workspace: { turn: { phase: "failed" }, items: [expect.objectContaining({ kind: "assistantMessage", text: "partial" })] },
    });
    await controller.retry();
    expect(controller.getState()).toMatchObject({ stage: "READY", workspace: { selectedThreadId: threadId } });
    expect(manager.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(true);
  });

  it("prevents new turns while the Bridge/Codex route is unavailable", async () => {
    const { controller, crash } = await fixture();
    const started = await createRealThread(controller, "first");
    const threadId = started.workspace.selectedThreadId!;
    crash();
    await expect(controller.sendChat({
      threadId, text: "should fail", attachmentIds: [], clientUserMessageId: "client-1",
    })).rejects.toMatchObject({ code: "BRIDGE_MODEL_MISMATCH" });
  });

  it("continues the authoritative Codex thread without starting or replaying a turn", async () => {
    const { controller, manager } = await fixture();
    const threadId = (await createRealThread(controller)).workspace.selectedThreadId!;
    manager.emit("turn/completed", { thread: { id: threadId }, turn: { id: "turn-1", status: "completed" } });
    manager.request.mockClear();

    const resumed = await controller.continueWork(threadId);

    expect(resumed.workspace.selectedThreadId).toBe(threadId);
    expect(manager.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(true);
    expect(manager.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("removes a pending image before send through main-process-owned attachment state", async () => {
    const attachment = { id: "image-1", name: "pixel.png", sizeBytes: 12, mimeType: "image/png" as const };
    const attachmentService = {
      addImage: vi.fn(async () => attachment),
      remove: vi.fn(),
      clear: vi.fn(),
      resolve: vi.fn(() => []),
    } as unknown as AttachmentService;
    const { controller } = await fixture(attachmentService);

    await expect(controller.chooseImage()).resolves.toEqual(attachment);
    expect(controller.getState().workspace.pendingAttachment).toEqual(attachment);
    const next = await controller.removePendingAttachment();

    expect(attachmentService.remove).toHaveBeenCalledWith([attachment.id]);
    expect(next.workspace.pendingAttachment).toBeUndefined();
  });

  it("keeps local history when the credential is removed", async () => {
    const { controller } = await fixture();
    const threadId = (await createRealThread(controller)).workspace.selectedThreadId!;

    const cleared = await controller.clearCredential();

    expect(cleared.stage).toBe("NEEDS_API_KEY");
    expect(cleared.history.some((record) => record.threadId === threadId)).toBe(true);
  });

  it("archives a history record through Codex and then hides it locally", async () => {
    const { controller, manager } = await fixture();
    const threadId = (await createRealThread(controller, "archive me")).workspace.selectedThreadId!;
    manager.emit("turn/completed", { thread: { id: threadId }, turn: { id: "turn-1", status: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    manager.request.mockClear();

    const archived = await controller.archiveHistory({ threadId, archived: true });

    expect(manager.request.mock.calls).toContainEqual(["thread/archive", { threadId }]);
    expect(archived.history.find((record) => record.threadId === threadId)?.archived).toBe(true);
    expect(archived.workspace.selectedThreadId).toBeUndefined();
    expect(archived.workspace.threads.some((thread) => thread.id === threadId)).toBe(false);
  });
});
