import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { imageInputPresentation } from "../src/desktop/renderer/presentation.js";

const model = (id: string, modalities: string[]) => ({
  id,
  modalities,
  kind: "chat" as const,
  selectable: true,
  synthetic: false,
  pricing: { mode: "free" as const },
});

describe("Desktop product-finishing contracts", () => {
  it("explains that image input needs a selected model", () => {
    expect(imageInputPresentation({ models: [], workspace: {} })).toEqual({
      supported: false,
      label: "Önce bir çalışma modeli seçin",
    });
  });

  it("uses the immutable thread model when presenting image capability", () => {
    expect(imageInputPresentation({
      models: [model("text", ["text"]), model("vision", ["text", "image"])],
      selectedModelId: "vision",
      workspace: { selectedThreadModel: "text" },
    })).toEqual({ modelId: "text", supported: false, label: "Bu model yalnızca metin kabul ediyor" });
  });

  it("advertises image input only from live catalog modalities", () => {
    expect(imageInputPresentation({
      models: [model("vision", ["text", "image"])],
      selectedModelId: "vision",
      workspace: {},
    })).toEqual({ modelId: "vision", supported: true, label: "Görsel girişi destekleniyor" });
  });

  it("keeps image selection failures visible and distinguishes upstream rate limiting", async () => {
    const source = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(source).toContain("setAttachmentError(readError(error))");
    expect(source).toContain("İstek upstream katmanına ulaştı ancak HTTP 429 ile reddedildi.");
    expect(source).toContain("Görsel istekleri otomatik yinelenmez");
    expect(source).not.toContain("void window.evrenDesktop.attachments.chooseImage()");
  });

  it("keeps conversation utilities attached to the composer and out of the top bar", async () => {
    const [source, styles] = await Promise.all([
      readFile("src/desktop/renderer/App.tsx", "utf8"),
      readFile("src/desktop/renderer/styles.css", "utf8"),
    ]);
    const topBar = source.slice(source.indexOf("function TopBar"), source.indexOf("function HomePage"));
    const composer = source.slice(source.indexOf("function Composer"), source.indexOf("function UsagePage"));
    expect(source).toContain("ÇALIŞMA MODELİ");
    expect(topBar).not.toContain("composer-usage");
    expect(topBar).not.toContain("composer-inspector");
    expect(composer).toContain('className="composer-utilities"');
    expect(composer).toContain('onClick={openInsights}');
    expect(composer).toContain('aria-pressed={inspectorOpen}');
    expect(composer).toContain('aria-label={inspectorOpen ? "Denetçiyi kapat" : "Denetçiyi aç"}');
    expect(composer).not.toContain("<strong>Denetçi</strong>");
    expect(styles).toContain(".composer-utilities");
    expect(styles).toContain("justify-self: end");
    expect(styles).toContain(".composer-inspector { position: relative; min-width: 36px;");
  });

  it("keeps Windows model popup options theme-readable without pricing suffixes", async () => {
    const [source, styles] = await Promise.all([
      readFile("src/desktop/renderer/App.tsx", "utf8"),
      readFile("src/desktop/renderer/styles.css", "utf8"),
    ]);
    const topBar = source.slice(source.indexOf("function TopBar"), source.indexOf("function HomePage"));
    expect(topBar).toContain("{model.id}</option>");
    expect(topBar).not.toContain("ÜCRETSİZ");
    expect(topBar).not.toContain("ÜCRETLİ");
    expect(styles).toContain(".model-control select option { color: var(--text-primary); background-color: var(--surface-inset); }");
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain("color-scheme: light");
  });

  it("labels non-Git conversation change totals as observed and incomplete", async () => {
    const source = await readFile("src/desktop/renderer/App.tsx", "utf8");
    expect(source).toContain('record.changes.coverage === "observed"');
    expect(source).toContain("gözlenen dosya · satır toplamı doğrulanmadı");
    expect(source).toContain("kabuk komutlarının ürettiği dosyalar eksik olabilir");
  });

  it("provides borderless runtime identity and recognizable history actions", async () => {
    const [source, styles] = await Promise.all([
      readFile("src/desktop/renderer/App.tsx", "utf8"),
      readFile("src/desktop/renderer/styles.css", "utf8"),
    ]);
    expect(source).not.toContain('className="runtime-caption"');
    expect(source).toContain('aria-pressed={record.pinned}');
    expect(source).toContain('<HistoryIcon name="star" filled={record.pinned} />');
    expect(source).toContain('<HistoryIcon name="edit" />');
    expect(source).toContain('<HistoryIcon name="trash" />');
    expect(source).toContain('<HistoryIcon name="resume" />');
    expect(styles).toContain(".runtime-link.active i");
    expect(styles).toContain(".runtime-cluster { display: flex");
    expect(styles).toContain(".history-action.resume");
  });
});
