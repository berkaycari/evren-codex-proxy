import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  event: string;
  level?: LogLevel;
  message?: string;
  data?: Record<string, unknown>;
}

export interface EventSink {
  log(event: LogEvent): void;
}

export interface RecentLogEvent {
  timestamp: string;
  event: string;
  detail?: string;
}

interface RecentEventCandidate extends RecentLogEvent {
  dedupe?: {
    key: string;
    source: "native" | "canonical";
  };
}

const SECRET_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api_key",
  "apikey",
  "evren_api_key",
]);

export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets.filter(Boolean)) {
      result = result.split(secret).join("[REDACTED]");
    }
    return result
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(item, secrets),
      ]),
    );
  }
  return value;
}

function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class SafeLogger implements EventSink {
  private readonly secrets: string[];
  private readonly debugEnabled: boolean;
  private readonly recent: RecentLogEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private lastToolActivity: { key: string; source: "native" | "canonical"; at: number } | undefined;

  constructor(
    private readonly logsDir: string,
    options: { secrets?: string[]; debug?: boolean; console?: boolean } = {},
  ) {
    this.secrets = options.secrets ?? [];
    this.debugEnabled = options.debug ?? process.env.DEBUG === "1";
    this.consoleEnabled = options.console ?? true;
  }

  private readonly consoleEnabled: boolean;

  log(entry: LogEvent): void {
    const level = entry.level ?? "info";
    if (level === "debug" && !this.debugEnabled) return;
    const now = new Date();
    const timestamp = now.toISOString();
    const safe = redact({ timestamp, ...entry, level }, this.secrets) as Record<string, unknown>;
    const candidate = recentEvent(entry, timestamp, this.secrets);
    if (!this.isDuplicateToolActivity(candidate, now.getTime())) {
      const { dedupe: _dedupe, ...recent } = candidate;
      this.recent.push(recent);
      if (this.recent.length > 100) this.recent.shift();
    }

    if (this.consoleEnabled && !process.stdout.isTTY) {
      const suffix = safe.message ? `: ${String(safe.message)}` : "";
      const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      target(`[${timestamp}] ${entry.event}${suffix}`);
    }

    void this.persist(safe).catch(() => {
      if (this.consoleEnabled) console.error(`[${timestamp}] LOG_WRITE_ERROR`);
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A terminal renderer must never interfere with bridge processing.
      }
    }
  }

  getRecent(): ReadonlyArray<RecentLogEvent> {
    return [...this.recent];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(entry: Record<string, unknown>): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    const file = path.join(this.logsDir, `bridge-${localDate()}.log`);
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private isDuplicateToolActivity(candidate: RecentEventCandidate, at: number): boolean {
    if (!candidate.dedupe) return false;
    const previous = this.lastToolActivity;
    this.lastToolActivity = { ...candidate.dedupe, at };
    return previous !== undefined
      && previous.key === candidate.dedupe.key
      && previous.source !== candidate.dedupe.source
      && at - previous.at <= 2_000;
  }
}

function recentEvent(entry: LogEvent, timestamp: string, secrets: string[]): RecentEventCandidate {
  const level = entry.level ?? "info";
  const isError = level === "error" || entry.event === "ERROR";
  const isWarning = level === "warn";
  const event = isError ? "ERROR" : isWarning ? "WARN" : canonicalDashboardEvent(entry.event);
  const detail = isError || isWarning
    ? safeMessage(entry.message, secrets)
    : safeEventDetail(entry, secrets);
  const dedupe = toolDedupe(entry, secrets);
  return {
    timestamp,
    event,
    ...(detail === undefined ? {} : { detail }),
    ...(dedupe === undefined ? {} : { dedupe }),
  };
}

function canonicalDashboardEvent(event: string): string {
  if (event === "NATIVE_TOOL_REQUEST") return "TOOL_REQUEST";
  if (event === "NATIVE_TOOL_RESULT") return "TOOL_RESULT";
  return sanitizeText(event, [], 80);
}

function safeEventDetail(entry: LogEvent, secrets: string[]): string | undefined {
  const data = entry.data;
  switch (entry.event) {
    case "CODEX_REQUEST": {
      const request = safeInteger(data?.request);
      const transport = data?.transport === "native" || data?.transport === "textual" ? data.transport : undefined;
      const toolCount = safeInteger(data?.toolCount);
      const inputEstimate = safeInteger(data?.inputEstimate);
      return joinDetail([
        request === undefined ? undefined : `#${request}`,
        transport,
        toolCount === undefined ? undefined : `tools=${toolCount}`,
        inputEstimate === undefined ? undefined : `≈${formatNumber(inputEstimate)}`,
      ]);
    }
    case "EVREN_NATIVE_REQUEST":
      return joinDetail([
        numberDetail("items", data?.inputItems),
        numberDetail("tools", data?.toolCount),
        numberDetail("max", data?.maxOutputTokens),
      ]);
    case "EVREN_NATIVE_RESPONSE":
      return joinDetail([
        numberDetail("items", data?.outputItems),
        typeof data?.hasUsage === "boolean" ? `usage=${data.hasUsage ? "yes" : "no"}` : undefined,
      ]);
    case "EVREN_REQUEST":
      return joinDetail(["textual", numberDetail("max", data?.maxOutputTokens)]);
    case "EVREN_RESPONSE":
      return joinDetail([
        "textual",
        typeof data?.hasUsage === "boolean" ? `usage=${data.hasUsage ? "yes" : "no"}` : undefined,
      ]);
    case "EVREN_USAGE":
      return joinDetail([
        safeInteger(data?.request) === undefined ? undefined : `#${formatNumber(safeInteger(data?.request)!)}`,
        numberDetail("in", data?.inputTokens),
        numberDetail("out", data?.outputTokens),
        numberDetail("bytes", data?.payloadBytes),
        numberDetail("items", data?.historyItems),
        numberDetail("tools", data?.toolCount),
      ]);
    case "NATIVE_TOOL_REQUEST":
    case "TOOL_REQUEST":
      return safeTool(data?.tool, secrets);
    case "NATIVE_TOOL_RESULT":
    case "TOOL_RESULT":
      return joinDetail([safeTool(data?.tool, secrets), numberDetail("chars", data?.chars)]);
    case "PRICING_CHECK_OK":
      return "0 CR verified";
    case "PROXY_STARTED":
      return "ready";
    case "RESPONSE_FINALIZED":
      return "completed";
    default:
      return undefined;
  }
}

function toolDedupe(entry: LogEvent, secrets: string[]): RecentEventCandidate["dedupe"] {
  const request = entry.event === "NATIVE_TOOL_REQUEST" || entry.event === "TOOL_REQUEST";
  const result = entry.event === "NATIVE_TOOL_RESULT" || entry.event === "TOOL_RESULT";
  if (!request && !result) return undefined;
  const tool = safeTool(entry.data?.tool, secrets);
  if (!tool) return undefined;
  const callId = typeof entry.data?.callId === "string" ? sanitizeText(entry.data.callId, secrets, 120) : "";
  return {
    key: `${request ? "request" : "result"}:${callId || tool}`,
    source: entry.event.startsWith("NATIVE_") ? "native" : "canonical",
  };
}

function safeMessage(message: string | undefined, secrets: string[]): string | undefined {
  if (!message) return undefined;
  return sanitizeText(message, secrets, 120)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function safeTool(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeText(value, secrets, 80);
  return clean || undefined;
}

function sanitizeText(value: string, secrets: string[], maxLength: number): string {
  return String(redact(value, secrets))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function numberDetail(label: string, value: unknown): string | undefined {
  const safe = safeInteger(value);
  return safe === undefined ? undefined : `${label}=${formatNumber(safe)}`;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function joinDetail(parts: Array<string | undefined>): string | undefined {
  const safe = parts.filter((part): part is string => Boolean(part));
  return safe.length > 0 ? safe.join(" · ") : undefined;
}

export const nullLogger: EventSink = { log: () => undefined };
