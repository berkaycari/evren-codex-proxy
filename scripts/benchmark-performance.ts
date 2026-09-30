import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { BridgeService } from "../src/bridge/bridge-service.js";
import type { NativeEvrenRequest } from "../src/bridge/native-codex-to-evren.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { CodexAppServerManager } from "../src/desktop/main/codex-app-server.js";
import { buildCodexLaunchSpec, DESKTOP_PROVIDER_ID } from "../src/desktop/main/codex-launch.js";
import { detectCodex } from "../src/desktop/main/codex-version.js";
import {
  EvrenClient,
  type EvrenInferenceResult,
  type EvrenNativeResult,
  type EvrenRequestContext,
  type EvrenTransport,
  type PreparedEvrenPayload,
} from "../src/evren/client.js";
import { generateLocalBridgeToken } from "../src/runtime/local-auth.js";
import { SessionStore } from "../src/sessions/store.js";
import { buildServer } from "../src/server/app.js";
import { UsagePersistence } from "../src/usage/persistence.js";
import { UsageTracker } from "../src/usage/tracker.js";

const execFileAsync = promisify(execFile);
const MODEL = "deepseek-v4.1-flash";
const functionTool = {
  type: "function",
  name: "read_fixture",
  description: "Read a deterministic benchmark fixture.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  strict: true,
};

type NativeResultFactory = (request: NativeEvrenRequest, index: number) => Record<string, unknown>;

class BenchmarkTransport implements EvrenTransport {
  readonly requests: NativeEvrenRequest[] = [];
  readonly preparedPayloads: PreparedEvrenPayload[] = [];
  private index = 0;

  constructor(private readonly factories: NativeResultFactory[] = []) {}

  async getModels(): Promise<unknown> {
    return { data: [] };
  }

  async infer(): Promise<EvrenInferenceResult> {
    throw new Error("Benchmark unexpectedly used textual inference.");
  }

  async respond(
    request: NativeEvrenRequest,
    _context?: EvrenRequestContext,
    prepared?: PreparedEvrenPayload,
  ): Promise<EvrenNativeResult> {
    const index = this.index++;
    this.requests.push(structuredClone(request));
    if (prepared) this.preparedPayloads.push(prepared);
    const raw = (this.factories[index] ?? this.factories.at(-1) ?? finalFactory)(request, index);
    return {
      id: String(raw.id),
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      raw,
      timing: { providerWaitMs: 0, responseParseMs: 0, resultProcessingMs: 0 },
    };
  }
}

function finalFactory(_request: NativeEvrenRequest, index: number): Record<string, unknown> {
  return response(`mock_${index}`, [message("OK")]);
}

function response(id: string, output: unknown[]): Record<string, unknown> {
  return { id, output, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
}

function message(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function toolCall(id: string): Record<string, unknown> {
  return { type: "function_call", call_id: id, name: "read_fixture", arguments: '{"path":"fixture.txt"}' };
}

async function bridgeFixture(
  factories: NativeResultFactory[] = [],
  overrides: Partial<BridgeConfig> = {},
  localClientAuthToken?: string,
) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "evren-performance-"));
  const config = { ...loadConfig({}), model: MODEL, maxRequestsPerSession: 250, ...overrides };
  const client = new BenchmarkTransport(factories);
  const sessions = new SessionStore(config.sessionTtlMinutes * 60_000);
  const usage = new UsageTracker(new UsagePersistence(tempDir));
  await usage.initialize();
  const logger = { log: () => undefined };
  const pricingGuard = {
    assertAllowed: () => undefined,
    getState: () => ({
      allowed: true,
      connected: true,
      checkedAt: "2026-09-30T00:00:00.000Z",
      pricing: { promptTokenPrice: 0, completionTokenPrice: 0, currency: "CR" },
    }),
  };
  const bridge = new BridgeService({ config, client, pricingGuard, sessions, usage, logger });
  const app = buildServer({
    config,
    pricingGuard,
    sessions,
    usage,
    bridge,
    logger,
    ...(localClientAuthToken ? { localClientAuthToken } : {}),
  });
  return {
    app,
    client,
    sessions,
    tempDir,
    async close() {
      await app.close();
      await removeOwnedTemp(tempDir);
    },
  };
}

