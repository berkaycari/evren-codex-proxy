import type { EventSink } from "../ui/logger.js";
import type { NativeEvrenRequest } from "../bridge/native-codex-to-evren.js";
import { extractResponseText, extractUsage, type EvrenUsage } from "./extract-response.js";

export interface EvrenInferenceResult {
  id: string;
  text: string;
  usage?: EvrenUsage;
  raw: unknown;
  timing?: EvrenResponseTiming;
}

export interface EvrenNativeResult {
  id: string;
  usage?: EvrenUsage;
  raw: unknown;
  timing?: EvrenResponseTiming;
}

export interface EvrenResponseTiming {
  providerWaitMs: number;
  responseParseMs: number;
  resultProcessingMs: number;
}

export interface PreparedEvrenPayload {
  serializedBody: string;
}

export interface EvrenCreditState {
  held?: number;
  remaining?: number;
  uncertain: boolean;
  updatedAt?: string;
}

export interface EvrenRequestContext {
  bridgeModel: string;
  codexRequestedModel?: string;
  threadId?: string;
  turnId?: string;
  requestKind?: string;
  inferenceNumber: number;
  signal?: AbortSignal;
}

export type UpstreamModelObservation = Omit<EvrenRequestContext, "signal"> & {
  upstreamModel: string;
  observedAt: number;
};

export interface EvrenUpstreamActivity {
  phase: "sending" | "waiting" | "processing" | "completed" | "failed";
  observedAt: number;
  threadId?: string;
  turnId?: string;
  inferenceNumber?: number;
  elapsedMs?: number;
  failureCode?: string;
}

export type EvrenFailureCategory =
  | "authentication"
  | "authorization"
  | "invalid_request"
  | "unsupported_model"
  | "unsupported_media"
  | "payload_too_large"
  | "rate_limit"
  | "provider_overload"
  | "provider_error"
  | "network"
  | "timeout"
  | "aborted"
  | "malformed_response";

