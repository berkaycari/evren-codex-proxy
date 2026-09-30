import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop final visual identity contract", () => {
  it("derives the EVREN navy identity from reusable renderer tokens", async () => {
    const styles = await readFile("src/desktop/renderer/styles.css", "utf8");
    expect(styles).toContain("--bg-canvas: #070b14");
    expect(styles).toContain("--surface-1: #0d1322");
    expect(styles).toContain("--accent: #00dff3");
    expect(styles).toContain("--accent-violet:");
    expect(styles).toContain("--font-mono:");
  });

  it("renders the secure onboarding as an EVREN workspace instead of prototype HTML", async () => {
    const source = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(source).toContain('className="onboarding-frame"');
    expect(source).toContain("KİMLİK DOĞRULAMA");
    expect(source).toContain("BELLEK SAKLAMA POLİTİKASI");
    expect(source).toContain("anahtar Codex'e aktarılmaz");
    expect(source).not.toContain("IPC PROTOCOL V2.4-SECURE");
  });

  it("uses real EVREN and Codex states in the shared runtime cluster", async () => {
    const [source, styles] = await Promise.all([
      readFile("src/desktop/renderer/App.tsx", "utf8"),
      readFile("src/desktop/renderer/styles.css", "utf8"),
    ]);
    expect(source).toContain("runtime-cluster");
    expect(source).toContain("Onay bekliyor");
    expect(source).toContain("Araç çalıştırıyor");
    expect(source).toContain("Durduruluyor");
    expect(source).toContain("Hız sınırı");
    expect(source).toContain("Kullanılamıyor");
    expect(styles).toContain("@media(prefers-reduced-motion:reduce)");
    expect(source).not.toMatch(/Codex[^\n]{0,80}%/);
  });

  it("keeps inspector, diff, permission and conversation insights in the shared visual system", async () => {
    const [source, styles] = await Promise.all([
      readFile("src/desktop/renderer/App.tsx", "utf8"),
      readFile("src/desktop/renderer/styles.css", "utf8"),
    ]);
    expect(source).toContain('role="tablist"');
    expect(source).toContain("Bu değerler bayttır; token olarak sunulmaz.");
    expect(styles).toContain(".change-summary");
    expect(styles).toContain(".permission-request, .permission-grant");
    expect(styles).toContain(".insight-hero");
  });

  it("hides the generic Windows menu bar without weakening the web preferences", async () => {
    const source = await readFile("src/desktop/main/index.ts", "utf8");
    expect(source).toContain('process.platform === "win32" || app.isPackaged');
    expect(source).toContain('autoHideMenuBar: process.platform === "win32"');
    expect(source).toContain("window.setMenuBarVisibility(false)");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("webSecurity: true");
  });
});
