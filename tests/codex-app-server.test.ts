import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerManager, type CodexProcessLike } from "../src/desktop/main/codex-app-server.js";
import type { CodexLaunchSpec } from "../src/desktop/main/codex-launch.js";

class FakeChild extends EventEmitter implements CodexProcessLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  exitOnStdinEnd = true;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as Record<string, unknown>;
      if (request.method === "initialize") {
        this.stdout.write(`${JSON.stringify({ id: request.id, result: {
          userAgent: "codex",
          codexHome: "C:\\codex",
          platformFamily: "windows",
          platformOs: "windows",
        } })}\n`);
      }
    });
    this.stdin.on("finish", () => {
      if (this.exitOnStdinEnd) this.finishExit();
    });
  }

  kill(): boolean {
    this.killed = true;
    this.finishExit();
    return true;
  }

  finishExit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

const spec: CodexLaunchSpec = {
  executable: "codex",
  args: ["app-server", "--listen", "stdio://"],
  cwd: "C:\\workspace",
  env: {},
};

describe("Codex App Server manager", () => {
  it("initializes and shuts down gracefully on stdin EOF", async () => {
    const child = new FakeChild();
    const manager = new CodexAppServerManager({ spawn: () => child, shutdownTimeoutMs: 20 });
    await manager.start(spec, "1.3.0");
    expect(manager.running).toBe(true);
    await manager.stop();
    expect(child.killed).toBe(false);
    expect(manager.running).toBe(false);
  });

  it("force-kills only after the graceful timeout", async () => {
    const child = new FakeChild();
    child.exitOnStdinEnd = false;
    const manager = new CodexAppServerManager({ spawn: () => child, shutdownTimeoutMs: 5 });
    await manager.start(spec, "1.3.0");
    await manager.stop();
    expect(child.killed).toBe(true);
  });

  it("surfaces unexpected child exit without crashing the host", async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const manager = new CodexAppServerManager({ spawn: () => child, onExit });
    await manager.start(spec, "1.3.0");
    child.finishExit();
    expect(onExit).toHaveBeenCalledOnce();
    expect(manager.running).toBe(false);
  });

  it("logs stderr only as safe metadata", async () => {
    const child = new FakeChild();
    const diagnostic = vi.fn();
    const manager = new CodexAppServerManager({ spawn: () => child, onDiagnostic: diagnostic });
    await manager.start(spec, "1.3.0");
    child.stderr.write("secret raw payload\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(diagnostic).toHaveBeenCalledWith("codex_stderr");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret raw payload");
    await manager.stop();
  });
});
