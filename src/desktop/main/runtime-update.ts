import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateLocalBridgeToken } from "../../runtime/local-auth.js";
import { CodexAppServerManager } from "./codex-app-server.js";
import { buildCodexLaunchSpec } from "./codex-launch.js";
import { detectCodex } from "./codex-version.js";

export interface VerifiedRuntimeManifest {
  schemaVersion: 1;
  codexVersion: string;
  platform: "win32";
  arch: "x64";
  url: string;
  sha256: string;
  sizeBytes?: number;
  minimumDesktopVersion: string;
  upstreamVersion?: string;
  files: Array<{ path: string; sha256: string }>;
}

export type RuntimeUpdateStatus =
  | "not_checked"
  | "checking"
  | "up_to_date"
  | "update_available"
  | "downloading"
  | "validating"
  | "installing"
  | "restart_required"
  | "offline"
  | "not_configured"
  | "source_unavailable"
  | "blocked_active_turn"
  | "error";

export interface RuntimeUpdateSnapshot {
  status: RuntimeUpdateStatus;
  installedVersion?: string;
  verifiedVersion?: string;
  upstreamVersion?: string;
  error?: string;
}

export interface RuntimeUpdateServiceOptions {
  userDataDir: string;
  desktopVersion: string;
  manifestUrl?: string;
  fetchManifest?: (url: string) => Promise<unknown>;
  downloadArchive?: (url: string, destination: string, expectedSize?: number) => Promise<void>;
  extractArchive?: (archive: string, destination: string) => Promise<void>;
  validateRuntime?: (executable: string, expectedVersion: string, cwd: string) => Promise<void>;
}

export const VERIFIED_RUNTIME_MANIFEST_URL =
  "https://github.com/berkaycari/evren-codex-proxy/releases/latest/download/codex-runtime-manifest.json";

const TRUSTED_DOWNLOAD_PREFIXES = [
  "https://github.com/openai/codex/releases/download/",
  "https://releases.openai.com/codex/",
  "https://github.com/berkaycari/evren-codex-proxy/releases/download/",
] as const;

const TRUSTED_REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com"]);
const REQUIRED_RUNTIME_FILES = [
  "codex-package.json",
  "bin/codex.exe",
  "bin/codex-code-mode-host.exe",
  "codex-path/rg.exe",
  "codex-resources/codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe",
] as const;

const execFileAsync = promisify(execFile);

export class RuntimeUpdateService {
  private state: RuntimeUpdateSnapshot = { status: "not_checked" };
  private available: VerifiedRuntimeManifest | undefined;

  constructor(private readonly options: RuntimeUpdateServiceOptions) {}

  snapshot(): RuntimeUpdateSnapshot {
    return { ...this.state };
  }

  markActivated(version: string): RuntimeUpdateSnapshot {
    this.state = { status: "up_to_date", installedVersion: version, verifiedVersion: version };
    return this.snapshot();
  }

  async check(installedVersion?: string): Promise<RuntimeUpdateSnapshot> {
    this.state = { status: "checking", ...(installedVersion ? { installedVersion } : {}) };
    try {
      const raw = await (this.options.fetchManifest ?? fetchVerifiedManifest)(
        this.options.manifestUrl ?? VERIFIED_RUNTIME_MANIFEST_URL,
      );
      const manifest = parseVerifiedRuntimeManifest(raw, this.options.desktopVersion);
      this.available = manifest;
      const updateAvailable = !installedVersion || compareSemver(manifest.codexVersion, installedVersion) > 0;
      this.state = {
        status: updateAvailable ? "update_available" : "up_to_date",
        ...(installedVersion ? { installedVersion } : {}),
        verifiedVersion: manifest.codexVersion,
        ...(manifest.upstreamVersion ? { upstreamVersion: manifest.upstreamVersion } : {}),
      };
    } catch (error) {
      this.available = undefined;
      const sourceUnavailable = isMissingManifest(error);
      this.state = {
        status: sourceUnavailable ? "source_unavailable" : isNetworkError(error) ? "offline" : "error",
        ...(installedVersion ? { installedVersion } : {}),
        error: safeUpdateError(error),
      };
    }
    return this.snapshot();
  }

