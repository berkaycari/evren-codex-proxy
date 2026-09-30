import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodexAppServerManager } from "../dist/desktop/main/codex-app-server.js";
import { buildCodexLaunchSpec } from "../dist/desktop/main/codex-launch.js";
import { detectCodex } from "../dist/desktop/main/codex-version.js";
import { generateLocalBridgeToken } from "../dist/runtime/local-auth.js";
import { isProcessAlive, terminateProcessTree, withTimeout } from "./smoke-process.mjs";

const status = await detectCodex();
const packageMetadata = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
if (!status.found || status.version !== "0.157.1") {
  throw new Error(`Codex 0.157.1 is required for this smoke test; detected ${status.version ?? "none"}.`);
}

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
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 65_535,
    model: "auto",
    localBridgeToken: generateLocalBridgeToken(),
  }), packageMetadata.version), 15_000, "CODEX_APP_SERVER_HANDSHAKE_TIMEOUT");
  process.stdout.write("CODEX_APP_SERVER_HANDSHAKE_OK\n");
} finally {
  try {
    await withTimeout(manager.stop(), 5_000, "CODEX_APP_SERVER_SHUTDOWN_TIMEOUT");
  } catch (error) {
    if (childPid) await terminateProcessTree(childPid);
    throw error;
  }
}

if (!childPid || isProcessAlive(childPid)) {
  if (childPid) await terminateProcessTree(childPid);
  throw new Error(`Codex App Server process ${childPid ?? "unknown"} is still alive after shutdown.`);
}
process.stdout.write("CODEX_APP_SERVER_SHUTDOWN_OK\n");
