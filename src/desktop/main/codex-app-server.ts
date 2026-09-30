import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CodexLaunchSpec } from "./codex-launch.js";
import {
  CodexAppServerClient,
  JsonRpcStdioTransport,
  type JsonRpcServerRequest,
} from "./json-rpc-stdio.js";

export interface CodexProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type CodexSpawner = (spec: CodexLaunchSpec) => CodexProcessLike;

export class CodexAppServerManager {
  private child: CodexProcessLike | undefined;
  private transport: JsonRpcStdioTransport | undefined;
  private stopping = false;

  constructor(private readonly options: {
    spawn?: CodexSpawner;
    shutdownTimeoutMs?: number;
    onExit?: () => void;
    onDiagnostic?: (event: string) => void;
  } = {}) {}

  async start(spec: CodexLaunchSpec, clientVersion: string): Promise<void> {
    if (this.child) throw new Error("Codex App Server is already running.");
    const child = (this.options.spawn ?? defaultSpawner)(spec);
    this.child = child;
    this.stopping = false;
    const transport = new JsonRpcStdioTransport(
      child.stdout,
      child.stdin,
      { onDiagnostic: (event) => this.options.onDiagnostic?.(`rpc_${event.type}`) },
    );
    this.transport = transport;
    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrLines.on("line", () => this.options.onDiagnostic?.("codex_stderr"));
    child.once("exit", () => {
      stderrLines.close();
      transport.close(new Error("Codex App Server exited."));
      this.child = undefined;
      this.transport = undefined;
      if (!this.stopping) this.options.onExit?.();
    });
    child.once("error", (error) => transport.close(error));
    try {
      await new CodexAppServerClient(transport).initialize(clientVersion);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.transport?.close(new Error("Codex App Server is shutting down."));
    const exited = waitForExit(child);
    try {
      child.stdin.end();
    } catch {
      // The child may already have closed stdin.
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(this.options.shutdownTimeoutMs ?? 2_000).then(() => false),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill();
      await Promise.race([exited, delay(1_000)]);
    }
    this.child = undefined;
    this.transport = undefined;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.transport) return Promise.reject(new Error("Codex App Server is not running."));
    return this.transport.request(method, params);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    if (!this.transport) throw new Error("Codex App Server is not running.");
    return this.transport.onNotification(listener);
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): () => void {
    if (!this.transport) throw new Error("Codex App Server is not running.");
    return this.transport.onServerRequest(listener);
  }

  respondToServerRequest(id: string | number, result: unknown): void {
    if (!this.transport) throw new Error("Codex App Server is not running.");
    this.transport.respondResult(id, result);
  }

  rejectServerRequest(id: string | number, code: number, message: string): void {
    if (!this.transport) throw new Error("Codex App Server is not running.");
    this.transport.respondError(id, code, message);
  }
}

function defaultSpawner(spec: CodexLaunchSpec): ChildProcessWithoutNullStreams {
  return spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForExit(child: CodexProcessLike): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
