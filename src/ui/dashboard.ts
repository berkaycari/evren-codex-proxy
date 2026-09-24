import type { PricingState } from "../safety/pricing-guard.js";
import type { Session } from "../sessions/store.js";
import type { EvrenCreditState } from "../evren/client.js";
import type { DailyUsageSnapshot } from "../usage/tracker.js";
import type { RecentLogEvent } from "./logger.js";
import type { UpdateCheckState } from "../update/checker.js";

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

export interface DashboardInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  isPaused?(): boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface DashboardConfigurationResult {
  status: "applied" | "cancelled" | "failed";
  preset?: DashboardPreset;
}

export type DashboardPreset = "Standard" | "Coding" | "Custom";

export interface DashboardCustomConfiguration {
  maxSessionTokens: number;
  maxDailyTokens: number;
  maxRequestsPerSession: number;
  maxToolCallsPerSession: number;
  maxEstimatedInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  sessionTtlMinutes: number;
  toolOutputMaxChars: number;
  toolPollWarningThreshold: number;
  maxConsecutiveToolPollInferences: number;
  pricingRefreshMinutes: number;
  requestTimeoutMs: number;
  updateCheckEnabled: boolean;
}

export interface DashboardConfigurationRequest {
  preset: DashboardPreset;
  customConfiguration?: DashboardCustomConfiguration;
}

interface DashboardOptions {
  terminal?: DashboardTerminal;
  input?: DashboardInput;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  onConfigure?: (request: DashboardConfigurationRequest) => Promise<DashboardConfigurationResult>;
  onInterrupt?: () => void;
}

export type DashboardStage = "READY" | "CODEX" | "EVREN" | "TOOL" | "RESULT" | "FINAL" | "ERROR";

type CustomNumberKey = Exclude<keyof DashboardCustomConfiguration, "updateCheckEnabled">;

const customNumberFields: ReadonlyArray<{ key: CustomNumberKey; label: string; minimum: number }> = [
  { key: "maxSessionTokens", label: "Oturum token limiti", minimum: 1 },
  { key: "maxDailyTokens", label: "Günlük token limiti", minimum: 1 },
  { key: "maxRequestsPerSession", label: "İstek / oturum", minimum: 1 },
  { key: "maxToolCallsPerSession", label: "Araç / oturum", minimum: 1 },
  { key: "maxEstimatedInputTokensPerCall", label: "Tahmini girdi/istek limiti", minimum: 1 },
  { key: "maxOutputTokensPerCall", label: "Çıktı token/istek limiti", minimum: 1 },
  { key: "toolOutputMaxChars", label: "Araç çıktısı maks. karakter", minimum: 1 },
  { key: "toolPollWarningThreshold", label: "Poll uyarı eşiği", minimum: 1 },
  { key: "maxConsecutiveToolPollInferences", label: "Poll hard cap (0 kapatır)", minimum: 0 },
  { key: "sessionTtlMinutes", label: "Oturum TTL (dakika)", minimum: 1 },
  { key: "pricingRefreshMinutes", label: "Fiyat yenileme (dakika)", minimum: 1 },
  { key: "requestTimeoutMs", label: "İstek zaman aşımı (ms)", minimum: 1 },
];

const customFieldCount = customNumberFields.length + 1;

export interface DashboardSnapshot {
  status: "ONLINE" | "BLOCKED" | "ERROR";
  listen: string;
  model: string;
  transport: "native" | "textual";
  version: string;
  pricing: PricingState;
  credits: EvrenCreditState;
  update?: UpdateCheckState;
  session?: Session;
  daily: DailyUsageSnapshot;
  limits: {
    requests: number;
    sessionTokens: number;
    dailyTokens: number;
    toolCalls: number;
    outputTokens: number;
    pollWarning: number;
    pollHardCap: number;
  };
  preset: "Standard" | "Coding" | "Custom" | "Custom/current";
  lastAction: string;
  customConfiguration?: DashboardCustomConfiguration;
}

