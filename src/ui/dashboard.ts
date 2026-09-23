import type { PricingState } from "../safety/pricing-guard.js";
import type { Session } from "../sessions/store.js";
import type { EvrenCreditState } from "../evren/client.js";
import type { DailyUsageSnapshot } from "../usage/tracker.js";
import type { RecentLogEvent } from "./logger.js";

const green = "\u001b[32m";
const red = "\u001b[31m";
const yellow = "\u001b[33m";
const cyan = "\u001b[36m";
const brightCyan = "\u001b[96m";
const gray = "\u001b[90m";
const bold = "\u001b[1m";
const reset = "\u001b[0m";
const enterAlternateScreen = "\u001b[?1049h";
const leaveAlternateScreen = "\u001b[?1049l";
const hideCursor = "\u001b[?25l";
const showCursor = "\u001b[?25h";
const clearAndHome = "\u001b[2J\u001b[H";

interface DashboardLogSource {
  getRecent(): ReadonlyArray<RecentLogEvent>;
}

export interface DashboardTerminal {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): unknown;
}

interface DashboardOptions {
  terminal?: DashboardTerminal;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

export type DashboardStage = "READY" | "CODEX" | "EVREN" | "TOOL" | "RESULT" | "FINAL" | "ERROR";

export interface DashboardSnapshot {
  status: "ONLINE" | "BLOCKED" | "ERROR";
  listen: string;
  model: string;
  transport: "native" | "textual";
  version: string;
  pricing: PricingState;
  credits: EvrenCreditState;
  session?: Session;
  daily: DailyUsageSnapshot;
  limits: {
    requests: number;
    sessionTokens: number;
    dailyTokens: number;
    toolCalls: number;
  };
  lastAction: string;
}

export class Dashboard {
  private readonly terminal: DashboardTerminal;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private started = false;

  constructor(
    private readonly logger: DashboardLogSource,
    options: DashboardOptions = {},
  ) {
    this.terminal = options.terminal ?? process.stdout;
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || !this.isEnabled()) return;

    this.started = true;
    try {
      this.terminal.write(`${enterAlternateScreen}${hideCursor}${clearAndHome}`);
    } catch (error) {
      try {
        this.terminal.write(`${showCursor}${leaveAlternateScreen}`);
      } catch {
        // Preserve the original terminal write error.
      }
      this.started = false;
      throw error;
    }
  }

  render(snapshot: DashboardSnapshot): void {
    if (!this.started) return;
    const lines = buildDashboardLines(
      snapshot,
      this.logger.getRecent(),
      { columns: this.terminal.columns, rows: this.terminal.rows },
      this.now(),
    );
    this.terminal.write(`${clearAndHome}${lines.join("\n")}`);
  }

  stop(): void {
    if (!this.started) return;
    this.terminal.write(`${showCursor}${leaveAlternateScreen}`);
    this.started = false;
  }

  private isEnabled(): boolean {
    return this.terminal.isTTY === true && this.environment.NO_DASHBOARD !== "1";
  }
}

