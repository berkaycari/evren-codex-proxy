import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PersistedDailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseIds: string[];
  updatedAt: string;
}

export class UsagePersistence {
  constructor(private readonly dataDir: string) {}

  async load(date: string): Promise<PersistedDailyUsage> {
    const file = this.filePath(date);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PersistedDailyUsage>;
      if (
        parsed.date !== date ||
        !Number.isSafeInteger(parsed.inputTokens) || (parsed.inputTokens ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.outputTokens) || (parsed.outputTokens ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.totalTokens) || (parsed.totalTokens ?? -1) < 0 ||
        parsed.totalTokens !== (parsed.inputTokens ?? 0) + (parsed.outputTokens ?? 0) ||
        !Array.isArray(parsed.responseIds) || parsed.responseIds.some((id) => typeof id !== "string")
      ) throw new Error(`Usage file ${file} is invalid.`);
      return parsed as PersistedDailyUsage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        date,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        responseIds: [],
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

export function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