export class Dashboard {
  private readonly terminal: DashboardTerminal;
  private readonly input: DashboardInput;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly onConfigure: ((request: DashboardConfigurationRequest) => Promise<DashboardConfigurationResult>) | undefined;
  private readonly onInterrupt: (() => void) | undefined;
  private started = false;
  private screenActive = false;
  private inputAttached = false;
  private inputWasRaw = false;
  private inputWasPaused = true;
  private view: "dashboard" | "help" | "configuration-preset" | "configuration-custom" | "configuration-confirm" = "dashboard";
  private configurationPresetIndex = 0;
  private configurationConfirmIndex = 0;
  private pendingConfiguration: DashboardConfigurationRequest | undefined;
  private customConfiguration: DashboardCustomConfiguration | undefined;
  private customFieldIndex = 0;
  private customDraft = "";
  private customError: string | undefined;
  private configuring = false;
  private snapshot: DashboardSnapshot | undefined;
  private notice: string | undefined;
  private readonly handleInput = (chunk: string | Buffer): void => {
    if (this.view === "configuration-custom" && !this.configuring) {
      this.handleCustomInput(chunk);
      return;
    }
    for (const key of parseDashboardKeys(chunk)) this.handleKey(key);
  };

  constructor(
    private readonly logger: DashboardLogSource,
    options: DashboardOptions = {},
  ) {
    this.terminal = options.terminal ?? process.stdout;
    this.input = options.input ?? process.stdin;
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.onConfigure = options.onConfigure;
    this.onInterrupt = options.onInterrupt;
  }

  start(): void {
    if (this.started || !this.isEnabled()) return;

    this.started = true;
    try {
      this.enterScreen();
      this.draw();
    } catch (error) {
      this.restoreInput();
      this.restoreScreen();
      this.started = false;
      throw error;
    }
  }

  render(snapshot: DashboardSnapshot): void {
    this.snapshot = snapshot;
    this.draw();
  }

  stop(): void {
    if (!this.started) {
      this.configuring = false;
      return;
    }
    this.started = false;
    this.restoreInput();
    this.restoreScreen();
    this.configuring = false;
    this.view = "dashboard";
  }

  private draw(): void {
    if (!this.started || !this.screenActive || !this.snapshot) return;
    const terminal = { columns: this.terminal.columns, rows: this.terminal.rows };
    const lines = this.view === "help"
      ? buildHelpLines(this.snapshot, terminal)
      : this.view === "configuration-preset"
        ? buildConfigurationPresetLines(this.snapshot, terminal, this.configurationPresetIndex)
        : this.view === "configuration-custom" && this.customConfiguration
          ? buildConfigurationCustomLines(
            this.snapshot,
            terminal,
            this.customConfiguration,
            this.customFieldIndex,
            this.customDraft,
            this.customError,
          )
          : this.view === "configuration-confirm" && this.pendingConfiguration
            ? buildConfigurationConfirmationLines(
              this.snapshot,
              terminal,
              this.pendingConfiguration,
              this.configurationConfirmIndex,
            )
            : buildDashboardLines(
          this.snapshot,
          this.logger.getRecent(),
          terminal,
          this.now(),
          this.canInteract(),
          this.notice,
        );
    this.terminal.write(`${clearAndHome}${lines.join("\n")}`);
  }

  private handleKey(key: DashboardKey): void {
    if (key === "interrupt") {
      this.onInterrupt?.();
      return;
    }
    if (this.configuring) return;

    if (this.view === "dashboard") {
      if (key === "help") {
        this.notice = undefined;
        this.view = "help";
        this.draw();
      }
      return;
    }

    if (this.view === "help") {
      if (key === "back") {
        this.view = "dashboard";
        this.draw();
        return;
      }
      if (key === "configure" && this.onConfigure) {
        this.openConfigurationMenu();
      }
      return;
    }

    if (this.view === "configuration-preset") {
      if (key === "back") {
        this.cancelConfiguration();
      } else if (key === "up") {
        this.configurationPresetIndex = (this.configurationPresetIndex + 2) % 3;
        this.draw();
      } else if (key === "down") {
        this.configurationPresetIndex = (this.configurationPresetIndex + 1) % 3;
        this.draw();
      } else if (key === "enter") {
        const preset = (["Standard", "Coding", "Custom"] as const)[this.configurationPresetIndex]!;
        if (preset === "Custom") {
          this.openCustomConfiguration();
        } else {
          this.pendingConfiguration = { preset };
          this.configurationConfirmIndex = 0;
          this.view = "configuration-confirm";
          this.draw();
        }
      }
      return;
    }

    if (this.view !== "configuration-confirm") return;

    if (key === "back") {
      this.cancelConfiguration();
    } else if (key === "up" || key === "down") {
      this.configurationConfirmIndex = this.configurationConfirmIndex === 0 ? 1 : 0;
      this.draw();
    } else if (key === "enter") {
      if (this.configurationConfirmIndex === 0 && this.pendingConfiguration) {
        void this.configure(this.pendingConfiguration);
      } else {
        this.cancelConfiguration();
      }
    }
  }

