import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDashboardLines,
  Dashboard,
  deriveDashboardStage,
  formatLocalTime,
  type DashboardSnapshot,
  type DashboardTerminal,
} from "../src/ui/dashboard.js";
import { SafeLogger } from "../src/ui/logger.js";

const snapshot: DashboardSnapshot = {
  status: "ONLINE",
  listen: "127.0.0.1:8787",
  model: "deepseek-v4-flash",
  transport: "native",
  version: "1.0.0",
  pricing: {
    allowed: true,
    connected: true,
    checkedAt: "2026-09-21T12:00:00.000Z",
    pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
  },
  daily: {
    date: "2026-09-21",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    accountingCertain: true,
  },
  limits: { requests: 100, sessionTokens: 1_000, dailyTokens: 10_000_000, toolCalls: 20 },
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
    expect(stripAnsi(lines.join("\n"))).toContain("Last FINAL ✓");
  });

  it("shows ERROR as the current and last state", () => {
    const events = [
      { timestamp: "2026-09-22T12:00:00.000Z", event: "CODEX_REQUEST" },
      { timestamp: "2026-09-22T12:00:01.000Z", event: "ERROR", detail: "safe failure" },
    ];

    expect(deriveDashboardStage(events)).toBe("ERROR");
    const rendered = stripAnsi(buildDashboardLines(snapshot, events, { columns: 72, rows: 24 }, Date.now()).join("\n"));
    expect(rendered).toContain("Current  ERROR");
    expect(rendered).toContain("Last ERROR");
  });

  it.each(["native", "textual"] as const)("displays %s transport and package version", (transport) => {
    const lines = buildDashboardLines({ ...snapshot, transport }, [], { columns: 72, rows: 18 }, Date.now());
    const rendered = stripAnsi(lines.join("\n"));

    expect(rendered).toContain(`Transport ${transport}`);
    expect(rendered).toContain("v1.0.0");
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
