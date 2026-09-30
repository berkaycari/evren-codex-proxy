import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHistoryStore, HISTORY_SCHEMA_VERSION, parseHistoryIndex, sanitizeVisibleText } from "../src/desktop/main/history-service.js";
import type { ConversationItemDto, ThreadSummaryDto } from "../src/desktop/shared/contracts.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evren-history-"));
  directories.push(directory);
  const store = new DesktopHistoryStore(directory);
  await store.load();
  return { directory, store };
}

const thread: ThreadSummaryDto = { id: "thread-1", cwd: "C:\\work\\project", model: "deepseek-v4.1-flash", modelProvider: "evren-desktop", preview: "Phase 3", updatedAt: 1_700_000_000, state: "idle" };
const items: ConversationItemDto[] = [
  { id: "u1", turnId: "t1", kind: "userMessage", status: "completed", text: "Implement settings", attachments: [] },
  { id: "c1", turnId: "t1", kind: "command", status: "completed", command: "secret command", cwd: thread.cwd, output: "huge secret output" },
  { id: "a1", turnId: "t1", kind: "assistantMessage", status: "completed", text: "Settings are ready" },
];

describe("Phase 3 local history", () => {
  it("requires the versioned history schema", () => {
    expect(HISTORY_SCHEMA_VERSION).toBe(4);
    expect(parseHistoryIndex({ schemaVersion: 1, records: [] })).toMatchObject({ schemaVersion: 4, records: [], metrics: {} });
    expect(parseHistoryIndex({ schemaVersion: 2, records: [], metrics: {} })).toMatchObject({ schemaVersion: 4, records: [], metrics: {} });
    expect(parseHistoryIndex({ schemaVersion: 3, records: [], metrics: {} })).toMatchObject({ schemaVersion: 4, records: [], metrics: {} });
    expect(() => parseHistoryIndex({ schemaVersion: 5, records: [] })).toThrow("invalid_history_index");
  });

  it("persists thread and project metadata atomically", async () => {
    const { directory, store } = await fixture();
    await store.upsertThread(thread, "project", { items });
    const index = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
    expect(index.records[0]).toMatchObject({ threadId: "thread-1", projectName: "project", model: thread.model, provider: "evren-desktop" });
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("recovers a corrupted index without fabricating history", async () => {
    const { directory } = await fixture();
    await writeFile(path.join(directory, "index.json"), "{broken", "utf8");
    const recovered = new DesktopHistoryStore(directory);
    await expect(recovered.load()).resolves.toEqual([]);
    expect((await readdir(directory)).some((name) => name.startsWith("index.json.corrupt-"))).toBe(true);
  });

  it("caches only bounded user-visible messages and never command output", async () => {
    const { directory, store } = await fixture();
    await store.upsertThread(thread, "project", { items });
    const files = await readdir(path.join(directory, "threads"));
    const raw = await readFile(path.join(directory, "threads", files[0]!), "utf8");
    expect(raw).toContain("Implement settings");
    expect(raw).toContain("Settings are ready");
    expect(raw).not.toContain("secret command");
    expect(raw).not.toContain("huge secret output");
    await expect(store.loadVisibleItems(thread.id)).resolves.toEqual([
      { kind: "userMessage", text: "Implement settings" },
      { kind: "assistantMessage", text: "Settings are ready" },
    ]);
  });

  it("redacts API keys, Bridge tokens and bearer credentials from previews", () => {
    const text = sanitizeVisibleText("api_key=abcdefghijklmnopqrstuvwxyz1234567890 authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("[REDACTED]");
  });

  it("never introduces system or developer instruction fields", async () => {
    const { directory, store } = await fixture();
    await store.upsertThread(thread, "project", { items });
    const raw = await readFile(path.join(directory, "index.json"), "utf8");
    expect(raw).not.toMatch(/systemInstruction|developerInstruction|reasoning/i);
  });

  it("supports local pin, rename and archive presentation metadata", async () => {
    const { store } = await fixture();
    await store.upsertThread(thread, "project");
    await store.setPinned(thread.id, true);
    await store.renameThread(thread.id, "Release candidate");
    await store.setArchived(thread.id, true);
    expect(store.find(thread.id)).toMatchObject({ pinned: true, title: "Release candidate", archived: true });
  });

  it("keeps meaningful activity stable across discovery, read-only open and cache refresh", async () => {
    const { directory, store } = await fixture();
    const older = { ...thread, id: "older", updatedAt: 1_700_000_000 };
    const newer = { ...thread, id: "newer", updatedAt: 1_700_000_100 };
    await store.upsertThread(older, "project");
    await store.upsertThread(newer, "project");
    await store.upsertThread({ ...older, updatedAt: 1_800_000_000 }, "project", { items });
    await store.markOpened(older.id, 1_900_000_000);
    await store.cacheVisibleItems(older.id, items);
    expect(store.snapshot().map((record) => record.threadId)).toEqual(["newer", "older"]);
    expect(store.find(older.id)).toMatchObject({ updatedAt: 1_700_000_000, lastOpenedAt: 1_900_000_000 });

    const restarted = new DesktopHistoryStore(directory);
    await restarted.load();
    expect(restarted.snapshot().map((record) => record.threadId)).toEqual(["newer", "older"]);
    expect(restarted.find(older.id)?.lastOpenedAt).toBe(1_900_000_000);
  });

  it("reorders only after explicit meaningful activity and preserves pin grouping", async () => {
    const { store } = await fixture();
    const older = { ...thread, id: "older", updatedAt: 1_700_000_000 };
    const newer = { ...thread, id: "newer", updatedAt: 1_700_000_100 };
    await store.upsertThread(older, "project");
    await store.upsertThread(newer, "project");
    await store.markMeaningfulActivity(older.id, 1_700_000_200);
    expect(store.snapshot().map((record) => record.threadId)).toEqual(["older", "newer"]);
    await store.setPinned(newer.id, true);
    await store.markMeaningfulActivity(older.id, 1_700_000_300);
    expect(store.snapshot().map((record) => record.threadId)).toEqual(["newer", "older"]);
  });

  it("marks stale local records unavailable during authoritative reconciliation", async () => {
    const { store } = await fixture();
    await store.upsertThread(thread, "project");
    await store.reconcile(thread.cwd, []);
    expect(store.find(thread.id)?.available).toBe(false);
  });

  it("restores availability when Codex lists the real thread again", async () => {
    const { store } = await fixture();
    await store.upsertThread(thread, "project");
    await store.reconcile(thread.cwd, []);
    await store.reconcile(thread.cwd, [thread]);
    expect(store.find(thread.id)?.available).toBe(true);
  });

  it("retains history independently from credentials", async () => {
    const { directory, store } = await fixture();
    await store.upsertThread(thread, "project");
    const restarted = new DesktopHistoryStore(directory);
    await restarted.load();
    expect(restarted.find(thread.id)?.threadId).toBe(thread.id);
  });

  it("uses a safe hashed cache filename instead of the opaque thread id", async () => {
    const { directory, store } = await fixture();
    const unsafe = { ...thread, id: "../thread:unsafe" };
    await store.upsertThread(unsafe, "project", { items });
    const files = await readdir(path.join(directory, "threads"));
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });
});
