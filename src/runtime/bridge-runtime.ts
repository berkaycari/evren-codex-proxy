import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BridgeService } from "../bridge/bridge-service.js";
import { loadConfig, type BridgeConfig } from "../config.js";
import {
  EvrenClient,
  type EvrenCreditState,
  type EvrenTransport,
  type EvrenUpstreamActivity,
  type UpstreamModelObservation,
} from "../evren/client.js";
import { PricingGuard, type PricingState } from "../safety/pricing-guard.js";
import { SessionStore, type Session } from "../sessions/store.js";
import { buildServer } from "../server/app.js";
import { SafeLogger, type EventSink } from "../ui/logger.js";
import { UpdateChecker, type UpdateCheckState } from "../update/checker.js";
import { UsagePersistence } from "../usage/persistence.js";
import { UsageTracker, type DailyUsageSnapshot } from "../usage/tracker.js";
import { rebindRuntimeConfiguration } from "./configuration.js";

export type BridgeRuntimeStatus = "stopped" | "starting" | "running" | "error";

export interface BridgeRuntimeSnapshot {
  status: BridgeRuntimeStatus;
  host: "127.0.0.1";
  port?: number;
  model: string;
  pricing: PricingState;
  credits: EvrenCreditState;
  dailyUsage?: DailyUsageSnapshot;
  session?: Session;
  upstreamModelObservations?: UpstreamModelObservation[];
  activity?: EvrenUpstreamActivity;
  update: UpdateCheckState;
  errorCode?: "startup_failed";
}

type RuntimeEvrenClient = EvrenTransport & {
  getCreditState?(): EvrenCreditState;
  setEffectiveModel?(model: string): void;
  setRequestTimeoutMs?(timeoutMs: number): void;
};

export interface BridgeRuntimeOptions {
  apiKey: string;
  currentVersion: string;
  dataDir: string;
  logsDir: string;
  config?: BridgeConfig;
  modelOverride?: string;
  port?: number;
  localClientAuthToken?: string;
  dashboardEnabled?: boolean;
  debug?: boolean;
  consoleLogging?: boolean;
  client?: RuntimeEvrenClient;
  logger?: SafeLogger;
  updateChecker?: UpdateChecker;
}

export class BridgeRuntime {
  readonly config: BridgeConfig;
  readonly sessions: SessionStore;
  readonly usage: UsageTracker;
  readonly client: RuntimeEvrenClient;
  readonly pricingGuard: PricingGuard;
  readonly updateChecker: UpdateChecker;
  readonly logger: SafeLogger;
  readonly dashboardEnabled: boolean;

  private app: FastifyInstance;
  private status: BridgeRuntimeStatus = "stopped";
  private actualPort: number | undefined;
  private readonly listeners = new Set<(snapshot: BridgeRuntimeSnapshot) => void>();
  private unsubscribeLogger: (() => void) | undefined;
  private upstreamModelObservations: UpstreamModelObservation[] = [];
  private activity: EvrenUpstreamActivity | undefined;
  private startPromise: Promise<BridgeRuntimeSnapshot> | undefined;
  private stopPromise: Promise<void> | undefined;
  private updateCheckPromise: Promise<UpdateCheckState> | undefined;

  constructor(private readonly options: BridgeRuntimeOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("EVREN API key is required.");
    const loaded = options.config ? { ...options.config } : loadConfig();
    loaded.host = "127.0.0.1";
    if (options.modelOverride !== undefined) loaded.model = validateModelOverride(options.modelOverride);
    if (options.port !== undefined) loaded.port = validatePort(options.port);
    this.config = loaded;
    this.dashboardEnabled = options.dashboardEnabled ?? false;
    this.logger = options.logger ?? new SafeLogger(options.logsDir, {
      secrets: [apiKey, options.localClientAuthToken ?? ""],
      ...(options.debug === undefined ? {} : { debug: options.debug }),
      ...(options.consoleLogging === undefined ? {} : { console: options.consoleLogging }),
    });
    this.usage = new UsageTracker(new UsagePersistence(options.dataDir));
    this.sessions = new SessionStore(this.config.sessionTtlMinutes * 60_000);
    this.client = options.client ?? new EvrenClient({
      baseUrl: this.config.evrenBaseUrl,
      apiKey,
      model: this.config.model,
      timeoutMs: this.config.requestTimeoutMs,
      logger: this.logger,
      onUpstreamRequest: (observation) => this.recordUpstreamModel(observation),
      onUpstreamActivity: (activity) => this.recordUpstreamActivity(activity),
    });
    this.pricingGuard = new PricingGuard(this.client, this.config.model, this.logger);
    this.updateChecker = options.updateChecker ?? new UpdateChecker({
      enabled: this.config.updateCheckEnabled,
      currentVersion: options.currentVersion,
      logger: this.logger,
    });
    this.app = this.buildApp();
  }

  start(): Promise<BridgeRuntimeSnapshot> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  snapshot(): BridgeRuntimeSnapshot {
    const dailyUsage = this.safeUsageSnapshot();
    const session = this.sessions.getCurrent();
    return {
      status: this.status,
      host: "127.0.0.1",
      ...(this.actualPort === undefined ? {} : { port: this.actualPort }),
      model: this.config.model,
      pricing: this.pricingGuard.getState(),
      credits: this.client.getCreditState?.() ?? { uncertain: false },
      ...(dailyUsage === undefined ? {} : { dailyUsage }),
      ...(session === undefined ? {} : { session }),
      upstreamModelObservations: this.upstreamModelObservations.map((observation) => ({ ...observation })),
      ...(this.activity === undefined ? {} : { activity: { ...this.activity } }),
      update: this.updateChecker.getState(),
      ...(this.status === "error" ? { errorCode: "startup_failed" as const } : {}),
    };
  }

