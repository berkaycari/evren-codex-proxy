import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public release documentation", () => {
  it("uses generic paths and contains no secret-looking example value", async () => {
    const [readme, envExample] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
    ]);

    expect(readme).not.toMatch(/C:\\Users\\/i);
    expect(readme).not.toContain("<gerçek-proje-klasörü>");
    expect(envExample).toContain("EVREN_API_KEY=replace-in-process-environment-only");
    expect(envExample).not.toMatch(/\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/);
  });
});
