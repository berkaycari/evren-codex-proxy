import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";
import { DesktopAppUpdateService } from "../src/desktop/main/app-update-service.js";

class MockUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

describe("Phase 3 Desktop application updates", () => {
  it("pins the updater package metadata to the official configured repository", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { build?: { publish?: unknown } };
    expect(packageJson.build?.publish).toEqual({ provider: "github", owner: "berkaycari", repo: "evren-codex-proxy", releaseType: "release" });
  });

  it("requires explicit download and install while blocking downgrade and install-on-quit", async () => {
    const updater = new MockUpdater();
    const service = new DesktopAppUpdateService(updater as unknown as AppUpdater, true);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    updater.emit("update-available", { version: "2.0.0", releaseNotes: "Verified release" });
    expect(service.snapshot()).toMatchObject({ status: "update_available", availableVersion: "2.0.0" });
    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    updater.emit("update-downloaded", { version: "2.0.0" });
    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("keeps the installed application usable when an anonymous update check fails", async () => {
    const updater = new MockUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("network failed"));
    const service = new DesktopAppUpdateService(updater as unknown as AppUpdater, true);
    await expect(service.check()).resolves.toEqual({ status: "error", technicalCode: "APP_UPDATE_CHECK_FAILED" });
    expect(updater.checkForUpdates).toHaveBeenCalledWith();
  });

  it("treats invalid release tags as a neutral unpublished-RC state", async () => {
    const updater = new MockUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("invalid tag"));
    const service = new DesktopAppUpdateService(updater as unknown as AppUpdater, true);
    await expect(service.check()).resolves.toEqual({ status: "unpublished", technicalCode: "APP_UPDATE_SOURCE_UNPUBLISHED" });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not invoke the provider when Desktop update checks are disabled", async () => {
    const updater = new MockUpdater();
    const service = new DesktopAppUpdateService(updater as unknown as AppUpdater, false);
    await expect(service.check()).resolves.toEqual({ status: "disabled" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