function metadata(requestKind: string, threadId: string, windowNumber = 1): Record<string, string> {
  return {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: requestKind,
      thread_id: threadId,
      turn_id: `turn_${requestKind}_${windowNumber}`,
      window_id: `window_${windowNumber}`,
      window_number: windowNumber,
      context_window_id: `context_${windowNumber}`,
    }),
  };
}

async function actualCodexBootstrapBenchmark() {
  const status = await detectCodex();
  assert(status.found && status.version === "0.157.1", `Codex 0.157.1 required; detected ${status.version ?? "none"}.`);
  const localToken = generateLocalBridgeToken();
  const fixture = await bridgeFixture([finalFactory, finalFactory], {}, localToken);
  const manager = new CodexAppServerManager();
  try {
    await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (fixture.app.server.address() as AddressInfo).port;
    await manager.start(buildCodexLaunchSpec({
      cwd: process.cwd(),
      host: "127.0.0.1",
      port,
      model: MODEL,
      localBridgeToken: localToken,
    }), "2.0.0-performance-benchmark");
    manager.onServerRequest((request) => manager.rejectServerRequest(request.id, -32_600, "Benchmark never approves server requests."));
    const started = asRecord(await manager.request("thread/start", {
      model: MODEL,
      modelProvider: DESKTOP_PROVIDER_ID,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: true,
      threadSource: "evren-codex-desktop",
    }));
    const threadId = String(asRecord(started.thread)?.id ?? "");
    assert(threadId.length > 0, "Codex did not return a thread id.");
    const firstPrompt = "Reply with the single word OK.";
    await runCodexTurn(manager, threadId, firstPrompt);
    const first = structuredClone(fixture.sessions.getCurrent()?.performanceObservability.traces[0]);
    await runCodexTurn(manager, threadId, "Again, reply with the single word OK.");
    const traces = fixture.sessions.getCurrent()?.performanceObservability.traces ?? [];
    const second = structuredClone(traces[1]);
    assert(first && second, "Codex benchmark did not produce two upstream traces.");
    const firstRequest = fixture.client.requests[0];
    assert(firstRequest, "Codex benchmark did not capture the first upstream request.");
    return {
      codexVersion: status.version,
      first,
      second,
      secondTurnPayloadGrowthBytes: second.payloadBytes - first.payloadBytes,
      toolCount: fixture.client.requests[0]?.tools.length ?? 0,
      serializedPayloadReused: fixture.client.preparedPayloads.every((prepared, index) =>
        prepared.serializedBody === JSON.stringify(fixture.client.requests[index])),
      firstRequestComponents: codexRequestComponents(firstRequest, first, firstPrompt),
      request: firstRequest,
    };
  } finally {
    await manager.stop();
    await fixture.close();
  }
}

function codexRequestComponents(
  request: NativeEvrenRequest,
  trace: { payloadBytes: number; currentInputBytes: number },
  prompt: string,
) {
  const question = request.input.find((item) => Array.isArray(item.content)
    && item.content.some((block) => Boolean(block) && typeof block === "object"
      && (block as { text?: unknown }).text === prompt));
  assert(question, "Could not isolate the benchmark user question.");
  const questionItemBytes = byteLength(question);
  const bootstrapCurrentInputBytes = trace.currentInputBytes - questionItemBytes - 1;
  const counts = new Map<string, number>();
  for (const item of request.input) {
    const serialized = JSON.stringify(item);
    counts.set(serialized, (counts.get(serialized) ?? 0) + 1);
  }
  return {
    userQuestionItemBytes: questionItemBytes,
    bootstrapCurrentInputBytes,
    fixedRequestBytesExcludingQuestionItem: trace.payloadBytes - questionItemBytes - 1,
    exactDuplicateInputItems: [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    toolSchemas: request.tools.map((tool) => ({ name: tool.name, bytes: byteLength(tool) })),
  };
}

async function runCodexTurn(manager: CodexAppServerManager, threadId: string, text: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    const unsubscribe = manager.onNotification((method, params) => {
      if (method !== "turn/completed") return;
      const value = asRecord(params);
      if (value.threadId !== threadId) return;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve();
    });
    timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Codex turn benchmark timed out."));
    }, 30_000);
  });
  await manager.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    clientUserMessageId: randomUUID(),
    model: MODEL,
  });
  await completed;
}

