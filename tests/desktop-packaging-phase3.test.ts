import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 3 Windows packaging contract", () => {
  it("keeps production code in ASAR and the executable Codex payload outside ASAR", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      main?: string;
      build?: { asar?: boolean; files?: string[]; extraResources?: Array<{ from?: string; to?: string }> };
    };
    expect(packageJson.main).toBe("dist/desktop/main/index.js");
    expect(packageJson.build?.asar).toBe(true);
    expect(packageJson.build?.extraResources).toContainEqual({ from: "resources/codex", to: "codex" });
    expect(packageJson.build?.files).toEqual(expect.arrayContaining([
      "dist/**/*", "dist-desktop/**/*", "resources/branding/**/*", "!**/*.map", "!tests{,/**/*}", "!docs{,/**/*}", "!scripts{,/**/*}", "!src{,/**/*}",
    ]));
  });

  it("includes the complete pinned runtime manifest and upstream license", async () => {
    const root = path.join(process.cwd(), "resources", "codex");
    const manifest = JSON.parse(await readFile(path.join(root, "bundle-manifest.json"), "utf8")) as {
      codexVersion?: string;
      platform?: string;
      arch?: string;
      files?: Array<{ path: string }>;
    };
    expect(manifest).toMatchObject({ codexVersion: "0.157.1", platform: "win32", arch: "x64" });
    expect(manifest.files?.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "codex-package.json",
      "bin/codex.exe",
      "bin/codex-code-mode-host.exe",
      "codex-path/rg.exe",
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ]));
    await expect(access(path.join(root, "LICENSE-OPENAI-CODEX.txt"))).resolves.toBeUndefined();
  });

  it("keeps generated releases out of Git and assigns large runtime executables to Git LFS", async () => {
    const [gitignore, attributes] = await Promise.all([
      readFile(path.join(process.cwd(), ".gitignore"), "utf8"),
      readFile(path.join(process.cwd(), ".gitattributes"), "utf8"),
    ]);
    expect(gitignore).toMatch(/^dist-release\/$/m);
    expect(attributes).toContain("resources/codex/**/*.exe filter=lfs diff=lfs merge=lfs -text");
  });

  it("builds NSIS and portable Windows x64 artifacts without visible child consoles", async () => {
    const [packageJson, controller, codexSmoke] = await Promise.all([
      readFile(path.join(process.cwd(), "package.json"), "utf8"),
      readFile(path.join(process.cwd(), "src", "desktop", "main", "desktop-controller.ts"), "utf8"),
      readFile(path.join(process.cwd(), "scripts", "smoke-bundled-codex.mjs"), "utf8"),
    ]);
    expect(packageJson).toContain('"desktop:dist": "npm run brand:icons && npm run build && electron-builder --win nsis portable --x64"');
    expect(packageJson).toContain('"productName": "EVREN Codex Bridge"');
    expect(packageJson).toContain('"artifactName": "EVREN-Codex-Bridge-Setup-${version}.${ext}"');
    expect(packageJson).toContain('"artifactName": "EVREN-Codex-Bridge-Portable-${version}.${ext}"');
    expect(packageJson).toContain('"icon": "resources/branding/evren-codex-bridge.ico"');
    expect(controller).toContain("resolveCodexRuntime({");
    expect(codexSmoke).toContain("windowsHide: true");
    expect(codexSmoke).toContain("shell: false");
  });
});
