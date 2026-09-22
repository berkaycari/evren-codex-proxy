import type { EventSink } from "../ui/logger.js";
import type { NativeEvrenRequest } from "../bridge/native-codex-to-evren.js";
import { extractResponseText, extractUsage, type EvrenUsage } from "./extract-response.js";

export interface EvrenInferenceResult {
  id: string;
  text: string;
  usage?: EvrenUsage;
  raw: unknown;
}

export interface EvrenNativeResult {
  id: string;
  usage?: EvrenUsage;
  raw: unknown;
}

export interface EvrenTransport {
  getModels(): Promise<unknown>;
  infer(input: string, maxOutputTokens: number): Promise<EvrenInferenceResult>;
  respond(request: NativeEvrenRequest): Promise<EvrenNativeResult>;
}

export class EvrenClient implements EvrenTransport {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      logger: EventSink;
      fetch?: typeof fetch;
    },
  ) {}

  async getModels(): Promise<unknown> {
    return this.request("/models", { method: "GET" });
  }

  async infer(input: string, maxOutputTokens: number): Promise<EvrenInferenceResult> {
    this.options.logger.log({ event: "EVREN_REQUEST", data: { inputChars: input.length, maxOutputTokens } });
    const body = {
      model: this.options.model,
      input,
      max_output_tokens: maxOutputTokens,
      stream: false,
    };
    // This allowlist is deliberate: native tools and tool_choice can never leak upstream.
    const raw = await this.request("/responses", { method: "POST", body: JSON.stringify(body) });
    const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : "";
    if (!id) throw new Error("EVREN response is missing a response id.");
    const text = extractResponseText(raw);
    const usage = extractUsage(raw);
    this.options.logger.log({
      event: "EVREN_RESPONSE",
      data: { responseId: id, outputChars: text.length, hasUsage: usage !== undefined },
    });
    return { id, text, ...(usage === undefined ? {} : { usage }), raw };
  }

  async respond(request: NativeEvrenRequest): Promise<EvrenNativeResult> {
    this.options.logger.log({
      event: "EVREN_NATIVE_REQUEST",
      data: {
        inputItems: request.input.length,
        toolCount: request.tools.length,
        maxOutputTokens: request.max_output_tokens,
      },
    });
    // The request type is the native allowlist. No caller-owned Responses fields are spread here.
    const body: NativeEvrenRequest = {
      model: this.options.model,
      input: request.input,
      tools: request.tools,
      tool_choice: request.tool_choice,
      parallel_tool_calls: false,
      max_output_tokens: request.max_output_tokens,
      stream: false,
    };
    const raw = await this.request("/responses", { method: "POST", body: JSON.stringify(body) });
    const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : "";
    if (!id) throw new Error("EVREN response is missing a response id.");
    const usage = extractUsage(raw);
    const outputCount = raw && typeof raw === "object" && Array.isArray((raw as { output?: unknown }).output)
      ? (raw as { output: unknown[] }).output.length
      : 0;
    this.options.logger.log({
      event: "EVREN_NATIVE_RESPONSE",
      data: { responseId: id, outputItems: outputCount, hasUsage: usage !== undefined },
    });
    return { id, ...(usage === undefined ? {} : { usage }), raw };
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const fetchImpl = this.options.fetch ?? fetch;
    try {
      const response = await fetchImpl(`${this.options.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
        },
      });
      if (!response.ok) throw new Error(`EVREN returned HTTP ${response.status}.`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("EVREN request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
