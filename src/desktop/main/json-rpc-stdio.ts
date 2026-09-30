import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type RequestId = number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export class JsonRpcStdioTransport {
  private nextRequestId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly requestListeners = new Set<(request: JsonRpcServerRequest) => void>();
  private readonly pendingServerRequests = new Set<string>();
  private readonly lines: ReadlineInterface;
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: {
      requestTimeoutMs?: number;
      onDiagnostic?: (event: { type: "malformed_message" | "oversized_message" }) => void;
    } = {},
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    input.once("error", () => this.close(new Error("Codex App Server output failed.")));
    input.once("end", () => this.close(new Error("Codex App Server output ended.")));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex JSON-RPC transport is closed."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex JSON-RPC request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 10_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Codex JSON-RPC write failed."));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  respondError(id: string | number, code: number, message: string): void {
    this.claimServerRequest(id);
    this.write({ id, error: { code, message } });
  }

  respondResult(id: string | number, result: unknown): void {
    this.claimServerRequest(id);
    this.write({ id, result });
  }

  close(reason = new Error("Codex JSON-RPC transport closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
    this.pendingServerRequests.clear();
    this.notificationListeners.clear();
    this.requestListeners.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private handleLine(line: string): void {
    if (line.length > 10 * 1024 * 1024) {
      this.options.onDiagnostic?.({ type: "oversized_message" });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.options.onDiagnostic?.({ type: "malformed_message" });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.options.onDiagnostic?.({ type: "malformed_message" });
      return;
    }
    const message = value as Record<string, unknown>;
    if ((typeof message.id === "number" || typeof message.id === "string")
      && typeof message.method === "string") {
      const request: JsonRpcServerRequest = {
        id: message.id,
        method: message.method,
        ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
      };
      const requestKey = serverRequestKey(request.id);
      if (this.pendingServerRequests.has(requestKey)) {
        this.options.onDiagnostic?.({ type: "malformed_message" });
        return;
      }
      this.pendingServerRequests.add(requestKey);
      if (this.requestListeners.size === 0) {
        this.respondError(request.id, -32_601, "Server request is not supported by this client.");
      } else {
        try {
          for (const listener of this.requestListeners) listener(request);
        } catch {
          if (this.pendingServerRequests.has(requestKey)) {
            this.respondError(request.id, -32_603, "Server request handling failed safely.");
          }
        }
      }
      return;
    }
    if (typeof message.id === "number" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) {
        pending.reject(new Error(safeRpcErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!Object.hasOwn(message, "id") && typeof message.method === "string") {
      for (const listener of this.notificationListeners) listener(message.method, message.params);
      return;
    }
    this.options.onDiagnostic?.({ type: "malformed_message" });
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error("Codex JSON-RPC transport is closed.");
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private claimServerRequest(id: string | number): void {
    const key = serverRequestKey(id);
    if (!this.pendingServerRequests.delete(key)) {
      throw new Error("Codex server request is missing or already resolved.");
    }
  }
}

export class CodexAppServerClient {
  constructor(private readonly transport: JsonRpcStdioTransport) {}

  async initialize(clientVersion: string): Promise<void> {
    await this.transport.request("initialize", {
      clientInfo: {
        name: "evren_codex_desktop",
        title: "EVREN Codex Bridge",
        version: clientVersion,
      },
      capabilities: null,
    });
    // Exact Codex 0.157.1 generated schema defines this notification without params.
    this.transport.notify("initialized");
  }
}

function safeRpcErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Codex JSON-RPC request failed.";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.length <= 300
    ? message.replace(/[\u0000-\u001f\u007f]/g, " ")
    : "Codex JSON-RPC request failed.";
}

function serverRequestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}