  private openConfigurationMenu(): void {
    this.notice = undefined;
    this.configurationPresetIndex = 0;
    this.configurationConfirmIndex = 0;
    this.pendingConfiguration = undefined;
    this.customConfiguration = undefined;
    this.customFieldIndex = 0;
    this.customDraft = "";
    this.customError = undefined;
    this.view = "configuration-preset";
    this.draw();
  }

  private openCustomConfiguration(): void {
    if (!this.snapshot?.customConfiguration) {
      this.notice = "Özel yapılandırma açılamadı · etkin değerler okunamadı.";
      this.view = "dashboard";
      this.draw();
      return;
    }

    this.pendingConfiguration = undefined;
    this.customConfiguration = { ...this.snapshot.customConfiguration };
    this.customFieldIndex = 0;
    this.customDraft = "";
    this.customError = undefined;
    this.view = "configuration-custom";
    this.draw();
  }

  private handleCustomInput(chunk: string | Buffer): void {
    if (!this.customConfiguration) return;

    const input = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (let index = 0; index < input.length;) {
      if (input.startsWith("\u001b[A", index) || input.startsWith("\u001b[B", index)) {
        if (this.customFieldIndex === customNumberFields.length) {
          this.customConfiguration.updateCheckEnabled = !this.customConfiguration.updateCheckEnabled;
          this.customError = undefined;
          this.draw();
        }
        index += 3;
        continue;
      }

      if (input.startsWith("\r\n", index)) {
        this.acceptCustomField();
        index += 2;
        continue;
      }

      const value = input[index]!;
      if (value === "\u0003") {
        this.onInterrupt?.();
        return;
      }
      if (value === "\u001b") {
        this.cancelConfiguration();
        return;
      }
      if (value === "\r" || value === "\n") {
        this.acceptCustomField();
        index += 1;
        continue;
      }

      if (this.customFieldIndex < customNumberFields.length) {
        if (value >= "0" && value <= "9") {
          this.customDraft += value;
          this.customError = undefined;
          this.draw();
        } else if (value === "\u0008" || value === "\u007f") {
          this.customDraft = this.customDraft.slice(0, -1);
          this.customError = undefined;
          this.draw();
        }
      } else if (value === " " || value === "a" || value === "A" || value === "k" || value === "K") {
        this.customConfiguration.updateCheckEnabled = value === "a" || value === "A"
          ? true
          : value === "k" || value === "K"
            ? false
            : !this.customConfiguration.updateCheckEnabled;
        this.customError = undefined;
        this.draw();
      }

      index += 1;
    }
  }

  private acceptCustomField(): void {
    if (!this.customConfiguration) return;

    if (this.customFieldIndex < customNumberFields.length) {
      const field = customNumberFields[this.customFieldIndex]!;
      if (this.customDraft.length > 0) {
        const parsed = Number(this.customDraft);
        if (!Number.isSafeInteger(parsed) || parsed < field.minimum || parsed > 2_147_483_647) {
          this.customError = `${field.minimum} ile 2147483647 arasında tam sayı girin.`;
          this.draw();
          return;
        }
        this.customConfiguration[field.key] = parsed;
      }

      this.customFieldIndex += 1;
      this.customDraft = "";
      this.customError = undefined;
      this.draw();
      return;
    }

    const customConfiguration = { ...this.customConfiguration };
    this.pendingConfiguration = { preset: "Custom", customConfiguration };
    this.configurationConfirmIndex = 0;
    this.customDraft = "";
    this.customError = undefined;
    this.view = "configuration-confirm";
    this.draw();
  }

  private cancelConfiguration(): void {
    this.view = "dashboard";
    this.pendingConfiguration = undefined;
    this.customConfiguration = undefined;
    this.customDraft = "";
    this.customError = undefined;
    this.notice = "Yapılandırma iptal edildi · önceki ayarlar korundu.";
    this.draw();
  }

