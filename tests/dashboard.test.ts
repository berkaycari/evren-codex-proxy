import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildHelpLines,
  buildDashboardLines,
  Dashboard,
  deriveDashboardStage,
  formatLocalTime,
  parseDashboardKeys,
  type DashboardConfigurationRequest,
  type DashboardInput,
  type DashboardSnapshot,
  type DashboardTerminal,
} from "../src/ui/dashboard.js";
import { SafeLogger } from "../src/ui/logger.js";
import { SessionStore } from "../src/sessions/store.js";

const snapshot: DashboardSnapshot = {
  status: "ONLINE",
  listen: "127.0.0.1:8787",
  model: "deepseek-v4.1-flash",
  transport: "native",
  version: "1.2.0",
  pricing: {
    allowed: true,
    connected: true,
    checkedAt: "2026-09-21T12:00:00.000Z",
    pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
  },
  credits: { held: 0, remaining: 1_000, uncertain: false },
  daily: {
    date: "2026-09-21",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    accountingCertain: true,
  },
  limits: {
    requests: 100,
    sessionTokens: 1_000,
    dailyTokens: 10_000_000,
    toolCalls: 20,
    outputTokens: 4_096,
    pollWarning: 3,
    pollHardCap: 0,
  },
  preset: "Custom/current",
  lastAction: "WAITING",
};

