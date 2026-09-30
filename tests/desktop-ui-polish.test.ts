import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeDesktopSettings } from "../src/desktop/main/settings-service.js";

const limits = {
  preset: "Standard" as const,
  maxSessionTokens: 1_000,
  maxDailyTokens: 2_000,
  maxRequestsPerSession: 10,
  maxToolCallsPerSession: 20,
  maxSessionCredits: 0,
  maxDailyCredits: 0,
  minCreditsRemaining: 0,
};

describe("v2 product polish presentation contract", () => {
  it("defaults to EVREN navy and preserves an explicit persisted theme", () => {
    expect(safeDesktopSettings({}, limits).theme).toBe("navy");
    expect(safeDesktopSettings({ theme: "light" }, limits).theme).toBe("light");
  });

  it("ships three token-based themes with reduced-motion and narrow-window support", async () => {
    const styles = await readFile(path.join(process.cwd(), "src", "desktop", "renderer", "styles.css"), "utf8");
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain(':root[data-theme="navy"]');
    expect(styles).toContain("--surface-1:");
    expect(styles).toContain("--focus:");
    expect(styles).toContain("prefers-reduced-motion:reduce");
    expect(styles).toContain("@media (max-width: 620px)");
  });

  it("exposes polished appearance, activity, approval, usage and help surfaces without fake progress", async () => {
    const app = await readFile(path.join(process.cwd(), "src", "desktop", "renderer", "App.tsx"), "utf8");
    expect(app).toContain("<ThemePicker");
    expect(app).toContain("document.documentElement.dataset.theme");
    expect(app).toContain("active-turn-bar");
    expect(app).toContain("KARARINIZ BEKLENİYOR");
    expect(app).toContain("Gelişmiş bağlam tanılaması");
    expect(app).toContain("Klasik terminal Bridge");
    expect(app).not.toMatch(/fake progress|% tamamlandı/i);
  });
});
