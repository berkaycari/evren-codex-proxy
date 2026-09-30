import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexStatusDto } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
export const TESTED_CODEX_VERSION = "0.157.1" as const;

export interface CommandRunner {
  (file: string, args: readonly string[]): Promise<{ stdout: string; stderr?: string }>;
}

export function parseCodexVersion(output: string): Omit<CodexStatusDto, "found" | "ready"> {
  const match = /(?:^|\s)codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/i.exec(output.trim());
  if (!match) return { testedVersion: TESTED_CODEX_VERSION, compatibility: "unknown" };
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  const comparison = compareVersions(version, TESTED_CODEX_VERSION);
  return {
    version,
    testedVersion: TESTED_CODEX_VERSION,
    compatibility: comparison === 0 ? "tested" : comparison > 0 ? "newer-unverified" : "older",
    ...(comparison > 0
      ? { warning: `Codex ${version} daha yeni; uyumluluk doğrulanmadı ancak bağlantı denenecek.` }
      : comparison < 0
        ? { warning: `Codex ${version}, test edilen ${TESTED_CODEX_VERSION} sürümünden eski.` }
        : {}),
  };
}

export async function detectCodex(
  executable = "codex",
  runner: CommandRunner = defaultRunner,
): Promise<CodexStatusDto> {
  try {
    const result = await runner(executable, ["--version"]);
    const parsed = parseCodexVersion(result.stdout);
    return { found: true, ready: false, ...parsed };
  } catch {
    return {
      found: false,
      ready: false,
      testedVersion: TESTED_CODEX_VERSION,
      compatibility: "unavailable",
      warning: "Codex CLI bulunamadı.",
    };
  }
}

async function defaultRunner(file: string, args: readonly string[]): Promise<{ stdout: string; stderr?: string }> {
  const result = await execFileAsync(file, [...args], { windowsHide: true, timeout: 10_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}