  async install(installedVersion?: string): Promise<RuntimeUpdateSnapshot> {
    const manifest = this.available;
    if (!manifest || this.state.status !== "update_available") throw manifestError("RUNTIME_UPDATE_NOT_AVAILABLE");
    if (installedVersion && compareSemver(manifest.codexVersion, installedVersion) <= 0) {
      throw manifestError("RUNTIME_DOWNGRADE_BLOCKED");
    }

    const runtimesRoot = path.join(this.options.userDataDir, "runtimes");
    const stagedDir = path.join(runtimesRoot, `.staged-${randomUUID()}`);
    const downloadDir = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-update-"));
    const archive = path.join(downloadDir, "runtime.tar.gz");
    try {
      await mkdir(runtimesRoot, { recursive: true, mode: 0o700 });
      this.state = updateState("downloading", installedVersion, manifest);
      await (this.options.downloadArchive ?? downloadRuntimeArchive)(manifest.url, archive, manifest.sizeBytes);
      await verifyFileSha256(archive, manifest.sha256, manifest.sizeBytes);

      this.state = updateState("validating", installedVersion, manifest);
      await mkdir(stagedDir, { recursive: false, mode: 0o700 });
      await (this.options.extractArchive ?? extractRuntimeArchive)(archive, stagedDir);
      await verifyRuntimeFiles(stagedDir, manifest);
      const executable = path.join(stagedDir, "bin", "codex.exe");
      await (this.options.validateRuntime ?? validateRuntimeExecutable)(executable, manifest.codexVersion, stagedDir);

      this.state = updateState("installing", installedVersion, manifest);
      const targetDir = path.join(runtimesRoot, "current");
      const backupDir = path.join(runtimesRoot, "backup");
      const previousPointer = await readFile(path.join(runtimesRoot, "active.json")).catch(() => undefined);
      await atomicRuntimeSwap({ stagedDir, targetDir, backupDir });
      try {
        await writeActiveRuntimePointer(runtimesRoot, manifest.codexVersion);
      } catch (error) {
        await rollbackRuntimeSwap({ targetDir, backupDir });
        if (previousPointer) await writeAtomic(path.join(runtimesRoot, "active.json"), previousPointer);
        throw error;
      }
      this.state = updateState("restart_required", manifest.codexVersion, manifest);
      this.available = undefined;
      return this.snapshot();
    } catch (error) {
      this.state = {
        ...updateState("error", installedVersion, manifest),
        error: safeUpdateError(error),
      };
      throw error;
    } finally {
      await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function assertRuntimeUpdateIdle(active: boolean): void {
  if (active) throw manifestError("RUNTIME_UPDATE_BLOCKED_ACTIVE_TURN");
}

export function parseVerifiedRuntimeManifest(value: unknown, desktopVersion: string): VerifiedRuntimeManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.platform !== "win32" || value.arch !== "x64") {
    throw manifestError("RUNTIME_MANIFEST_INVALID");
  }
  const codexVersion = semver(value.codexVersion);
  const minimumDesktopVersion = semver(value.minimumDesktopVersion);
  const upstreamVersion = value.upstreamVersion === undefined ? undefined : semver(value.upstreamVersion);
  const url = typeof value.url === "string" ? value.url : "";
  const sha256 = digest(value.sha256);
  if (!codexVersion || !minimumDesktopVersion || value.upstreamVersion !== undefined && !upstreamVersion || !sha256 || !trustedUrl(url)) {
    throw manifestError("RUNTIME_MANIFEST_INVALID");
  }
  if (compareSemver(desktopVersion, minimumDesktopVersion) < 0) throw manifestError("RUNTIME_DESKTOP_INCOMPATIBLE");
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 500) throw manifestError("RUNTIME_MANIFEST_INVALID");
  const seen = new Set<string>();
  const files = value.files.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !safeArchivePath(entry.path)) throw manifestError("RUNTIME_MANIFEST_INVALID");
    const fileSha = digest(entry.sha256);
    if (!fileSha) throw manifestError("RUNTIME_MANIFEST_INVALID");
    const normalized = entry.path.replace(/\\/g, "/");
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw manifestError("RUNTIME_MANIFEST_INVALID");
    seen.add(key);
    return { path: normalized, sha256: fileSha };
  });
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!files.some((entry) => entry.path.toLocaleLowerCase("en-US") === required)) throw manifestError("RUNTIME_MANIFEST_INCOMPLETE");
  }
  const sizeBytes = value.sizeBytes;
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0)) throw manifestError("RUNTIME_MANIFEST_INVALID");
  return {
    schemaVersion: 1,
    codexVersion,
    platform: "win32",
    arch: "x64",
    url,
    sha256,
    ...(sizeBytes === undefined ? {} : { sizeBytes: sizeBytes as number }),
    minimumDesktopVersion,
    ...(upstreamVersion ? { upstreamVersion } : {}),
    files,
  };
}

