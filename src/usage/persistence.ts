import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyClassifiedUsageTotals,
  type ClassifiedUsageTotals,
  type UsageTotals,
} from "./types.js";

export interface PersistedDailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseIds: string[];
  classified: ClassifiedUsageTotals;
  updatedAt: string;
}

export class UsagePersistence {
  constructor(private readonly dataDir: string) {}

  async load(date: string): Promise<PersistedDailyUsage> {
    const file = this.filePath(date);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PersistedDailyUsage>;
      const totals = parsed as Partial<UsageTotals>;
      if (
        parsed.date !== date ||
        !validUsageTotals(totals) ||
        !Array.isArray(parsed.responseIds) || parsed.responseIds.some((id) => typeof id !== "string")
      ) throw new Error(`Usage file ${file} is invalid.`);
      const classified = parsed.classified === undefined
        ? {
          ...emptyClassifiedUsageTotals(),
          unclassified: {
            inputTokens: parsed.inputTokens!,
            outputTokens: parsed.outputTokens!,
            totalTokens: parsed.totalTokens!,
          },
        }
        : parseClassifiedUsage(parsed.classified, totals, file);
      return { ...(parsed as PersistedDailyUsage), classified };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        date,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        responseIds: [],
        classified: emptyClassifiedUsageTotals(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async save(usage: PersistedDailyUsage): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = this.filePath(usage.date);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(usage, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private filePath(date: string): string {
    return path.join(this.dataDir, `usage-${date}.json`);
  }
}

function parseClassifiedUsage(value: unknown, totals: UsageTotals, file: string): ClassifiedUsageTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Usage file ${file} has invalid classified usage.`);
  }
  const record = value as Record<string, unknown>;
  const classified = emptyClassifiedUsageTotals();
  for (const key of ["foreground", "internal", "unclassified"] as const) {
    const candidate = record[key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !validUsageTotals(candidate as Partial<UsageTotals>)) {
      throw new Error(`Usage file ${file} has invalid classified usage.`);
    }
    classified[key] = candidate as UsageTotals;
  }
  const sum = Object.values(classified).reduce((result, usage) => ({
    inputTokens: result.inputTokens + usage.inputTokens,
    outputTokens: result.outputTokens + usage.outputTokens,
    totalTokens: result.totalTokens + usage.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  if (sum.inputTokens !== totals.inputTokens
    || sum.outputTokens !== totals.outputTokens
    || sum.totalTokens !== totals.totalTokens) {
    throw new Error(`Usage file ${file} classified totals do not match authoritative totals.`);
  }
  return classified;
}

function validUsageTotals(value: Partial<UsageTotals>): value is UsageTotals {
  return Number.isSafeInteger(value.inputTokens) && (value.inputTokens ?? -1) >= 0
    && Number.isSafeInteger(value.outputTokens) && (value.outputTokens ?? -1) >= 0
    && Number.isSafeInteger(value.totalTokens) && (value.totalTokens ?? -1) >= 0
    && value.totalTokens === (value.inputTokens ?? 0) + (value.outputTokens ?? 0);
}

export function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
