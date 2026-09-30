import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeError } from "../src/desktop/main/desktop-controller.js";
import {
  applicationErrorIsVisible,
  formatTurnDuration,
  groupConversationItems,
  modelControlPresentation,
  routeErrorIsVisible,
  turnStatusLabel,
  type DesktopPage,
} from "../src/desktop/renderer/presentation.js";
import type { ConversationItemDto } from "../src/desktop/shared/contracts.js";

describe("final RC micro-fix and presentation contract", () => {
  it("keeps chat errors on chat while application-global errors remain visible on every route", () => {
    const chatError = { scope: "chat" as const, message: "turn failed" };
    const pages: DesktopPage[] = ["home", "chat", "history", "usage", "settings", "help", "updates"];
    expect(pages.map((page) => routeErrorIsVisible(chatError, page))).toEqual([false, true, false, false, false, false, false]);
    expect(pages.every(() => applicationErrorIsVisible({ code: "BRIDGE_UNAVAILABLE", message: "Bridge kullanılamıyor." }))).toBe(true);
  });

  it("presents HTTP 429 safely in Turkish without raw provider JSON", () => {
    const error = safeError(Object.assign(new Error('{"error":{"message":"429 Too Many Requests: exceeded retry limit","secret":"hidden"}}'), { code: "provider_error" }));
    expect(error).toEqual({
      code: "UPSTREAM_RATE_LIMIT",
      message: "İstek şu anda yoğunluk veya hız sınırı nedeniyle tamamlanamadı. Bir süre sonra tekrar deneyin.",
      detail: "HTTP 429 · Too Many Requests",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("exceeded retry limit");
  });

  it.each([
    ["upstream_authentication_failed", "UPSTREAM_AUTHENTICATION"],
    ["upstream_media_unsupported", "UPSTREAM_MEDIA_UNSUPPORTED"],
    ["upstream_payload_too_large", "UPSTREAM_PAYLOAD_TOO_LARGE"],
    ["upstream_overloaded", "UPSTREAM_OVERLOADED"],
    ["upstream_provider_error", "UPSTREAM_PROVIDER_ERROR"],
    ["upstream_network_error", "UPSTREAM_NETWORK_ERROR"],
    ["upstream_timeout", "UPSTREAM_TIMEOUT"],
    ["upstream_aborted", "UPSTREAM_ABORTED"],
    ["upstream_malformed_response", "UPSTREAM_MALFORMED_RESPONSE"],
  ])("maps safe upstream code %s to a distinct Turkish product error", (sourceCode, expectedCode) => {
    const error = safeError(Object.assign(new Error("raw provider payload must not appear"), { code: sourceCode }));
    expect(error.code).toBe(expectedCode);
    expect(error.message).not.toContain("raw provider payload");
    expect(error.detail).toBeUndefined();
  });

  it("groups only completed commands and leaves active or failed activity discoverable", () => {
    const command = (id: string, status: "running" | "completed" | "failed"): ConversationItemDto => ({ id, turnId: "turn-1", kind: "command", status, command: `cmd-${id}`, cwd: "C:\\project" });
    const groups = groupConversationItems([command("1", "completed"), command("2", "completed"), command("3", "failed"), command("4", "running")]);
    expect(groups[0]).toMatchObject({ kind: "completedCommands", items: [{ id: "1" }, { id: "2" }] });
    expect(groups.slice(1)).toEqual([
      { kind: "item", item: command("3", "failed") },
      { kind: "item", item: command("4", "running") },
    ]);
  });

  it("explains model loading instead of presenting a dead dropdown", () => {
    expect(modelControlPresentation({ models: [], evren: { status: "connecting" } }, false)).toEqual({
      disabled: true,
      placeholder: "Modeller yükleniyor…",
    });
    expect(modelControlPresentation({
      models: [{ id: "chat", modalities: ["text"], kind: "chat", selectable: true, synthetic: false, pricing: { mode: "free" } }],
      evren: { status: "connected" },
    }, false)).toEqual({ disabled: false });
  });

  it("formats real turn stages and elapsed time without fake progress", () => {
    expect(turnStatusLabel({ phase: "running", activity: "waitingForEvren", startedAt: 1 })).toBe("EVREN yanıtı bekleniyor…");
    expect(turnStatusLabel({ phase: "running", activity: "runningCommand", startedAt: 1 })).toBe("Komut çalıştırılıyor…");
    expect(turnStatusLabel({ phase: "completed", outcome: "success", startedAt: 1, completedAt: 282_001 })).toBe("Görev tamamlandı");
    expect(turnStatusLabel({ phase: "completed", outcome: "approvalDeclined", startedAt: 1, completedAt: 2 })).toBe("İzin reddedildi");
    expect(turnStatusLabel({ phase: "failed", outcome: "failed", errorCode: "UPSTREAM_RATE_LIMIT", startedAt: 1, completedAt: 2 })).toBe("EVREN hız sınırı · görev tamamlanamadı");
    expect(turnStatusLabel({ phase: "interrupted", startedAt: 1, completedAt: 2 })).toBe("Durduruldu");
    expect(formatTurnDuration(282_999)).toBe("04:42");
  });

  it("configures the original multi-size EVREN icon for Windows packaging", async () => {
    const [ico, packageText, generator, app, styles] = await Promise.all([
      readFile(path.join(process.cwd(), "resources", "branding", "evren-codex-bridge.ico")),
      readFile(path.join(process.cwd(), "package.json"), "utf8"),
      readFile(path.join(process.cwd(), "scripts", "generate-brand-icons.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "src", "desktop", "renderer", "App.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "src", "desktop", "renderer", "styles.css"), "utf8"),
    ]);
    expect(ico.readUInt16LE(4)).toBe(7);
    expect(Array.from({ length: 7 }, (_, index) => ico[6 + index * 16] || 256)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    expect(packageText).toContain('"icon": "resources/branding/evren-codex-bridge.ico"');
    expect(generator).toContain("const iconSizes = [16, 24, 32, 48, 64, 128, 256]");
    expect(app).toContain("<BrandMark");
    expect(app).toContain("resources/branding/evren-codex-bridge.png");
    expect(app).toContain("EVREN'e bir görev verin…");
    expect(app).not.toContain("Codex'e bir görev verin…");
    expect(app).toContain("Sohbet ölçümü yok");
    expect(app).toContain("Güncelleme kaynağında yayımlanmış uygun bir sürüm yok.");
    expect(app).toContain("Doğrulanmış runtime güncelleme kaynağı henüz yayımlanmadı.");
    expect(app).not.toContain("invalid tag");
    expect(styles).toContain("prefers-reduced-motion:reduce");
  });
});