  private async configure(request: DashboardConfigurationRequest): Promise<void> {
    if (this.configuring || !this.onConfigure) return;
    this.configuring = true;
    this.restoreInput();
    this.restoreScreen();

    let result: DashboardConfigurationResult;
    try {
      result = await this.onConfigure(request);
    } catch {
      result = { status: "failed" };
    }

    if (!this.started) {
      this.configuring = false;
      return;
    }

    this.view = "dashboard";
    this.pendingConfiguration = undefined;
    this.customConfiguration = undefined;
    this.customDraft = "";
    this.customError = undefined;
    this.notice = result.status === "applied"
      ? `Yapılandırma uygulandı${result.preset ? ` · ${presetLabel(result.preset)}` : ""}. Etkin limitler için F1.`
      : result.status === "cancelled"
        ? "Yapılandırma iptal edildi · önceki ayarlar korundu."
        : "Yapılandırma başarısız · önceki ayarlar korundu.";

    try {
      this.enterScreen();
      this.draw();
    } catch {
      this.restoreInput();
      this.restoreScreen();
      this.started = false;
      this.onInterrupt?.();
    } finally {
      this.configuring = false;
    }
  }

  private enterScreen(): void {
    if (this.screenActive) return;
    this.terminal.write(`${enterAlternateScreen}${hideCursor}${clearAndHome}`);
    this.screenActive = true;
    this.attachInput();
  }

  private restoreScreen(): void {
    if (!this.screenActive) return;
    try {
      this.terminal.write(`${showCursor}${leaveAlternateScreen}`);
    } finally {
      this.screenActive = false;
    }
  }

  private attachInput(): void {
    if (this.inputAttached || !this.canInteract()) return;
    this.inputWasRaw = this.input.isRaw === true;
    this.inputWasPaused = this.input.isPaused?.() ?? true;
    try {
      this.input.setRawMode?.(true);
      this.input.on("data", this.handleInput);
      this.input.resume();
      this.inputAttached = true;
    } catch (error) {
      try {
        this.input.off("data", this.handleInput);
        this.input.setRawMode?.(this.inputWasRaw);
        if (this.inputWasPaused) this.input.pause();
      } catch {
        // Preserve the original input setup error.
      }
      throw error;
    }
  }

  private restoreInput(): void {
    if (!this.inputAttached) return;
    try {
      this.input.off("data", this.handleInput);
      this.input.setRawMode?.(this.inputWasRaw);
      if (this.inputWasPaused) this.input.pause();
    } finally {
      this.inputAttached = false;
    }
  }

  private canInteract(): boolean {
    return this.input.isTTY === true;
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
  showHelpHint = false,
  notice?: string,
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const maxRows = Math.max(1, Math.floor(terminal.rows ?? 30));
  const inner = width - 2;
  const session = snapshot.session;
  const requestCount = session?.requestCount ?? 0;
  const sessionTokens = session?.usage.totalTokens ?? 0;
  const tools = session?.toolCallCount ?? 0;
  const inferences = session?.inferenceCount ?? 0;
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
  const activePoll = session?.polling.active;

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
    ...(snapshot.update?.updateAvailableVersion
      ? [colorFirst(boxedText(`Update available  v${snapshot.update.updateAvailableVersion}`, inner), "Update available", yellow, true)]
      : []),
    divider(inner, "├", "┤"),
    colorFirst(boxedText("FLOW", inner), "FLOW", cyan),
    decorateFlow(boxedText("READY → CODEX → EVREN → TOOL → RESULT → FINAL", inner), stage),
    decorateStage(boxedText(`Current  ${stage}`, inner), stage),
    divider(inner, "├", "┤"),
    boxedPair("Requests", `${formatNumber(requestCount)} / ${formatNumber(snapshot.limits.requests)}`, "Tools", `${formatNumber(tools)} / ${formatNumber(snapshot.limits.toolCalls)}`, inner),
    ...(session ? [boxedPair(
      "Inferences",
      formatNumber(inferences),
      "Polls",
      activePoll
        ? `${formatNumber(activePoll.consecutivePolls)} · ${formatCompact(activePoll.authoritativeTokensSpent)} tokens`
        : "—",
      inner,
    )] : []),
    boxedPair("Session", `${formatNumber(sessionTokens)} / ${formatNumber(snapshot.limits.sessionTokens)}`, "Daily", `${formatNumber(snapshot.daily.totalTokens)} / ${formatNumber(snapshot.limits.dailyTokens)}`, inner),
    boxedPair("Usage", progress(sessionTokens, snapshot.limits.sessionTokens, Math.max(4, Math.floor(inner / 3))), "Last", lastUsage, inner),
    ...(showHelpHint ? [colorFirst(boxedText("Yardım: F1", inner), "F1", cyan, true)] : []),
    ...(notice ? [colorFirst(boxedText(notice, inner), "Yapılandırma", green, true)] : []),
    `╰${"─".repeat(inner)}╯`,
  ];
  const liveHeader = colorFirst(centerRule(`LIVE ACTIVITY · updated ${formatLocalTime(nowMs)}`, width), `updated ${formatLocalTime(nowMs)}`, gray);
  const availableRows = Math.max(0, maxRows - box.length - 1);
  const eventCount = Math.min(15, availableRows);
  const events = recent.slice(-eventCount).map((event) => formatActivity(event, width));
  if (availableRows > 0 && events.length === 0) events.push(colorFirst(fit("Waiting for Codex", width), "Waiting for Codex", gray));
  return [...box, liveHeader, ...events].slice(0, maxRows);
}

