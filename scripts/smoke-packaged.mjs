import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerManager } from "../dist/desktop/main/codex-app-server.js";
import { buildCodexLaunchSpec } from "../dist/desktop/main/codex-launch.js";
import { resolveCodexRuntime } from "../dist/desktop/main/runtime-resolver.js";
import { generateLocalBridgeToken } from "../dist/runtime/local-auth.js";
import {
  isProcessAlive,
  observeChild,
  terminateProcessTree,
  waitForChildWithTimeout,
  withTimeout,
} from "./smoke-process.mjs";

const packageRoot = path.join(process.cwd(), "dist-release", "win-unpacked");
const packageMetadata = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
const desktopVersion = packageMetadata.version;
const executable = path.join(packageRoot, "EVREN Codex Bridge.exe");
const portableMode = process.argv.slice(2).includes("--portable");
const desktopExecutable = portableMode
  ? path.join(process.cwd(), "dist-release", `EVREN-Codex-Bridge-Portable-${desktopVersion}.exe`)
  : executable;
const resourcesPath = path.join(packageRoot, "resources");
const packagedCodexRoot = path.join(resourcesPath, "codex");
const bundledCodex = path.join(packagedCodexRoot, "win32-x64", "bin", "codex.exe");
await access(executable);
await access(desktopExecutable);
await access(bundledCodex);

const userData = await mkdtemp(path.join(os.tmpdir(), "evren-packaged-smoke-"));
const minimalEnvironment = isolatedEnvironment(userData);
let finalMarker;
try {
  await mkdir(minimalEnvironment.CODEX_HOME, { recursive: true });
  await verifyPackagedRuntimeFiles(packagedCodexRoot);
  process.stdout.write("EVREN_PACKAGED_CODEX_HASHES_OK\n");

  await assertSystemCodexUnavailable(minimalEnvironment, packageRoot);
  process.stdout.write("EVREN_PACKAGED_SYSTEM_CODEX_UNAVAILABLE_OK\n");

  const resolved = await resolveCodexRuntime({
    packaged: true,
    resourcesPath,
    userDataDir: userData,
    platform: "win32",
    arch: "x64",
  });
  if (resolved.source !== "bundled" || path.resolve(resolved.executable) !== path.resolve(bundledCodex)) {
    throw new Error(`Packaged resolver did not select the bundled runtime: ${JSON.stringify(resolved)}`);
  }
  if (!resolved.status.found || resolved.status.version !== "0.157.1" || resolved.status.compatibility !== "tested") {
    throw new Error(`Packaged Codex 0.157.1 is required: ${JSON.stringify(resolved.status)}`);
  }
  process.stdout.write("EVREN_PACKAGED_CODEX_RESOLUTION_OK\n");

  let appServerPid;
  const manager = new CodexAppServerManager({
    shutdownTimeoutMs: 2_000,
    spawn: (spec) => {
      const child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      appServerPid = child.pid;
      return child;
    },
  });
  try {
    await withTimeout(manager.start(buildCodexLaunchSpec({
      executable: resolved.executable,
      cwd: packageRoot,
      host: "127.0.0.1",
      port: 65_535,
      model: "auto",
      localBridgeToken: generateLocalBridgeToken(),
      baseEnv: minimalEnvironment,
    }), desktopVersion), 15_000, "PACKAGED_CODEX_HANDSHAKE_TIMEOUT");
    process.stdout.write("EVREN_PACKAGED_CODEX_HANDSHAKE_OK\n");
  } finally {
    try {
      await withTimeout(manager.stop(), 5_000, "PACKAGED_CODEX_SHUTDOWN_TIMEOUT");
    } catch (error) {
      if (appServerPid) await terminateProcessTree(appServerPid);
      throw error;
    }
  }
  if (!appServerPid || isProcessAlive(appServerPid)) {
    if (appServerPid) await terminateProcessTree(appServerPid);
    throw new Error(`Packaged Codex App Server child did not stop cleanly (pid ${appServerPid ?? "unknown"}).`);
  }
  process.stdout.write("EVREN_PACKAGED_CODEX_SHUTDOWN_OK\n");

  await runDesktopSmoke(desktopExecutable, packageRoot, userData, minimalEnvironment, portableMode ? 45_000 : 30_000);
  finalMarker = portableMode ? "EVREN_PORTABLE_DESKTOP_SMOKE_OK\n" : "EVREN_PACKAGED_DESKTOP_SMOKE_OK\n";
} finally {
  await rm(userData, { recursive: true, force: true });
}
await new Promise((resolve) => process.stdout.write(finalMarker, resolve));
process.exit(0);

