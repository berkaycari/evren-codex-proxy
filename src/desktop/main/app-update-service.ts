import type { AppUpdater, UpdateCheckResult } from "electron-updater";

export type DesktopAppUpdateStatus = "not_checked" | "checking" | "up_to_date" | "update_available" | "downloading" | "downloaded" | "unpublished" | "error" | "disabled";

export interface DesktopAppUpdateSnapshot {
  status: DesktopAppUpdateStatus;
  availableVersion?: string;
  releaseNotes?: string;
  progressPercent?: number;
  technicalCode?: string;
}

export class DesktopAppUpdateService {
  private state: DesktopAppUpdateSnapshot;
  private readonly listeners = new Set<(state: DesktopAppUpdateSnapshot) => void>();

  constructor(private readonly updater: AppUpdater, enabled: boolean) {
    this.state = { status: enabled ? "not_checked" : "disabled" };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on("checking-for-update", () => this.set({ status: "checking" }));
    updater.on("update-not-available", () => this.set({ status: "up_to_date" }));
    updater.on("update-available", (info) => this.set({
      status: "update_available",
      availableVersion: info.version,
      ...(typeof info.releaseNotes === "string" ? { releaseNotes: info.releaseNotes.slice(0, 2_000) } : {}),
    }));
    updater.on("download-progress", (progress) => this.set({
      ...this.state,
      status: "downloading",
      progressPercent: Math.max(0, Math.min(100, progress.percent)),
    }));
    updater.on("update-downloaded", (info) => this.set({ status: "downloaded", availableVersion: info.version }));
    updater.on("error", (error) => this.set(updateFailure(error)));
  }

  snapshot(): DesktopAppUpdateSnapshot { return { ...this.state }; }
  subscribe(listener: (state: DesktopAppUpdateSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async check(): Promise<DesktopAppUpdateSnapshot> {
    if (this.state.status === "disabled") return this.snapshot();
    try {
      const result: UpdateCheckResult | null = await this.updater.checkForUpdates();
      if (!result && this.state.status === "checking") this.set({ status: "up_to_date" });
    } catch (error) {
      this.set(updateFailure(error));
    }
    return this.snapshot();
  }

  async download(): Promise<DesktopAppUpdateSnapshot> {
    if (this.state.status !== "update_available") throw Object.assign(new Error("No validated Desktop update is available."), { code: "APP_UPDATE_NOT_AVAILABLE" });
    await this.updater.downloadUpdate();
    return this.snapshot();
  }

  install(): void {
    if (this.state.status !== "downloaded") throw Object.assign(new Error("Desktop update is not ready to install."), { code: "APP_UPDATE_NOT_READY" });
    this.updater.quitAndInstall(false, true);
  }

  private set(state: DesktopAppUpdateSnapshot): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

function updateFailure(error: unknown): DesktopAppUpdateSnapshot {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/invalid\s+tag/i.test(detail)) {
    return { status: "unpublished", technicalCode: "APP_UPDATE_SOURCE_UNPUBLISHED" };
  }
  return { status: "error", technicalCode: "APP_UPDATE_CHECK_FAILED" };
}