export type DashboardKey = "help" | "back" | "configure" | "interrupt" | "up" | "down" | "enter";

export function parseDashboardKeys(chunk: string | Buffer): DashboardKey[] {
  const input = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: DashboardKey[] = [];
  for (let index = 0; index < input.length;) {
    if (input.startsWith("\u001b[11~", index)) {
      keys.push("help");
      index += 5;
      continue;
    }
    if (input.startsWith("\u001bOP", index)) {
      keys.push("help");
      index += 3;
      continue;
    }
    if (input.startsWith("\u001b[A", index)) {
      keys.push("up");
      index += 3;
      continue;
    }
    if (input.startsWith("\u001b[B", index)) {
      keys.push("down");
      index += 3;
      continue;
    }
    if (input.startsWith("\r\n", index)) {
      keys.push("enter");
      index += 2;
      continue;
    }
    const value = input[index]!;
    if (value === "\u0003") keys.push("interrupt");
    else if (value === "\u001b") keys.push("back");
    else if (value === "b" || value === "B") keys.push("back");
    else if (value === "c" || value === "C") keys.push("configure");
    else if (value === "\r" || value === "\n") keys.push("enter");
    index += 1;
  }
  return keys;
}

export function buildHelpLines(
  snapshot: DashboardSnapshot,
  terminal: { columns?: number | undefined; rows?: number | undefined },
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const maxRows = Math.max(1, Math.floor(terminal.rows ?? 36));
  const inner = width - 2;
  const hardCap = snapshot.limits.pollHardCap === 0
    ? "Kapalı (0)"
    : formatNumber(snapshot.limits.pollHardCap);
  const lines = [
    `╭${"─".repeat(inner)}╮`,
    `│${cyan}${center("EVREN CODEX BRIDGE — YARDIM", inner)}${reset}│`,
    divider(inner, "├", "┤"),
    boxedText("HIZLI BAŞLANGIÇ", inner),
    boxedText("1. Bu bridge terminalini açık bırakın.", inner),
    boxedText("2. İkinci bir terminal açın.", inner),
    boxedText("3. Codex'in çalışacağı proje klasörüne gidin:", inner),
    boxedText("   cd <proje-klasoru>", inner),
    boxedText("4. Codex'i EVREN profiliyle başlatın:", inner),
    boxedText("   codex --profile evren", inner),
    boxedText("5. İsteğinizi Codex terminaline yazın; bu panele yazmayın.", inner),
    boxedText("Bridge terminali: durum, kullanım, güvenlik ve yapılandırma.", inner),
    boxedText("Yerel URL: http://127.0.0.1:8787/v1", inner),
    divider(inner, "├", "┤"),
    boxedText("YAPILANDIRMA", inner),
    boxedText(`Profil  ${presetLabel(snapshot.preset)}`, inner),
    boxedPair("Oturum", formatNumber(snapshot.limits.sessionTokens), "Günlük", formatNumber(snapshot.limits.dailyTokens), inner),
    boxedPair("İstek", formatNumber(snapshot.limits.requests), "Araç", formatNumber(snapshot.limits.toolCalls), inner),
    boxedText(`Çıktı/istek ${formatNumber(snapshot.limits.outputTokens)} · Poll uyarı ${formatNumber(snapshot.limits.pollWarning)} · hard cap ${hardCap}`, inner),
    boxedText("Öncelik: environment > config/local.json > config/defaults.json", inner),
    boxedText("EVREN_API_KEY yalnızca environment; local.json yerel/ignore edilir.", inner),
    boxedText("STANDART: 1200000 / 60 / 80; günlük 10000000; çıktı 4096.", inner),
    boxedText("KODLAMA: 3000000 / 120 / 140; günlük 10000000; çıktı 4096.", inner),
    boxedText("ÖZEL: desteklenen gizli olmayan alanları elle düzenler.", inner),
    boxedText("ÖNERİLER", inner),
    boxedText("Normalde Standart, büyük kodlama işleri için Kodlama kullanın.", inner),
    boxedText("Uzun komutlar poll/token kullanır; Polls değerini izleyin.", inner),
    divider(inner, "├", "┤"),
    boxedText("Esc / B   Panele dön        C   Yapılandırma", inner),
    `╰${"─".repeat(inner)}╯`,
  ];
  return lines.slice(0, maxRows);
}

