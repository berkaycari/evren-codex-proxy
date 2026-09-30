import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public release documentation", () => {
  it("v2 README covers key product content and contains no secret-looking values or internal paths", async () => {
    const [readme, envExample, calculatorImage, snakeImage] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../docs/evren-v1.2-calculator-acceptance.png", import.meta.url)),
      readFile(new URL("../docs/evren-v1.2-snake-acceptance.png", import.meta.url)),
    ]);

    // No raw Windows paths or secret-looking values
    expect(readme).not.toMatch(/C:\\Users\\/i);
    expect(readme).not.toContain("<gerçek-proje-klasörü>");
    expect(envExample).toContain("EVREN_API_KEY=replace-in-process-environment-only");
    expect(envExample).not.toMatch(/\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/);

    // v2 product identity
    expect(readme).toContain("> **Sürüm:** 2.0.0");
    expect(readme).toContain("EVREN Codex Bridge");
    expect(readme).toContain("0.157.1");
    expect(readme).toContain("Windows x64");
    expect(readme).toContain("Final arayüz ekran görüntüleri");
    expect(readme).not.toContain("![EVREN Codex Bridge masaüstü ana ekranı]");
    expect(readme).not.toContain("![EVREN Codex Bridge gerçek coding-agent oturumu]");
    expect(readme).not.toContain("2.0.0-rc.1");

    // Stable setup and workflow contract
    expect(readme).toContain("EVREN-Codex-Bridge-Setup-2.0.0.exe");
    expect(readme).toContain("EVREN-Codex-Bridge-Portable-2.0.0.exe");
    expect(readme).toContain("EVREN API anahtarınızı");
    expect(readme).toContain("sistem Codex kurulumu");

    // Three supported workflows
    expect(readme).toContain("npm start");
    expect(readme).toContain("npm run bridge");
    expect(readme).toContain("codex --profile evren");
    expect(readme).toContain("# Klasik terminal Bridge");

    // Security model
    expect(readme).toContain("safeStorage");
    expect(readme).toContain("127.0.0.1");
    expect(readme).toContain("gözlenen etkinlik");
    expect(readme).toContain("CODING_AGENT_ACCEPTANCE.md");

    // Unsigned installer note
    expect(readme).toContain("SmartScreen");

    // Historical acceptance screenshots still exist (preserved in git)
    for (const image of [calculatorImage, snakeImage]) {
      expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(image.byteLength).toBeGreaterThan(8);
    }
  });
});
