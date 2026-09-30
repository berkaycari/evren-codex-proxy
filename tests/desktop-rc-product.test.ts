import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeError } from "../src/desktop/main/desktop-controller.js";
import { validateChatSendInput } from "../src/desktop/shared/contracts.js";

describe("v2 release-candidate product contract", () => {
  it("accepts an exact local-draft send without a thread ID", () => {
    expect(validateChatSendInput({
      text: "ilk mesaj",
      attachmentIds: [],
      clientUserMessageId: "client-draft-1",
    })).toEqual({
      text: "ilk mesaj",
      attachmentIds: [],
      clientUserMessageId: "client-draft-1",
    });
    expect(() => validateChatSendInput({
      text: "ilk mesaj",
      attachmentIds: [],
      clientUserMessageId: "client-draft-1",
      unexpected: true,
    })).toThrow("invalid_chat_input");
  });

  it("keeps raw provider payloads out of the primary error message", () => {
    const providerError = Object.assign(new Error('{"error":{"message":"secret provider payload"}}'), {
      code: "invalid_request_error",
    });
    expect(safeError(providerError)).toEqual({
      code: "invalid_request_error",
      message: "İstek tamamlanamadı.",
      detail: '{"error":{"message":"secret provider payload"}}',
    });
    expect(safeError(Object.assign(new Error("Model seçimi geçersiz."), { code: "MODEL_INVALID" })))
      .toEqual({ code: "MODEL_INVALID", message: "Model seçimi geçersiz." });
  });

  it("uses the RC identity, Turkish critical navigation, branding and packaged menu policy", async () => {
    const [packageText, appText, mainText, htmlText] = await Promise.all([
      readFile(path.join(process.cwd(), "package.json"), "utf8"),
      readFile(path.join(process.cwd(), "src", "desktop", "renderer", "App.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "src", "desktop", "main", "index.ts"), "utf8"),
      readFile(path.join(process.cwd(), "index.html"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageText) as { version?: string; build?: { productName?: string } };
    expect(packageJson).toMatchObject({ version: "2.0.0", build: { productName: "EVREN Codex Bridge" } });
    expect(appText).toContain("Ana Sayfa");
    expect(appText).toContain("Yeni Sohbet");
    expect(appText).toContain("Çalışmaya Devam Et");
    expect(appText).toContain("Kullanım");
    expect(appText).toContain("Ayarlar");
    expect(appText).toContain("Yardım");
    expect(appText).not.toContain("Unavailable");
    expect(appText).toContain("İlk istekten sonra görünür");
    expect(appText).toContain("Bu oturumda henüz ölçülmedi");
    expect(appText).toContain("Sağlayıcı bu metriği sunmuyor");
    expect(appText).toContain("Bayt; token değildir");
    expect(mainText).toContain('app.setName("EVREN Codex Bridge")');
    expect(mainText).toContain("Menu.setApplicationMenu(null)");
    expect(mainText).toContain("evren-codex-bridge.png");
    expect(htmlText).toContain("<title>EVREN Codex Bridge</title>");
  });
});
