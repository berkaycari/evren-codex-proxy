import { createHash } from "node:crypto";
import type { NativeEvrenRequest } from "../bridge/native-codex-to-evren.js";

export const RETRY_CIRCUIT_FAILURE_THRESHOLD = 2;
export const RETRY_CIRCUIT_WINDOW_MS = 60_000;
export const RETRY_CIRCUIT_MAX_ENTRIES = 256;

interface FailureEntry {
  fingerprint: string;
  failureCode: string;
  failureTimes: number[];
  lastTouchedAt: number;
}

export class DeterministicRetryCircuit {
  private readonly entries = new Map<string, FailureEntry>();

  constructor(private readonly options: {
    threshold?: number;
    windowMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {}) {}

  assertAllowed(fingerprint: string): void {
    const now = this.now();
    this.prune(now);
    for (const entry of this.entries.values()) {
      if (entry.fingerprint === fingerprint && entry.failureTimes.length >= this.threshold) {
        throw new RetryCircuitBlockedError(entry.failureCode);
      }
    }
  }

  recordFailure(fingerprint: string, failureCode: string): void {
    const now = this.now();
    this.prune(now);
    const key = `${fingerprint}:${failureCode}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.failureTimes.push(now);
      existing.lastTouchedAt = now;
      return;
    }

    this.makeRoom();
    this.entries.set(key, {
      fingerprint,
      failureCode,
      failureTimes: [now],
      lastTouchedAt: now,
    });
  }

  recordSuccess(fingerprint: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.fingerprint === fingerprint) this.entries.delete(key);
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.entries) {
      entry.failureTimes = entry.failureTimes.filter((failureAt) => failureAt > cutoff);
      if (entry.failureTimes.length === 0) this.entries.delete(key);
    }
  }

  private makeRoom(): void {
    if (this.entries.size < this.maxEntries) return;
    let oldest: [string, FailureEntry] | undefined;
    for (const candidate of this.entries) {
      if (!oldest || candidate[1].lastTouchedAt < oldest[1].lastTouchedAt) oldest = candidate;
    }
    if (oldest) this.entries.delete(oldest[0]);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get threshold(): number {
    return this.options.threshold ?? RETRY_CIRCUIT_FAILURE_THRESHOLD;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? RETRY_CIRCUIT_WINDOW_MS;
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? RETRY_CIRCUIT_MAX_ENTRIES;
  }
}

export class RetryCircuitBlockedError extends Error {
  readonly code = "retry_circuit_blocked";

  constructor(readonly failureCode: string) {
    super("Repeated deterministic EVREN protocol failure; retry is temporarily blocked before inference.");
  }
}

export function fingerprintNativeEvrenRequest(request: NativeEvrenRequest): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}
