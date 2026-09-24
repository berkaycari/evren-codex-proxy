import type { EvrenUsage } from "../evren/extract-response.js";
import { localDate, UsagePersistence, type PersistedDailyUsage } from "./persistence.js";
import { addUsage, type ClassifiedUsageTotals, type RequestClassification } from "./types.js";

export interface DailyUsageSnapshot {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  classified?: ClassifiedUsageTotals;
  accountingCertain: boolean;
}

export class UsageTracker {
  private current?: PersistedDailyUsage;
  private certain = true;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: UsagePersistence,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    this.current = await this.persistence.load(localDate(this.now()));
  }

  snapshot(): DailyUsageSnapshot {
    const usage = this.requireCurrent();
    return {
      date: usage.date,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      classified: structuredClone(usage.classified),
      accountingCertain: this.certain,
    };
  }

  assertCertain(): void {
    if (!this.certain) throw new AccountingUncertainError();
  }

  markUncertain(): void {
    this.certain = false;
  }

  async record(
    responseId: string,
    usage: EvrenUsage,
    classification: RequestClassification = "unclassified",
  ): Promise<boolean> {
    let recorded = false;
    this.queue = this.queue.then(async () => {
      await this.rollDateIfNeeded();
      const current = this.requireCurrent();
      if (current.responseIds.includes(responseId)) return;
      current.responseIds.push(responseId);
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.totalTokens += usage.totalTokens;
      addUsage(current.classified[classification], usage);
      current.updatedAt = this.now().toISOString();
      await this.persistence.save(current);
      recorded = true;
    });
    await this.queue;
    return recorded;
  }

  private async rollDateIfNeeded(): Promise<void> {
    const date = localDate(this.now());
    if (this.current?.date !== date) this.current = await this.persistence.load(date);
  }

  private requireCurrent(): PersistedDailyUsage {
    if (!this.current) throw new Error("UsageTracker is not initialized.");
    return this.current;
  }
}

export class AccountingUncertainError extends Error {
  readonly code = "usage_accounting_uncertain";
  constructor() {
    super("EVREN usage accounting is uncertain because a response omitted valid usage; inference is blocked until restart.");
  }
}