export function buildDashboardLines(
  snapshot: DashboardSnapshot,
  recent: ReadonlyArray<RecentLogEvent>,
  terminal: { columns?: number | undefined; rows?: number | undefined },
  nowMs: number,
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const maxRows = Math.max(1, Math.floor(terminal.rows ?? 30));
  const inner = width - 2;
  const session = snapshot.session;
  const requestCount = session?.requestCount ?? 0;
  const sessionTokens = session?.usage.totalTokens ?? 0;
  const tools = session?.toolCallCount ?? 0;
  const pricingText = snapshot.pricing.pricing
    ? `prompt ${snapshot.pricing.pricing.promptTokenPrice} · completion ${snapshot.pricing.pricing.completionTokenPrice} ${snapshot.pricing.pricing.currency}`
    : "unverified";
  const stage = deriveDashboardStage(recent);
  const lastUsage = session?.lastUsage
    ? `in ${formatNumber(session.lastUsage.inputTokens)} · out ${formatNumber(session.lastUsage.outputTokens)}`
    : "—";
  const statusColor = snapshot.status === "ONLINE" ? green : red;
  const header = fit(`EVREN CODEX BRIDGE · v${snapshot.version}`, inner);
  const status = boxedPair("●", snapshot.status, "Transport", snapshot.transport, inner);

  const box = [
    `╭${"─".repeat(inner)}╮`,
    `│${cyan}${center(header.trimEnd(), inner)}${reset}│`,
    divider(inner, "├", "┤"),
    colorFirst(status, `● ${snapshot.status}`, statusColor),
    colorFirst(boxedPair("Model", snapshot.model, "EVREN", snapshot.pricing.connected ? "connected" : "disconnected", inner), snapshot.pricing.connected ? "connected" : "disconnected", snapshot.pricing.connected ? green : red),
    boxedText(`Pricing  ${pricingText}`, inner),
    ...(snapshot.pricing.pricing?.freeUntil
      ? [boxedText(`Free until  ${snapshot.pricing.pricing.freeUntil}`, inner)]
      : []),
    boxedPair("Credits Held", formatCredit(snapshot.credits.held), "Remaining", formatCredit(snapshot.credits.remaining), inner),
    divider(inner, "├", "┤"),
    colorFirst(boxedText("FLOW", inner), "FLOW", cyan),
    decorateFlow(boxedText("READY → CODEX → EVREN → TOOL → RESULT → FINAL", inner), stage),
    decorateStage(boxedText(`Current  ${stage}`, inner), stage),
    divider(inner, "├", "┤"),
    boxedPair("Requests", `${formatNumber(requestCount)} / ${formatNumber(snapshot.limits.requests)}`, "Tools", `${formatNumber(tools)} / ${formatNumber(snapshot.limits.toolCalls)}`, inner),
    boxedPair("Session", `${formatNumber(sessionTokens)} / ${formatNumber(snapshot.limits.sessionTokens)}`, "Daily", `${formatNumber(snapshot.daily.totalTokens)} / ${formatNumber(snapshot.limits.dailyTokens)}`, inner),
    boxedPair("Usage", progress(sessionTokens, snapshot.limits.sessionTokens, Math.max(4, Math.floor(inner / 3))), "Last", lastUsage, inner),
    `╰${"─".repeat(inner)}╯`,
  ];
  const liveHeader = colorFirst(centerRule(`LIVE ACTIVITY · updated ${formatLocalTime(nowMs)}`, width), `updated ${formatLocalTime(nowMs)}`, gray);
  const availableRows = Math.max(0, maxRows - box.length - 1);
  const eventCount = Math.min(15, availableRows);
  const events = recent.slice(-eventCount).map((event) => formatActivity(event, width));
  if (availableRows > 0 && events.length === 0) events.push(colorFirst(fit("Waiting for Codex", width), "Waiting for Codex", gray));
  return [...box, liveHeader, ...events].slice(0, maxRows);
}

export function deriveDashboardStage(recent: ReadonlyArray<RecentLogEvent>): DashboardStage {
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const event = recent[index]?.event;
    if (!event) continue;
    if (event === "ERROR") return "ERROR";
    if (event === "RESPONSE_FINALIZED") return "FINAL";
    if (event === "TOOL_RESULT" || event === "NATIVE_TOOL_RESULT") return "RESULT";
    if (event === "TOOL_REQUEST" || event === "NATIVE_TOOL_REQUEST") return "TOOL";
    if (event === "EVREN_NATIVE_REQUEST" || event === "EVREN_NATIVE_RESPONSE" || event === "EVREN_REQUEST" || event === "EVREN_RESPONSE") return "EVREN";
    if (event === "CODEX_REQUEST") return "CODEX";
    if (event === "PROXY_STARTED" || event === "PRICING_CHECK_OK") return "READY";
  }
  return "READY";
}

function formatActivity(event: RecentLogEvent, width: number): string {
  const label = activityLabel(event.event);
  const detail = event.detail ? ` · ${sanitize(event.detail)}` : "";
  let line = fit(`${formatLocalTime(event.timestamp)}  ${label}${detail}`, width);
  line = colorFirst(line, formatLocalTime(event.timestamp), gray);
  const stage = activityStage(event.event);
  if (event.event === "WARN") return colorFirst(line, "WARN", yellow, true);
  if (!stage) return line;
  const color = event.event === "EVREN_NATIVE_RESPONSE" || event.event === "EVREN_RESPONSE"
    ? green
    : stageColor(stage);
  return colorFirst(line, stage, color, true);
}

