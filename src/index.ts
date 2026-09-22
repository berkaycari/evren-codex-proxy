import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeService } from "./bridge/bridge-service.js";
import { loadConfig } from "./config.js";
import { EvrenClient } from "./evren/client.js";
import { PricingGuard } from "./safety/pricing-guard.js";
import { SessionStore } from "./sessions/store.js";
import { buildServer } from "./server/app.js";
import { Dashboard } from "./ui/dashboard.js";
import { SafeLogger } from "./ui/logger.js";
import { UsagePersistence } from "./usage/persistence.js";
import { UsageTracker } from "./usage/tracker.js";

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
  const pricing = await pricingGuard.refresh();
  pricingGuard.startPeriodic(config.pricingRefreshMinutes);
  const bridge = new BridgeService({ config, client, pricingGuard, sessions, usage, logger });
  const app = buildServer({ config, pricingGuard, sessions, usage, bridge, logger });
  const dashboard = new Dashboard(logger);

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
  dashboard.start();
  process.once("exit", restoreTerminal);
  process.on("uncaughtExceptionMonitor", restoreTerminal);
  let lastDashboardFingerprint = "";

  const render = (): void => {
    const session = sessions.getLatest();
    const pricingState = pricingGuard.getState();
    const daily = usage.snapshot();
    const lastAction = logger.getRecent().at(-1)?.event ?? "Waiting for Codex";

    const status =
      pricingState.allowed && daily.accountingCertain
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
      session: session
        ? {
          id: session.id,
          requests: session.requestCount,
          toolCalls: session.toolCallCount,
          inputTokens: session.usage.inputTokens,
          outputTokens: session.usage.outputTokens,
          totalTokens: session.usage.totalTokens,
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
      ...(session === undefined ? {} : { session }),
      daily,
      limits: {
        requests: config.maxRequestsPerSession,
        sessionTokens: config.maxSessionTokens,
        dailyTokens: config.maxDailyTokens,
        toolCalls: config.maxToolCallsPerSession,
      },
      lastAction,
    });
  };

  const unsubscribeDashboard = logger.subscribe(render);
  process.stdout.on("resize", render);
  logger.log({
    event: "PROXY_STARTED",
    data: { host: config.host, port: config.port, model: config.model, pricingAllowed: pricing.allowed },
  });
  render();

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
  const handleShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      restoreTerminal();
      console.error(`Bridge shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

main().catch(async (error: unknown) => {
  await cleanupStartupFailure();
  console.error(`Bridge startup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
