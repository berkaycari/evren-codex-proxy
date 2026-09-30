import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readProjectFile = (relativePath: string): Promise<string> =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("desktop production preload contract", () => {
  it("builds a deterministic bundled CommonJS preload separately from the ESM main process", async () => {
    const [packageJson, config, tsconfig] = await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("vite.preload.config.ts"),
      readProjectFile("tsconfig.build.json"),
    ]);
    expect(packageJson).toContain('"preload:build": "vite build --config vite.preload.config.ts"');
    expect(packageJson).toContain("npm run core:build && npm run preload:build && npm run renderer:build");
    expect(config).toContain('formats: ["cjs"]');
    expect(config).toContain('fileName: () => "index.cjs"');
    expect(config).toContain('external: ["electron"]');
    expect(tsconfig).toContain('"src/desktop/preload/**/*"');
  });

  it("points BrowserWindow at the CommonJS artifact while preserving sandbox hardening", async () => {
    const main = await readProjectFile("src/desktop/main/index.ts");
    expect(main).toContain('"../preload/index.cjs"');
    expect(main).not.toContain('"../preload/index.js"');
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webSecurity: true");
  });

  it("keeps the preload surface narrow and does not expose ipcRenderer or Node APIs", async () => {
    const preload = await readProjectFile("src/desktop/preload/index.ts");
    expect(preload).toContain('contextBridge.exposeInMainWorld("evrenDesktop", desktopApi)');
    expect(preload).not.toContain('exposeInMainWorld("ipcRenderer"');
    expect(preload).not.toMatch(/from\s+["']node:(?:fs|child_process)["']/);
    expect(preload).not.toContain("process.env");
    expect(preload).toContain("projects:");
    expect(preload).toContain("threads:");
    expect(preload).toContain("chat:");
    expect(preload).toContain("approvals:");
    expect(preload).toContain("changes:");
    expect(preload).toContain("getDiff: (input) => ipcRenderer.invoke(DESKTOP_IPC.changeDiffGet, input)");
    expect(preload).toContain("attachments:");
    expect(preload).toContain("removePending: () => ipcRenderer.invoke(DESKTOP_IPC.attachmentRemovePending)");
    expect(preload).not.toContain("rawJsonRpc");
    expect(preload).not.toContain("ipcRenderer.send(");
  });

  it("returns an unsubscribe function for the only renderer event subscription", async () => {
    const preload = await readProjectFile("src/desktop/preload/index.ts");
    expect(preload).toContain("return () => ipcRenderer.removeListener(DESKTOP_IPC.stateChanged, wrapped)");
    expect(preload.match(/ipcRenderer\.on\(/g)).toHaveLength(1);
  });

  it("renders a safe PRELOAD_UNAVAILABLE screen instead of dereferencing a missing API", async () => {
    const renderer = await readProjectFile("src/desktop/renderer/main.tsx");
    expect(renderer).toContain("if (!window.evrenDesktop)");
    expect(renderer).toContain('dataset.evrenDesktopFatal = "PRELOAD_UNAVAILABLE"');
    expect(renderer).toContain("Masaüstü güvenli köprüsü yüklenemedi.");
    expect(renderer).toContain("CHAT_RENDER_FAILED");
    expect(renderer).toContain("RendererErrorBoundary");
    expect(renderer).not.toContain("error.stack");
  });

  it("marks renderer readiness only after a non-booting state is received", async () => {
    const app = await readProjectFile("src/desktop/renderer/App.tsx");
    expect(app).toContain('state.stage !== "BOOTING"');
    expect(app).toContain('dataset.evrenDesktopReady = "true"');
    expect(app.indexOf('state.stage !== "BOOTING"')).toBeLessThan(app.indexOf('dataset.evrenDesktopReady = "true"'));
  });

  it("renders the safe per-turn upstream model evidence fields", async () => {
    const app = await readProjectFile("src/desktop/renderer/App.tsx");
    expect(app).toContain("ModelRoutePanel");
    expect(app).toContain("Desktop seçimi");
    expect(app).toContain("Codex isteği");
    expect(app).toContain("Bridge etkin model");
    expect(app).toContain("EVREN upstream");
    expect(app).toContain("Provider ID");
    expect(app).not.toContain("assistant self-identification");
  });

  it("requires the real renderer milestone and rejects a deliberately missing preload", async () => {
    const [main, smoke, smokeProcess] = await Promise.all([
      readProjectFile("src/desktop/main/index.ts"),
      readProjectFile("scripts/smoke-desktop.mjs"),
      readProjectFile("scripts/smoke-process.mjs"),
    ]);
    expect(main).toContain("await waitForRendererReady(window)");
    expect(main).toContain('data-testid="evren-desktop-root"');
    expect(main).toContain("EVREN_DESKTOP_SMOKE_RESULT_FILE");
    expect(smoke).toContain("EVREN_DESKTOP_SMOKE_PRELOAD_UNAVAILABLE");
    expect(smoke).toContain("EVREN_DESKTOP_MISSING_PRELOAD_REJECTED");
    expect(smoke).toContain("waitForChildWithTimeout");
    expect(smokeProcess).toContain("TIMEOUT_PROCESS_TREE_TERMINATION_FAILED");
    expect(smokeProcess).toContain("taskkill.exe");
    expect(smoke).toMatch(/unsupported top-level ESM import/);
  });

  it("removes frame-ancestors from meta CSP while retaining the response-header policy", async () => {
    const [html, main] = await Promise.all([
      readProjectFile("index.html"),
      readProjectFile("src/desktop/main/index.ts"),
    ]);
    expect(html).not.toContain("frame-ancestors");
    expect(main).toContain("frame-ancestors 'none'");
  });
});
