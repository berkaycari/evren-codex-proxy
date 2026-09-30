import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SafeDesktopSettingsDto, UsageLimitsInput } from "../shared/contracts.js";

export interface WindowBoundsSetting {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DesktopSettings {
  schemaVersion?: 2;
  theme?: "dark" | "light" | "navy";
  selectedModelId?: string;
  recentProjects?: string[];
  lastActiveProject?: string;
  lastSelectedThreadId?: string;
  windowBounds?: WindowBoundsSetting;
  startupBehavior?: "restore" | "home";
  recentProjectsEnabled?: boolean;
  desktopUpdateChecks?: boolean;
  runtimeUpdateChecks?: boolean;
  limits?: UsageLimitsInput;
}

export class DesktopSettingsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<DesktopSettings> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return parseDesktopSettings(value);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      return {};
    }
  }

  async save(settings: DesktopSettings): Promise<void> {
    const validated = parseDesktopSettings(settings);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const selectedModelId = safeModelId(record.selectedModelId);
  const recentProjects = parseRecentProjects(record.recentProjects);
  const lastActiveProject = safePath(record.lastActiveProject);
  const lastSelectedThreadId = safeOpaqueId(record.lastSelectedThreadId);
  const windowBounds = parseWindowBounds(record.windowBounds);
  const theme = record.theme === "dark" || record.theme === "light" || record.theme === "navy" ? record.theme : undefined;
  const startupBehavior = record.startupBehavior === "home" || record.startupBehavior === "restore" ? record.startupBehavior : undefined;
  const recentProjectsEnabled = typeof record.recentProjectsEnabled === "boolean" ? record.recentProjectsEnabled : undefined;
  const desktopUpdateChecks = typeof record.desktopUpdateChecks === "boolean" ? record.desktopUpdateChecks : undefined;
  const runtimeUpdateChecks = typeof record.runtimeUpdateChecks === "boolean" ? record.runtimeUpdateChecks : undefined;
  const limits = parseLimits(record.limits);
  return {
    ...(record.schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
    ...(selectedModelId === undefined ? {} : { selectedModelId }),
    ...(recentProjects.length === 0 ? {} : { recentProjects }),
    ...(lastActiveProject === undefined ? {} : { lastActiveProject }),
    ...(lastSelectedThreadId === undefined ? {} : { lastSelectedThreadId }),
    ...(windowBounds === undefined ? {} : { windowBounds }),
    ...(theme === undefined ? {} : { theme }),
    ...(startupBehavior === undefined ? {} : { startupBehavior }),
    ...(recentProjectsEnabled === undefined ? {} : { recentProjectsEnabled }),
    ...(desktopUpdateChecks === undefined ? {} : { desktopUpdateChecks }),
    ...(runtimeUpdateChecks === undefined ? {} : { runtimeUpdateChecks }),
    ...(limits === undefined ? {} : { limits }),
  };
}

export function safeDesktopSettings(settings: DesktopSettings, defaults: UsageLimitsInput): SafeDesktopSettingsDto {
  return {
    schemaVersion: 2,
    theme: settings.theme ?? "navy",
    startupBehavior: settings.startupBehavior ?? "restore",
    recentProjectsEnabled: settings.recentProjectsEnabled !== false,
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    desktopUpdateChecks: settings.desktopUpdateChecks !== false,
    runtimeUpdateChecks: settings.runtimeUpdateChecks !== false,
    limits: settings.limits ?? defaults,
  };
}

function parseLimits(value: unknown): UsageLimitsInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const preset = record.preset;
  if (preset !== "Standard" && preset !== "Coding" && preset !== "Custom") return undefined;
  const integerKeys = ["maxSessionTokens", "maxDailyTokens", "maxRequestsPerSession", "maxToolCallsPerSession"] as const;
  if (integerKeys.some((key) => !Number.isSafeInteger(record[key]) || (record[key] as number) <= 0)) return undefined;
  const decimalKeys = ["maxSessionCredits", "maxDailyCredits", "minCreditsRemaining"] as const;
  if (decimalKeys.some((key) => typeof record[key] !== "number" || !Number.isFinite(record[key]) || (record[key] as number) < 0)) return undefined;
  return {
    preset,
    maxSessionTokens: record.maxSessionTokens as number,
    maxDailyTokens: record.maxDailyTokens as number,
    maxRequestsPerSession: record.maxRequestsPerSession as number,
    maxToolCallsPerSession: record.maxToolCallsPerSession as number,
    maxSessionCredits: record.maxSessionCredits as number,
    maxDailyCredits: record.maxDailyCredits as number,
    minCreditsRemaining: record.minCreditsRemaining as number,
  };
}

function parseRecentProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const projectPath = safePath(candidate);
    const key = projectPath?.toLocaleLowerCase("en-US");
    if (!projectPath || !key || seen.has(key)) continue;
    seen.add(key);
    projects.push(projectPath);
    if (projects.length === 10) break;
  }
  return projects;
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  const result = path.normalize(value.trim());
  return result && result.length <= 32_000 && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

function safeOpaqueId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 300 && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 200 && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

function parseWindowBounds(value: unknown): WindowBoundsSetting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!validInteger(record.width, 800, 10_000) || !validInteger(record.height, 600, 10_000)) return undefined;
  const x = validInteger(record.x, -100_000, 100_000) ? record.x : undefined;
  const y = validInteger(record.y, -100_000, 100_000) ? record.y : undefined;
  return {
    width: record.width,
    height: record.height,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  };
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
