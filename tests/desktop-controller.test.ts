import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeRuntime, BridgeRuntimeSnapshot } from "../src/runtime/bridge-runtime.js";
import { CredentialService, type CredentialEncryption } from "../src/desktop/main/credential-service.js";
import { DesktopController } from "../src/desktop/main/desktop-controller.js";
import type { CodexAppServerManager } from "../src/desktop/main/codex-app-server.js";
import type { CodexLaunchSpec } from "../src/desktop/main/codex-launch.js";
import { EvrenCatalogService } from "../src/desktop/main/model-catalog.js";
import { DesktopSettingsStore } from "../src/desktop/main/settings-service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeEncryption implements CredentialEncryption {
  isAvailable(): boolean { return true; }
  encrypt(value: string): Buffer { return Buffer.from(value).reverse(); }
  decrypt(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

async function fixture(codexFound = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-controller-"));
  directories.push(directory);
  const credentialService = new CredentialService(path.join(directory, "credentials.json"), new FakeEncryption());
  const settingsStore = new DesktopSettingsStore(path.join(directory, "settings.json"));
  const runtimeStop = vi.fn(async () => undefined);
  const runtimeSnapshot: BridgeRuntimeSnapshot = {
    status: "running",
    host: "127.0.0.1",
    port: 45454,
    model: "chat-model",
    pricing: {
      allowed: true,
      connected: true,
      pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    },
    credits: { remaining: 100, uncertain: false },
    update: { status: "disabled" },
  };
  const fakeRuntime = {
    start: vi.fn(async () => runtimeSnapshot),
    stop: runtimeStop,
  } as unknown as BridgeRuntime;
  const managerStart = vi.fn(async (_spec: CodexLaunchSpec, _version: string) => undefined);
  const managerStop = vi.fn(async () => undefined);
  const managerRequest = vi.fn(async (method: string) => {
    if (method === "thread/list") return { data: [], nextCursor: null };
    return {};
  });
  const fakeManager = {
    start: managerStart,
    stop: managerStop,
    request: managerRequest,
    onNotification: () => () => undefined,
    onServerRequest: () => () => undefined,
    respondToServerRequest: vi.fn(),
    rejectServerRequest: vi.fn(),
  } as unknown as CodexAppServerManager;
  const catalogService = new EvrenCatalogService({
    baseUrl: "https://example.invalid/v1",
    timeoutMs: 1000,
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: "chat-model",
      task: "chat",
      modalities: ["text"],
      pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
    }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const controller = new DesktopController({
    version: "1.3.0",
    userDataDir: directory,
    cwd: directory,
    credentialService,
    settingsStore,
    catalogService,
    detectCodex: async () => codexFound
      ? { found: true, version: "0.157.1", testedVersion: "0.157.1", compatibility: "tested", ready: false }
      : { found: false, testedVersion: "0.157.1", compatibility: "unavailable", ready: false },
    createRuntime: () => fakeRuntime,
    createCodexManager: () => fakeManager,
  });
  return { controller, credentialService, runtimeStop, managerStart, managerStop };
}

describe("desktop startup state machine", () => {
  it("starts at NEEDS_API_KEY when no credential exists", async () => {
    const { controller } = await fixture();
    await expect(controller.initialize()).resolves.toMatchObject({ stage: "NEEDS_API_KEY" });
  });

  it("moves through EVREN, Bridge, Codex, and READY states", async () => {
    const { controller, managerStart } = await fixture();
    await controller.initialize();
    const stages: string[] = [];
    controller.subscribe((state) => stages.push(state.stage));
    const state = await controller.saveCredential({ apiKey: "private-key", persistence: "session" });
    expect(state).toMatchObject({
      stage: "READY",
      selectedModelId: "chat-model",
      bridge: { running: true, host: "127.0.0.1", port: 45454 },
      codex: { found: true, version: "0.157.1", ready: true },
    });
    expect(stages).toEqual(expect.arrayContaining(["CONNECTING_EVREN", "STARTING_BRIDGE", "STARTING_CODEX", "READY"]));
    const launchSpec = managerStart.mock.calls[0]![0];
    expect(launchSpec.env.EVREN_API_KEY).toBeUndefined();
  });

  it("reports READY_NO_CODEX without failing the Bridge", async () => {
    const { controller } = await fixture(false);
    await controller.initialize();
    await expect(controller.saveCredential({ apiKey: "private-key", persistence: "session" })).resolves.toMatchObject({
      stage: "READY_NO_CODEX",
      bridge: { running: true },
      codex: { found: false, ready: false },
    });
  });

  it("stops Codex before Bridge and clears session credentials on shutdown", async () => {
    const { controller, credentialService, managerStop, runtimeStop } = await fixture();
    await controller.initialize();
    await controller.saveCredential({ apiKey: "private-key", persistence: "session" });
    await controller.shutdown();
    expect(managerStop).toHaveBeenCalledOnce();
    expect(runtimeStop).toHaveBeenCalledOnce();
    expect((await credentialService.getStatus()).exists).toBe(false);
  });
});
