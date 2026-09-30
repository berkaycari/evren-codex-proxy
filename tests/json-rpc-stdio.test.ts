import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  JsonRpcStdioTransport,
  type JsonRpcServerRequest,
} from "../src/desktop/main/json-rpc-stdio.js";

function nextChunk(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => stream.once("data", (chunk) => resolve(String(chunk))));
}

describe("Codex JSON-RPC stdio transport", () => {
  it("routes concurrent request IDs to the correct promises", async () => {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, clientInput);
    const firstChunk = nextChunk(clientInput);
    const first = transport.request("first", { value: 1 });
    const firstRequest = JSON.parse((await firstChunk).trim()) as { id: number };
    const secondChunk = nextChunk(clientInput);
    const second = transport.request("second", { value: 2 });
    const secondRequest = JSON.parse((await secondChunk).trim()) as { id: number };
    serverOutput.write(`${JSON.stringify({ id: secondRequest.id, result: "second-result" })}\n`);
    serverOutput.write(`${JSON.stringify({ id: firstRequest.id, result: "first-result" })}\n`);
    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toBe("second-result");
    transport.close();
  });

  it("routes notifications without exposing them as responses", async () => {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const listener = vi.fn();
    const transport = new JsonRpcStdioTransport(serverOutput, clientInput);
    transport.onNotification(listener);
    serverOutput.write('{"method":"thread/started","params":{"safe":true}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(listener).toHaveBeenCalledWith("thread/started", { safe: true });
    transport.close();
  });

  it("does not crash on malformed input", async () => {
    const diagnostic = vi.fn();
    const serverOutput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, new PassThrough(), { onDiagnostic: diagnostic });
    serverOutput.write("not-json\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(diagnostic).toHaveBeenCalledWith({ type: "malformed_message" });
    transport.close();
  });

  it("rejects every pending request when the process stream closes", async () => {
    const serverOutput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, new PassThrough());
    const pending = transport.request("waiting", {});
    serverOutput.end();
    await expect(pending).rejects.toThrow("output ended");
    expect(transport.pendingCount).toBe(0);
  });

  it("performs the exact 0.157.1 initialize then initialized lifecycle", async () => {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, clientInput);
    const requestChunk = nextChunk(clientInput);
    const initializing = new CodexAppServerClient(transport).initialize("1.3.0");
    const request = JSON.parse((await requestChunk).trim()) as Record<string, unknown>;
    expect(request).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "evren_codex_desktop", title: "EVREN Codex Bridge", version: "1.3.0" },
        capabilities: null,
      },
    });
    const notificationChunk = nextChunk(clientInput);
    serverOutput.write(`${JSON.stringify({ id: request.id, result: {
      userAgent: "codex",
      codexHome: "C:\\codex",
      platformFamily: "windows",
      platformOs: "windows",
    } })}\n`);
    await initializing;
    expect(JSON.parse((await notificationChunk).trim())).toEqual({ method: "initialized" });
    transport.close();
  });

  it("provides a safe server-request placeholder response", async () => {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, clientInput);
    const responseChunk = nextChunk(clientInput);
    serverOutput.write('{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{}}\n');
    const response = JSON.parse((await responseChunk).trim()) as Record<string, unknown>;
    expect(response).toMatchObject({ id: "approval-1", error: { code: -32601 } });
    transport.close();
  });

  it("routes server requests and writes one exact JSON-RPC result", async () => {
    const serverOutput = new PassThrough();
    const clientInput = new PassThrough();
    const transport = new JsonRpcStdioTransport(serverOutput, clientInput);
    const listener = vi.fn((request: JsonRpcServerRequest) => {
      transport.respondResult(request.id, { decision: "accept" });
    });
    transport.onServerRequest(listener);
    const responseChunk = nextChunk(clientInput);
    serverOutput.write('{"id":"approval-2","method":"item/commandExecution/requestApproval","params":{"threadId":"t"}}\n');
    expect(JSON.parse((await responseChunk).trim())).toEqual({ id: "approval-2", result: { decision: "accept" } });
    expect(listener).toHaveBeenCalledOnce();
    expect(() => transport.respondResult("approval-2", { decision: "decline" })).toThrow("already resolved");
    transport.close();
  });
});
