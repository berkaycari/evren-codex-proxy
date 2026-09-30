import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session } from "electron";
import electronUpdater from "electron-updater";
import { DesktopAppUpdateService } from "./app-update-service.js";
import { CredentialService } from "./credential-service.js";
import { DesktopController } from "./desktop-controller.js";
import { ElectronSafeStorageEncryption } from "./electron-safe-storage.js";
import { registerDesktopIpc } from "./ipc.js";
import { RuntimeUpdateService } from "./runtime-update.js";
import { DesktopSettingsStore } from "./settings-service.js";
import { configureWindowSecurity } from "./window-security.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const packageMetadata = JSON.parse(
  readFileSync(path.resolve(currentDirectory, "../../../package.json"), "utf8"),
) as { version?: unknown };
const version = typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown";
app.setName("EVREN Codex Bridge");
const smokeMode = process.env.EVREN_DESKTOP_SMOKE === "1";
const smokeUserData = process.env.EVREN_DESKTOP_SMOKE_USER_DATA;
const smokeResultFile = process.env.EVREN_DESKTOP_SMOKE_RESULT_FILE;
const simulateMissingPreload = smokeMode && process.env.EVREN_DESKTOP_SMOKE_PRELOAD_UNAVAILABLE === "1";
if (smokeMode) {
  if (!smokeUserData || !path.isAbsolute(smokeUserData)) throw new Error("Desktop smoke userData path is invalid.");
  if (smokeResultFile && (
    !path.isAbsolute(smokeResultFile)
    || path.dirname(path.resolve(smokeResultFile)) !== path.resolve(smokeUserData)
  )) throw new Error("Desktop smoke result path is invalid.");
  app.setPath("userData", smokeUserData);
}

let mainWindow: BrowserWindow | undefined;
let controller: DesktopController | undefined;
let unregisterIpc: (() => void) | undefined;
let quitAfterCleanup = false;

