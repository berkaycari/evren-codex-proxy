import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { waitForChildWithTimeout } from "./smoke-process.mjs";

const preloadPath = path.join(process.cwd(), "dist", "desktop", "preload", "index.cjs");
const preloadSource = await readFile(preloadPath, "utf8");
if (/^\s*import(?:\s|\{|\*)/m.test(preloadSource)) {
  throw new Error("Production preload contains unsupported top-level ESM import syntax.");
}
if (!/require\(["']electron["']\)/.test(preloadSource)) {
  throw new Error("Production preload is not a CommonJS Electron bundle.");
}

const success = await runElectronSmoke({});
if (success.exitCode !== 0 || !success.output.includes("EVREN_DESKTOP_SMOKE_OK")) {
  throw new Error(`Desktop renderer-ready smoke failed: ${diagnostic(success.output, success.exitCode)}`);
}

const missingPreload = await runElectronSmoke({ EVREN_DESKTOP_SMOKE_PRELOAD_UNAVAILABLE: "1" });
if (
  missingPreload.exitCode === 0
  || missingPreload.output.includes("EVREN_DESKTOP_SMOKE_OK")
  || !missingPreload.output.includes("EVREN_DESKTOP_SMOKE_FAILED:PRELOAD_UNAVAILABLE")
) {
  throw new Error(`Missing-preload smoke did not fail safely: ${diagnostic(missingPreload.output, missingPreload.exitCode)}`);
}

process.stdout.write("EVREN_DESKTOP_MISSING_PRELOAD_REJECTED\n");
process.stdout.write("EVREN_DESKTOP_SMOKE_OK\n");

async function runElectronSmoke(extraEnvironment) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "evren-desktop-smoke-"));
  const resultFile = path.join(userData, "desktop-smoke-result.txt");
  let output = "";
  try {
    const childEnvironment = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, ["."], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childEnvironment,
        EVREN_DESKTOP_SMOKE: "1",
        EVREN_DESKTOP_SMOKE_USER_DATA: userData,
        EVREN_DESKTOP_SMOKE_RESULT_FILE: resultFile,
        ...extraEnvironment,
      },
    });
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    try {
      const outcome = await waitForChildWithTimeout(child, 30_000, "DESKTOP_RENDERER_READY");
      if (outcome.type === "error") throw outcome.error;
      output += await readFile(resultFile, "utf8").catch(() => "");
      return { exitCode: outcome.code, output };
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

function diagnostic(output, exitCode) {
  const safeOutput = output.replace(/[\u0000-\u001f\u007f]/g, " ").slice(-2_000);
  return `exit ${exitCode ?? "unknown"}: ${safeOutput}`;
}
