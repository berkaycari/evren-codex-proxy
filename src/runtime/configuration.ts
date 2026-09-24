import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import type { DashboardConfigurationResult, DashboardCustomConfiguration, DashboardPreset } from "../ui/dashboard.js";

export type BridgePreset = DashboardPreset;

interface LocalConfigSnapshot {
  exists: boolean;
  bytes?: Buffer;
}

export interface ConfiguratorProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type ConfiguratorRunner = (options: {
  scriptPath: string;
  resultPath: string;
  preset: BridgePreset;
  customConfiguration?: DashboardCustomConfiguration;
}) => Promise<ConfiguratorProcessResult>;

export interface ConfigurationFlowOptions {
  projectRoot: string;
  preset: BridgePreset;
  customConfiguration?: DashboardCustomConfiguration;
  runner?: ConfiguratorRunner;
  loadEffectiveConfig(): BridgeConfig;
  applyEffectiveConfig(config: BridgeConfig): Promise<void>;
}

export interface RebindableServer {
  close(): Promise<unknown>;
  listen(options: { host: "127.0.0.1"; port: number }): Promise<unknown>;
}

export interface RuntimeRebindOptions<TServer extends RebindableServer> {
  currentConfig: BridgeConfig;
  nextConfig: BridgeConfig;
  getServer(): TServer;
  setServer(server: TServer): void;
  buildServer(): TServer;
  applyRuntimeValues(config: BridgeConfig): void;
}

export class RuntimeRollbackError extends AggregateError {}

export async function rebindRuntimeConfiguration<TServer extends RebindableServer>(
  options: RuntimeRebindOptions<TServer>,
): Promise<void> {
  const previousConfig = { ...options.currentConfig };
  await options.getServer().close();
  try {
    options.applyRuntimeValues(options.nextConfig);
    const nextServer = options.buildServer();
    await nextServer.listen({
      host: options.currentConfig.host,
      port: options.currentConfig.port,
    });
    options.setServer(nextServer);
  } catch (error) {
    options.applyRuntimeValues(previousConfig);
    const rollbackServer = options.buildServer();
    try {
      await rollbackServer.listen({
        host: options.currentConfig.host,
        port: options.currentConfig.port,
      });
      options.setServer(rollbackServer);
    } catch (rollbackError) {
      throw new RuntimeRollbackError(
        [error, rollbackError],
        "Bridge configuration and rollback both failed.",
      );
    }
    throw error;
  }
}

export async function executeConfigurationFlow(
  options: ConfigurationFlowOptions,
): Promise<DashboardConfigurationResult> {
  const localConfigPath = path.join(options.projectRoot, "config", "local.json");
  const scriptPath = path.join(options.projectRoot, "scripts", "configure-bridge.ps1");
  const resultPath = path.join(
    os.tmpdir(),
    `evren-config-result-${process.pid}-${randomUUID()}.json`,
  );
  const snapshot = await snapshotLocalConfig(localConfigPath);
  try {
    const processResult = await (options.runner ?? runPowerShellConfigurator)({
      scriptPath,
      resultPath,
      preset: options.preset,
      ...(options.customConfiguration === undefined ? {} : { customConfiguration: options.customConfiguration }),
    });
    const result = await readConfiguratorResult(resultPath);
    if (processResult.exitCode !== 0 || !result || result.outcome === "failed") {
      await restoreLocalConfig(localConfigPath, snapshot);
      return { status: processResult.signal ? "cancelled" : "failed" };
    }
    if (result.outcome === "cancelled") {
      await restoreLocalConfig(localConfigPath, snapshot);
      return { status: "cancelled" };
    }
    try {
      const nextConfig = options.loadEffectiveConfig();
      await options.applyEffectiveConfig(nextConfig);
      return {
        status: "applied",
        ...(result.preset === undefined ? {} : { preset: result.preset }),
      };
    } catch {
      await restoreLocalConfig(localConfigPath, snapshot);
      return { status: "failed" };
    }
  } catch {
    await restoreLocalConfig(localConfigPath, snapshot);
    return { status: "failed" };
  } finally {
    await rm(resultPath, { force: true }).catch(() => undefined);
  }
}

export function runPowerShellConfigurator(options: {
  scriptPath: string;
  resultPath: string;
  preset: BridgePreset;
  customConfiguration?: DashboardCustomConfiguration;
}): Promise<ConfiguratorProcessResult> {
  return new Promise((resolve, reject) => {
    const hasDashboardCustomValues = options.preset === "Custom" && options.customConfiguration !== undefined;
    const args = [
      "-ExecutionPolicy",
      "Bypass",
      "-NoProfile",
      "-File",
      options.scriptPath,
      "-ResultPath",
      options.resultPath,
      "-Preset",
      options.preset,
      "-Save",
      ...(hasDashboardCustomValues
        ? ["-CustomJson", JSON.stringify(options.customConfiguration)]
        : []),
    ];
    const child = spawn(
      "powershell.exe",
      args,
      {
        stdio: hasDashboardCustomValues || options.preset !== "Custom"
          ? ["ignore", "inherit", "inherit"]
          : "inherit",
        shell: false,
      },
    );
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function snapshotLocalConfig(localConfigPath: string): Promise<LocalConfigSnapshot> {
  try {
    return { exists: true, bytes: await readFile(localConfigPath) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function restoreLocalConfig(
  localConfigPath: string,
  snapshot: LocalConfigSnapshot,
): Promise<void> {
  if (!snapshot.exists) {
    await rm(localConfigPath, { force: true });
    return;
  }
  await mkdir(path.dirname(localConfigPath), { recursive: true });
  const temporaryPath = `${localConfigPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, snapshot.bytes!);
    await rename(temporaryPath, localConfigPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readConfiguratorResult(resultPath: string): Promise<{
  outcome: "saved" | "cancelled" | "failed";
  preset?: BridgePreset;
} | undefined> {
  let raw: string;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.outcome !== "saved" && record.outcome !== "cancelled" && record.outcome !== "failed") {
    return undefined;
  }
  const preset = record.preset;
  if (preset !== undefined && preset !== "Standard" && preset !== "Coding" && preset !== "Custom") {
    return undefined;
  }
  return {
    outcome: record.outcome,
    ...(preset === undefined ? {} : { preset: preset as BridgePreset }),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