describe("dashboard", () => {
  it("keeps the dashboard above a terminal-sized bounded live log", () => {
    const events = Array.from({ length: 30 }, (_, index) => ({
      timestamp: `2026-09-21T12:00:${String(index).padStart(2, "0")}.000Z`,
      event: `EVENT_${index}`,
    }));
    const now = new Date(2026, 8, 21, 17, 13, 16).getTime();
    const lines = buildDashboardLines(snapshot, events, { columns: 60, rows: 22 }, now);

    expect(lines[0]).toHaveLength(60);
    expect(lines.some((line) => line.includes("EVREN CODEX BRIDGE"))).toBe(true);
    expect(lines.some((line) => line.includes("0 / 10,000,000"))).toBe(true);
    expect(stripAnsi(lines.join("\n"))).toContain("LIVE ACTIVITY · updated 17:13:16");
    expect(lines).toHaveLength(22);
    expect(lines.at(-1)).toContain("EVENT_29");
  });

  it("bounds every rendered line and row count to a narrow terminal", () => {
    const lines = buildDashboardLines(snapshot, [], { columns: 12, rows: 8 }, Date.now());

    expect(lines).toHaveLength(8);
    expect(lines.every((line) => stripAnsi(line).length <= 12)).toBe(true);
  });

  it("parses only F1 for Help plus configuration navigation and raw Ctrl+C", () => {
    expect(parseDashboardKeys("\u001bOP")).toEqual(["help"]);
    expect(parseDashboardKeys("\u001b[11~")).toEqual(["help"]);
    expect(parseDashboardKeys("?Hh")).toEqual([]);
    expect(parseDashboardKeys("\u001b[A\u001b[B\r")).toEqual(["up", "down", "enter"]);
    expect(parseDashboardKeys("\r\n")).toEqual(["enter"]);
    expect(parseDashboardKeys("\u001bBbCc\u0003")).toEqual([
      "back", "back", "back", "configure", "configure", "interrupt",
    ]);
    expect(parseDashboardKeys("Rr")).toEqual(["recover", "recover"]);
  });

  it("shows limit recovery, applies only its recommended field, and respects environment precedence", async () => {
    const terminal = fakeTerminal({ isTTY: true, columns: 72, rows: 20 });
    const input = fakeInput();
    const session = new SessionStore(60_000).resolve();
    session.limitRecovery = {
      limitName: "MAX_SESSION_TOKENS",
      current: 1_200_000,
      limit: 1_200_000,
      recommended: 3_000_000,
      blockedAt: new Date(),
      recoverable: true,
    };
    const onConfigure = vi.fn();
    const recoverySnapshot: DashboardSnapshot = {
      ...snapshot,
      session,
      customConfiguration: {
        maxSessionTokens: 1_200_000,
        maxDailyTokens: 10_000_000,
        maxSessionCredits: 0,
        maxDailyCredits: 0,
        minCreditsRemaining: 0,
        maxRequestsPerSession: 60,
        maxToolCallsPerSession: 80,
        maxEstimatedInputTokensPerCall: 80_000,
        maxOutputTokensPerCall: 4_096,
        sessionTtlMinutes: 30,
        toolOutputMaxChars: 50_000,
        toolPollWarningThreshold: 3,
        maxConsecutiveToolPollInferences: 0,
        pricingRefreshMinutes: 10,
        requestTimeoutMs: 120_000,
        updateCheckEnabled: true,
      },
    };
    const dashboard = new Dashboard({ getRecent: () => [] }, {
      terminal,
      input,
      environment: { MAX_SESSION_TOKENS: "1200000" },
      onConfigure,
    });
    dashboard.render(recoverySnapshot);
    dashboard.start();
    const rendered = stripAnsi(terminal.output.at(-1) ?? "");
    expect(rendered).toContain("LIMIT REACHED");
    expect(rendered).toContain("[R] Önerilen limiti yükselt → 3,000,000");
    input.emit("r");
    expect(onConfigure).not.toHaveBeenCalled();
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("environment tarafından yönetiliyor");
    dashboard.stop();

    const liveTerminal = fakeTerminal({ isTTY: true, columns: 72, rows: 20 });
    const liveInput = fakeInput();
    const liveConfigure = vi.fn().mockResolvedValue({ status: "applied", preset: "Custom" });
    const liveDashboard = new Dashboard({ getRecent: () => [] }, {
      terminal: liveTerminal,
      input: liveInput,
      environment: {},
      onConfigure: liveConfigure,
    });
    liveDashboard.render(recoverySnapshot);
    liveDashboard.start();
    liveInput.emit("r");
    expect(liveConfigure).toHaveBeenCalledWith({
      preset: "Custom",
      recoveryLimitName: "MAX_SESSION_TOKENS",
      customConfiguration: {
        ...recoverySnapshot.customConfiguration!,
        maxSessionTokens: 3_000_000,
      },
    });
    await Promise.resolve();
    liveDashboard.stop();
  });

  it("renders compact second-terminal instructions and effective configuration without secrets", () => {
    const rendered = stripAnsi(buildHelpLines(snapshot, { columns: 72, rows: 30 }).join("\n"));

    expect(rendered).toContain("EVREN CODEX BRIDGE — YARDIM");
    expect(rendered).toContain("HIZLI BAŞLANGIÇ");
    expect(rendered).toContain("İkinci bir terminal açın");
    expect(rendered).toContain("cd <proje-klasoru>");
    expect(rendered).toContain("codex --profile evren");
    expect(rendered).toContain("Codex terminaline yazın; bu panele yazmayın");
    expect(rendered).toContain("environment > config/local.json > config/defaults.json");
    expect(rendered).toContain("STANDART");
    expect(rendered).toContain("KODLAMA");
    expect(rendered).toContain("3000000 / 120 / 140");
    expect(rendered).toContain("ÖZEL");
    expect(rendered).toContain("Esc / B   Panele dön        C   Yapılandırma");
    expect(rendered).not.toContain("EVREN_API_KEY=");
    expect(rendered.split("\n")).toHaveLength(30);
  });

  it("renders UTC event timestamps and freshness with the same local-time formatter", () => {
    const localTime = new Date(2026, 8, 22, 17, 30, 27);
    const utcTimestamp = localTime.toISOString();
    const lines = buildDashboardLines(
      snapshot,
      [{ timestamp: utcTimestamp, event: "LOCAL_TIME_EVENT" }],
      { columns: 72, rows: 18 },
      localTime.getTime(),
    );

    expect(formatLocalTime(utcTimestamp)).toBe("17:30:27");
    expect(stripAnsi(lines.join("\n"))).toContain("LIVE ACTIVITY · updated 17:30:27");
    expect(stripAnsi(lines.join("\n"))).toContain("17:30:27  LOCAL_TIME_EVENT");
  });

  it("uses a safe fallback for invalid event timestamps", () => {
    const lines = buildDashboardLines(
      snapshot,
      [{ timestamp: "not-a-date", event: "INVALID_TIME_EVENT" }],
      { columns: 72, rows: 18 },
      Date.now(),
    );

    expect(stripAnsi(lines.join("\n"))).toContain("--:--:--  INVALID_TIME_EVENT");
  });

  it("derives the real FLOW progression and final state from events", () => {
    const events = [
      { timestamp: "2026-09-22T12:00:00.000Z", event: "PROXY_STARTED" },
      { timestamp: "2026-09-22T12:00:01.000Z", event: "CODEX_REQUEST" },
      { timestamp: "2026-09-22T12:00:02.000Z", event: "EVREN_NATIVE_REQUEST" },
      { timestamp: "2026-09-22T12:00:03.000Z", event: "TOOL_REQUEST" },
      { timestamp: "2026-09-22T12:00:04.000Z", event: "TOOL_RESULT" },
      { timestamp: "2026-09-22T12:00:05.000Z", event: "RESPONSE_FINALIZED" },
    ];

    expect(events.map((_, index) => deriveDashboardStage(events.slice(0, index + 1))))
      .toEqual(["READY", "CODEX", "EVREN", "TOOL", "RESULT", "FINAL"]);
    const lines = buildDashboardLines(snapshot, events, { columns: 72, rows: 24 }, Date.now());
    expect(stripAnsi(lines.join("\n"))).toContain("Current  FINAL");
    expect(stripAnsi(lines.join("\n"))).toContain("Last —");
  });

  it("keeps an active TOOL stage across pricing refresh and resumes normal transitions", () => {
    const active = [
      { timestamp: "2026-09-22T12:00:00.000Z", event: "CODEX_REQUEST" },
      { timestamp: "2026-09-22T12:00:01.000Z", event: "TOOL_REQUEST" },
      { timestamp: "2026-09-22T12:00:02.000Z", event: "PRICING_CHECK_OK", detail: "0 CR verified" },
    ];
    expect(deriveDashboardStage(active)).toBe("TOOL");
    expect(deriveDashboardStage([
      ...active,
      { timestamp: "2026-09-22T12:00:03.000Z", event: "TOOL_RESULT" },
    ])).toBe("RESULT");
    expect(deriveDashboardStage([
      ...active,
      { timestamp: "2026-09-22T12:00:03.000Z", event: "TOOL_RESULT" },
      { timestamp: "2026-09-22T12:00:04.000Z", event: "RESPONSE_FINALIZED" },
    ])).toBe("FINAL");
  });

  it("shows ERROR as the current and last state", () => {
    const events = [
      { timestamp: "2026-09-22T12:00:00.000Z", event: "CODEX_REQUEST" },
      { timestamp: "2026-09-22T12:00:01.000Z", event: "ERROR", detail: "safe failure" },
    ];

    expect(deriveDashboardStage(events)).toBe("ERROR");
    const rendered = stripAnsi(buildDashboardLines(snapshot, events, { columns: 72, rows: 24 }, Date.now()).join("\n"));
    expect(rendered).toContain("Current  ERROR");
    expect(rendered).toContain("Last —");
  });

  it.each(["native", "textual"] as const)("displays %s transport and package version", (transport) => {
    const lines = buildDashboardLines({ ...snapshot, transport }, [], { columns: 72, rows: 18 }, Date.now());
    const rendered = stripAnsi(lines.join("\n"));

    expect(rendered).toContain(`Transport ${transport}`);
    expect(rendered).toContain("EVREN CODEX BRIDGE · v1.2.0");
  });

  it("shows authoritative last usage, pricing metadata, and trusted credits without inventing price units", () => {
    const session = {
      id: "sess_usage",
      createdAt: new Date(),
      lastActivity: new Date(),
      requestCount: 3,
      inferenceCount: 4,
      usage: { inputTokens: 40_000, outputTokens: 500, totalTokens: 40_500 },
      usageByClass: {
        foreground: { inputTokens: 40_000, outputTokens: 500, totalTokens: 40_500 },
        internal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        unclassified: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
      lastUsage: { inputTokens: 20_731, outputTokens: 184, totalTokens: 20_915 },
      lastOutputBudgetSaturated: false,
      outputBudgetSaturationCount: 0,
      toolCallCount: 2,
      transcript: [],
      nativeHistory: [],
      context: { transcript: [], nativeHistory: [], compactionGeneration: 0 },
      contextObservability: {
        totalUpstreamPayloadBytes: 0,
        canonicalHistoryReplayBytes: 0,
        currentInputBytes: 0,
        toolCatalogBytes: 0,
        acceptedToolOutputReplayBytes: 0,
        currentActiveContextBytes: 0,
        peakActiveContextBytes: 0,
      },
      acceptedCompactionCount: 0,
      responseIds: new Set<string>(),
      accountedEvrenResponseIds: new Set<string>(),
      pendingToolCalls: new Map(),
      completedToolCalls: new Map(),
      tools: new Map(),
      polling: { totalPollInferences: 0, totalAuthoritativeTokens: 0 },
    };
    const rendered = stripAnsi(buildDashboardLines({
      ...snapshot,
      session,
      pricing: {
        ...snapshot.pricing,
        pricing: {
          promptTokenPrice: 0,
          completionTokenPrice: 0,
          currency: "CR",
          freeUntil: "2026-11-01",
        },
      },
    }, [], { columns: 72, rows: 24 }, Date.now()).join("\n"));

    expect(rendered).toContain("Pricing  FREE · prompt 0 · completion 0 CR");
    expect(rendered).toContain("Free until  2026-11-01");
    expect(rendered).toContain("Credits Held 0.0000 CR");
    expect(rendered).toContain("Remaining 1000.0000 CR");
    expect(rendered).toContain("Last in 20,731 · out 184");
    expect(rendered).not.toMatch(/CR\s*\/\s*(token|1K|1M)/i);
  });

  it("shows compact active poll usage and an available stable update", () => {
    const activeSession = {
      id: "sess_poll",
      createdAt: new Date(),
      lastActivity: new Date(),
      requestCount: 3,
      inferenceCount: 3,
      usage: { inputTokens: 72_700, outputTokens: 300, totalTokens: 73_000 },
      usageByClass: {
        foreground: { inputTokens: 72_700, outputTokens: 300, totalTokens: 73_000 },
        internal: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        unclassified: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
      lastOutputBudgetSaturated: false,
      outputBudgetSaturationCount: 0,
      toolCallCount: 3,
      transcript: [],
      nativeHistory: [],
      context: { transcript: [], nativeHistory: [], compactionGeneration: 0 },
      contextObservability: {
        totalUpstreamPayloadBytes: 0,
        canonicalHistoryReplayBytes: 0,
        currentInputBytes: 0,
        toolCatalogBytes: 0,
        acceptedToolOutputReplayBytes: 0,
        currentActiveContextBytes: 0,
        peakActiveContextBytes: 0,
      },
      acceptedCompactionCount: 0,
      responseIds: new Set<string>(),
      accountedEvrenResponseIds: new Set<string>(),
      pendingToolCalls: new Map(),
      completedToolCalls: new Map(),
      tools: new Map(),
      polling: {
        active: {
          toolName: "write_stdin",
          identityHash: "never-rendered",
          consecutivePolls: 3,
          authoritativeTokensSpent: 73_000,
          startedAt: new Date(),
          lastPollAt: new Date(),
          warningEmitted: true,
        },
        totalPollInferences: 3,
        totalAuthoritativeTokens: 73_000,
      },
    };
    const rendered = stripAnsi(buildDashboardLines({
      ...snapshot,
      session: activeSession,
      update: { status: "update_available", updateAvailableVersion: "1.2.0" },
    }, [], { columns: 72, rows: 26 }, Date.now()).join("\n"));
    expect(rendered).toContain("Polls 3 · 73k tokens");
    expect(rendered).toContain("Update available  v1.2.0");
    expect(rendered).not.toContain("never-rendered");
  });

  it("colors a successful EVREN response green without changing visible width", () => {
    const lines = buildDashboardLines(
      snapshot,
      [{ timestamp: "2026-09-22T12:00:00.000Z", event: "EVREN_NATIVE_RESPONSE", detail: "items=1 · usage=yes" }],
      { columns: 72, rows: 20 },
      Date.now(),
    );
    const activity = lines.find((line) => stripAnsi(line).includes("← EVREN"));

    expect(activity).toContain("\u001b[1m\u001b[32mEVREN\u001b[0m");
    expect(stripAnsi(activity ?? "").length).toBe(72);
  });

  it("enters and leaves alternate screen exactly once", () => {
    const terminal = fakeTerminal({ isTTY: true });
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal });

    dashboard.start();
    dashboard.start();
    dashboard.render(snapshot);
    dashboard.stop();
    dashboard.stop();

    expect(terminal.output.join("").match(/\u001b\[\?1049h/g)).toHaveLength(1);
    expect(terminal.output.join("").match(/\u001b\[\?25l/g)).toHaveLength(1);
    expect(terminal.output.join("").match(/\u001b\[\?25h/g)).toHaveLength(1);
    expect(terminal.output.join("").match(/\u001b\[\?1049l/g)).toHaveLength(1);
    expect(terminal.output[1]?.endsWith("\n")).toBe(false);
  });

  it("cycles Turkish Help and arrow-key Coding configuration without extra or duplicate input", async () => {
    const terminal = fakeTerminal({ isTTY: true, rows: 36 });
    const input = fakeInput();
    let dashboard!: Dashboard;
    const onConfigure = vi.fn().mockImplementation(async (request: DashboardConfigurationRequest) => {
      expect(request).toEqual({ preset: "Coding" });
      dashboard.render({
        ...snapshot,
        preset: "Coding",
        limits: {
          ...snapshot.limits,
          sessionTokens: 3_000_000,
          requests: 120,
          toolCalls: 140,
        },
      });
      return { status: "applied", preset: "Coding" } as const;
    });
    dashboard = new Dashboard(
      { getRecent: () => [] },
      { terminal, input, onConfigure },
    );

    dashboard.render(snapshot);
    dashboard.start();
    expect(input.listenerCount()).toBe(1);
    input.emit("?");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Yardım: F1");
    input.emit("hH");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Yardım: F1");
    input.emit("\u001bOP");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("EVREN CODEX BRIDGE — YARDIM");
    dashboard.render({ ...snapshot, lastAction: "BACKGROUND_UPDATE" });
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("EVREN CODEX BRIDGE — YARDIM");
    input.emit("c");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("EVREN CODEX BRIDGE — YAPILANDIRMA");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("> Standart");
    input.emit("\u001b[B");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("> Kodlama");
    input.emit("\u001b[A");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("> Standart");
    input.emit("\u001b[B\r");
    const preview = stripAnsi(terminal.output.at(-1) ?? "");
    expect(preview).toContain("KODLAMA PROFİLİ");
    expect(preview).toContain("Oturum token limiti : 3,000,000");
    expect(preview).toContain("İstek / oturum      : 120");
    expect(preview).toContain("Araç / oturum       : 140");
    expect(preview).toContain("Çıktı / istek       : 4,096");
    input.emit("\r");

    await vi.waitFor(() => expect(onConfigure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Yapılandırma uygulandı"));
    expect(input.listenerCount()).toBe(1);
    expect(input.rawModes).toEqual([true, false, true]);
    expect(terminal.output.join("").match(/\u001b\[\?1049h/g)).toHaveLength(2);
    expect(terminal.output.join("").match(/\u001b\[\?1049l/g)).toHaveLength(1);
    input.emit("\u001b[11~");
    const updatedHelp = stripAnsi(terminal.output.at(-1) ?? "");
    expect(updatedHelp).toContain("Profil  Kodlama");
    expect(updatedHelp).toContain("Oturum 3,000,000");
    expect(updatedHelp).toContain("İstek 120");
    input.emit("b");
    input.emit("\u001bOPc\u001b");
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Yapılandırma iptal edildi");

    dashboard.stop();
    expect(input.listenerCount()).toBe(0);
    expect(input.rawModes).toEqual([true, false, true, false]);
  });


  it("edits Custom configuration in the Node raw-mode loop and applies with one Enter", async () => {
    const terminal = fakeTerminal({ isTTY: true, rows: 36 });
    const input = fakeInput();
    const currentCustom = {
      maxSessionTokens: 800_000,
      maxDailyTokens: 10_000_000,
      maxSessionCredits: 0,
      maxDailyCredits: 0,
      minCreditsRemaining: 0,
      maxRequestsPerSession: 40,
      maxToolCallsPerSession: 60,
      maxEstimatedInputTokensPerCall: 80_000,
      maxOutputTokensPerCall: 4_096,
      sessionTtlMinutes: 30,
      toolOutputMaxChars: 50_000,
      toolPollWarningThreshold: 3,
      maxConsecutiveToolPollInferences: 0,
      pricingRefreshMinutes: 10,
      requestTimeoutMs: 120_000,
      updateCheckEnabled: true,
    };
    const customSnapshot: DashboardSnapshot = {
      ...snapshot,
      customConfiguration: currentCustom,
    };
    let dashboard!: Dashboard;
    const onConfigure = vi.fn().mockImplementation(async (request: DashboardConfigurationRequest) => {
      expect(request.preset).toBe("Custom");
      expect(request.customConfiguration).toMatchObject({
        maxSessionTokens: 1_200_000,
        maxDailyTokens: 10_000_000,
        maxRequestsPerSession: 60,
        maxToolCallsPerSession: 80,
        maxOutputTokensPerCall: 4_096,
        updateCheckEnabled: true,
      });
      dashboard.render({
        ...customSnapshot,
        preset: "Custom",
        limits: {
          ...customSnapshot.limits,
          sessionTokens: 1_200_000,
          requests: 60,
          toolCalls: 80,
        },
        customConfiguration: request.customConfiguration!,
      });
      return { status: "applied", preset: "Custom" } as const;
    });

    dashboard = new Dashboard(
      { getRecent: () => [] },
      { terminal, input, onConfigure },
    );
    dashboard.render(customSnapshot);
    dashboard.start();

    input.emit("\u001bOPc\u001b[B\u001b[B\r");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("EVREN CODEX BRIDGE — ÖZEL YAPILANDIRMA");

    input.emit("1200000\r");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Günlük token limiti");

    input.emit("\r");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("İstek / oturum");

    input.emit("60\r");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Araç / oturum");

    input.emit("80\r");
    expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Tahmini girdi/istek limiti");

    // Keep the remaining eleven numeric values with one Enter each.
    for (let index = 0; index < 11; index += 1) input.emit("\r");

    const updateField = stripAnsi(terminal.output.at(-1) ?? "");
    expect(updateField).toContain("Anonim güncelleme denetimi");
    input.emit("\r");

    const confirmation = stripAnsi(terminal.output.at(-1) ?? "");
    expect(confirmation).toContain("ÖZEL PROFİLİ");
    expect(confirmation).toContain("Oturum token limiti : 1,200,000");
    expect(confirmation).toContain("İstek / oturum      : 60");
    expect(confirmation).toContain("Araç / oturum       : 80");
    expect(confirmation).toContain("> Uygula");

    input.emit("\r");

    await vi.waitFor(() => expect(onConfigure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stripAnsi(terminal.output.at(-1) ?? "")).toContain("Yapılandırma uygulandı"));
    expect(input.listenerCount()).toBe(1);
    expect(input.rawModes).toEqual([true, false, true]);

    dashboard.stop();
    expect(input.listenerCount()).toBe(0);
  });

  it("cancels preset selection with Esc and preserves the previous effective snapshot", () => {
    const terminal = fakeTerminal({ isTTY: true, rows: 36 });
    const input = fakeInput();
    const onConfigure = vi.fn();
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal, input, onConfigure });
    dashboard.render(snapshot);
    dashboard.start();

    input.emit("\u001bOPc\u001b[B\u001b");

    expect(onConfigure).not.toHaveBeenCalled();
    const rendered = stripAnsi(terminal.output.at(-1) ?? "");
    expect(rendered).toContain("Yapılandırma iptal edildi");
    expect(rendered).toContain("0 / 1,000");
    dashboard.stop();
  });

  it("routes raw Ctrl+C to shutdown without opening Help", () => {
    const terminal = fakeTerminal({ isTTY: true });
    const input = fakeInput();
    const onInterrupt = vi.fn();
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal, input, onInterrupt });
    dashboard.render(snapshot);
    dashboard.start();

    input.emit("\u0003");

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(stripAnsi(terminal.output.at(-1) ?? "")).not.toContain("EVREN CODEX BRIDGE — YARDIM");
    dashboard.stop();
  });

  it("does not render before start", () => {
    const terminal = fakeTerminal({ isTTY: true });
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal });

    dashboard.render(snapshot);

    expect(terminal.output).toEqual([]);
  });

  it.each([
    { name: "dashboard disabled", isTTY: true, environment: { NO_DASHBOARD: "1" } },
    { name: "non-TTY output", isTTY: false, environment: {} },
  ])("writes no terminal controls for $name", ({ isTTY, environment }) => {
    const terminal = fakeTerminal({ isTTY });
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal, environment });

    dashboard.start();
    dashboard.render(snapshot);
    dashboard.stop();

    expect(terminal.output).toEqual([]);
  });

  it("keeps a non-TTY input untouched even when dashboard output is a TTY", () => {
    const terminal = fakeTerminal({ isTTY: true });
    const input = fakeInput(false);
    const dashboard = new Dashboard({ getRecent: () => [] }, { terminal, input });
    dashboard.render(snapshot);

    dashboard.start();

    expect(input.listenerCount()).toBe(0);
    expect(input.rawModes).toEqual([]);
    expect(stripAnsi(terminal.output.at(-1) ?? "")).not.toContain("Yardım: F1");
    dashboard.stop();
  });

  it("notifies only on events and keeps secrets and control characters out of recent TUI data", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "evren-dashboard-"));
    const logger = new SafeLogger(temp, { secrets: ["top-secret"], console: false });
    const listener = vi.fn();
    const unsubscribe = logger.subscribe(listener);
    logger.log({
      event: "TOOL_REQUEST",
      message: "raw output top-secret",
      data: { tool: "shell\u001b[2J-top-secret", rawPrompt: "must not appear" },
    });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.getRecent())).not.toContain("top-secret");
    expect(JSON.stringify(logger.getRecent())).not.toContain("raw output");
    expect(JSON.stringify(logger.getRecent())).not.toContain("rawPrompt");
    expect(logger.getRecent()[0]?.detail).toBe("shell?[2J-[REDACTED]");

    await vi.waitFor(async () => {
      const [logFile] = await readdir(temp);
      expect(logFile).toBeDefined();
      const persisted = JSON.parse(await readFile(path.join(temp, logFile!), "utf8")) as { timestamp: string };
      expect(persisted.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(persisted.timestamp).toISOString()).toBe(persisted.timestamp);
    });
  });

  it("allowlists activity metadata and deduplicates native/canonical tool pairs", () => {
    const logger = new SafeLogger(path.join(os.tmpdir(), `evren-dashboard-${Date.now()}`), {
      secrets: ["api-live-secret"],
      console: false,
    });
    logger.log({
      event: "CODEX_REQUEST",
      data: {
        request: 2,
        transport: "native",
        toolCount: 19,
        inputEstimate: 22_000,
        prompt: "private prompt",
        reasoning: "private reasoning",
        unknown: "private metadata",
      },
    });
    logger.log({
      event: "EVREN_NATIVE_REQUEST",
      data: { inputItems: 4, toolCount: 19, maxOutputTokens: 4_096, rawBody: "private body" },
    });
    logger.log({
      event: "NATIVE_TOOL_REQUEST",
      data: { tool: "exec_command", callId: "call-1", command: "Get-ChildItem Env:" },
    });
    logger.log({
      event: "TOOL_REQUEST",
      data: { tool: "exec_command", callId: "call-1", arguments: { command: "Get-ChildItem Env:" } },
    });
    logger.log({
      event: "NATIVE_TOOL_RESULT",
      data: { tool: "exec_command", callId: "call-1", chars: 238, output: "api-live-secret" },
    });
    logger.log({
      event: "TOOL_RESULT",
      data: { tool: "exec_command", callId: "call-1", chars: 238, output: "api-live-secret" },
    });

    const recent = logger.getRecent();
    const serialized = JSON.stringify(recent);
    expect(recent.filter((event) => event.event === "TOOL_REQUEST")).toHaveLength(1);
    expect(recent.filter((event) => event.event === "TOOL_RESULT")).toHaveLength(1);
    expect(recent[0]?.detail).toBe("#2 · native · tools=19 · ≈22,000");
    expect(recent[1]?.detail).toBe("items=4 · tools=19 · max=4,096");
    expect(recent.at(-1)?.detail).toBe("exec_command · chars=238");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("private metadata");
    expect(serialized).not.toContain("Get-ChildItem Env:");
    expect(serialized).not.toContain("api-live-secret");
  });

  it("redacts and truncates only safe error summaries", () => {
    const logger = new SafeLogger(path.join(os.tmpdir(), `evren-dashboard-error-${Date.now()}`), {
      secrets: ["known-secret"],
      console: false,
    });
    logger.log({
      event: "UPSTREAM_FAILED",
      level: "error",
      message: `Authorization: Bearer arbitrary-token known-secret ${"x".repeat(200)}`,
      data: { body: "raw upstream body", reasoning_text: "hidden" },
    });

    const serialized = JSON.stringify(logger.getRecent());
    expect(logger.getRecent()[0]?.event).toBe("ERROR");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("arbitrary-token");
    expect(serialized).not.toContain("known-secret");
    expect(serialized).not.toContain("raw upstream body");
    expect(serialized).not.toContain("reasoning_text");
    expect(logger.getRecent()[0]?.detail?.length).toBeLessThanOrEqual(120);
  });
});

function fakeTerminal(options: { isTTY: boolean; columns?: number; rows?: number }): DashboardTerminal & { output: string[] } {
  const output: string[] = [];
  return {
    isTTY: options.isTTY,
    columns: options.columns ?? 60,
    rows: options.rows ?? 22,
    output,
    write(chunk: string): boolean {
      output.push(chunk);
      return true;
    },
  };
}

function fakeInput(isTTY = true): DashboardInput & {
  rawModes: boolean[];
  emit(chunk: string): void;
  listenerCount(): number;
} {
  const listeners = new Set<(chunk: string | Buffer) => void>();
  const rawModes: boolean[] = [];
  let raw = false;
  let paused = true;
  return {
    isTTY,
    get isRaw() { return raw; },
    rawModes,
    isPaused: () => paused,
    setRawMode(mode: boolean) {
      raw = mode;
      rawModes.push(mode);
    },
    resume() { paused = false; },
    pause() { paused = true; },
    on(_event, listener) { listeners.add(listener); },
    off(_event, listener) { listeners.delete(listener); },
    emit(chunk: string) { for (const listener of listeners) listener(chunk); },
    listenerCount: () => listeners.size,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
