import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, UnknownPreviousResponseError } from "../src/sessions/store.js";
import { UsagePersistence } from "../src/usage/persistence.js";
import { UsageTracker } from "../src/usage/tracker.js";

describe("sessions and usage", () => {
  it("maps previous_response_id to the same session", () => {
    const store = new SessionStore(60_000);
    const session = store.resolve();
    store.recordResponse(session, "resp_1");
    expect(store.resolve("resp_1")).toBe(session);
    expect(() => store.resolve("resp_missing")).toThrowError(UnknownPreviousResponseError);
  });

  it("applies a reconfigured session TTL to existing sessions", () => {
    let now = new Date("2026-09-21T12:00:00.000Z");
    const store = new SessionStore(60_000, () => now);
    const session = store.resolve();
    store.recordResponse(session, "resp_reconfigured_ttl");
    now = new Date("2026-09-21T12:00:02.000Z");

    store.setTtlMs(1_000);

    expect(() => store.resolve("resp_reconfigured_ttl")).toThrowError(UnknownPreviousResponseError);
  });

  it("removes pending call_id mappings when an expired session is pruned", () => {
    let now = new Date("2026-09-21T12:00:00.000Z");
    const store = new SessionStore(1_000, () => now);
    const session = store.resolve();
    store.recordPendingToolCall(session, {
      callId: "call_expired",
      tool: { name: "shell", kind: "function", description: "Run a command", inputSchema: {} },
    });

    now = new Date("2026-09-21T12:00:01.001Z");
    expect(store.prune()).toBe(1);
    expect(() => store.resolveByToolCallIds(["call_expired"]))
      .toThrow("Tool output references unknown call_id: call_expired");
  });

  it("removes completed call_id mappings and ledgers when an expired session is pruned", () => {
    let now = new Date("2026-09-21T12:00:00.000Z");
    const store = new SessionStore(1_000, () => now);
    const session = store.resolve();
    store.recordPendingToolCall(session, {
      callId: "call_completed_expired",
      tool: { name: "shell", kind: "function", description: "Run a command", inputSchema: {} },
    });
    store.prepareIncomingToolOutputs(session, [{ callId: "call_completed_expired", output: "result" }]);
    store.completePendingToolCall(session, "call_completed_expired");
    expect(session.completedToolCalls.has("call_completed_expired")).toBe(true);

    now = new Date("2026-09-21T12:00:01.001Z");
    expect(store.prune()).toBe(1);
    expect(() => store.resolveByToolCallIds(["call_completed_expired"]))
      .toThrow("Tool output references unknown call_id: call_completed_expired");
  });

  it("selects the most recently started foreground session instead of the latest background activity", () => {
    let now = new Date("2026-09-23T12:00:00.000Z");
    const store = new SessionStore(60_000, () => now);
    const main = store.resolve();
    store.markForeground(main);
    now = new Date("2026-09-23T12:00:01.000Z");
    const helper = store.resolve();

    expect(store.getLatest()).toBe(helper);
    expect(store.getCurrent()).toBe(main);

    now = new Date("2026-09-23T12:00:02.000Z");
    const realToollessForeground = store.resolve();
    store.markForeground(realToollessForeground);
    expect(store.getCurrent()).toBe(realToollessForeground);
  });

  it("persists authoritative EVREN usage atomically and deduplicates response ids", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "evren-usage-"));
    const tracker = new UsageTracker(new UsagePersistence(temp), () => new Date("2026-09-21T12:00:00+03:00"));
    await tracker.initialize();
    expect(await tracker.record("evren_1", { inputTokens: 7, outputTokens: 3, totalTokens: 10 })).toBe(true);
    expect(await tracker.record("evren_1", { inputTokens: 7, outputTokens: 3, totalTokens: 10 })).toBe(false);
    expect(tracker.snapshot()).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    const file = path.join(temp, `usage-${tracker.snapshot().date}.json`);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { responseIds: string[]; totalTokens: number };
    expect(persisted).toMatchObject({ responseIds: ["evren_1"], totalTokens: 10 });
  });

  it("preserves legacy daily totals as unclassified and never double-counts classified usage", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "evren-usage-legacy-"));
    const tracker = new UsageTracker(new UsagePersistence(temp), () => new Date("2026-09-21T12:00:00+03:00"));
    const file = path.join(temp, "usage-2026-09-21.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({
      date: "2026-09-21",
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      responseIds: ["legacy"],
      updatedAt: "2026-09-21T00:00:00.000Z",
    }), "utf8");
    await tracker.initialize();
    expect(tracker.snapshot().classified?.unclassified.totalTokens).toBe(10);
    expect(await tracker.record("evren_internal", { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, "internal"))
      .toBe(true);
    expect(await tracker.record("evren_internal", { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, "internal"))
      .toBe(false);
    expect(tracker.snapshot()).toMatchObject({
      totalTokens: 15,
      classified: {
        internal: { totalTokens: 5 },
        unclassified: { totalTokens: 10 },
      },
    });
  });
});