async function toolLoopBenchmark() {
  const fixture = await bridgeFixture([
    () => response("loop_1", [toolCall("call_1")]),
    () => response("loop_2", [toolCall("call_2")]),
    () => response("loop_3", [message("done")]),
  ]);
  try {
    const initial = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      input: "Read the fixture twice.", tools: [functionTool], client_metadata: metadata("turn", "thread_loop"),
    } });
    const one = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      previous_response_id: initial.json().id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "first" }],
      tools: [functionTool], client_metadata: metadata("turn", "thread_loop"),
    } });
    const two = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      previous_response_id: one.json().id,
      input: [
        { type: "function_call_output", call_id: "call_1", output: "first" },
        { type: "function_call_output", call_id: "call_2", output: "second" },
      ],
      tools: [functionTool], client_metadata: metadata("turn", "thread_loop"),
    } });
    assert(two.statusCode === 200, "Tool loop did not complete.");
    const session = fixture.sessions.getCurrent()!;
    return {
      inferenceCount: session.inferenceCount,
      reasons: session.performanceObservability.reasonCounts,
      payloadBytes: session.performanceObservability.traces.map((trace) => trace.payloadBytes),
      duplicateFirstOutputOccurrencesInLastRequest:
        occurrences(JSON.stringify(fixture.client.requests[2]), '"output":"first"'),
    };
  } finally {
    await fixture.close();
  }
}

async function largeOutputBenchmark() {
  const fixture = await bridgeFixture([
    () => response("large_1", [toolCall("call_large")]),
    () => response("large_2", [message("done")]),
  ]);
  try {
    const first = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      input: "Read the large fixture.", tools: [functionTool],
    } });
    const raw = `HEAD-${"x".repeat(199_988)}-TAIL`;
    const second = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      previous_response_id: first.json().id,
      input: [{ type: "function_call_output", call_id: "call_large", output: raw }],
      tools: [functionTool],
    } });
    assert(second.statusCode === 200, "Large-output continuation failed.");
    const forwardedItem = fixture.client.requests[1]?.input
      .map(asRecord)
      .find((item) => item.type === "function_call_output" && item.call_id === "call_large");
    const forwardedOutput = typeof forwardedItem?.output === "string" ? forwardedItem.output : "";
    const trace = fixture.sessions.getCurrent()?.performanceObservability.traces[1];
    return {
      rawChars: raw.length,
      configuredLimitChars: 50_000,
      retainedOutputChars: forwardedOutput.length,
      keptHead: forwardedOutput.startsWith("HEAD-"),
      keptTail: forwardedOutput.endsWith("-TAIL"),
      hasExplicitMarker: forwardedOutput.includes("[TRUNCATED 149998 CHARS]"),
      currentInputBytes: trace?.currentInputBytes,
      acceptedHistoricalToolOutputBytes: trace?.acceptedToolOutputBytes,
    };
  } finally {
    await fixture.close();
  }
}

