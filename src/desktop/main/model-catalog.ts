import type { ModelDto, ModelPricingDto, SafeErrorDto } from "../shared/contracts.js";

const MAX_TEXT_LENGTH = 200;
const ALLOWED_MODALITIES = new Set(["text", "image", "video", "audio"]);

export interface ModelCatalogResult {
  models: ModelDto[];
}

export function parseEvrenModelCatalog(payload: unknown): ModelCatalogResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModelCatalogError("malformed_model_catalog", "EVREN model kataloğu geçersiz.");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new ModelCatalogError("malformed_model_catalog", "EVREN model kataloğu veri listesi içermiyor.");
  }

  const byId = new Map<string, ModelDto>();
  for (const raw of data) {
    const parsed = parseModel(raw);
    if (!parsed || byId.has(parsed.id)) continue;
    byId.set(parsed.id, parsed);
  }
  if (!byId.has("auto")) {
    byId.set("auto", {
      id: "auto",
      modalities: [],
      kind: "routing",
      selectable: true,
      synthetic: true,
      pricing: { mode: "unknown" },
    });
  }
  return { models: [...byId.values()] };
}

export function chooseInitialModel(
  models: readonly ModelDto[],
  savedModelId: string | undefined,
): { selectedModelId?: string; savedModelUnavailable?: string } {
  const selectable = models.filter((model) => model.selectable);
  if (savedModelId) {
    const saved = selectable.find((model) => model.id === savedModelId);
    if (saved) return { selectedModelId: saved.id };
  }
  const preferred = selectable.find((model) => model.id === "deepseek-v4.1-flash")
    ?? selectable.find((model) => model.kind === "chat")
    ?? selectable.find((model) => model.id === "auto");
  return {
    ...(preferred === undefined ? {} : { selectedModelId: preferred.id }),
    ...(savedModelId === undefined ? {} : { savedModelUnavailable: savedModelId }),
  };
}

export class EvrenCatalogService {
  constructor(private readonly options: {
    baseUrl: string;
    timeoutMs: number;
    fetch?: typeof fetch;
  }) {}

  async load(apiKey: string): Promise<ModelCatalogResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}/models`, {
        method: "GET",
        signal: controller.signal,
        headers: { "x-api-key": apiKey },
      });
      if (!response.ok) throw httpError(response.status);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModelCatalogError("malformed_model_catalog", "EVREN model kataloğu okunamadı.");
      }
      return parseEvrenModelCatalog(payload);
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelCatalogError("timeout", "EVREN bağlantısı zaman aşımına uğradı.");
      }
      throw new ModelCatalogError("network_unavailable", "EVREN ağına ulaşılamadı.");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ModelCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }

  toDto(): SafeErrorDto {
    return { code: this.code, message: this.message };
  }
}

function parseModel(value: unknown): ModelDto | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = safeText(record.id);
  if (!id) return undefined;
  const task = safeText(record.task)?.toLowerCase();
  const modalities = Array.isArray(record.modalities)
    ? [...new Set(record.modalities.filter((item): item is string =>
      typeof item === "string" && ALLOWED_MODALITIES.has(item.toLowerCase()),
    ).map((item) => item.toLowerCase()))]
    : [];
  const ownedBy = safeText(record.owned_by ?? record.ownedBy);
  const pricing = parsePricing(record.pricing, record.free_until);
  const auto = id === "auto";
  const kind: ModelDto["kind"] = auto
    ? "routing"
    : task === "chat"
      ? "chat"
      : task === undefined
        ? "unknown"
        : "dedicated";
  return {
    id,
    ...(task === undefined ? {} : { task }),
    modalities,
    ...(ownedBy === undefined ? {} : { ownedBy }),
    kind,
    selectable: auto || task === "chat",
    synthetic: false,
    pricing,
  };
}

function parsePricing(value: unknown, fallbackFreeUntil: unknown): ModelPricingDto {
  if (value === undefined) return { mode: "unknown" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "invalid" };
  const record = value as Record<string, unknown>;
  const prompt = record.prompt_token_price;
  const completion = record.completion_token_price;
  const currency = record.currency;
  if (!validPrice(prompt) || !validPrice(completion) || currency !== "CR") return { mode: "invalid" };
  const freeUntil = safeText(record.free_until ?? fallbackFreeUntil);
  return {
    mode: prompt === 0 && completion === 0 ? "free" : "paid",
    promptTokenPrice: prompt,
    completionTokenPrice: completion,
    currency: "CR",
    ...(freeUntil === undefined ? {} : { freeUntil }),
  };
}

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= MAX_TEXT_LENGTH && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function httpError(status: number): ModelCatalogError {
  if (status === 401) return new ModelCatalogError("unauthorized", "EVREN API anahtarı doğrulanamadı.");
  if (status === 403) return new ModelCatalogError("forbidden", "EVREN erişimi reddedildi; hesap koşullarını ve yetkileri kontrol edin.");
  if (status === 429) return new ModelCatalogError("rate_limited", "EVREN model kataloğu hız sınırına takıldı; daha sonra yeniden deneyin.");
  if (status === 408 || status === 504) return new ModelCatalogError("timeout", "EVREN bağlantısı zaman aşımına uğradı.");
  if (status === 503) return new ModelCatalogError("provider_overloaded", "EVREN hizmeti şu anda yoğun.");
  if (status >= 500) return new ModelCatalogError("provider_unavailable", "EVREN hizmeti şu anda kullanılamıyor.");
  return new ModelCatalogError("provider_error", `EVREN bağlantısı başarısız oldu (HTTP ${status}).`);
}