export function buildConfigurationPresetLines(
  snapshot: DashboardSnapshot,
  terminal: { columns?: number | undefined; rows?: number | undefined },
  selectedIndex: number,
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const inner = width - 2;
  const options = ["Standart", "Kodlama", "Özel"];
  return [
    `╭${"─".repeat(inner)}╮`,
    `│${cyan}${center("EVREN CODEX BRIDGE — YAPILANDIRMA", inner)}${reset}│`,
    divider(inner, "├", "┤"),
    boxedText(`Model: ${snapshot.model}`, inner),
    boxedText("Presetler model yeteneğini artırmaz; yerel limitleri değiştirir.", inner),
    boxedText("↑/↓ ile seçin, Enter ile onaylayın, Esc ile çıkın.", inner),
    divider(inner, "├", "┤"),
    ...options.map((option, index) => menuLine(option, index === selectedIndex, inner)),
    `╰${"─".repeat(inner)}╯`,
  ];
}

export function buildConfigurationCustomLines(
  snapshot: DashboardSnapshot,
  terminal: { columns?: number | undefined; rows?: number | undefined },
  values: DashboardCustomConfiguration,
  fieldIndex: number,
  draft: string,
  error?: string,
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const inner = width - 2;
  const isBoolean = fieldIndex >= customNumberFields.length;
  const field = isBoolean ? undefined : customNumberFields[fieldIndex];
  const currentValue = field ? values[field.key] : undefined;
  const lines = [
    `╭${"─".repeat(inner)}╮`,
    `│${cyan}${center("EVREN CODEX BRIDGE — ÖZEL YAPILANDIRMA", inner)}${reset}│`,
    divider(inner, "├", "┤"),
    boxedText(`Model: ${snapshot.model}`, inner),
    boxedText(`Alan ${Math.min(fieldIndex + 1, customFieldCount)} / ${customFieldCount}`, inner),
    divider(inner, "├", "┤"),
  ];

  if (field) {
    lines.push(
      boxedText(`${field.label}`, inner),
      boxedText(`Geçerli: ${formatNumber(currentValue!)}`, inner),
      boxedText(`Yeni değer: ${draft || "(Enter = geçerli değeri koru)"}`, inner),
      boxedText("Rakamları yazın · Backspace siler · Enter onaylar · Esc iptal", inner),
    );
  } else {
    lines.push(
      boxedText("Anonim güncelleme denetimi", inner),
      boxedText(`Değer: ${values.updateCheckEnabled ? "Açık" : "Kapalı"}`, inner),
      boxedText("↑/↓ veya Space değiştirir · Enter onaylar · Esc iptal", inner),
    );
  }

  if (error) lines.push(colorFirst(boxedText(error, inner), error, yellow, true));
  lines.push(`╰${"─".repeat(inner)}╯`);
  return lines;
}