async function compactionBenchmark() {
  const fixture = await bridgeFixture([
    () => response("compact_1", [message("old answer")]),
    () => response("compact_2", [message("summary")]),
    () => response("compact_3", [message("new answer")]),
  ]);
  try {
    const old = `obsolete-${"x".repeat(40_000)}`;
    await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      instructions: "stable instruction",
      input: old,
      tools: [functionTool],
      client_metadata: metadata("turn", "thread_compaction", 1),
    } });
    await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      instructions: "stable instruction",
      input: [
        { type: "message", role: "user", content: old },
        { type: "message", role: "assistant", content: "old answer" },
      ],
      tools: [functionTool],
      client_metadata: metadata("compaction", "thread_compaction", 1),
    } });
    const after = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      instructions: "stable instruction",
      input: [
        { type: "message", role: "user", content: "Compacted deterministic summary" },
        { type: "message", role: "user", content: "continue" },
      ],
      tools: [functionTool],
      client_metadata: metadata("turn", "thread_compaction", 2),
    } });
    assert(after.statusCode === 200, "Compaction continuation failed.");
    const session = fixture.sessions.getCurrent()!;
    const traces = session.performanceObservability.traces;
    return {
      beforeCanonicalHistoryBytes: traces[1]?.canonicalHistoryBytes,
      afterCanonicalHistoryBytes: traces[2]?.canonicalHistoryBytes,
      oldContentStillPresent: JSON.stringify(fixture.client.requests[2]).includes("obsolete-"),
      acceptedCompactionCount: session.acceptedCompactionCount,
      cumulativeTokens: session.usage.totalTokens,
      reasons: session.performanceObservability.reasonCounts,
    };
  } finally {
    await fixture.close();
  }
}

async function imageBenchmark() {
  const fixture = await bridgeFixture();
  try {
    const source = Buffer.alloc(1_024, 7);
    const imageUrl = `data:image/png;base64,${source.toString("base64")}`;
    const result = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: imageUrl, detail: "auto" },
      ] }],
    } });
    assert(result.statusCode === 200, "Image fixture failed.");
    const context = fixture.sessions.getCurrent()!.contextObservability;
    return {
      sourceBytes: context.sourceImageBytes,
      encodedPayloadBytes: context.encodedImageBytes,
      base64Characters: source.toString("base64").length,
      forwardedOccurrences: occurrences(JSON.stringify(fixture.client.requests[0]), imageUrl),
    };
  } finally {
    await fixture.close();
  }
}

async function longMemoryBenchmark() {
  const fixture = await bridgeFixture();
  try {
    const heapBefore = process.memoryUsage().heapUsed;
    let previousResponseId: string | undefined;
    for (let index = 0; index < 140; index += 1) {
      const result = await fixture.app.inject({ method: "POST", url: "/v1/responses", payload: {
        input: `turn-${index}`,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      } });
      assert(result.statusCode === 200, `Long-memory fixture failed at inference ${index + 1}.`);
      previousResponseId = result.json().id;
    }
    const session = fixture.sessions.getCurrent()!;
    return {
      inferenceCount: session.inferenceCount,
      retainedTraceCount: session.performanceObservability.traces.length,
      traceLimit: 128,
      nativeHistoryItems: session.nativeHistory.length,
      heapDeltaBytesIndicative: process.memoryUsage().heapUsed - heapBefore,
    };
  } finally {
    await fixture.close();
  }
}

async function stopBenchmark() {
  let requestCount = 0;
  const waitingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  }) as typeof fetch;
  const client = new EvrenClient({
    baseUrl: "https://benchmark.invalid/v1",
    apiKey: "benchmark-only-not-real",
    model: MODEL,
    timeoutMs: 30_000,
    logger: { log: () => undefined },
    fetch: waitingFetch,
  });
  const controller = new AbortController();
  const pending = client.infer("stop", 16, {
    bridgeModel: MODEL,
    inferenceNumber: 1,
    signal: controller.signal,
  }).then(() => ({ code: "unexpected_success" }), (error: unknown) => ({
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
  }));
  controller.abort();
  const result = await pending;
  return { requestCount, continuationRequests: Math.max(0, requestCount - 1), failureCode: result.code };
}