export class EvrenUpstreamError extends Error {
  constructor(
    readonly category: EvrenFailureCategory,
    readonly code: string,
    message: string,
    readonly options: {
      httpStatus?: number;
      retryAfterMs?: number;
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = "EvrenUpstreamError";
  }
}

export interface EvrenTransport {
  getModels(): Promise<unknown>;
  getCreditState?(): EvrenCreditState;
  getEffectiveModel?(): string;
  setEffectiveModel?(model: string): void;
  infer(input: string, maxOutputTokens: number, context?: EvrenRequestContext, prepared?: PreparedEvrenPayload): Promise<EvrenInferenceResult>;
  respond(request: NativeEvrenRequest, context?: EvrenRequestContext, prepared?: PreparedEvrenPayload): Promise<EvrenNativeResult>;
}

export class EvrenClient implements EvrenTransport {
  private creditState: EvrenCreditState = { uncertain: false };

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      logger: EventSink;
      fetch?: typeof fetch;
      onUpstreamRequest?: (observation: UpstreamModelObservation) => void;
      onUpstreamActivity?: (activity: EvrenUpstreamActivity) => void;
    },
  ) {}

  async getModels(): Promise<unknown> {
    return this.request("/models", { method: "GET" });
  }

  getCreditState(): EvrenCreditState {
    return { ...this.creditState };
  }

  getEffectiveModel(): string {
    return this.options.model;
  }

  setEffectiveModel(model: string): void {
    const value = model.trim();
    if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("EVREN model must be a non-empty safe identifier.");
    }
    this.options.model = value;
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("EVREN request timeout must be a positive integer.");
    }
    this.options.timeoutMs = timeoutMs;
  }

  async infer(
    input: string,
    maxOutputTokens: number,
    context?: EvrenRequestContext,
    prepared?: PreparedEvrenPayload,
  ): Promise<EvrenInferenceResult> {
    this.options.logger.log({ event: "EVREN_REQUEST", data: { inputChars: input.length, maxOutputTokens } });
    const body = {
      model: this.options.model,
      input,
      max_output_tokens: maxOutputTokens,
      stream: false,
    };
    this.assertModelRoute(body.model, context);
    // This allowlist is deliberate: native tools and tool_choice can never leak upstream.
    const startedAt = Date.now();
    this.observeUpstreamActivity("sending", context);
    try {
      const upstreamRequest = this.requestMeasured(
        "/responses",
        { method: "POST", body: prepared?.serializedBody ?? JSON.stringify(body) },
        context?.signal,
      );
      this.observeUpstreamModel(body.model, context);
      this.observeUpstreamActivity("waiting", context);
      const measured = await upstreamRequest;
      const raw = measured.value;
      this.observeUpstreamActivity("processing", context);
      const processingStartedAt = Date.now();
      const id = responseId(raw);
      let text: string;
      try {
        text = extractResponseText(raw);
      } catch {
        throw malformedResponse("EVREN response does not contain usable text output.");
      }
      const usage = extractUsage(raw);
      this.options.logger.log({
        event: "EVREN_RESPONSE",
        data: { outputChars: text.length, hasUsage: usage !== undefined },
      });
      const timing: EvrenResponseTiming = {
        ...measured.timing,
        resultProcessingMs: Date.now() - processingStartedAt,
      };
      this.observeUpstreamActivity("completed", context, { elapsedMs: Date.now() - startedAt });
      return { id, text, ...(usage === undefined ? {} : { usage }), raw, timing };
    } catch (error) {
      const classified = classifyUnexpectedError(error, context?.signal);
      this.observeUpstreamActivity("failed", context, {
        elapsedMs: Date.now() - startedAt,
        failureCode: classified.code,
      });
      throw classified;
    }
  }

  async respond(
    request: NativeEvrenRequest,
    context?: EvrenRequestContext,
    prepared?: PreparedEvrenPayload,
  ): Promise<EvrenNativeResult> {
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
      parallel_tool_calls: request.parallel_tool_calls,
      max_output_tokens: request.max_output_tokens,
      stream: false,
    };
    this.assertModelRoute(body.model, context);
    const startedAt = Date.now();
    this.observeUpstreamActivity("sending", context);
    try {
      const upstreamRequest = this.requestMeasured(
        "/responses",
        { method: "POST", body: prepared?.serializedBody ?? JSON.stringify(body) },
        context?.signal,
      );
      this.observeUpstreamModel(body.model, context);
      this.observeUpstreamActivity("waiting", context);
      const measured = await upstreamRequest;
      const raw = measured.value;
      this.observeUpstreamActivity("processing", context);
      const processingStartedAt = Date.now();
      const id = responseId(raw);
      const usage = extractUsage(raw);
      const outputCount = raw && typeof raw === "object" && Array.isArray((raw as { output?: unknown }).output)
        ? (raw as { output: unknown[] }).output.length
        : 0;
      this.options.logger.log({
        event: "EVREN_NATIVE_RESPONSE",
        data: { outputItems: outputCount, hasUsage: usage !== undefined },
      });
      const timing: EvrenResponseTiming = {
        ...measured.timing,
        resultProcessingMs: Date.now() - processingStartedAt,
      };
      this.observeUpstreamActivity("completed", context, { elapsedMs: Date.now() - startedAt });
      return { id, ...(usage === undefined ? {} : { usage }), raw, timing };
    } catch (error) {
      const classified = classifyUnexpectedError(error, context?.signal);
      this.observeUpstreamActivity("failed", context, {
        elapsedMs: Date.now() - startedAt,
        failureCode: classified.code,
      });
      throw classified;
    }
  }

  private assertModelRoute(upstreamModel: string, context: EvrenRequestContext | undefined): void {
    if (!context) return;
    if (context.bridgeModel !== upstreamModel
      || (context.codexRequestedModel !== undefined && context.codexRequestedModel !== upstreamModel)) {
      throw new Error("Effective upstream model does not match the requested Bridge route.");
    }
  }

  private observeUpstreamModel(upstreamModel: string, context: EvrenRequestContext | undefined): void {
    if (!context) return;
    try {
      const { signal: _signal, ...safeContext } = context;
      this.options.onUpstreamRequest?.({ ...safeContext, upstreamModel, observedAt: Date.now() });
    } catch {
      this.options.logger.log({
        event: "UPSTREAM_MODEL_OBSERVER_FAILED",
        level: "warn",
        message: "The safe upstream model observer failed after request dispatch.",
      });
    }
  }

  private observeUpstreamActivity(
    phase: EvrenUpstreamActivity["phase"],
    context: EvrenRequestContext | undefined,
    terminal: { elapsedMs?: number; failureCode?: string } = {},
  ): void {
    try {
      this.options.onUpstreamActivity?.({
        phase,
        observedAt: Date.now(),
        ...(context?.threadId === undefined ? {} : { threadId: context.threadId }),
        ...(context?.turnId === undefined ? {} : { turnId: context.turnId }),
        ...(context?.inferenceNumber === undefined ? {} : { inferenceNumber: context.inferenceNumber }),
        ...(terminal.elapsedMs === undefined ? {} : { elapsedMs: terminal.elapsedMs }),
        ...(terminal.failureCode === undefined ? {} : { failureCode: terminal.failureCode }),
      });
    } catch {
      // UI activity projection must never interfere with an upstream request.
    }
  }

  private async request(pathname: string, init: RequestInit, externalSignal?: AbortSignal): Promise<unknown> {
    return (await this.requestMeasured(pathname, init, externalSignal)).value;
  }

  private async requestMeasured(
    pathname: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<{ value: unknown; timing: Omit<EvrenResponseTiming, "resultProcessingMs"> }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const abortFromCaller = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const fetchImpl = this.options.fetch ?? fetch;
    try {
      const requestStartedAt = Date.now();
      const response = await fetchImpl(`${this.options.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
        },
      });
      const responseStartedAt = Date.now();
      if (!response.ok) throw await classifyHttpError(response);
      if (pathname === "/responses") this.captureCreditHeaders(response.headers);
      try {
        const value = await response.json();
        return {
          value,
          timing: {
            providerWaitMs: responseStartedAt - requestStartedAt,
            responseParseMs: Date.now() - responseStartedAt,
          },
        };
      } catch {
        throw malformedResponse("EVREN returned malformed JSON.");
      }
    } catch (error) {
      if (error instanceof EvrenUpstreamError) throw error;
      if (timedOut) {
        throw new EvrenUpstreamError("timeout", "upstream_timeout", "EVREN request timed out.", {
          retryable: true,
        });
      }
      if (externalSignal?.aborted) {
        throw new EvrenUpstreamError("aborted", "upstream_aborted", "EVREN request was interrupted.", {
          retryable: false,
        });
      }
      throw new EvrenUpstreamError("network", "upstream_network_error", "EVREN network request failed.", {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private captureCreditHeaders(headers: Headers): void {
    const parsed = parseEvrenCreditHeaders(headers);
    this.creditState = {
      ...(parsed.held === undefined ? {} : { held: parsed.held }),
      ...(parsed.remaining === undefined ? {} : { remaining: parsed.remaining }),
      uncertain: parsed.invalidHeld || parsed.invalidRemaining,
      updatedAt: new Date().toISOString(),
    };
    if (this.creditState.uncertain) {
      this.options.logger.log({
        event: "EVREN_CREDIT_HEADERS_INVALID",
        level: "warn",
        message: "EVREN returned an invalid credit header; the affected value is unavailable.",
        data: {
          invalidHeld: parsed.invalidHeld,
          invalidRemaining: parsed.invalidRemaining,
        },
      });
    }
  }
}

export function parseEvrenCreditHeaders(headers: Pick<Headers, "get">): {
  held?: number;
  remaining?: number;
  invalidHeld: boolean;
  invalidRemaining: boolean;
} {
  const held = parseCreditHeader(headers.get("X-Evren-Credits-Held"));
  const remaining = parseCreditHeader(headers.get("X-Evren-Credits-Remaining"));
  return {
    ...(held.value === undefined ? {} : { held: held.value }),
    ...(remaining.value === undefined ? {} : { remaining: remaining.value }),
    invalidHeld: held.invalid,
    invalidRemaining: remaining.invalid,
  };
}

function parseCreditHeader(raw: string | null): { value?: number; invalid: boolean } {
  if (raw === null) return { invalid: false };
  const trimmed = raw.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { invalid: true };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return { invalid: true };
  return { value, invalid: false };
}

function responseId(raw: unknown): string {
  const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
    ? (raw as { id: string }).id.trim()
    : "";
  if (!id) throw malformedResponse("EVREN response is missing a response id.");
  return id;
}

function malformedResponse(message: string): EvrenUpstreamError {
  return new EvrenUpstreamError("malformed_response", "upstream_malformed_response", message, {
    retryable: false,
  });
}

function classifyUnexpectedError(error: unknown, signal?: AbortSignal): EvrenUpstreamError {
  if (error instanceof EvrenUpstreamError) return error;
  if (signal?.aborted) {
    return new EvrenUpstreamError("aborted", "upstream_aborted", "EVREN request was interrupted.", {
      retryable: false,
    });
  }
  return new EvrenUpstreamError("malformed_response", "upstream_malformed_response", "EVREN response could not be processed.", {
    retryable: false,
  });
}

async function classifyHttpError(response: Response): Promise<EvrenUpstreamError> {
  const status = response.status;
  const metadata = await readProviderErrorMetadata(response);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  const hint = `${metadata.code ?? ""} ${metadata.message ?? ""}`.toLowerCase();
  const options = (retryable: boolean): EvrenUpstreamError["options"] => ({
    httpStatus: status,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (status === 401) {
    return new EvrenUpstreamError("authentication", "upstream_authentication_failed", "EVREN authentication failed (HTTP 401).", options(false));
  }
  if (status === 403) {
    return new EvrenUpstreamError("authorization", "upstream_authorization_failed", "EVREN authorization failed (HTTP 403).", options(false));
  }
  if (status === 413) {
    return new EvrenUpstreamError("payload_too_large", "upstream_payload_too_large", "EVREN rejected the request payload as too large (HTTP 413).", options(false));
  }
  if (status === 415 || /(?:unsupported|invalid).*(?:image|mime|media)|(?:image|mime|media).*(?:unsupported|invalid)/i.test(hint)) {
    return new EvrenUpstreamError("unsupported_media", "upstream_media_unsupported", `EVREN rejected the image or media input (HTTP ${status}).`, options(false));
  }
  if (status === 429) {
    return new EvrenUpstreamError("rate_limit", "upstream_rate_limit", "EVREN rate limited the request (HTTP 429).", options(true));
  }
  if ((status === 400 || status === 404 || status === 422)
    && /(?:model_not_found|unsupported_model|unknown_model)|(?:model).*(?:unsupported|not found|unknown)/i.test(hint)) {
    return new EvrenUpstreamError("unsupported_model", "upstream_model_unsupported", `EVREN rejected the selected model (HTTP ${status}).`, options(false));
  }
  if (status === 408 || status === 504) {
    return new EvrenUpstreamError("timeout", "upstream_timeout", `EVREN request timed out (HTTP ${status}).`, options(true));
  }
  if (status === 503) {
    return new EvrenUpstreamError("provider_overload", "upstream_overloaded", "EVREN or the selected provider is temporarily overloaded (HTTP 503).", options(true));
  }
  if (status >= 500) {
    return new EvrenUpstreamError("provider_error", "upstream_provider_error", `EVREN or the selected provider failed (HTTP ${status}).`, options(true));
  }
  if (status === 400 || status === 404 || status === 422) {
    return new EvrenUpstreamError("invalid_request", "upstream_invalid_request", `EVREN rejected the request (HTTP ${status}).`, options(false));
  }
  return new EvrenUpstreamError("provider_error", "upstream_http_error", `EVREN returned HTTP ${status}.`, options(false));
}

async function readProviderErrorMetadata(response: Response): Promise<{ code?: string; message?: string }> {
  let value: unknown;
  try {
    const text = (await response.text()).slice(0, 16 * 1024);
    value = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  const root = asRecord(value);
  const nested = asRecord(root?.error);
  return {
    ...safeProviderField(nested?.code ?? root?.code, "code"),
    ...safeProviderField(nested?.message ?? root?.message, "message"),
  };
}

function safeProviderField(value: unknown, key: "code" | "message"): { code?: string; message?: string } {
  if (typeof value !== "string") return {};
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  return text ? { [key]: text } : {};
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1_000), 24 * 60 * 60 * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), 24 * 60 * 60 * 1_000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