  subscribe(listener: (snapshot: BridgeRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshPricing(): Promise<PricingState> {
    const state = await this.pricingGuard.refresh();
    this.emit();
    return state;
  }

  async applyConfiguration(nextConfig: BridgeConfig): Promise<void> {
    nextConfig.host = "127.0.0.1";
    await rebindRuntimeConfiguration({
      currentConfig: this.config,
      nextConfig,
      getServer: () => this.app,
      setServer: (server) => { this.app = server; },
      buildServer: () => this.buildApp(),
      applyRuntimeValues: (config) => this.applyRuntimeValues(config),
    });
    this.actualPort = boundPort(this.app);
    this.emit();
  }

  private async startInternal(): Promise<BridgeRuntimeSnapshot> {
    if (this.status === "running") return this.snapshot();
    this.status = "starting";
    this.emit();
    try {
      await this.usage.initialize();
      await this.pricingGuard.refresh();
      this.pricingGuard.startPeriodic(this.config.pricingRefreshMinutes);
      await this.app.listen({ host: "127.0.0.1", port: this.config.port });
      this.actualPort = boundPort(this.app);
      this.config.port = this.actualPort;
      this.unsubscribeLogger = this.logger.subscribe(() => this.emit());
      this.status = "running";
      this.logger.log({
        event: "PROXY_STARTED",
        data: {
          host: "127.0.0.1",
          port: this.actualPort,
          model: this.config.model,
          pricingAllowed: this.pricingGuard.getState().allowed,
          localAuth: this.options.localClientAuthToken !== undefined,
        },
      });
      this.updateCheckPromise = this.updateChecker.checkOnce().then((update) => {
        this.emit();
        return update;
      });
      this.emit();
      return this.snapshot();
    } catch (error) {
      this.status = "error";
      this.pricingGuard.stopPeriodic();
      await this.app.close().catch(() => undefined);
      this.emit();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.unsubscribeLogger?.();
    this.unsubscribeLogger = undefined;
    this.pricingGuard.stopPeriodic();
    await this.updateCheckPromise?.catch(() => undefined);
    this.updateCheckPromise = undefined;
    await this.app.close().catch((error: unknown) => {
      if (this.status !== "stopped") throw error;
    });
    await this.logger.flush();
    this.status = "stopped";
    this.actualPort = undefined;
    this.listeners.clear();
  }

  private buildApp(): FastifyInstance {
    const bridge = new BridgeService({
      config: this.config,
      client: this.client,
      pricingGuard: this.pricingGuard,
      sessions: this.sessions,
      usage: this.usage,
      logger: this.logger,
      requireRequestedModel: this.options.localClientAuthToken !== undefined,
    });
    return buildServer({
      config: this.config,
      pricingGuard: this.pricingGuard,
      sessions: this.sessions,
      usage: this.usage,
      bridge,
      logger: this.logger,
      credits: { getCreditState: () => this.client.getCreditState?.() ?? { uncertain: false } },
      updateCheck: this.updateChecker,
      ...(this.options.localClientAuthToken === undefined
        ? {}
        : { localClientAuthToken: this.options.localClientAuthToken }),
    });
  }

  private applyRuntimeValues(nextConfig: BridgeConfig): void {
    if (nextConfig.model !== this.config.model) {
      if (!this.client.setEffectiveModel) {
        throw new Error("EVREN client cannot safely apply the requested model change.");
      }
      this.client.setEffectiveModel(nextConfig.model);
    }
    Object.assign(this.config, nextConfig, { host: "127.0.0.1" as const });
    this.client.setRequestTimeoutMs?.(nextConfig.requestTimeoutMs);
    this.sessions.setTtlMs(nextConfig.sessionTtlMinutes * 60_000);
    this.pricingGuard.startPeriodic(nextConfig.pricingRefreshMinutes);
    this.updateChecker.setEnabled(nextConfig.updateCheckEnabled);
  }

  private safeUsageSnapshot(): DailyUsageSnapshot | undefined {
    try {
      return this.usage.snapshot();
    } catch {
      return undefined;
    }
  }

  private recordUpstreamModel(observation: UpstreamModelObservation): void {
    const sameTurn = (candidate: UpstreamModelObservation): boolean => Boolean(
      observation.threadId
      && observation.turnId
      && candidate.threadId === observation.threadId
      && candidate.turnId === observation.turnId,
    );
    this.upstreamModelObservations = [
      ...this.upstreamModelObservations.filter((candidate) => !sameTurn(candidate)),
      { ...observation },
    ].slice(-100);
    this.logger.log({
      event: "UPSTREAM_MODEL_ROUTE",
      data: {
        bridgeModel: observation.bridgeModel,
        codexRequestedModel: observation.codexRequestedModel,
        upstreamModel: observation.upstreamModel,
        requestKind: observation.requestKind,
        inferenceNumber: observation.inferenceNumber,
      },
    });
    this.emit();
  }

  private recordUpstreamActivity(activity: EvrenUpstreamActivity): void {
    this.activity = { ...activity };
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Runtime observers must never interfere with Bridge processing.
      }
    }
  }
}

export function createBridgeRuntime(options: BridgeRuntimeOptions): BridgeRuntime {
  return new BridgeRuntime(options);
}

function boundPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Bridge did not expose a TCP listen address.");
  return (address as AddressInfo).port;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Bridge port must be an integer between 0 and 65535.");
  }
  return port;
}

function validateModelOverride(model: string): string {
  const value = model.trim();
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Bridge model override is invalid.");
  }
  return value;
}

export function defaultRuntimeDirectories(projectRoot: string): { dataDir: string; logsDir: string } {
  return {
    dataDir: path.join(projectRoot, "data"),
    logsDir: path.join(projectRoot, "logs"),
  };
}
