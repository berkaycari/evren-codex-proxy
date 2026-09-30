import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop IDE workflow UI contracts", () => {
  it("renders the collapsible accessible three-tab inspector", async () => {
    const source = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(source).toContain('type InspectorTab = "changes" | "permissions" | "conversation"');
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("Değişiklikler");
    expect(source).toContain("İzinler");
    expect(source).toContain("Sohbet");
  });

  it("keeps revert explicit and never exposes a renderer path parameter", async () => {
    const contracts = await readFile("src/desktop/shared/contracts.ts", "utf8");
    const renderer = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(contracts).toContain("export interface ChangeReviewInput { changeId: string }");
    expect(contracts).not.toContain("interface ChangeReviewInput { path:");
    expect(renderer).toContain("window.confirm");
    expect(renderer).toContain("window.evrenDesktop.changes.revert({ changeId: selected.id })");
  });

  it("uses bounded horizontally scrollable diff presentation and responsive drawer behavior", async () => {
    const styles = await readFile("src/desktop/renderer/styles.css", "utf8");
    expect(styles).toContain(".unified-diff");
    expect(styles).toContain("white-space: pre");
    expect(styles).toContain("max-height: min(56vh, 620px)");
    expect(styles).toContain(".workspace-inspector { position: absolute");
    expect(styles).toContain(".workspace-inspector { width: 100%; }");
  });

  it("labels bytes separately and never offers unsupported permission revocation", async () => {
    const source = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(source).toContain("Bu değerler bayttır; token olarak sunulmaz.");
    expect(source).toContain("revocationReason");
    expect(source).not.toContain("İzni Kaldır");
  });
});