async function verifyPackagedRuntimeFiles(codexRoot) {
  const packagedManifest = JSON.parse(await readFile(path.join(codexRoot, "bundle-manifest.json"), "utf8"));
  const sourceManifest = JSON.parse(await readFile(path.join(process.cwd(), "resources", "codex", "bundle-manifest.json"), "utf8"));
  if (JSON.stringify(packagedManifest) !== JSON.stringify(sourceManifest)) {
    throw new Error("Packaged Codex manifest differs from the source manifest.");
  }
  if (packagedManifest.codexVersion !== "0.157.1" || packagedManifest.platform !== "win32" || packagedManifest.arch !== "x64") {
    throw new Error("Packaged Codex manifest target is invalid.");
  }
  for (const entry of packagedManifest.files) {
    const filePath = path.join(codexRoot, "win32-x64", ...entry.path.split("/"));
    const bytes = await readFile(filePath);
    if (bytes.byteLength !== entry.sizeBytes) throw new Error(`Packaged runtime size mismatch: ${entry.path}`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) throw new Error(`Packaged runtime hash mismatch: ${entry.path}`);
  }
  await access(path.join(codexRoot, "LICENSE-OPENAI-CODEX.txt"));
}

async function assertSystemCodexUnavailable(environment, cwd) {
  const child = spawn("codex", ["--version"], {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  let outcome;
  try {
    outcome = await withTimeout(observeChild(child), 5_000, "SYSTEM_CODEX_ISOLATION_CHECK_TIMEOUT");
  } catch (error) {
    await terminateProcessTree(child.pid);
    throw error;
  }
  if (outcome.type !== "error" || outcome.error?.code !== "ENOENT") {
    throw new Error(`System Codex was unexpectedly available in the isolated PATH: ${JSON.stringify(outcome)}`);
  }
}

async function runDesktopSmoke(appExecutable, cwd, smokeUserData, environment, timeoutMs) {
  let output = "";
  const resultFile = path.join(smokeUserData, "desktop-smoke-result.txt");
  const child = spawn(appExecutable, [], {
    cwd,
    env: {
      ...environment,
      EVREN_DESKTOP_SMOKE: "1",
      EVREN_DESKTOP_SMOKE_USER_DATA: smokeUserData,
      EVREN_DESKTOP_SMOKE_RESULT_FILE: resultFile,
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const outcome = await waitForChildWithTimeout(child, timeoutMs, portableMode ? "PORTABLE_DESKTOP" : "PACKAGED_DESKTOP");
    if (outcome.type === "error") throw outcome.error;
    const result = await readFile(resultFile, "utf8").catch(() => "");
    if (outcome.code !== 0 || !(output + result).includes("EVREN_DESKTOP_SMOKE_OK")) {
      throw new Error(`Packaged Desktop smoke failed (exit ${outcome.code}): ${sanitize(output).slice(-2_000)}`);
    }
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

function isolatedEnvironment(userData) {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/(api.?key|token|secret|password|credential|authorization)/i.test(key)) {
      environment[key] = value;
    }
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SystemRoot = windowsRoot;
  environment.WINDIR = windowsRoot;
  environment.PATH = [path.join(windowsRoot, "System32"), windowsRoot].join(path.delimiter);
  environment.TEMP = process.env.TEMP || os.tmpdir();
  environment.TMP = process.env.TMP || os.tmpdir();
  environment.CODEX_HOME = path.join(userData, "codex-home");
  return environment;
}

function sanitize(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}
