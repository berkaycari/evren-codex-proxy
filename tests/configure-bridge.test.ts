import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function copiedConfigurator(local?: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evren-configurator-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "config"));
  await copyFile(new URL("../scripts/configure-bridge.ps1", import.meta.url), path.join(root, "scripts", "configure-bridge.ps1"));
  await copyFile(new URL("../config/defaults.json", import.meta.url), path.join(root, "config", "defaults.json"));
  if (local) await writeFile(path.join(root, "config", "local.json"), JSON.stringify(local), "utf8");
  return {
    root,
    script: path.join(root, "scripts", "configure-bridge.ps1"),
    local: path.join(root, "config", "local.json"),
  };
}

function run(
  script: string,
  preset: "Standard" | "Coding" | "Custom",
  input?: string,
  resultPath?: string,
  customJson?: Record<string, unknown>,
) {
  return spawnSync("powershell.exe", [
    "-ExecutionPolicy", "Bypass",
    "-NoProfile", "-File", script, "-Preset", preset, "-Save",
    ...(resultPath ? ["-ResultPath", resultPath] : []),
    ...(customJson ? ["-CustomJson", JSON.stringify(customJson)] : []),
  ], {
    encoding: "utf8",
    input,
    timeout: 20_000,
  });
}

describe("configure-bridge presets", () => {
  it("writes the Standard safety preset while preserving unrelated local settings", async () => {
    const copied = await copiedConfigurator({ maxDailyTokens: 9_000_000, maxOutputTokensPerCall: 2_048, maxSessionCredits: 12.5, updateCheckEnabled: false });
    const resultPath = path.join(copied.root, "result.json");
    const result = run(copied.script, "Standard", undefined, resultPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ outcome: "saved", preset: "Standard" });
    const saved = JSON.parse(await readFile(copied.local, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      maxSessionTokens: 1_200_000,
      maxDailyTokens: 10_000_000,
      maxRequestsPerSession: 60,
      maxToolCallsPerSession: 80,
      maxOutputTokensPerCall: 4096,
      updateCheckEnabled: false,
      maxSessionCredits: 12.5,
    });
    expect(JSON.stringify(saved)).not.toMatch(/EVREN_API_KEY|secret|authorization/i);
  });

  it("writes the Coding safety preset while preserving unrelated local settings", async () => {
    const copied = await copiedConfigurator({ maxDailyTokens: 8_500_000, maxOutputTokensPerCall: 2048 });
    const result = run(copied.script, "Coding");
    expect(result.status, result.stderr).toBe(0);
    const saved = JSON.parse(await readFile(copied.local, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      maxSessionTokens: 3_000_000,
      maxRequestsPerSession: 120,
      maxToolCallsPerSession: 140,
      maxDailyTokens: 10_000_000,
      maxSessionCredits: 0,
      maxDailyCredits: 0,
      minCreditsRemaining: 0,
      maxOutputTokensPerCall: 4096,
      maxEstimatedInputTokensPerCall: 80_000,
    });
  });


  it("writes dashboard-provided Custom JSON without reading stdin", async () => {
    const copied = await copiedConfigurator();
    const values = {
      maxSessionTokens: 1_200_000,
      maxDailyTokens: 10_000_000,
      maxSessionCredits: 0,
      maxDailyCredits: 0,
      minCreditsRemaining: 0,
      maxRequestsPerSession: 60,
      maxToolCallsPerSession: 80,
      maxEstimatedInputTokensPerCall: 80_000,
      maxOutputTokensPerCall: 4_096,
      toolOutputMaxChars: 50_000,
      toolPollWarningThreshold: 3,
      maxConsecutiveToolPollInferences: 0,
      sessionTtlMinutes: 30,
      pricingRefreshMinutes: 10,
      requestTimeoutMs: 120_000,
      updateCheckEnabled: true,
    };
    const resultPath = path.join(copied.root, "result.json");
    const result = run(copied.script, "Custom", undefined, resultPath, values);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ outcome: "saved", preset: "Custom" });
    expect(JSON.parse(await readFile(copied.local, "utf8"))).toMatchObject(values);
  });

  it("keeps Custom interactive editing, including polling cap zero support and update opt-out", async () => {
    const copied = await copiedConfigurator();
    const input = [
      "810000", "9000000", "0", "0", "2.5", "70000", "4096", "41", "61", "40000",
      "4", "0", "45", "15", "90000", "Kapali",
    ].join("\n") + "\n";
    const result = run(copied.script, "Custom", input);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const saved = JSON.parse(await readFile(copied.local, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      maxSessionTokens: 810_000,
      maxDailyTokens: 9_000_000,
      maxSessionCredits: 0,
      maxDailyCredits: 0,
      minCreditsRemaining: 2.5,
      maxEstimatedInputTokensPerCall: 70_000,
      maxOutputTokensPerCall: 4096,
      maxRequestsPerSession: 41,
      maxToolCallsPerSession: 61,
      toolOutputMaxChars: 40_000,
      toolPollWarningThreshold: 4,
      maxConsecutiveToolPollInferences: 0,
      sessionTtlMinutes: 45,
      pricingRefreshMinutes: 15,
      requestTimeoutMs: 90_000,
      updateCheckEnabled: false,
    });
    expect(result.stdout).toContain("EVREN CODEX BRIDGE — YAPILANDIRMA");
    expect(result.stdout).toContain("Seçilen profil: Custom");
  });
});
