import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { displayDiff, displayFilePath, displayProjectLocation, projectNameFromPath } from "../src/desktop/shared/display-path.js";
import { resolveCodexRuntime } from "../src/desktop/main/runtime-resolver.js";
import { buildCodexChildEnvironment } from "../src/desktop/main/codex-launch.js";

describe("Phase 3 path presentation", () => {
  it("shows the project name instead of an absolute root", () => expect(projectNameFromPath("C:\\Users\\Berkay\\smoke-test")).toBe("smoke-test"));
  it("labels the exact command cwd as Project root", () => expect(displayProjectLocation("C:\\work\\app", "C:\\work\\app")).toBe("Project root"));
  it("shows nested cwd and files as project-relative", () => {
    expect(displayProjectLocation("C:\\work\\app\\src", "C:\\work\\app")).toBe("src");
    expect(displayFilePath("C:\\work\\app\\src\\App.tsx", "C:\\work\\app")).toBe("src/App.tsx");
  });
  it("uses a friendly basename for external paths", () => expect(displayFilePath("D:\\other\\file.txt", "C:\\work\\app")).toBe("file.txt"));
  it("renders activity diffs relatively without mutating the input", () => {
    const source = "--- C:\\work\\app\\src\\App.tsx";
    expect(displayDiff(source, "C:\\work\\app")).toBe("--- .\\src\\App.tsx");
    expect(source).toContain("C:\\work\\app");
  });
});

describe("Phase 3 production runtime policy", () => {
  it("uses the system runtime only in development", async () => {
    const detect = vi.fn(async () => ({ found: true, ready: false, version: "0.157.1", testedVersion: "0.157.1" as const, compatibility: "tested" as const }));
    const result = await resolveCodexRuntime({ packaged: false, resourcesPath: "C:\\resources", userDataDir: "C:\\data", platform: "win32", arch: "x64", developmentExecutable: "dev-codex.exe", detect });
    expect(result).toMatchObject({ executable: "dev-codex.exe", source: "system" });
  });
  it("fails safely on unsupported production platforms", async () => {
    const result = await resolveCodexRuntime({ packaged: true, resourcesPath: "/resources", userDataDir: "/data", platform: "linux", arch: "x64" });
    expect(result).toMatchObject({ source: "unavailable", status: { found: false } });
  });
  it("uses an atomically activated EVREN-verified runtime before the bundled fallback", async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "evren-verified-runtime-"));
    try {
      const executable = path.join(userDataDir, "runtimes", "current", "bin", "codex.exe");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "fixture");
      await writeFile(path.join(userDataDir, "runtimes", "active.json"), JSON.stringify({ schemaVersion: 1, version: "0.158.0", executable: "current/bin/codex.exe" }));
      const detect = vi.fn(async () => ({ found: true, ready: false, version: "0.158.0", testedVersion: "0.157.1" as const, compatibility: "newer-unverified" as const }));
      const result = await resolveCodexRuntime({ packaged: true, resourcesPath: "C:\\missing", userDataDir, platform: "win32", arch: "x64", detect });
      expect(result).toMatchObject({ executable, source: "verified-update", status: { version: "0.158.0", compatibility: "tested" } });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
  it("strips EVREN, OpenAI and authorization secrets from the Codex environment", () => {
    const env = buildCodexChildEnvironment({ EVREN_API_KEY: "secret", OPENAI_API_KEY: "secret", Authorization: "secret", SAFE: "ok" }, "x".repeat(40));
    expect(env).toMatchObject({ SAFE: "ok", EVREN_DESKTOP_BRIDGE_TOKEN: "x".repeat(40) });
    expect(env.EVREN_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.Authorization).toBeUndefined();
  });
});
