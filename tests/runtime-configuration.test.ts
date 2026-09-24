import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import {
  executeConfigurationFlow,
  rebindRuntimeConfiguration,
  RuntimeRollbackError,
  type ConfiguratorRunner,
  type RebindableServer,
} from "../src/runtime/configuration.js";

async function fixture(initial: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-config-"));
  const configDirectory = path.join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  const localConfigPath = path.join(configDirectory, "local.json");
  await writeFile(localConfigPath, JSON.stringify(initial), "utf8");
  return { root, localConfigPath };
}

describe("dashboard configuration flow", () => {
  it("applies saved config with environment precedence through an injected runner", async () => {
    const copied = await fixture({ maxSessionTokens: 400_000 });
    const applied: BridgeConfig[] = [];
    const runner: ConfiguratorRunner = async ({ resultPath, preset }) => {
      expect(preset).toBe("Coding");
      await writeFile(copied.localConfigPath, JSON.stringify({
        maxSessionTokens: 800_000,
        maxRequestsPerSession: 40,
        maxToolCallsPerSession: 60,
      }), "utf8");
      await writeFile(resultPath, JSON.stringify({ outcome: "saved", preset: "Coding" }), "utf8");
      return { exitCode: 0, signal: null };
    };

    const result = await executeConfigurationFlow({
      projectRoot: copied.root,
      preset: "Coding",
      runner,
      loadEffectiveConfig: () => loadConfig(
        { MAX_REQUESTS_PER_SESSION: "55" },
        { localConfigPath: copied.localConfigPath },
      ),
      applyEffectiveConfig: async (config) => { applied.push(config); },
    });

    expect(result).toEqual({ status: "applied", preset: "Coding" });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      maxSessionTokens: 800_000,
      maxRequestsPerSession: 55,
      maxToolCallsPerSession: 60,
    });
  });

  it("restores the previous local config when configuration is cancelled", async () => {
    const copied = await fixture({ maxSessionTokens: 400_000 });
    const applyEffectiveConfig = vi.fn();
    const runner: ConfiguratorRunner = async ({ resultPath }) => {
      await writeFile(copied.localConfigPath, JSON.stringify({ maxSessionTokens: 900_000 }), "utf8");
      await writeFile(resultPath, JSON.stringify({ outcome: "cancelled", preset: "Custom" }), "utf8");
      return { exitCode: 0, signal: null };
    };

    const result = await executeConfigurationFlow({
      projectRoot: copied.root,
      preset: "Custom",
      runner,
      loadEffectiveConfig: () => loadConfig({}, { localConfigPath: copied.localConfigPath }),
      applyEffectiveConfig,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(applyEffectiveConfig).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(copied.localConfigPath, "utf8"))).toEqual({ maxSessionTokens: 400_000 });
  });

  it("restores the previous local config when apply fails and reports safely", async () => {
    const copied = await fixture({ maxSessionTokens: 400_000 });
    const runner: ConfiguratorRunner = async ({ resultPath }) => {
      await writeFile(copied.localConfigPath, JSON.stringify({ maxSessionTokens: 900_000 }), "utf8");
      await writeFile(resultPath, JSON.stringify({ outcome: "saved", preset: "Custom" }), "utf8");
      return { exitCode: 0, signal: null };
    };

    const result = await executeConfigurationFlow({
      projectRoot: copied.root,
      preset: "Custom",
      runner,
      loadEffectiveConfig: () => loadConfig({}, { localConfigPath: copied.localConfigPath }),
      applyEffectiveConfig: async () => { throw new Error("private failure detail"); },
    });

    expect(result).toEqual({ status: "failed" });
    expect(JSON.parse(await readFile(copied.localConfigPath, "utf8"))).toEqual({ maxSessionTokens: 400_000 });
    expect(JSON.stringify(result)).not.toContain("private failure detail");
  });

  it("treats an interrupted child as cancellation and preserves config", async () => {
    const copied = await fixture({ maxSessionTokens: 400_000 });
    const result = await executeConfigurationFlow({
      projectRoot: copied.root,
      preset: "Standard",
      runner: async () => ({ exitCode: null, signal: "SIGINT" }),
      loadEffectiveConfig: () => loadConfig({}, { localConfigPath: copied.localConfigPath }),
      applyEffectiveConfig: vi.fn(),
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(JSON.parse(await readFile(copied.localConfigPath, "utf8"))).toEqual({ maxSessionTokens: 400_000 });
  });

  it("drains and rebinds the server before exposing the new effective config", async () => {
    const currentConfig = loadConfig({});
    const nextConfig = { ...currentConfig, maxSessionTokens: 800_000 };
    const order: string[] = [];
    const oldServer = {
      close: async () => { order.push("close-old"); },
      listen: async () => undefined,
    };
    const nextServer = {
      close: async () => undefined,
      listen: async () => { order.push("listen-new"); },
    };
    let activeServer: RebindableServer = oldServer;

    await rebindRuntimeConfiguration({
      currentConfig,
      nextConfig,
      getServer: () => activeServer,
      setServer: (server) => { activeServer = server; order.push("set-new"); },
      buildServer: () => nextServer,
      applyRuntimeValues: (config) => { Object.assign(currentConfig, config); order.push("apply-config"); },
    });

    expect(order).toEqual(["close-old", "apply-config", "listen-new", "set-new"]);
    expect(activeServer).toBe(nextServer);
    expect(currentConfig.maxSessionTokens).toBe(800_000);
  });

  it("rebinds the previous runtime config when the new server cannot listen", async () => {
    const currentConfig = loadConfig({});
    const previousSessionLimit = currentConfig.maxSessionTokens;
    const nextConfig = { ...currentConfig, maxSessionTokens: 800_000 };
    const oldServer = { close: async () => undefined, listen: async () => undefined };
    const failedServer = {
      close: async () => undefined,
      listen: async () => { throw new Error("new listen failed"); },
    };
    const rollbackServer = { close: async () => undefined, listen: async () => undefined };
    const built: RebindableServer[] = [failedServer, rollbackServer];
    let activeServer: RebindableServer = oldServer;

    await expect(rebindRuntimeConfiguration({
      currentConfig,
      nextConfig,
      getServer: () => activeServer,
      setServer: (server) => { activeServer = server; },
      buildServer: () => built.shift()!,
      applyRuntimeValues: (config) => { Object.assign(currentConfig, config); },
    })).rejects.toThrow("new listen failed");

    expect(activeServer).toBe(rollbackServer);
    expect(currentConfig.maxSessionTokens).toBe(previousSessionLimit);
  });

  it("surfaces a terminal rollback failure distinctly", async () => {
    const currentConfig = loadConfig({});
    const failingServer = {
      close: async () => undefined,
      listen: async () => { throw new Error("listen failed"); },
    };

    await expect(rebindRuntimeConfiguration({
      currentConfig,
      nextConfig: { ...currentConfig, maxSessionTokens: 800_000 },
      getServer: () => failingServer,
      setServer: () => undefined,
      buildServer: () => failingServer,
      applyRuntimeValues: (config) => { Object.assign(currentConfig, config); },
    })).rejects.toBeInstanceOf(RuntimeRollbackError);
  });
});
