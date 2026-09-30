import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import {
  createBridgeRuntime,
  defaultRuntimeDirectories,
  type BridgeRuntime,
} from "../runtime/bridge-runtime.js";
import {
  executeConfigurationFlow,
  RuntimeRollbackError,
} from "../runtime/configuration.js";
import { Dashboard, type DashboardConfigurationRequest } from "../ui/dashboard.js";

let restoreTerminal = (): void => undefined;
let cleanupStartupFailure = async (): Promise<void> => {
  restoreTerminal();
};

const packageMetadata = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
const packageVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown";

async function main(): Promise<void> {
  const apiKey = process.env.EVREN_API_KEY?.trim();
  if (!apiKey) {
    console.error("EVREN_API_KEY is required. Set it for this PowerShell process without printing it:");
    console.error("$env:EVREN_API_KEY = (Get-Clipboard -Raw).Trim()");
    process.exitCode = 1;
    return;
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const runtime = createBridgeRuntime({
    apiKey,
    currentVersion: packageVersion,
    ...defaultRuntimeDirectories(projectRoot),
    config: loadConfig(),
    dashboardEnabled: process.env.NO_DASHBOARD !== "1",
    debug: process.env.DEBUG === "1",
  });
  console.log(`EVREN_API_KEY loaded (length: ${apiKey.length})`);

  let currentPreset: "Standard" | "Coding" | "Custom" | "Custom/current" = "Custom/current";
  let shuttingDown = false;
  let lastDashboardFingerprint = "";
  const dashboard = new Dashboard(runtime.logger, {
    onConfigure: configureFromDashboard,
    onInterrupt: handleShutdown,
  });

  restoreTerminal = (): void => {
    try {
      dashboard.stop();
    } catch {
      // Terminal restoration is best-effort and must not block server cleanup.
    }
  };
  cleanupStartupFailure = async (): Promise<void> => {
    restoreTerminal();
    await runtime.stop().catch(() => undefined);
  };

  await runtime.start();

  const render = (): void => {
    const snapshot = runtime.snapshot();
    const session = snapshot.session;
    const pricingState = snapshot.pricing;
    const daily = snapshot.dailyUsage;
    if (!daily) return;
    const credits = snapshot.credits;
    const update = snapshot.update;
    const config = runtime.config;
    const lastAction = runtime.logger.getRecent().at(-1)?.event ?? "Waiting for Codex";
    const creditPolicyAllowed = config.maxSessionCredits === 0
      && config.maxDailyCredits === 0
      && (config.minCreditsRemaining === 0
        || credits.remaining === undefined
        || credits.remaining > config.minCreditsRemaining);
    const status = pricingState.allowed && daily.accountingCertain && creditPolicyAllowed
      ? "ONLINE"
      : "BLOCKED";

    const fingerprint = JSON.stringify({
      status,
      pricing: pricingState,
      credits,
      update,
      config,
      session: session ? {
        id: session.id,
        requests: session.requestCount,
        toolCalls: session.toolCallCount,
        usage: session.usage,
        inferenceCount: session.inferenceCount,
        pollCount: session.polling.active?.consecutivePolls ?? 0,
        pollTokens: session.polling.active?.authoritativeTokensSpent ?? 0,
        outputBudgetSaturated: session.lastOutputBudgetSaturated,
        activeContextBytes: session.contextObservability.currentActiveContextBytes,
        compactions: session.acceptedCompactionCount,
        limitRecovery: session.limitRecovery,
      } : null,
      daily,
      lastAction,
      recent: runtime.logger.getRecent(),
      terminal: { columns: process.stdout.columns, rows: process.stdout.rows },
    });
    if (fingerprint === lastDashboardFingerprint) return;
    lastDashboardFingerprint = fingerprint;

    dashboard.render({
      status,
      listen: `${snapshot.host}:${snapshot.port ?? config.port}`,
      model: config.model,
      transport: config.toolTransport,
      version: packageVersion,
      pricing: pricingState,
      credits,
      update,
      ...(session === undefined ? {} : { session }),
      daily,
      limits: {
        requests: config.maxRequestsPerSession,
        sessionTokens: config.maxSessionTokens,
        dailyTokens: config.maxDailyTokens,
        toolCalls: config.maxToolCallsPerSession,
        outputTokens: config.maxOutputTokensPerCall,
        pollWarning: config.toolPollWarningThreshold,
        pollHardCap: config.maxConsecutiveToolPollInferences,
      },
      preset: currentPreset,
      lastAction,
      customConfiguration: {
        maxSessionTokens: config.maxSessionTokens,
        maxDailyTokens: config.maxDailyTokens,
        maxSessionCredits: config.maxSessionCredits,
        maxDailyCredits: config.maxDailyCredits,
        minCreditsRemaining: config.minCreditsRemaining,
        maxRequestsPerSession: config.maxRequestsPerSession,
        maxToolCallsPerSession: config.maxToolCallsPerSession,
        maxEstimatedInputTokensPerCall: config.maxEstimatedInputTokensPerCall,
        maxOutputTokensPerCall: config.maxOutputTokensPerCall,
        sessionTtlMinutes: config.sessionTtlMinutes,
        toolOutputMaxChars: config.toolOutputMaxChars,
        toolPollWarningThreshold: config.toolPollWarningThreshold,
        maxConsecutiveToolPollInferences: config.maxConsecutiveToolPollInferences,
        pricingRefreshMinutes: config.pricingRefreshMinutes,
        requestTimeoutMs: config.requestTimeoutMs,
        updateCheckEnabled: config.updateCheckEnabled,
      },
    });
  };

  const unsubscribeRuntime = runtime.subscribe(render);
  const unsubscribeDashboard = runtime.logger.subscribe(render);
  process.stdout.on("resize", render);
  render();

  async function configureFromDashboard(request: DashboardConfigurationRequest) {
    const result = await executeConfigurationFlow({
      projectRoot,
      preset: request.preset,
      ...(request.customConfiguration === undefined ? {} : { customConfiguration: request.customConfiguration }),
      loadEffectiveConfig: () => loadConfig(),
      applyEffectiveConfig: (config) => runtime.applyConfiguration(config),
    });
    if (result.status === "applied") currentPreset = result.preset ?? "Custom/current";
    if (result.status === "applied" && request.recoveryLimitName) {
      const session = runtime.sessions.getCurrent();
      const recovery = session?.limitRecovery;
      if (session && recovery?.limitName === request.recoveryLimitName) {
        const config = runtime.config;
        const newLimit = request.recoveryLimitName === "MAX_SESSION_TOKENS"
          ? config.maxSessionTokens
          : request.recoveryLimitName === "MAX_REQUESTS_PER_SESSION"
            ? config.maxRequestsPerSession
            : config.maxToolCallsPerSession;
        recovery.appliedAt = new Date();
        recovery.appliedLimit = newLimit;
        runtime.logger.log({
          event: "LIMIT_RECOVERY_APPLIED",
          data: { limitName: request.recoveryLimitName, oldValue: recovery.limit, newValue: newLimit },
        });
      }
    }
    lastDashboardFingerprint = "";
    render();
    return result;
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribeRuntime();
    unsubscribeDashboard();
    process.stdout.off("resize", render);
    process.off("uncaughtExceptionMonitor", restoreTerminal);
    process.off("exit", restoreTerminal);
    restoreTerminal();
    await runtime.stop();
  };

  function handleShutdown(): void {
    void shutdown().catch((error: unknown) => {
      restoreTerminal();
      console.error(`Bridge shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    });
  }

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
  process.once("exit", restoreTerminal);
  process.on("uncaughtExceptionMonitor", restoreTerminal);
  if (runtime.dashboardEnabled) dashboard.start();
}

main().catch(async (error: unknown) => {
  await cleanupStartupFailure();
  if (error instanceof RuntimeRollbackError) restoreTerminal();
  console.error(`Bridge startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
