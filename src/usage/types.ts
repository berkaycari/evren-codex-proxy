import type { EvrenUsage } from "../evren/extract-response.js";

export type RequestClassification = "foreground" | "internal" | "unclassified";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type ClassifiedUsageTotals = Record<RequestClassification, UsageTotals>;

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function emptyClassifiedUsageTotals(): ClassifiedUsageTotals {
  return {
    foreground: emptyUsageTotals(),
    internal: emptyUsageTotals(),
    unclassified: emptyUsageTotals(),
  };
}

export function addUsage(target: UsageTotals, usage: EvrenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
}