function activityLabel(event: string): string {
  switch (event) {
    case "CODEX_REQUEST": return "→ CODEX";
    case "EVREN_NATIVE_REQUEST":
    case "EVREN_REQUEST": return "→ EVREN";
    case "EVREN_NATIVE_RESPONSE":
    case "EVREN_RESPONSE": return "← EVREN";
    case "TOOL_REQUEST":
    case "NATIVE_TOOL_REQUEST": return "⚙ TOOL";
    case "TOOL_RESULT":
    case "NATIVE_TOOL_RESULT": return "✓ RESULT";
    case "RESPONSE_FINALIZED": return "✓ FINAL";
    case "ERROR": return "✕ ERROR";
    case "WARN": return "! WARN";
    case "PROXY_STARTED":
    case "PRICING_CHECK_OK": return "● READY";
    default: return sanitize(event);
  }
}

function activityStage(event: string): DashboardStage | undefined {
  if (event === "CODEX_REQUEST") return "CODEX";
  if (event.startsWith("EVREN_")) return "EVREN";
  if (event === "TOOL_REQUEST" || event === "NATIVE_TOOL_REQUEST") return "TOOL";
  if (event === "TOOL_RESULT" || event === "NATIVE_TOOL_RESULT") return "RESULT";
  if (event === "RESPONSE_FINALIZED") return "FINAL";
  if (event === "ERROR") return "ERROR";
  if (event === "PROXY_STARTED" || event === "PRICING_CHECK_OK") return "READY";
  return undefined;
}

function boxedPair(leftLabel: string, leftValue: string, rightLabel: string, rightValue: string, inner: number): string {
  const content = inner >= 34
    ? `${leftLabel} ${leftValue}`.padEnd(Math.floor(inner / 2)) + `${rightLabel} ${rightValue}`
    : `${leftLabel} ${leftValue} · ${rightLabel} ${rightValue}`;
  return `│${fit(` ${content}`, inner)}│`;
}

function boxedText(text: string, inner: number): string {
  return `│${fit(` ${text}`, inner)}│`;
}

function progress(value: number, limit: number, width: number): string {
  const barWidth = Math.max(4, Math.min(12, width));
  const ratio = Math.min(1, value / Math.max(limit, 1));
  const filled = Math.round(ratio * barWidth);
  return `${"█".repeat(filled)}${"░".repeat(barWidth - filled)} ${Math.round(ratio * 100)}%`;
}

function divider(inner: number, left: string, right: string): string {
  return `${left}${"─".repeat(inner)}${right}`;
}

function center(text: string, width: number): string {
  const clean = sanitize(text).slice(0, width);
  const left = Math.floor((width - clean.length) / 2);
  return `${" ".repeat(left)}${clean}${" ".repeat(width - clean.length - left)}`;
}

function centerRule(text: string, width: number): string {
  const label = ` ${sanitize(text)} `;
  if (label.length >= width) return fit(label, width);
  const left = Math.floor((width - label.length) / 2);
  return `${"─".repeat(left)}${label}${"─".repeat(width - label.length - left)}`;
}

function decorateFlow(line: string, current: DashboardStage): string {
  let decorated = line;
  for (const stage of ["READY", "CODEX", "EVREN", "TOOL", "RESULT", "FINAL"] as const) {
    decorated = colorFirst(decorated, stage, stageColor(stage), stage === current);
  }
  return decorated;
}

function decorateStage(line: string, stage: DashboardStage): string {
  return colorFirst(line, stage, stageColor(stage), true);
}

function stageColor(stage: DashboardStage): string {
  if (stage === "READY" || stage === "RESULT" || stage === "FINAL") return green;
  if (stage === "CODEX") return cyan;
  if (stage === "EVREN") return brightCyan;
  if (stage === "TOOL") return yellow;
  return red;
}

function colorFirst(line: string, token: string, color: string, strong = false): string {
  if (!token || !line.includes(token)) return line;
  return line.replace(token, `${strong ? bold : ""}${color}${token}${reset}`);
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clean = sanitize(text);
  if (clean.length <= width) return clean.padEnd(width);
  if (width === 1) return clean.slice(0, 1);
  return `${clean.slice(0, width - 1)}…`;
}

function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export function formatLocalTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";

  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCredit(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(4)} CR`;
}
