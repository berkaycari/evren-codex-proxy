import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodexAppServerManager } from "../dist/desktop/main/codex-app-server.js";
import { buildCodexLaunchSpec } from "../dist/desktop/main/codex-launch.js";
import { detectCodex } from "../dist/desktop/main/codex-version.js";
import { generateLocalBridgeToken } from "../dist/runtime/local-auth.js";
import { isProcessAlive, terminateProcessTree, withTimeout } from "./smoke-process.mjs";

const runtimeRoot = path.join(process.cwd(), "resources", "codex", "win32-x64");
const packageMetadata = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(process.cwd(), "resources", "codex", "bundle-manifest.json"), "utf8"));
for (const entry of manifest.files) {
  const filePath = path.join(runtimeRoot, ...entry.path.split("/"));
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== entry.sizeBytes) throw new Error(`Bundled runtime size mismatch: ${entry.path}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) throw new Error(`Bundled runtime hash mismatch: ${entry.path}`);
}

const executable = path.join(runtimeRoot, "bin", "codex.exe");
const status = await detectCodex(executable);
if (!status.found || status.version !== "0.157.1") throw new Error(`Bundled Codex 0.157.1 is required; detected ${status.version ?? "none"}.`);
process.stdout.write("EVREN_BUNDLED_CODEX_VERSION_OK\n");

let childPid;
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
    childPid = child.pid;
    return child;
  },
});
try {
  await withTimeout(manager.start(buildCodexLaunchSpec({
    executable,
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 65_535,
    model: "auto",
    localBridgeToken: generateLocalBridgeToken(),
  }), packageMetadata.version), 15_000, "BUNDLED_CODEX_HANDSHAKE_TIMEOUT");
  process.stdout.write("EVREN_BUNDLED_CODEX_HANDSHAKE_OK\n");
} finally {
  try {
    await withTimeout(manager.stop(), 5_000, "BUNDLED_CODEX_SHUTDOWN_TIMEOUT");
  } catch (error) {
    if (childPid) await terminateProcessTree(childPid);
    throw error;
  }
}
if (!childPid || isProcessAlive(childPid)) {
  if (childPid) await terminateProcessTree(childPid);
  throw new Error(`Bundled Codex App Server child did not stop cleanly (pid ${childPid ?? "unknown"}).`);
}
process.stdout.write("EVREN_BUNDLED_CODEX_SHUTDOWN_OK\n");