export async function verifyFileSha256(filePath: string, expected: string, expectedSize?: number): Promise<void> {
  const file = await stat(filePath);
  if (!file.isFile()) throw manifestError("RUNTIME_ARCHIVE_INVALID");
  if (expectedSize !== undefined && file.size !== expectedSize) throw manifestError("RUNTIME_SIZE_MISMATCH");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest("hex") !== expected.toLocaleLowerCase("en-US")) throw manifestError("RUNTIME_HASH_MISMATCH");
}

export function validateArchiveEntries(entries: readonly string[]): string[] {
  if (entries.length === 0 || entries.length > 10_000) throw manifestError("RUNTIME_ARCHIVE_INVALID");
  return entries.map((entry) => {
    const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!safeArchivePath(normalized)) throw manifestError("RUNTIME_ARCHIVE_TRAVERSAL");
    return normalized;
  });
}

export async function atomicRuntimeSwap(options: {
  stagedDir: string;
  targetDir: string;
  backupDir: string;
}): Promise<void> {
  const parent = path.dirname(options.targetDir);
  for (const candidate of [options.stagedDir, options.targetDir, options.backupDir]) {
    if (path.dirname(path.resolve(candidate)) !== path.resolve(parent)) throw manifestError("RUNTIME_SWAP_SCOPE_INVALID");
  }
  await rm(options.backupDir, { recursive: true, force: true });
  let movedOld = false;
  try {
    await rename(options.targetDir, options.backupDir);
    movedOld = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  try {
    await rename(options.stagedDir, options.targetDir);
  } catch (error) {
    if (movedOld) await rename(options.backupDir, options.targetDir).catch(() => undefined);
    throw error;
  }
}

async function fetchVerifiedManifest(url: string): Promise<unknown> {
  if (url !== VERIFIED_RUNTIME_MANIFEST_URL) throw manifestError("RUNTIME_MANIFEST_SOURCE_INVALID");
  const response = await fetch(url, { redirect: "follow", headers: { Accept: "application/json" } });
  if (!response.ok) throw manifestError(`RUNTIME_MANIFEST_HTTP_${response.status}`);
  if (!trustedResponseUrl(response.url, url)) throw manifestError("RUNTIME_MANIFEST_SOURCE_INVALID");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) throw manifestError("RUNTIME_MANIFEST_INVALID");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw manifestError("RUNTIME_MANIFEST_INVALID");
  }
}

async function downloadRuntimeArchive(url: string, destination: string, expectedSize?: number): Promise<void> {
  if (!trustedUrl(url)) throw manifestError("RUNTIME_DOWNLOAD_SOURCE_INVALID");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw manifestError(`RUNTIME_DOWNLOAD_HTTP_${response.status}`);
  if (!trustedResponseUrl(response.url, url)) throw manifestError("RUNTIME_DOWNLOAD_SOURCE_INVALID");
  const maximum = expectedSize ?? 1_500_000_000;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) throw manifestError("RUNTIME_SIZE_MISMATCH");
  const file = await open(destination, "wx", 0o600);
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximum) {
        await reader.cancel();
        throw manifestError("RUNTIME_SIZE_MISMATCH");
      }
      await file.write(value);
    }
  } finally {
    await file.close();
  }
}

async function extractRuntimeArchive(archive: string, destination: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe");
  await access(tar);
  const names = await runTar(tar, ["-tzf", archive]);
  const entries = validateArchiveEntries(names.split(/\r?\n/).filter(Boolean));
  const verbose = (await runTar(tar, ["-tvzf", archive])).split(/\r?\n/).filter(Boolean);
  if (verbose.length !== entries.length || verbose.some((line) => !line.startsWith("-") && !line.startsWith("d"))) {
    throw manifestError("RUNTIME_ARCHIVE_UNSAFE_ENTRY");
  }
  await runTar(tar, ["-xzf", archive, "-C", destination]);
}

