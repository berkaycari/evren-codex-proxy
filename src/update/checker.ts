import type { EventSink } from "../ui/logger.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/berkaycari/evren-codex-proxy/releases/latest";
const DEFAULT_TIMEOUT_MS = 3_000;

export type UpdateCheckStatus =
  | "not_checked"
  | "disabled"
  | "up_to_date"
  | "update_available"
  | "local_newer"
  | "offline"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "malformed_response"
  | "invalid_tag";

export interface UpdateCheckState {
  status: UpdateCheckStatus;
  checkedAt?: string;
  updateAvailableVersion?: string;
}

export class UpdateChecker {
  private state: UpdateCheckState;
  private checkPromise: Promise<UpdateCheckState> | undefined;
  private generation = 0;

  constructor(private readonly options: {
    enabled: boolean;
    currentVersion: string;
    logger: EventSink;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    this.state = { status: options.enabled ? "not_checked" : "disabled" };
  }

  getState(): UpdateCheckState {
    return { ...this.state };
  }

  setEnabled(enabled: boolean): boolean {
    if (this.options.enabled === enabled) return false;
    this.options.enabled = enabled;
    this.generation += 1;
    this.checkPromise = undefined;
    this.state = { status: enabled ? "not_checked" : "disabled" };
    return enabled;
  }

  checkOnce(): Promise<UpdateCheckState> {
    if (!this.options.enabled) return Promise.resolve(this.getState());
    this.checkPromise ??= this.performCheck(this.generation);
    return this.checkPromise;
  }

  private async performCheck(generation: number): Promise<UpdateCheckState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const fetchImpl = this.options.fetch ?? fetch;
      const response = await fetchImpl(LATEST_RELEASE_URL, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `evren-codex-bridge/${this.options.currentVersion}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        return this.finish(response.status === 403 || response.status === 429 ? "rate_limited" : "http_error", generation);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return this.finish("malformed_response", generation);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return this.finish("malformed_response", generation);
      }
      const release = payload as Record<string, unknown>;
      if (release.draft === true || release.prerelease === true) return this.finish("invalid_tag", generation);
      const latest = parseStableVersion(release.tag_name);
      const current = parseStableVersion(this.options.currentVersion);
      if (!latest || !current) return this.finish("invalid_tag", generation);
      const comparison = compareVersions(current.parts, latest.parts);
      if (comparison < 0) return this.finish("update_available", generation, latest.normalized);
      return this.finish(comparison > 0 ? "local_newer" : "up_to_date", generation);
    } catch (error) {
      return this.finish(error instanceof Error && error.name === "AbortError" ? "timeout" : "offline", generation);
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(status: UpdateCheckStatus, generation: number, updateAvailableVersion?: string): UpdateCheckState {
    if (generation !== this.generation) return this.getState();
    this.state = {
      status,
      checkedAt: new Date().toISOString(),
      ...(updateAvailableVersion === undefined ? {} : { updateAvailableVersion }),
    };
    if (status === "update_available") {
      this.options.logger.log({
        event: "UPDATE_AVAILABLE",
        message: `Update available: v${updateAvailableVersion}.`,
        data: { version: updateAvailableVersion },
      });
    } else if (status === "up_to_date" || status === "local_newer") {
      this.options.logger.log({ event: "UPDATE_CHECK_OK", data: { status } });
    } else {
      this.options.logger.log({
        event: "UPDATE_CHECK_UNAVAILABLE",
        level: "warn",
        message: `Update check unavailable (${status}); bridge readiness and inference are unaffected.`,
        data: { status },
      });
    }
    return this.getState();
  }
}

function parseStableVersion(value: unknown): { normalized: string; parts: [number, number, number] } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  return { normalized: parts.join("."), parts };
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}
