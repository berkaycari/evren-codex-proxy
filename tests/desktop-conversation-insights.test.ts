import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopHistoryStore,
  type ConversationProviderSnapshot,
} from "../src/desktop/main/history-service.js";
import type { ConversationChangeSummaryDto, ThreadSummaryDto } from "../src/desktop/shared/contracts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ root: string; store: DesktopHistoryStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "evren-insights-test-"));
  directories.push(root);
  const store = new DesktopHistoryStore(root);
  await store.load();
  return { root, store };
}

function thread(id: string): ThreadSummaryDto {
  return { id, preview: "Task", cwd: "C:\\workspace", model: "model-1", modelProvider: "evren-desktop", updatedAt: 100, state: "idle" };
}

function provider(overrides: Partial<ConversationProviderSnapshot> = {}): ConversationProviderSnapshot {
  return {
    sessionId: "session-1",
    requests: 2,
    inferences: 3,
    toolCalls: 4,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 30,
    totalTokens: 120,
    activeContextBytes: 1_000,
    peakContextBytes: 1_500,
    replayBytes: 200,
    payloadBytes: 2_000,
    peakPayloadBytes: 1_200,
    instructionBytes: 700,
    toolCatalogBytes: 500,
    toolResultBytes: 100,
    sessionMetadataBytes: 80,
    protocolWrapperBytes: 20,
    encodedImageBytes: 0,
    sourceImageBytes: 0,
    providerWaitMs: 900,
    responseParseMs: 10,
    resultProcessingMs: 40,
    requestSerializationMs: 5,
    peakInferenceInputTokens: 75,
    inferenceReasons: {
      initialTurn: 1,
      conversationContinuation: 0,
      toolResult: 2,
      compaction: 0,
      compactionContinuation: 0,
      prewarm: 0,
      memory: 0,
      protocolRepair: 0,
      other: 0,
    },
    compactions: 1,
    accountingCertain: true,
    observedAt: 1_000,
    ...overrides,
  };
}

function changes(filesChanged = 1): ConversationChangeSummaryDto {
  return { filesChanged, additions: 4, deletions: 2, created: 0, modified: filesChanged, deleted: 0, renamed: 0 };
}

describe("Conversation insights persistence", () => {
  it("starts each conversation with isolated accounting", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.upsertThread(thread("thread-2"), "Project");
    await store.recordProviderSnapshot("thread-1", provider());
    expect(store.find("thread-1")?.insights?.totalTokens).toBe(120);
    expect(store.find("thread-2")?.insights).toBeUndefined();
  });

  it("updates one provider session monotonically without replay double-counting", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordProviderSnapshot("thread-1", provider());
    await store.recordProviderSnapshot("thread-1", provider({ requests: 3, totalTokens: 150, inputTokens: 120, outputTokens: 30, cachedTokens: 35 }));
    await store.recordProviderSnapshot("thread-1", provider({ requests: 2, totalTokens: 120 }));
    expect(store.find("thread-1")?.insights).toMatchObject({ requests: 3, inputTokens: 120, outputTokens: 30, cachedTokens: 35, totalTokens: 150 });
  });

  it("accumulates a new Bridge session when a resumed conversation continues after restart", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordProviderSnapshot("thread-1", provider());
    await store.recordProviderSnapshot("thread-1", provider({ sessionId: "session-2", requests: 1, inferences: 1, toolCalls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 2, totalTokens: 15, replayBytes: 20, payloadBytes: 100, compactions: 0 }));
    expect(store.find("thread-1")?.insights).toMatchObject({ requests: 3, inferences: 4, toolCalls: 5, inputTokens: 110, outputTokens: 25, cachedTokens: 32, totalTokens: 135, replayBytes: 220, payloadBytes: 2_100 });
  });

  it("deduplicates command and completed-turn activity identifiers", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordCommandActivity("thread-1", "turn-1:command-1", 250);
    await store.recordCommandActivity("thread-1", "turn-1:command-1", 250);
    await store.recordCompletedTurn("thread-1", "turn-1", 2_000, changes());
    await store.recordCompletedTurn("thread-1", "turn-1", 2_000, changes());
    expect(store.find("thread-1")?.insights).toMatchObject({ commandCalls: 1, commandTimeMs: 250, elapsedMs: 2_000, completedTurns: 1 });
    expect(store.find("thread-1")?.changes).toMatchObject({ filesChanged: 1, additions: 4, deletions: 2 });
  });

  it("separates package/test time and counts repeated commands without suppressing them", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordCommandActivity("thread-1", "turn-1:command-1", 100, "npm.cmd install");
    await store.recordCommandActivity("thread-1", "turn-1:command-2", 120, "npm.cmd   install");
    await store.recordCommandActivity("thread-1", "turn-1:command-3", 200, "npm.cmd test");
    expect(store.find("thread-1")?.insights).toMatchObject({
      commandCalls: 3,
      commandTimeMs: 420,
      packageTimeMs: 220,
      testBuildTimeMs: 200,
      repeatedCommandCalls: 1,
    });
  });

  it("persists bounded provider phase, payload component, and inference-reason summaries", async () => {
    const { root, store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordProviderSnapshot("thread-1", provider());
    const reloaded = new DesktopHistoryStore(root);
    await reloaded.load();
    expect(reloaded.find("thread-1")?.insights).toMatchObject({
      peakPayloadBytes: 1_200,
      instructionBytes: 700,
      toolCatalogBytes: 500,
      toolResultBytes: 100,
      providerWaitMs: 900,
      responseParseMs: 10,
      resultProcessingMs: 40,
      requestSerializationMs: 5,
      peakInferenceInputTokens: 75,
      inferenceReasons: { initialTurn: 1, toolResult: 2 },
    });
  });

  it("accumulates multiple turns while keeping byte diagnostics separate from tokens", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordProviderSnapshot("thread-1", provider({ totalTokens: 120, replayBytes: 999_999 }));
    await store.recordCompletedTurn("thread-1", "turn-1", 1_000, changes());
    await store.recordCompletedTurn("thread-1", "turn-2", 2_000, changes(2));
    const record = store.find("thread-1")!;
    expect(record.insights).toMatchObject({ totalTokens: 120, replayBytes: 999_999, elapsedMs: 3_000, completedTurns: 2 });
    expect(record.changes).toMatchObject({ filesChanged: 3, additions: 8, deletions: 4 });
  });

  it("preserves accounting and change summaries across an application restart", async () => {
    const { root, store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    await store.recordProviderSnapshot("thread-1", provider());
    await store.recordCommandActivity("thread-1", "turn-1:command-1", 300);
    await store.recordCompletedTurn("thread-1", "turn-1", 2_500, changes());
    const reloaded = new DesktopHistoryStore(root);
    await reloaded.load();
    expect(reloaded.find("thread-1")?.insights).toMatchObject({ totalTokens: 120, cachedTokens: 30, commandCalls: 1, commandTimeMs: 300, elapsedMs: 2_500 });
    expect(reloaded.find("thread-1")?.changes?.filesChanged).toBe(1);
  });

  it("omits cached tokens when the provider never supplied that field", async () => {
    const { store } = await storeFixture();
    await store.upsertThread(thread("thread-1"), "Project");
    const snapshot = provider();
    delete snapshot.cachedTokens;
    await store.recordProviderSnapshot("thread-1", snapshot);
    expect(store.find("thread-1")?.insights).not.toHaveProperty("cachedTokens");
  });
});
