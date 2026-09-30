import { describe, expect, it, vi } from "vitest";
import {
  chooseInitialModel,
  EvrenCatalogService,
  ModelCatalogError,
  parseEvrenModelCatalog,
} from "../src/desktop/main/model-catalog.js";

const chat = {
  id: "chat-model",
  task: "chat",
  modalities: ["text", "image"],
  owned_by: "evren",
  pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
};

describe("EVREN desktop model catalog", () => {
  it("parses allowlisted model fields and FREE pricing", () => {
    const result = parseEvrenModelCatalog({ data: [{ ...chat, ignored_secret: "nope" }] });
    expect(result.models[0]).toEqual({
      id: "chat-model",
      task: "chat",
      modalities: ["text", "image"],
      ownedBy: "evren",
      kind: "chat",
      selectable: true,
      synthetic: false,
      pricing: { mode: "free", promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    });
    expect(JSON.stringify(result)).not.toContain("ignored_secret");
  });

  it("accepts positive CR pricing as PAID", () => {
    const model = parseEvrenModelCatalog({ data: [{
      ...chat,
      pricing: { prompt_token_price: 0.25, completion_token_price: 1, currency: "CR" },
    }] }).models[0]!;
    expect(model.pricing.mode).toBe("paid");
  });

  it("marks malformed pricing without crashing", () => {
    const model = parseEvrenModelCatalog({ data: [{ ...chat, pricing: { prompt_token_price: -1 } }] }).models[0]!;
    expect(model.pricing).toEqual({ mode: "invalid" });
  });

  it("keeps chat selectable and dedicated tasks informational", () => {
    const models = parseEvrenModelCatalog({ data: [chat, { id: "ocr", task: "ocr", modalities: ["image"] }] }).models;
    expect(models.find((model) => model.id === "chat-model")?.selectable).toBe(true);
    expect(models.find((model) => model.id === "ocr")).toMatchObject({ kind: "dedicated", selectable: false });
  });

  it("does not guess unknown task compatibility", () => {
    const model = parseEvrenModelCatalog({ data: [{ id: "mystery", modalities: ["text"] }] }).models[0]!;
    expect(model).toMatchObject({ kind: "unknown", selectable: false });
  });

  it("uses only known modalities", () => {
    const model = parseEvrenModelCatalog({ data: [{ ...chat, modalities: ["text", "TEXT", "telepathy", 5] }] }).models[0]!;
    expect(model.modalities).toEqual(["text"]);
  });

  it("adds synthetic auto routing exactly once when absent", () => {
    const models = parseEvrenModelCatalog({ data: [chat] }).models;
    expect(models.filter((model) => model.id === "auto")).toEqual([expect.objectContaining({ kind: "routing", synthetic: true })]);
  });

  it("does not duplicate a provider auto entry", () => {
    const models = parseEvrenModelCatalog({ data: [{ id: "auto", task: "chat" }, chat] }).models;
    expect(models.filter((model) => model.id === "auto")).toHaveLength(1);
    expect(models.find((model) => model.id === "auto")).toMatchObject({ kind: "routing", synthetic: false });
  });

  it("rejects malformed top-level catalogs", () => {
    expect(() => parseEvrenModelCatalog({ models: [] })).toThrow(ModelCatalogError);
    expect(() => parseEvrenModelCatalog(null)).toThrow(ModelCatalogError);
  });

  it("preserves an eligible saved model", () => {
    const models = parseEvrenModelCatalog({ data: [chat] }).models;
    expect(chooseInitialModel(models, "chat-model")).toEqual({ selectedModelId: "chat-model" });
  });

  it("reports a disappeared saved model and uses the preferred live fallback", () => {
    const preferred = { ...chat, id: "deepseek-v4.1-flash" };
    const models = parseEvrenModelCatalog({ data: [chat, preferred] }).models;
    expect(chooseInitialModel(models, "gone")).toEqual({
      selectedModelId: "deepseek-v4.1-flash",
      savedModelUnavailable: "gone",
    });
  });

  it("tests connectivity with GET /models and never runs inference", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({ data: [chat] }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new EvrenCatalogService({ baseUrl: "https://example.invalid/v1", timeoutMs: 1000, fetch: fetchMock as typeof fetch });
    await expect(service.load("private-key")).resolves.toMatchObject({ models: expect.any(Array) });
    expect(fetchMock).toHaveBeenCalledWith("https://example.invalid/v1/models", expect.objectContaining({ method: "GET" }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "provider_unavailable"],
  ])("maps HTTP %i to a safe error", async (status, code) => {
    const service = new EvrenCatalogService({
      baseUrl: "https://example.invalid/v1",
      timeoutMs: 1000,
      fetch: vi.fn(async () => new Response("provider body must stay hidden", { status })) as typeof fetch,
    });
    await expect(service.load("private-key")).rejects.toMatchObject({ code });
  });
});
