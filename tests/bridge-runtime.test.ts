import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeEvrenRequest } from "../src/bridge/native-codex-to-evren.js";
import { loadConfig } from "../src/config.js";
import type { EvrenInferenceResult, EvrenNativeResult, EvrenTransport } from "../src/evren/client.js";
import { createBridgeRuntime, type BridgeRuntime } from "../src/runtime/bridge-runtime.js";

class FakeEvren implements EvrenTransport {
  readonly nativeRequests: NativeEvrenRequest[] = [];
  constructor(private readonly model: string) {}
  async getModels(): Promise<unknown> {
    return { data: [{
      id: this.model,
      pricing: { prompt_token_price: 0, completion_token_price: 0, currency: "CR" },
    }] };
  }
  getEffectiveModel(): string { return this.model; }
  async infer(): Promise<EvrenInferenceResult> { throw new Error("textual transport is not expected"); }
  async respond(request: NativeEvrenRequest): Promise<EvrenNativeResult> {
    this.nativeRequests.push(request);
    return {
      id: "evren_runtime_1",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      raw: {
        id: "evren_runtime_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    };
  }
}

const runtimes: BridgeRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(localClientAuthToken?: string, effectiveModel = "runtime-model") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-runtime-"));
  directories.push(directory);
  const model = "runtime-model";
  const client = new FakeEvren(effectiveModel);
  const runtime = createBridgeRuntime({
    apiKey: "actual-evren-key",
    currentVersion: "1.3.0",
    dataDir: path.join(directory, "data"),
    logsDir: path.join(directory, "logs"),
    config: loadConfig({}),
    modelOverride: model,
    port: 0,
    ...(localClientAuthToken === undefined ? {} : { localClientAuthToken }),
    dashboardEnabled: false,
    consoleLogging: false,
    client,
  });
  runtimes.push(runtime);
  const snapshot = await runtime.start();
  return { runtime, snapshot, client };
}

describe("reusable Bridge runtime", () => {
  it("starts the v1.3 core on an ephemeral loopback port and stops cleanly", async () => {
    const { runtime, snapshot } = await fixture();
    expect(snapshot).toMatchObject({ status: "running", host: "127.0.0.1", model: "runtime-model" });
    expect(snapshot.port).toBeGreaterThan(0);
    expect(snapshot.port).not.toBe(8787);
    await runtime.stop();
    expect(runtime.snapshot().status).toBe("stopped");
  });

  it("keeps legacy CLI mode available without local authentication", async () => {
    const { snapshot } = await fixture();
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/models`);
    expect(response.status).toBe(200);
  });

  it("rejects a missing Desktop local token", async () => {
    const { snapshot } = await fixture("local-token-value-that-is-long-enough");
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/models`);
    expect(response.status).toBe(401);
  });

  it("rejects a wrong Desktop local token", async () => {
    const { snapshot } = await fixture("local-token-value-that-is-long-enough");
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/models`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the correct Desktop local token", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { snapshot } = await fixture(token);
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a Codex model mismatch before EVREN inference", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { snapshot, client } = await fixture(token);
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "different-model", input: "hello", stream: false }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request_error" } });
    expect(client.nativeRequests).toHaveLength(0);
  });

  it("requires an explicit Codex model in authenticated Desktop mode", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { snapshot, client } = await fixture(token);
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", stream: false }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_request_error",
        message: "Desktop Codex request did not include an explicit model.",
      },
    });
    expect(client.nativeRequests).toHaveLength(0);
  });

  it("rejects a conflicting effective upstream client model before EVREN inference", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { snapshot, client } = await fixture(token, "silently-rerouted-model");
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "runtime-model", input: "hello", stream: false }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "invalid_request_error",
        message: "Effective upstream model does not match the active Desktop Bridge model.",
      },
    });
    expect(client.nativeRequests).toHaveLength(0);
  });

  it("uses the explicit runtime model override", async () => {
    const { runtime } = await fixture();
    expect(runtime.config.model).toBe("runtime-model");
  });

  it("never forwards the local bearer token in the EVREN request body", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { snapshot, client } = await fixture(token);
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "runtime-model", input: "hello", stream: false }),
    });
    expect(response.status).toBe(200);
    expect(client.nativeRequests).toHaveLength(1);
    expect(JSON.stringify(client.nativeRequests)).not.toContain(token);
    expect(JSON.stringify(client.nativeRequests)).not.toContain("actual-evren-key");
  });

  it("uses verified live session metadata as the only upstream model identity source", async () => {
    const token = "local-token-value-that-is-long-enough";
    const { runtime, snapshot, client } = await fixture(token);
    const response = await fetch(`http://127.0.0.1:${snapshot.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "runtime-model",
        instructions: "You are Codex, based on GPT-5. MEMORY.md says GPT-5.",
        input: "Which model are you?",
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    const request = client.nativeRequests[0]!;
    const serializedInput = JSON.stringify(request.input);
    expect(serializedInput).toContain("You are Codex, based on GPT-5");
    const identityMessage = request.input.find((item) => JSON.stringify(item).includes("BRIDGE-VERIFIED LIVE SESSION MODEL METADATA"));
    expect(identityMessage).toMatchObject({ type: "message", role: "developer" });
    const identityInstruction = String(
      ((identityMessage?.content as Array<{ text?: unknown }> | undefined)?.[0]?.text),
    );
    expect(identityInstruction).toContain('"upstream_inference_model":"runtime-model"');
    expect(identityInstruction).toContain("Codex is the agent/runtime");
    expect(identityInstruction).toContain("EVREN is the provider/bridge");
    expect(identityInstruction).toContain("MEMORY.md");
    expect(runtime.snapshot().session?.modelIdentity).toEqual({
      source: "bridge_session",
      agentRuntime: "Codex",
      providerBridge: "EVREN",
      upstreamInferenceModel: "runtime-model",
    });
  });

  it("emits safe runtime state snapshots", async () => {
    const { runtime } = await fixture("local-token-value-that-is-long-enough");
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain("local-token-value-that-is-long-enough");
    expect(serialized).not.toContain("actual-evren-key");
  });
});
