import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CodexStatusDto } from "../shared/contracts.js";
import { detectCodex } from "./codex-version.js";

export type RuntimeSource = "bundled" | "verified-update" | "system" | "unavailable";

export interface ResolvedCodexRuntime {
  executable: string;
  source: RuntimeSource;
  status: CodexStatusDto;
}

export async function resolveCodexRuntime(options: {
  packaged: boolean;
  resourcesPath: string;
  userDataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  developmentExecutable?: string;
  detect?: typeof detectCodex;
}): Promise<ResolvedCodexRuntime> {
  const detect = options.detect ?? detectCodex;
  if ((options.platform ?? process.platform) !== "win32" || (options.arch ?? process.arch) !== "x64") {
    return unavailable("Bundled Codex Runtime is available only for Windows x64.");
  }
  if (!options.packaged) {
    const executable = options.developmentExecutable?.trim() || "codex";
    return { executable, source: "system", status: await detect(executable) };
  }

  const verified = await readVerifiedRuntime(options.userDataDir);
  if (verified) {
    const status = await detect(verified.executable);
    if (status.found && status.version === verified.version) {
      const { warning: _warning, ...verifiedStatus } = status;
      return {
        executable: verified.executable,
        source: "verified-update",
        status: { ...verifiedStatus, compatibility: "tested" },
      };
    }
  }

  const executable = path.join(options.resourcesPath, "codex", "win32-x64", "bin", "codex.exe");
  try {
    await access(executable);
  } catch {
    return unavailable("Bundled Codex Runtime is missing or incomplete.");
  }
  const status = await detect(executable);
  return { executable, source: status.found ? "bundled" : "unavailable", status };
}

async function readVerifiedRuntime(userDataDir: string): Promise<{ executable: string; version: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(userDataDir, "runtimes", "active.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.version) || typeof record.executable !== "string") return undefined;
    const root = path.resolve(userDataDir, "runtimes");
    const executable = path.resolve(root, record.executable);
    if (!executable.toLocaleLowerCase("en-US").startsWith(`${root.toLocaleLowerCase("en-US")}${path.sep}`)) return undefined;
    await access(executable);
    return { executable, version: record.version };
  } catch {
    return undefined;
  }
}

function unavailable(warning: string): ResolvedCodexRuntime {
  return {
    executable: "",
    source: "unavailable",
    status: {
      found: false,
      ready: false,
      testedVersion: "0.157.1",
      compatibility: "unavailable",
      warning,
    },
  };
}
