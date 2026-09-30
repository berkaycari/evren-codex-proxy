import { spawn } from "node:child_process";
import path from "node:path";

export async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function observeChild(child) {
  if (child.exitCode !== null) return Promise.resolve({ type: "exit", code: child.exitCode, signal: null });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    child.once("exit", (code, signal) => resolve({ type: "exit", code, signal }));
  });
}

export async function waitForChildWithTimeout(child, timeoutMs, label) {
  let timer;
  try {
    const outcome = await Promise.race([
      observeChild(child),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      }),
    ]);
    if (outcome.type !== "timeout") return outcome;

    const terminated = await terminateProcessTree(child.pid);
    if (!terminated) throw new Error(`${label}_TIMEOUT_PROCESS_TREE_TERMINATION_FAILED`);
    throw new Error(`${label}_TIMEOUT`);
  } finally {
    clearTimeout(timer);
  }
}

export async function terminateProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return true;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
      return await waitForProcessGone(pid, 2_000);
    } catch {
      return !isProcessAlive(pid);
    }
  }

  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const taskkill = spawn(path.join(windowsRoot, "System32", "taskkill.exe"), [
    "/PID",
    String(pid),
    "/T",
    "/F",
  ], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const outcome = await Promise.race([
    observeChild(taskkill),
    delay(5_000).then(() => ({ type: "timeout" })),
  ]);
  if (outcome.type === "timeout") taskkill.kill();
  if (await waitForProcessGone(pid, 2_000)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The exact process may have exited between the liveness check and fallback kill.
  }
  return waitForProcessGone(pid, 2_000);
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessAlive(pid);
}
