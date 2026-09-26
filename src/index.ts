import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeService } from "./bridge/bridge-service.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { EvrenClient } from "./evren/client.js";
import {
  executeConfigurationFlow,
  rebindRuntimeConfiguration,
  RuntimeRollbackError,
} from "./runtime/configuration.js";
import { PricingGuard } from "./safety/pricing-guard.js";
import { SessionStore } from "./sessions/store.js";
import { buildServer } from "./server/app.js";
import { Dashboard, type DashboardConfigurationRequest } from "./ui/dashboard.js";
import { SafeLogger } from "./ui/logger.js";
import { UsagePersistence } from "./usage/persistence.js";
import { UsageTracker } from "./usage/tracker.js";
import { UpdateChecker } from "./update/checker.js";

let restoreTerminal = (): void => undefined;
let cleanupStartupFailure = async (): Promise<void> => {
  restoreTerminal();
};

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
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

  const config = loadConfig();
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const logger = new SafeLogger(path.join(projectRoot, "logs"), {
    secrets: [apiKey],
    debug: process.env.DEBUG === "1",
  });
  console.log(`EVREN_API_KEY loaded (length: ${apiKey.length})`);

  const usage = new UsageTracker(new UsagePersistence(path.join(projectRoot, "data")));
  await usage.initialize();
  const sessions = new SessionStore(config.sessionTtlMinutes * 60_000);
  const client = new EvrenClient({
    baseUrl: config.evrenBaseUrl,
    apiKey,
    model: config.model,
    timeoutMs: config.requestTimeoutMs,
    logger,
  });
  const pricingGuard = new PricingGuard(client, config.model, logger);
  const updateChecker = new UpdateChecker({
    enabled: config.updateCheckEnabled,
    currentVersion: packageVersion,
    logger,
  });
  const pricing = await pricingGuard.refresh();
  pricingGuard.startPeriodic(config.pricingRefreshMinutes);
  const bridge = new BridgeService({ config, client, pricingGuard, sessions, usage, logger });
  const buildApp = () => buildServer({
    config,
    pricingGuard,
    sessions,
    usage,
    bridge,
    logger,
    credits: client,
    updateCheck: updateChecker,
  });
  let app = buildApp();
  let currentPreset: "Standard" | "Coding" | "Custom" | "Custom/current" = "Custom/current";
  const dashboard = new Dashboard(logger, {
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
    pricingGuard.stopPeriodic();
    try {
      await app.close();
    } catch {
      // Preserve the original startup error.
    }
  };

  await app.listen({ host: config.host, port: config.port });
  let lastDashboardFingerprint = "";

  const render = (): void => {
    const session = sessions.getCurrent();
    const pricingState = pricingGuard.getState();
    const daily = usage.snapshot();
    const credits = client.getCreditState();
    const update = updateChecker.getState();
    const lastAction = logger.getRecent().at(-1)?.event ?? "Waiting for Codex";
    const creditPolicyAllowed = config.maxSessionCredits === 0
      && config.maxDailyCredits === 0
      && (config.minCreditsRemaining === 0
        || credits.remaining === undefined
        || credits.remaining > config.minCreditsRemaining);

    const status =
      pricingState.allowed && daily.accountingCertain && creditPolicyAllowed
        ? "ONLINE"
        : "BLOCKED";

    // Render only when bridge state, safe events, or terminal dimensions change.
    const fingerprint = JSON.stringify({
      status,
      pricing: {
        allowed: pricingState.allowed,
        connected: pricingState.connected,
        checkedAt: pricingState.checkedAt,
        reason: pricingState.reason,
        values: pricingState.pricing,
      },
      credits,
      update,
      config: {
        preset: currentPreset,
        requests: config.maxRequestsPerSession,
        sessionTokens: config.maxSessionTokens,
        dailyTokens: config.maxDailyTokens,
        toolCalls: config.maxToolCallsPerSession,
        outputTokens: config.maxOutputTokensPerCall,
        maxSessionCredits: config.maxSessionCredits,
        maxDailyCredits: config.maxDailyCredits,
        minCreditsRemaining: config.minCreditsRemaining,
        pollWarning: config.toolPollWarningThreshold,
        pollHardCap: config.maxConsecutiveToolPollInferences,
      },
      session: session
        ? {
          id: session.id,
          requests: session.requestCount,
          toolCalls: session.toolCallCount,
          inputTokens: session.usage.inputTokens,
          outputTokens: session.usage.outputTokens,
          totalTokens: session.usage.totalTokens,
          inferenceCount: session.inferenceCount,
          pollCount: session.polling.active?.consecutivePolls ?? 0,
          pollTokens: session.polling.active?.authoritativeTokensSpent ?? 0,
          outputBudgetSaturated: session.lastOutputBudgetSaturated,
          activeContextBytes: session.contextObservability.currentActiveContextBytes,
          compactions: session.acceptedCompactionCount,
          limitRecovery: session.limitRecovery,
        }
        : null,
      daily: {
        inputTokens: daily.inputTokens,
        outputTokens: daily.outputTokens,
        totalTokens: daily.totalTokens,
        accountingCertain: daily.accountingCertain,
      },
      lastAction,
      recent: logger.getRecent(),
      terminal: { columns: process.stdout.columns, rows: process.stdout.rows },
    });

    if (fingerprint === lastDashboardFingerprint) {
      return;
    }

    lastDashboardFingerprint = fingerprint;

    dashboard.render({
      status,
      listen: `${config.host}:${config.port}`,
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

  const unsubscribeDashboard = logger.subscribe(render);
  process.stdout.on("resize", render);
  logger.log({
    event: "PROXY_STARTED",
    data: { host: config.host, port: config.port, model: config.model, pricingAllowed: pricing.allowed },
  });
  render();
  void updateChecker.checkOnce();

  async function configureFromDashboard(request: DashboardConfigurationRequest) {
    const result = await executeConfigurationFlow({
      projectRoot,
      preset: request.preset,
      ...(request.customConfiguration === undefined ? {} : { customConfiguration: request.customConfiguration }),
      loadEffectiveConfig: () => loadConfig(),
      applyEffectiveConfig,
    });
    if (result.status === "applied") currentPreset = result.preset ?? "Custom/current";
    if (result.status === "applied" && request.recoveryLimitName) {
      const session = sessions.getCurrent();
      const recovery = session?.limitRecovery;
      if (session && recovery?.limitName === request.recoveryLimitName) {
        const newLimit = request.recoveryLimitName === "MAX_SESSION_TOKENS"
          ? config.maxSessionTokens
          : request.recoveryLimitName === "MAX_REQUESTS_PER_SESSION"
            ? config.maxRequestsPerSession
            : config.maxToolCallsPerSession;
        recovery.appliedAt = new Date();
        recovery.appliedLimit = newLimit;
        logger.log({
          event: "LIMIT_RECOVERY_APPLIED",
          data: { limitName: request.recoveryLimitName, oldValue: recovery.limit, newValue: newLimit },
        });
      }
    }
    lastDashboardFingerprint = "";
    render();
    return result;
  }

  async function applyEffectiveConfig(nextConfig: BridgeConfig): Promise<void> {
    try {
      await rebindRuntimeConfiguration({
        currentConfig: config,
        nextConfig,
        getServer: () => app,
        setServer: (nextApp) => { app = nextApp; },
        buildServer: buildApp,
        applyRuntimeValues,
      });
      if (updateChecker.getState().status === "not_checked") void updateChecker.checkOnce();
    } catch (error) {
      if (error instanceof RuntimeRollbackError) {
        restoreTerminal();
        process.exitCode = 1;
      } else if (updateChecker.getState().status === "not_checked") {
        void updateChecker.checkOnce();
      }
      throw error;
    }
  }

  function applyRuntimeValues(nextConfig: BridgeConfig): void {
    Object.assign(config, nextConfig);
    client.setRequestTimeoutMs(nextConfig.requestTimeoutMs);
    sessions.setTtlMs(nextConfig.sessionTtlMinutes * 60_000);
    pricingGuard.startPeriodic(nextConfig.pricingRefreshMinutes);
    updateChecker.setEnabled(nextConfig.updateCheckEnabled);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribeDashboard();
    process.stdout.off("resize", render);
    process.off("uncaughtExceptionMonitor", restoreTerminal);
    process.off("exit", restoreTerminal);
    restoreTerminal();
    pricingGuard.stopPeriodic();
    await app.close();
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
  dashboard.start();
}

main().catch(async (error: unknown) => {
  await cleanupStartupFailure();
  console.error(`Bridge startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
