import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimeUpdateIdle, atomicRuntimeSwap, parseVerifiedRuntimeManifest, RuntimeUpdateService, validateArchiveEntries, verifyFileSha256 } from "../src/desktop/main/runtime-update.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function manifest(overrides: Record<string, unknown> = {}) {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    codexVersion: "0.157.1",
    platform: "win32",
    arch: "x64",
    url: "https://github.com/openai/codex/releases/download/rust-v0.157.1/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: digest,
    minimumDesktopVersion: "1.3.0",
    files: ["codex-package.json", "bin/codex.exe", "bin/codex-code-mode-host.exe", "codex-path/rg.exe", "codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"].map((entry) => ({ path: entry, sha256: digest })),
    ...overrides,
  };
}

describe("Phase 3 verified runtime updates", () => {
  it("accepts a complete trusted Windows x64 manifest", () => expect(parseVerifiedRuntimeManifest(manifest(), "1.3.0").codexVersion).toBe("0.157.1"));
  it("rejects an invalid schema", () => expect(() => parseVerifiedRuntimeManifest(manifest({ schemaVersion: 2 }), "1.3.0")).toThrow("RUNTIME_MANIFEST_INVALID"));
  it("rejects an unexpected platform", () => expect(() => parseVerifiedRuntimeManifest(manifest({ platform: "linux" }), "1.3.0")).toThrow("RUNTIME_MANIFEST_INVALID"));
  it("rejects an unexpected architecture", () => expect(() => parseVerifiedRuntimeManifest(manifest({ arch: "arm64" }), "1.3.0")).toThrow("RUNTIME_MANIFEST_INVALID"));
  it("rejects arbitrary download hosts and insecure URLs", () => expect(() => parseVerifiedRuntimeManifest(manifest({ url: "http://evil.invalid/runtime.zip" }), "1.3.0")).toThrow("RUNTIME_MANIFEST_INVALID"));
  it("rejects an incompatible Desktop version", () => expect(() => parseVerifiedRuntimeManifest(manifest({ minimumDesktopVersion: "2.0.0" }), "1.3.0")).toThrow("RUNTIME_DESKTOP_INCOMPATIBLE"));
  it("rejects incomplete runtime payloads", () => expect(() => parseVerifiedRuntimeManifest(manifest({ files: [{ path: "bin/codex.exe", sha256: "a".repeat(64) }] }), "1.3.0")).toThrow("RUNTIME_MANIFEST_INCOMPLETE"));
  it("rejects archive traversal and absolute paths", () => {
    expect(() => validateArchiveEntries(["../codex.exe"])).toThrow("RUNTIME_ARCHIVE_TRAVERSAL");
    expect(() => validateArchiveEntries(["C:\\codex.exe"])).toThrow("RUNTIME_ARCHIVE_TRAVERSAL");
  });
  it("accepts normalized safe archive entries", () => expect(validateArchiveEntries(["bin/codex.exe", "codex-path/rg.exe"])).toEqual(["bin/codex.exe", "codex-path/rg.exe"]));
  it("detects SHA-256 mismatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-hash-")); directories.push(directory);
    const file = path.join(directory, "runtime.bin"); await writeFile(file, "runtime", "utf8");
    await expect(verifyFileSha256(file, "0".repeat(64))).rejects.toThrow("RUNTIME_HASH_MISMATCH");
  });
  it("allows a valid SHA-256 and expected size", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-hash-")); directories.push(directory);
    const file = path.join(directory, "runtime.bin"); await writeFile(file, "runtime", "utf8");
    await expect(verifyFileSha256(file, "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23", 7)).resolves.toBeUndefined();
  });
  it("atomically swaps a staged runtime while retaining the known-good backup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-swap-")); directories.push(directory);
    const target = path.join(directory, "current"); const staged = path.join(directory, "staged"); const backup = path.join(directory, "backup");
    await Promise.all([writeFile(path.join(directory, "placeholder"), "x"), mkdir(target), mkdir(staged)]);
    await writeFile(path.join(target, "version"), "old"); await writeFile(path.join(staged, "version"), "new");
    await atomicRuntimeSwap({ stagedDir: staged, targetDir: target, backupDir: backup });
    expect(await readFile(path.join(target, "version"), "utf8")).toBe("new");
    expect(await readFile(path.join(backup, "version"), "utf8")).toBe("old");
  });
  it("rolls the known-good runtime back when the staged swap fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-rollback-")); directories.push(directory);
    const target = path.join(directory, "current"); const staged = path.join(directory, "missing-staged"); const backup = path.join(directory, "backup");
    await mkdir(target); await writeFile(path.join(target, "version"), "old");
    await expect(atomicRuntimeSwap({ stagedDir: staged, targetDir: target, backupDir: backup })).rejects.toThrow();
    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  });
  it("blocks runtime replacement while a turn is active", () => {
    expect(() => assertRuntimeUpdateIdle(true)).toThrow("RUNTIME_UPDATE_BLOCKED_ACTIVE_TURN");
    expect(() => assertRuntimeUpdateIdle(false)).not.toThrow();
  });
  it("does not offer a verified manifest that would downgrade the installed runtime", async () => {
    const service = new RuntimeUpdateService({
      userDataDir: os.tmpdir(),
      desktopVersion: "1.3.0",
      fetchManifest: async () => manifest({ codexVersion: "0.156.0" }),
    });
    await expect(service.check("0.157.1")).resolves.toMatchObject({ status: "up_to_date", installedVersion: "0.157.1", verifiedVersion: "0.156.0" });
    await expect(service.install("0.157.1")).rejects.toThrow("RUNTIME_UPDATE_NOT_AVAILABLE");
  });
  it("treats a missing published manifest as a neutral source state and preserves the installed runtime", async () => {
    const service = new RuntimeUpdateService({
      userDataDir: os.tmpdir(),
      desktopVersion: "2.0.0-rc.1",
      fetchManifest: async () => { throw new Error("RUNTIME_MANIFEST_HTTP_404"); },
    });
    await expect(service.check("0.157.1")).resolves.toEqual({
      status: "source_unavailable",
      installedVersion: "0.157.1",
      error: "RUNTIME_MANIFEST_HTTP_404",
    });
    await expect(service.install("0.157.1")).rejects.toThrow("RUNTIME_UPDATE_NOT_AVAILABLE");
    expect(service.snapshot().installedVersion).toBe("0.157.1");
  });
  it("validates a staged runtime before atomically activating it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-service-")); directories.push(directory);
    const fixture = runtimeFixture("0.158.0");
    let validated = false;
    const service = new RuntimeUpdateService({
      userDataDir: directory,
      desktopVersion: "1.3.0",
      fetchManifest: async () => fixture.manifest,
      downloadArchive: async (_url, destination) => writeFile(destination, fixture.archive),
      extractArchive: async (_archive, destination) => writeRuntimeFixture(destination, fixture.files),
      validateRuntime: async (executable, version) => {
        expect(executable).toBe(path.join(directory, "runtimes", path.basename(path.dirname(path.dirname(executable))), "bin", "codex.exe"));
        expect(version).toBe("0.158.0");
        validated = true;
      },
    });
    await expect(service.check("0.157.1")).resolves.toMatchObject({ status: "update_available", verifiedVersion: "0.158.0" });
    await expect(service.install("0.157.1")).resolves.toMatchObject({ status: "restart_required", installedVersion: "0.158.0" });
    expect(validated).toBe(true);
    expect(JSON.parse(await readFile(path.join(directory, "runtimes", "active.json"), "utf8"))).toEqual({ schemaVersion: 1, version: "0.158.0", executable: "current/bin/codex.exe" });
    expect(await readFile(path.join(directory, "runtimes", "current", "bin", "codex.exe"), "utf8")).toBe(fixture.files["bin/codex.exe"]);
  });
  it("keeps the working runtime untouched when staged runtime validation fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-service-fail-")); directories.push(directory);
    const current = path.join(directory, "runtimes", "current");
    await mkdir(current, { recursive: true }); await writeFile(path.join(current, "known-good"), "old");
    const fixture = runtimeFixture("0.158.0");
    const service = new RuntimeUpdateService({
      userDataDir: directory,
      desktopVersion: "1.3.0",
      fetchManifest: async () => fixture.manifest,
      downloadArchive: async (_url, destination) => writeFile(destination, fixture.archive),
      extractArchive: async (_archive, destination) => writeRuntimeFixture(destination, fixture.files),
      validateRuntime: async () => { throw new Error("validation rejected"); },
    });
    await service.check("0.157.1");
    await expect(service.install("0.157.1")).rejects.toThrow("validation rejected");
    expect(await readFile(path.join(current, "known-good"), "utf8")).toBe("old");
    expect(service.snapshot()).toMatchObject({ status: "error", error: "RUNTIME_UPDATE_FAILED" });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFixture(version: string) {
  const files: Record<string, string> = {
    "codex-package.json": JSON.stringify({ version }),
    "bin/codex.exe": `codex-${version}`,
    "bin/codex-code-mode-host.exe": "host",
    "codex-path/rg.exe": "rg",
    "codex-resources/codex-command-runner.exe": "runner",
    "codex-resources/codex-windows-sandbox-setup.exe": "sandbox",
  };
  const archive = "fixture-archive";
  return {
    archive,
    files,
    manifest: manifest({
      codexVersion: version,
      sha256: sha256(archive),
      sizeBytes: Buffer.byteLength(archive),
      files: Object.entries(files).map(([filePath, contents]) => ({ path: filePath, sha256: sha256(contents) })),
    }),
  };
}

async function writeRuntimeFixture(destination: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, contents] of Object.entries(files)) {
    const target = path.join(destination, ...filePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