async function fileAndPackageBenchmark() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evren-command-benchmark-"));
  try {
    const fixturePath = path.join(root, "fixture.txt");
    await writeFile(fixturePath, "needle one\nneedle two\n", "utf8");
    const readDurationsMs: number[] = [];
    const searchDurationsMs: number[] = [];
    const counts: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      let startedAt = performance.now();
      const value = await readFile(fixturePath, "utf8");
      readDurationsMs.push(round(performance.now() - startedAt));
      counts.push(occurrences(value, "needle"));
      startedAt = performance.now();
      await execFileAsync("rg", ["--count", "needle", fixturePath], { windowsHide: true });
      searchDurationsMs.push(round(performance.now() - startedAt));
    }
    await writeFile(fixturePath, "needle one\nchanged\nneedle three\n", "utf8");
    const changed = await readFile(fixturePath, "utf8");
    const packageJson = path.join(root, "package.json");
    await writeFile(packageJson, '{"name":"evren-performance-fixture","version":"1.0.0","private":true}\n', "utf8");
    const installDurationsMs: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const startedAt = performance.now();
      if (process.platform === "win32") {
        await execFileAsync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", [
          "/d", "/s", "/c", "npm.cmd install --offline --ignore-scripts --no-audit --no-fund --package-lock=false",
        ], { cwd: root, windowsHide: true });
      } else {
        await execFileAsync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], {
          cwd: root,
          windowsHide: true,
        });
      }
      installDurationsMs.push(round(performance.now() - startedAt));
    }
    return {
      fileReads: { durationsMs: readDurationsMs, unchangedCounts: counts, afterChangeCount: occurrences(changed, "needle") },
      searches: { durationsMs: searchDurationsMs, executions: 2, suppressedExecutions: 0 },
      packageInstall: { coldMs: installDurationsMs[0], warmMs: installDurationsMs[1], executions: 2, suppressedExecutions: 0 },
    };
  } finally {
    await removeOwnedTemp(root);
  }
}

function serializationBenchmark(request: NativeEvrenRequest) {
  const iterations = 250;
  let startedAt = performance.now();
  let legacyBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    legacyBytes += Buffer.byteLength(JSON.stringify(request), "utf8");
    legacyBytes += Buffer.byteLength(JSON.stringify(request), "utf8");
    legacyBytes += Buffer.byteLength(JSON.stringify(request), "utf8");
  }
  const legacyMs = round(performance.now() - startedAt);
  startedAt = performance.now();
  let optimizedBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const prepared = JSON.stringify(request);
    optimizedBytes += Buffer.byteLength(prepared, "utf8");
  }
  const optimizedMs = round(performance.now() - startedAt);
  return {
    iterations,
    legacyFullSerializationPassesPerRequest: 3,
    optimizedFullSerializationPassesPerRequest: 1,
    legacyBytesProcessed: legacyBytes,
    optimizedBytesProcessed: optimizedBytes,
    byteWorkReductionPercent: round((1 - optimizedBytes / legacyBytes) * 100),
    legacyMsIndicative: legacyMs,
    optimizedMsIndicative: optimizedMs,
  };
}

function occurrences(value: string, needle: string): number {
  if (!needle) return 0;
  return value.split(needle).length - 1;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function assert(condition: unknown, messageText: string): asserts condition {
  if (!condition) throw new Error(messageText);
}

async function removeOwnedTemp(target: string): Promise<void> {
  const relative = path.relative(os.tmpdir(), path.resolve(target));
  assert(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), `Refusing to remove non-temp path: ${target}`);
  await rm(target, { recursive: true, force: true });
}

const actual = await actualCodexBootstrapBenchmark();
const report = {
  generatedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, provider: "deterministic mock; no EVREN credential or credits" },
  A_freshTrivialRequest: actual.first,
  B_secondTurnSameThread: actual.second,
  B_secondTurnPayloadGrowthBytes: actual.secondTurnPayloadGrowthBytes,
  actualCodexToolCount: actual.toolCount,
  actualCodexFirstRequestComponents: actual.firstRequestComponents,
  preparedPayloadReused: actual.serializedPayloadReused,
  C_multiToolLoop: await toolLoopBenchmark(),
  D_largeToolOutput: await largeOutputBenchmark(),
  E_repeatedFileAndSearch: undefined as unknown,
  F_coldWarmPackageInstall: undefined as unknown,
  G_compaction: await compactionBenchmark(),
  H_imagePayload: await imageBenchmark(),
  I_stopCancellation: await stopBenchmark(),
  longTaskMemory: await longMemoryBenchmark(),
  serialization: serializationBenchmark(actual.request),
};
const commandResults = await fileAndPackageBenchmark();
report.E_repeatedFileAndSearch = { fileReads: commandResults.fileReads, searches: commandResults.searches };
report.F_coldWarmPackageInstall = commandResults.packageInstall;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