export function buildConfigurationConfirmationLines(
  snapshot: DashboardSnapshot,
  terminal: { columns?: number | undefined; rows?: number | undefined },
  request: DashboardConfigurationRequest | "Standard" | "Coding",
  selectedIndex: number,
): string[] {
  const width = Math.max(2, Math.min(72, Math.floor(terminal.columns ?? 72)));
  const inner = width - 2;
  const normalizedRequest: DashboardConfigurationRequest = typeof request === "string" ? { preset: request } : request;
  const preset = normalizedRequest.preset;
  const custom = normalizedRequest.customConfiguration;
  const sessionTokens = preset === "Standard"
    ? 1_200_000
    : preset === "Coding"
      ? 3_000_000
      : preset === "Custom" && custom
        ? custom.maxSessionTokens
        : snapshot.limits.sessionTokens;
  const dailyTokens = preset === "Standard" || preset === "Coding"
    ? 10_000_000
    : preset === "Custom" && custom
      ? custom.maxDailyTokens
      : snapshot.limits.dailyTokens;
  const requests = preset === "Standard"
    ? 60
    : preset === "Coding"
      ? 120
      : preset === "Custom" && custom
        ? custom.maxRequestsPerSession
        : snapshot.limits.requests;
  const tools = preset === "Standard"
    ? 80
    : preset === "Coding"
      ? 140
      : preset === "Custom" && custom
        ? custom.maxToolCallsPerSession
        : snapshot.limits.toolCalls;
  const outputTokens = preset === "Standard" || preset === "Coding"
    ? 4_096
    : preset === "Custom" && custom
      ? custom.maxOutputTokensPerCall
      : snapshot.limits.outputTokens;
  const pollWarning = preset === "Custom" && custom ? custom.toolPollWarningThreshold : snapshot.limits.pollWarning;
  const pollHardCapValue = preset === "Custom" && custom
    ? custom.maxConsecutiveToolPollInferences
    : snapshot.limits.pollHardCap;
  const hardCap = pollHardCapValue === 0 ? "Kapalı" : formatNumber(pollHardCapValue);

  return [
    `╭${"─".repeat(inner)}╮`,
    `│${cyan}${center(`${presetLabel(preset).toUpperCase()} PROFİLİ`, inner)}${reset}│`,
    divider(inner, "├", "┤"),
    boxedText(`Oturum token limiti : ${formatNumber(sessionTokens)}`, inner),
    boxedText(`Günlük token limiti : ${formatNumber(dailyTokens)}`, inner),
    boxedText(`İstek / oturum      : ${formatNumber(requests)}`, inner),
    boxedText(`Araç / oturum       : ${formatNumber(tools)}`, inner),
    boxedText(`Çıktı / istek       : ${formatNumber(outputTokens)}`, inner),
    boxedText(`Poll uyarı eşiği    : ${formatNumber(pollWarning)}`, inner),
    boxedText(`Poll hard cap       : ${hardCap}`, inner),
    divider(inner, "├", "┤"),
    boxedText("↑/↓ ile seçin, Enter ile onaylayın, Esc ile çıkın.", inner),
    menuLine("Uygula", selectedIndex === 0, inner),
    menuLine("Vazgeç", selectedIndex === 1, inner),
    `╰${"─".repeat(inner)}╯`,
  ];
}

function menuLine(label: string, selected: boolean, inner: number): string {
  const text = `${selected ? ">" : " "} ${label}`;
  const line = boxedText(text, inner);
  return selected ? colorFirst(line, text, brightCyan, true) : line;
}

function presetLabel(preset: DashboardSnapshot["preset"] | DashboardPreset): string {
  switch (preset) {
    case "Standard": return "Standart";
    case "Coding": return "Kodlama";
    case "Custom": return "Özel";
    default: return "Özel/geçerli";
  }
}

export function deriveDashboardStage(recent: ReadonlyArray<RecentLogEvent>): DashboardStage {
  let ready: DashboardStage = "READY";
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const event = recent[index]?.event;
    if (!event) continue;
    if (event === "ERROR") return "ERROR";
    if (event === "RESPONSE_FINALIZED") return "FINAL";
    if (event === "TOOL_RESULT" || event === "NATIVE_TOOL_RESULT") return "RESULT";
    if (event === "TOOL_REQUEST" || event === "NATIVE_TOOL_REQUEST") return "TOOL";
    if (event === "EVREN_NATIVE_REQUEST" || event === "EVREN_NATIVE_RESPONSE" || event === "EVREN_REQUEST" || event === "EVREN_RESPONSE") return "EVREN";
    if (event === "CODEX_REQUEST") return "CODEX";
    if (event === "PROXY_STARTED" || event === "PRICING_CHECK_OK") {
      ready = "READY";
      continue;
    }
  }
  return ready;
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

function formatCompact(value: number): string {
  if (value < 1_000) return formatNumber(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function formatCredit(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(4)} CR`;
}