async function runTar(executable: string, args: string[]): Promise<string> {
  const result = await execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function verifyRuntimeFiles(root: string, manifest: VerifiedRuntimeManifest): Promise<void> {
  for (const entry of manifest.files) {
    const candidate = path.resolve(root, ...entry.path.split("/"));
    if (!isWithin(root, candidate)) throw manifestError("RUNTIME_ARCHIVE_TRAVERSAL");
    await verifyFileSha256(candidate, entry.sha256);
  }
}

async function validateRuntimeExecutable(executable: string, expectedVersion: string, cwd: string): Promise<void> {
  const status = await detectCodex(executable);
  if (!status.found || status.version !== expectedVersion) throw manifestError("RUNTIME_VERSION_MISMATCH");
  const manager = new CodexAppServerManager({
    shutdownTimeoutMs: 2_000,
    spawn: (spec) => spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  });
  try {
    await manager.start(buildCodexLaunchSpec({
      executable,
      cwd,
      host: "127.0.0.1",
      port: 65_535,
      model: "auto",
      localBridgeToken: generateLocalBridgeToken(),
    }), "runtime-update-validation");
  } catch {
    throw manifestError("RUNTIME_HANDSHAKE_FAILED");
  } finally {
    await manager.stop();
  }
}

async function writeActiveRuntimePointer(runtimesRoot: string, version: string): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    version,
    executable: "current/bin/codex.exe",
  }, null, 2)}\n`, "utf8");
  await writeAtomic(path.join(runtimesRoot, "active.json"), payload);
}

async function writeAtomic(destination: string, payload: Uint8Array): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, payload, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function rollbackRuntimeSwap(options: { targetDir: string; backupDir: string }): Promise<void> {
  const failed = `${options.targetDir}.failed-${randomUUID()}`;
  await rename(options.targetDir, failed).catch(() => undefined);
  try {
    await rename(options.backupDir, options.targetDir);
  } finally {
    await rm(failed, { recursive: true, force: true }).catch(() => undefined);
  }
}

function updateState(status: RuntimeUpdateStatus, installedVersion: string | undefined, manifest: VerifiedRuntimeManifest): RuntimeUpdateSnapshot {
  return {
    status,
    ...(installedVersion ? { installedVersion } : {}),
    verifiedVersion: manifest.codexVersion,
    ...(manifest.upstreamVersion ? { upstreamVersion: manifest.upstreamVersion } : {}),
  };
}

function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TRUSTED_DOWNLOAD_PREFIXES.some((prefix) => value.startsWith(prefix));
  } catch {
    return false;
  }
}

function trustedResponseUrl(responseUrl: string, requestedUrl: string): boolean {
  if (!responseUrl || responseUrl === requestedUrl) return true;
  try {
    const url = new URL(responseUrl);
    return url.protocol === "https:" && TRUSTED_REDIRECT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function safeArchivePath(value: string): boolean {
  if (!value || value.length > 500 || value.includes("\0") || /^[a-zA-Z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  const parts = value.replace(/\\/g, "/").split("/");
  return parts.every((part) => part !== ".." && part !== "" && part !== ".");
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = `${path.resolve(root).toLocaleLowerCase("en-US")}${path.sep}`;
  return candidate.toLocaleLowerCase("en-US").startsWith(normalizedRoot);
}

function digest(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLocaleLowerCase("en-US") : undefined;
}

function semver(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : undefined;
}

function compareSemver(left: string, right: string): number {
  const a = left.split("-")[0]!.split(".").map(Number);
  const b = right.split("-")[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

function safeUpdateError(error: unknown): string {
  if (error instanceof Error && /^RUNTIME_[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "RUNTIME_UPDATE_FAILED";
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || isNodeError(error) && ["ENETUNREACH", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(error.code ?? "");
}

function isMissingManifest(error: unknown): boolean {
  return error instanceof Error && error.message === "RUNTIME_MANIFEST_HTTP_404";
}

function manifestError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