async function createWindow(): Promise<void> {
  const userData = app.getPath("userData");
  const settingsStore = new DesktopSettingsStore(path.join(userData, "settings.json"));
  const settings = await settingsStore.load();
  const bounds = settings.windowBounds;
  autoUpdater.logger = null;
  const appUpdater = new DesktopAppUpdateService(autoUpdater, app.isPackaged && settings.desktopUpdateChecks !== false);
  const preloadPath = path.resolve(
    currentDirectory,
    simulateMissingPreload ? "../preload/missing.cjs" : "../preload/index.cjs",
  );
  if (process.platform === "win32" || app.isPackaged) Menu.setApplicationMenu(null);
  const iconPath = path.resolve(currentDirectory, "../../../resources/branding/evren-codex-bridge.png");
  const window = new BrowserWindow({
    width: bounds?.width ?? 1180,
    height: bounds?.height ?? 760,
    ...(bounds?.x === undefined ? {} : { x: bounds.x }),
    ...(bounds?.y === undefined ? {} : { y: bounds.y }),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#08111f",
    autoHideMenuBar: process.platform === "win32",
    show: false,
    title: "EVREN Codex Bridge",
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  if (process.platform === "win32") window.setMenuBarVisibility(false);
  mainWindow = window;

  const developmentUrl = process.env.EVREN_DESKTOP_DEV_URL;
  const rendererPath = path.resolve(currentDirectory, "../../../dist-desktop/renderer/index.html");
  const allowedUrl = developmentUrl ?? pathToFileURL(rendererPath).toString();
  configureWindowSecurity(window, allowedUrl);
  configureContentSecurityPolicy(developmentUrl !== undefined);

  controller = new DesktopController({
    version,
    userDataDir: userData,
    cwd: process.cwd(),
    credentialService: new CredentialService(
      path.join(userData, "credentials.json"),
      new ElectronSafeStorageEncryption(),
    ),
    settingsStore,
    appPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appUpdater,
    ...(app.isPackaged ? { runtimeUpdater: new RuntimeUpdateService({ userDataDir: userData, desktopVersion: version }) } : {}),
    pickProject: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
      return result.canceled ? undefined : result.filePaths[0];
    },
    pickImage: async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [{ name: "Görseller", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    pickProjectFile: async (projectRoot) => {
      const result = await dialog.showOpenDialog(window, { properties: ["openFile"], defaultPath: projectRoot });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  unregisterIpc = registerDesktopIpc({ ipcMain, window, allowedUrl, controller });

  window.once("ready-to-show", () => { if (!smokeMode) window.show(); });
  window.on("close", () => {
    const size = window.getSize();
    const position = window.getPosition();
    void controller?.updateWindowBounds({ x: position[0]!, y: position[1]!, width: size[0]!, height: size[1]! });
  });
  window.on("closed", () => { mainWindow = undefined; });

  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(rendererPath);
  await controller.initialize();
  if (smokeMode) {
    await waitForRendererReady(window);
    process.stdout.write("EVREN_DESKTOP_SMOKE_OK\n");
    if (smokeResultFile) writeFileSync(smokeResultFile, "EVREN_DESKTOP_SMOKE_OK\n", { encoding: "utf8", mode: 0o600 });
    setImmediate(() => app.quit());
  }
}

async function waitForRendererReady(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const probe = await window.webContents.executeJavaScript(`(() => {
      const api = window.evrenDesktop;
      return {
        ready: document.documentElement.dataset.evrenDesktopReady === "true",
        fatal: document.documentElement.dataset.evrenDesktopFatal,
        hasRoot: document.querySelector('[data-testid="evren-desktop-root"]') !== null,
        surface: api ? {
          root: Object.keys(api).sort(),
          state: Object.keys(api.state ?? {}).sort(),
          credentials: Object.keys(api.credentials ?? {}).sort(),
          models: Object.keys(api.models ?? {}).sort(),
          startup: Object.keys(api.startup ?? {}).sort(),
          projects: Object.keys(api.projects ?? {}).sort(),
          threads: Object.keys(api.threads ?? {}).sort(),
          chat: Object.keys(api.chat ?? {}).sort(),
          approvals: Object.keys(api.approvals ?? {}).sort(),
          changes: Object.keys(api.changes ?? {}).sort(),
          attachments: Object.keys(api.attachments ?? {}).sort(),
          history: Object.keys(api.history ?? {}).sort(),
          settings: Object.keys(api.settings ?? {}).sort(),
          usage: Object.keys(api.usage ?? {}).sort(),
          updates: Object.keys(api.updates ?? {}).sort(),
          diagnostics: Object.keys(api.diagnostics ?? {}).sort(),
        } : null,
      };
    })()`, true) as {
      ready: boolean;
      fatal?: string;
      hasRoot: boolean;
      surface: null | Record<string, string[]>;
    };
    if (probe.fatal) throw new Error(probe.fatal);
    if (probe.ready && probe.hasRoot && hasExpectedDesktopApi(probe.surface)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("RENDERER_READY_TIMEOUT");
}

function hasExpectedDesktopApi(surface: null | Record<string, string[]>): boolean {
  return surface !== null
    && JSON.stringify(surface.root) === JSON.stringify(["approvals", "attachments", "changes", "chat", "credentials", "diagnostics", "history", "models", "projects", "settings", "startup", "state", "threads", "updates", "usage"])
    && JSON.stringify(surface.state) === JSON.stringify(["get", "subscribe"])
    && JSON.stringify(surface.credentials) === JSON.stringify(["clear", "save", "test"])
    && JSON.stringify(surface.models) === JSON.stringify(["select"])
    && JSON.stringify(surface.startup) === JSON.stringify(["retry"])
    && JSON.stringify(surface.projects) === JSON.stringify(["chooseFile", "openFolder", "openRecent"])
    && JSON.stringify(surface.threads) === JSON.stringify(["archive", "list", "loadEarlier", "resume", "start"])
    && JSON.stringify(surface.chat) === JSON.stringify(["interrupt", "send"])
    && JSON.stringify(surface.approvals) === JSON.stringify(["respond"])
    && JSON.stringify(surface.changes) === JSON.stringify(["getDiff", "keep", "revert"])
    && JSON.stringify(surface.attachments) === JSON.stringify(["chooseImage", "removePending"])
    && JSON.stringify(surface.history) === JSON.stringify(["archive", "continue", "pin", "rename"])
    && JSON.stringify(surface.settings) === JSON.stringify(["update"])
    && JSON.stringify(surface.usage) === JSON.stringify(["applyLimits"])
    && JSON.stringify(surface.updates) === JSON.stringify(["check", "download", "install", "installRuntime"])
    && JSON.stringify(surface.diagnostics) === JSON.stringify(["get"]);
}

function configureContentSecurityPolicy(development: boolean): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const policy = development
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error: unknown) => {
  if (smokeMode) {
    const code = error instanceof Error ? error.message : "UNKNOWN_STARTUP_FAILURE";
    process.stderr.write(`EVREN_DESKTOP_SMOKE_FAILED:${code}\n`);
  }
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitAfterCleanup) return;
  event.preventDefault();
  quitAfterCleanup = true;
  unregisterIpc?.();
  unregisterIpc = undefined;
  void (controller?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
});
