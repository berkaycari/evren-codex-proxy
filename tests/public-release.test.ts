import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public release documentation", () => {
  it("uses generic paths and contains no secret-looking example value", async () => {
    const [readme, envExample, calculatorImage, snakeImage] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../docs/evren-v1.2-calculator-acceptance.png", import.meta.url)),
      readFile(new URL("../docs/evren-v1.2-snake-acceptance.png", import.meta.url)),
    ]);

    expect(readme).not.toMatch(/C:\\Users\\/i);
    expect(readme).not.toContain("<gerçek-proje-klasörü>");
    expect(envExample).toContain("EVREN_API_KEY=replace-in-process-environment-only");
    expect(envExample).not.toMatch(/\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/);
    expect(readme).toContain("EVREN Codex Bridge `v1.2.0`");
    expect(readme).toContain("yalnızca `F1`, Türkçe Yardım / Hızlı Başlangıç ekranını açar");
    expect(readme).not.toContain("`F1`, `?` veya `H`/`h`");
    expect(readme).toContain("Preseti `↑` / `↓` ile seçip `Enter` ile onaylayın");
    expect(readme).toContain("codex --profile evren");
    expect(readme).toContain("docs/evren-v1.2-calculator-acceptance.png");
    expect(readme).toContain("docs/evren-v1.2-snake-acceptance.png");
    expect(readme).toContain(
      "EVREN Codex Bridge `v1.2.0` ile gerçekleştirilen gerçek bir coding-agent kabul testinden birleşik görüntü.",
    );

    for (const image of [calculatorImage, snakeImage]) {
      expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(image.byteLength).toBeGreaterThan(8);
    }
  });
});
