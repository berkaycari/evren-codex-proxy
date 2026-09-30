import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialService, SecurePersistenceUnavailableError, type CredentialEncryption } from "../src/desktop/main/credential-service.js";
import { buildCodexChildEnvironment, buildCodexLaunchSpec, LOCAL_BRIDGE_TOKEN_ENV } from "../src/desktop/main/codex-launch.js";
import { detectCodex, parseCodexVersion } from "../src/desktop/main/codex-version.js";
import { DesktopSettingsStore, parseDesktopSettings } from "../src/desktop/main/settings-service.js";
import { isAllowedRendererUrl } from "../src/desktop/main/window-security.js";
import { generateLocalBridgeToken, LOCAL_BRIDGE_TOKEN_BYTES } from "../src/runtime/local-auth.js";
import {
  validateApiKeyTestInput,
  validateApprovalResponseInput,
  validateChatInterruptInput,
  validateChatSendInput,
  validateCredentialInput,
  validateDesktopSettingsUpdateInput,
  validateModelSelectionInput,
  validateProjectPathInput,
  validateThreadInput,
} from "../src/desktop/shared/contracts.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeEncryption implements CredentialEncryption {
  constructor(private readonly available = true) {}
  isAvailable(): boolean { return this.available; }
  encrypt(value: string): Buffer { return Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`); }
  decrypt(value: Buffer): string { return Buffer.from(value.toString().slice("encrypted:".length), "base64").toString(); }
}

async function tempPath(file: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-desktop-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, file);
}

describe("desktop credential service", () => {
  it("keeps session credentials only in memory", async () => {
    const file = await tempPath("credentials.json");
    const service = new CredentialService(file, new FakeEncryption());
    await service.setCredential("session-secret", "session");
    expect(await service.getStatus()).toMatchObject({ exists: true, persistence: "session" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.withCredential(async (value) => value)).resolves.toBe("session-secret");
  });

  it("persists encrypted ciphertext without plaintext", async () => {
    const file = await tempPath("credentials.json");
    const service = new CredentialService(file, new FakeEncryption());
    await service.setCredential("plain-secret-value", "secure");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("plain-secret-value");
    expect(await service.getStatus()).toMatchObject({ exists: true, persistence: "secure" });
    await expect(service.withCredential(async (value) => value)).resolves.toBe("plain-secret-value");
  });

  it("never returns a raw key from status", async () => {
    const service = new CredentialService(await tempPath("credentials.json"), new FakeEncryption());
    await service.setCredential("do-not-return", "session");
    expect(JSON.stringify(await service.getStatus())).not.toContain("do-not-return");
  });

  it("has no plaintext persistence fallback", async () => {
    const file = await tempPath("credentials.json");
    const service = new CredentialService(file, new FakeEncryption(false));
    await expect(service.setCredential("secret", "secure")).rejects.toBeInstanceOf(SecurePersistenceUnavailableError);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears session and persisted credentials", async () => {
    const file = await tempPath("credentials.json");
    const service = new CredentialService(file, new FakeEncryption());
    await service.setCredential("secret", "secure");
    await service.clearCredential();
    expect(await service.getStatus()).toMatchObject({ exists: false, persistence: "none" });
  });

  it("treats a corrupt credential file as unavailable without exposing its contents", async () => {
    const file = await tempPath("credentials.json");
    await writeFile(file, "not-json", "utf8");
    const service = new CredentialService(file, new FakeEncryption());

    await expect(service.getStatus()).resolves.toMatchObject({ exists: false, persistence: "none" });
    await expect(service.withCredential(async () => undefined)).rejects.toMatchObject({
      code: "credential_unavailable",
    });
  });
});

describe("desktop settings", () => {
  it("validates supported settings and ignores secrets", () => {
    expect(parseDesktopSettings({ selectedModelId: "chat", theme: "light", apiKey: "secret", windowBounds: { width: 1000, height: 700 } })).toEqual({
      selectedModelId: "chat",
      theme: "light",
      windowBounds: { width: 1000, height: 700 },
    });
    expect(parseDesktopSettings({ theme: "system" })).toEqual({});
  });

  it("falls back safely for corrupted settings", async () => {
    const file = await tempPath("settings.json");
    await writeFile(file, "not-json", "utf8");
    await expect(new DesktopSettingsStore(file).load()).resolves.toEqual({});
  });

  it("accepts only explicit product themes over the narrow settings IPC", () => {
    expect(validateDesktopSettingsUpdateInput({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(validateDesktopSettingsUpdateInput({ theme: "light" })).toEqual({ theme: "light" });
    expect(validateDesktopSettingsUpdateInput({ theme: "navy" })).toEqual({ theme: "navy" });
    expect(() => validateDesktopSettingsUpdateInput({ theme: "system" })).toThrow("invalid_settings_update");
    expect(() => validateDesktopSettingsUpdateInput({ theme: "navy", rawCss: "*{}" })).toThrow("invalid_settings_update");
  });

  it("writes atomically without leaving temporary files", async () => {
    const file = await tempPath("settings.json");
    const store = new DesktopSettingsStore(file);
    await store.save({ selectedModelId: "auto", windowBounds: { x: 10, y: 20, width: 1100, height: 700 } });
    await expect(store.load()).resolves.toEqual({ selectedModelId: "auto", windowBounds: { x: 10, y: 20, width: 1100, height: 700 } });
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("Codex detection and launch security", () => {
  it("parses the tested Codex version", () => {
    expect(parseCodexVersion("codex-cli 0.157.1")).toMatchObject({ version: "0.157.1", compatibility: "tested" });
  });

  it("marks newer, older, and malformed versions", () => {
    expect(parseCodexVersion("codex-cli 0.158.0").compatibility).toBe("newer-unverified");
    expect(parseCodexVersion("codex-cli 0.156.9").compatibility).toBe("older");
    expect(parseCodexVersion("unexpected").compatibility).toBe("unknown");
  });

  it("reports a missing Codex executable", async () => {
    const result = await detectCodex("missing", async () => { throw new Error("ENOENT"); });
    expect(result).toMatchObject({ found: false, compatibility: "unavailable", ready: false });
  });

  it("builds per-process stdio provider overrides without a profile or config write", () => {
    const spec = buildCodexLaunchSpec({
      cwd: "C:\\workspace",
      host: "127.0.0.1",
      port: 45678,
      model: "chat-model",
      localBridgeToken: "x".repeat(43),
      baseEnv: { PATH: "safe", EVREN_API_KEY: "must-not-pass" },
    });
    expect(spec.args).toContain("stdio://");
    expect(spec.args.join(" ")).toContain('model_provider="evren-desktop"');
    expect(spec.args.join(" ")).toContain('wire_api="responses"');
    expect(spec.args.join(" ")).toContain(`env_key="${LOCAL_BRIDGE_TOKEN_ENV}"`);
    expect(spec.args).not.toContain("--profile");
    expect(spec.env.EVREN_API_KEY).toBeUndefined();
    expect(spec.env[LOCAL_BRIDGE_TOKEN_ENV]).toBe("x".repeat(43));
  });

  it("removes credential-like variables from the Codex child environment", () => {
    const env = buildCodexChildEnvironment({ PATH: "safe", OPENAI_API_KEY: "a", SOME_TOKEN: "b", ORDINARY: "c" }, "z".repeat(43));
    expect(env).toEqual({ PATH: "safe", ORDINARY: "c", [LOCAL_BRIDGE_TOKEN_ENV]: "z".repeat(43) });
  });

  it("generates at least 256-bit per-launch local tokens", () => {
    const first = generateLocalBridgeToken();
    const second = generateLocalBridgeToken();
    expect(Buffer.from(first, "base64url")).toHaveLength(LOCAL_BRIDGE_TOKEN_BYTES);
    expect(first).not.toBe(second);
  });
});

describe("desktop boundary validation", () => {
  it("rejects unexpected credential fields", () => {
    expect(() => validateCredentialInput({ apiKey: "x", persistence: "session", extra: true })).toThrow();
    expect(() => validateApiKeyTestInput({ apiKey: "x", extra: true })).toThrow();
  });

  it("rejects invalid model selection fields", () => {
    expect(() => validateModelSelectionInput({ modelId: "" })).toThrow();
    expect(() => validateModelSelectionInput({ modelId: "chat", path: "C:\\" })).toThrow();
  });

  it("validates exact Phase 2 IPC inputs and rejects authority expansion", () => {
    expect(validateProjectPathInput({ path: "C:\\work" })).toEqual({ path: "C:\\work" });
    expect(validateThreadInput({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(validateChatSendInput({
      threadId: "thread-1", text: "hello", attachmentIds: [], clientUserMessageId: "client-1",
    })).toMatchObject({ text: "hello" });
    expect(validateChatInterruptInput({ threadId: "thread-1", turnId: "turn-1" })).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(validateApprovalResponseInput({ approvalId: "a1", threadId: "thread-1", decision: "accept" }))
      .toEqual({ approvalId: "a1", threadId: "thread-1", decision: "accept" });
    expect(() => validateChatSendInput({
      threadId: "thread-1", text: "", attachmentIds: [], clientUserMessageId: "client-1",
    })).toThrow("empty_chat_input");
    expect(() => validateApprovalResponseInput({ approvalId: "a1", threadId: "thread-1", decision: "allowEverything" }))
      .toThrow("invalid_approval_decision");
    expect(() => validateThreadInput({ threadId: "thread-1", rawJsonRpc: true })).toThrow("invalid_thread_input");
  });

  it("allows only the exact local renderer URL", () => {
    const allowed = "file:///C:/app/index.html";
    expect(isAllowedRendererUrl("file:///C:/app/index.html", allowed)).toBe(true);
    expect(isAllowedRendererUrl("https://example.com", allowed)).toBe(false);
    expect(isAllowedRendererUrl("file:///C:/other.html", allowed)).toBe(false);
  });

  it("keeps the preload surface narrow and excludes Node authority", async () => {
    const source = await readFile(new URL("../src/desktop/preload/index.ts", import.meta.url), "utf8");
    expect(source).toContain('contextBridge.exposeInMainWorld("evrenDesktop", desktopApi)');
    expect(source).not.toMatch(/from\s+["']node:(?:fs|child_process)["']/);
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("shell.");
    expect(source).not.toContain("ipcRenderer: ipcRenderer");
  });

  it("uses hardened BrowserWindow and navigation policies", async () => {
    const [main, security] = await Promise.all([
      readFile(new URL("../src/desktop/main/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/desktop/main/window-security.ts", import.meta.url), "utf8"),
    ]);
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webSecurity: true");
    expect(main).not.toContain("unsafe-eval");
    expect(security).toContain('"will-navigate"');
    expect(security).toContain('action: "deny"');
  });
});
