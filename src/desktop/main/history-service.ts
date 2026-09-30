import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationChangeSummaryDto,
  ConversationInsightsDto,
  InferenceReasonCountsDto,
  ConversationItemDto,
  HistoryRecordDto,
  ThreadSummaryDto,
} from "../shared/contracts.js";

export const HISTORY_SCHEMA_VERSION = 4;
const MAX_RECORDS = 200;
const MAX_CACHED_MESSAGES = 120;
const MAX_PREVIEW = 240;
const MAX_VISIBLE_MESSAGE = 20_000;

interface HistoryIndexFile {
  schemaVersion: 4;
  records: HistoryRecordDto[];
  metrics: Record<string, PersistedThreadMetrics>;
}

interface HistoryThreadFile {
  schemaVersion: 1;
  threadId: string;
  messages: Array<{ kind: "userMessage" | "assistantMessage"; text: string }>;
}

export interface ConversationProviderSnapshot {
  sessionId: string;
  requests: number;
  inferences: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  totalTokens: number;
  activeContextBytes?: number;
  peakContextBytes?: number;
  replayBytes: number;
  payloadBytes: number;
  peakPayloadBytes: number;
  instructionBytes: number;
  toolCatalogBytes: number;
  toolResultBytes: number;
  sessionMetadataBytes: number;
  protocolWrapperBytes: number;
  encodedImageBytes: number;
  sourceImageBytes: number;
  providerWaitMs: number;
  responseParseMs: number;
  resultProcessingMs: number;
  requestSerializationMs: number;
  peakInferenceInputTokens: number;
  inferenceReasons: InferenceReasonCountsDto;
  compactions: number;
  accountingCertain: boolean;
  observedAt: number;
}

interface PersistedProviderSource extends Omit<ConversationProviderSnapshot, "sessionId"> {
  sourceId: string;
}

interface PersistedThreadMetrics {
  sources: PersistedProviderSource[];
  seenActivities: string[];
  seenTurns: string[];
  commandCalls: number;
  commandTimeMs: number;
  packageTimeMs: number;
  testBuildTimeMs: number;
  repeatedCommandCalls: number;
  seenCommandHashes: string[];
  elapsedMs: number;
  completedTurns: number;
  changes: ConversationChangeSummaryDto;
}

export class DesktopHistoryStore {
  private records: HistoryRecordDto[] = [];
  private metrics: Record<string, PersistedThreadMetrics> = {};
  private readonly indexPath: string;
  private readonly threadsDir: string;

  constructor(private readonly rootDir: string) {
    this.indexPath = path.join(rootDir, "index.json");
    this.threadsDir = path.join(rootDir, "threads");
  }

  async load(): Promise<HistoryRecordDto[]> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      const index = parseHistoryIndex(parsed);
      this.records = index.records;
      this.metrics = index.metrics;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") await this.quarantine(this.indexPath);
      this.records = [];
      this.metrics = {};
    }
    return this.snapshot();
  }

  snapshot(): HistoryRecordDto[] {
    return structuredClone(this.records);
  }

  find(threadId: string): HistoryRecordDto | undefined {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    return record ? structuredClone(record) : undefined;
  }

  async upsertThread(thread: ThreadSummaryDto, projectName: string, options: {
    available?: boolean;
    items?: ConversationItemDto[];
  } = {}): Promise<void> {
    const existing = this.records.find((candidate) => candidate.threadId === thread.id);
    const previews = previewsFromItems(options.items ?? []);
    const lastUserPreview = previews.user ?? existing?.lastUserPreview;
    const lastAssistantPreview = previews.assistant ?? existing?.lastAssistantPreview;
    const record: HistoryRecordDto = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      threadId: thread.id,
      projectPath: path.normalize(thread.cwd),
      projectName: safeLabel(projectName, "Project"),
      title: existing?.title ?? safeLabel(thread.name || thread.preview || previews.user || "New chat", "New chat"),
      model: safeLabel(thread.model, "unknown"),
      provider: "evren-desktop",
      createdAt: existing?.createdAt ?? thread.updatedAt,
      updatedAt: existing?.updatedAt ?? thread.updatedAt,
      ...(existing?.lastOpenedAt !== undefined ? { lastOpenedAt: existing.lastOpenedAt } : {}),
      pinned: existing?.pinned ?? false,
      archived: existing?.archived ?? false,
      available: options.available ?? existing?.available ?? true,
      ...(lastUserPreview ? { lastUserPreview } : {}),
      ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
      ...(existing?.insights ? { insights: existing.insights } : {}),
      ...(existing?.changes ? { changes: existing.changes } : {}),
    };
    this.records = [record, ...this.records.filter((candidate) => candidate.threadId !== thread.id)]
      .sort(compareRecords)
      .slice(0, MAX_RECORDS);
    await this.saveIndex();
    if (options.items) await this.saveVisibleMessages(thread.id, options.items);
  }

  async cacheVisibleItems(threadId: string, items: ConversationItemDto[]): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record) return;
    const previews = previewsFromItems(items);
    if (previews.user) record.lastUserPreview = previews.user;
    if (previews.assistant) record.lastAssistantPreview = previews.assistant;
    await Promise.all([this.saveIndex(), this.saveVisibleMessages(threadId, items)]);
  }

  async markOpened(threadId: string, openedAt = Math.floor(Date.now() / 1000)): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record || !validTimestamp(openedAt)) return;
    record.lastOpenedAt = Math.max(record.lastOpenedAt ?? 0, openedAt);
    await this.saveIndex();
  }

  async markMeaningfulActivity(threadId: string, activityAt = Math.floor(Date.now() / 1000)): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record || !validTimestamp(activityAt)) return;
    record.updatedAt = Math.max(record.updatedAt, activityAt);
    this.records.sort(compareRecords);
    await this.saveIndex();
  }

  async loadVisibleItems(threadId: string): Promise<Array<{ kind: "userMessage" | "assistantMessage"; text: string }>> {
    try {
      const filePath = this.threadPath(threadId);
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      return parseThreadCache(parsed, threadId).messages;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") await this.quarantine(this.threadPath(threadId));
      return [];
    }
  }

  async reconcile(projectPath: string, authoritative: ThreadSummaryDto[]): Promise<void> {
    const projectKey = canonicalPath(projectPath);
    const available = new Set(authoritative.map((thread) => thread.id));
    let changed = false;
    for (const record of this.records) {
      if (canonicalPath(record.projectPath) !== projectKey) continue;
      const next = available.has(record.threadId);
      if (record.available !== next) {
        record.available = next;
        changed = true;
      }
    }
    if (changed) await this.saveIndex();
  }

  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    const record = this.requireRecord(threadId);
    record.pinned = pinned;
    this.records.sort(compareRecords);
    await this.saveIndex();
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    const record = this.requireRecord(threadId);
    record.archived = archived;
    await this.saveIndex();
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const record = this.requireRecord(threadId);
    record.title = safeLabel(title, record.title);
    await this.saveIndex();
  }

  async recordProviderSnapshot(threadId: string, snapshot: ConversationProviderSnapshot): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record) return;
    const metrics = this.threadMetrics(threadId);
    const sourceId = hashIdentifier(snapshot.sessionId);
    const { sessionId: _sessionId, ...counters } = snapshot;
    const source: PersistedProviderSource = { ...counters, sourceId };
    const existingIndex = metrics.sources.findIndex((candidate) => candidate.sourceId === sourceId);
    if (existingIndex >= 0) metrics.sources[existingIndex] = mergeProviderSource(metrics.sources[existingIndex]!, source);
    else metrics.sources.push(source);
    if (metrics.sources.length > 32) metrics.sources = metrics.sources.slice(-32);
    this.refreshInsights(record, metrics);
    await this.saveIndex();
  }

  async recordCommandActivity(threadId: string, activityId: string, durationMs?: number, command?: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record) return;
    const metrics = this.threadMetrics(threadId);
    const key = hashIdentifier(activityId);
    if (metrics.seenActivities.includes(key)) return;
    metrics.seenActivities.push(key);
    metrics.seenActivities = metrics.seenActivities.slice(-500);
    metrics.commandCalls += 1;
    if (command) {
      const commandHash = hashIdentifier(normalizeCommand(command));
      if (metrics.seenCommandHashes.includes(commandHash)) metrics.repeatedCommandCalls += 1;
      else {
        metrics.seenCommandHashes.push(commandHash);
        metrics.seenCommandHashes = metrics.seenCommandHashes.slice(-500);
      }
    }
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      metrics.commandTimeMs += durationMs;
      const category = classifyCommand(command);
      if (category === "package") metrics.packageTimeMs += durationMs;
      if (category === "test_build") metrics.testBuildTimeMs += durationMs;
    }
    this.refreshInsights(record, metrics);
    await this.saveIndex();
  }

  async recordCompletedTurn(
    threadId: string,
    turnId: string,
    elapsedMs: number,
    changes: ConversationChangeSummaryDto,
  ): Promise<void> {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record) return;
    const metrics = this.threadMetrics(threadId);
    const key = hashIdentifier(turnId);
    if (metrics.seenTurns.includes(key)) return;
    metrics.seenTurns.push(key);
    metrics.seenTurns = metrics.seenTurns.slice(-500);
    metrics.completedTurns += 1;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) metrics.elapsedMs += elapsedMs;
    metrics.changes = addChangeSummary(metrics.changes, changes);
    record.changes = { ...metrics.changes };
    this.refreshInsights(record, metrics);
    await this.saveIndex();
  }

  private requireRecord(threadId: string): HistoryRecordDto {
    const record = this.records.find((candidate) => candidate.threadId === threadId);
    if (!record) throw Object.assign(new Error("Local history record was not found."), { code: "HISTORY_NOT_FOUND" });
    return record;
  }

  private async saveVisibleMessages(threadId: string, items: ConversationItemDto[]): Promise<void> {
    const messages = items
      .filter((item): item is Extract<ConversationItemDto, { kind: "userMessage" | "assistantMessage" }> =>
        item.kind === "userMessage" || item.kind === "assistantMessage")
      .slice(-MAX_CACHED_MESSAGES)
      .map((item) => ({ kind: item.kind, text: sanitizeVisibleText(item.text, MAX_VISIBLE_MESSAGE) }));
    const file: HistoryThreadFile = { schemaVersion: 1, threadId, messages };
    await atomicJsonWrite(this.threadPath(threadId), file);
  }

  private async saveIndex(): Promise<void> {
    const file: HistoryIndexFile = { schemaVersion: HISTORY_SCHEMA_VERSION, records: this.records, metrics: this.metrics };
    await atomicJsonWrite(this.indexPath, file);
  }

  private threadMetrics(threadId: string): PersistedThreadMetrics {
    const existing = this.metrics[threadId];
    if (existing) return existing;
    const created = emptyThreadMetrics();
    this.metrics[threadId] = created;
    return created;
  }

  private refreshInsights(record: HistoryRecordDto, metrics: PersistedThreadMetrics): void {
    record.insights = insightsFromMetrics(metrics);
    record.changes = { ...metrics.changes };
    record.updatedAt = Math.max(record.updatedAt, Math.floor(Date.now() / 1000));
    this.records.sort(compareRecords);
  }

  private threadPath(threadId: string): string {
    const key = createHash("sha256").update(threadId, "utf8").digest("hex");
    return path.join(this.threadsDir, `${key}.json`);
  }

  private async quarantine(filePath: string): Promise<void> {
    const quarantined = `${filePath}.corrupt-${Date.now()}`;
    await rename(filePath, quarantined).catch(() => undefined);
  }
}

export function parseHistoryIndex(value: unknown): HistoryIndexFile {
  if (!isRecord(value) || ![1, 2, 3, HISTORY_SCHEMA_VERSION].includes(Number(value.schemaVersion)) || !Array.isArray(value.records)) {
    throw new Error("invalid_history_index");
  }
  const records = value.records.map(parseHistoryRecord).filter((record): record is HistoryRecordDto => record !== undefined);
  const metrics = [2, 3, HISTORY_SCHEMA_VERSION].includes(Number(value.schemaVersion)) ? parseMetrics(value.metrics) : {};
  for (const record of records) {
    const threadMetrics = metrics[record.threadId];
    if (threadMetrics) {
      record.insights = insightsFromMetrics(threadMetrics);
      record.changes = { ...threadMetrics.changes };
    }
  }
  return { schemaVersion: HISTORY_SCHEMA_VERSION, records: records.sort(compareRecords).slice(0, MAX_RECORDS), metrics };
}

export function sanitizeVisibleText(value: string, maximum = MAX_PREVIEW): string {
  const bounded = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maximum);
  return bounded
    .replace(/\b(?:bearer\s+)?[a-z0-9_-]{32,}\b/gi, "[REDACTED]")
    .replace(/\b(?:api[_ -]?key|authorization|bridge[_ -]?token)\s*[:=]\s*\S+/gi, "$1: [REDACTED]")
    .trim();
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseHistoryRecord(value: unknown): HistoryRecordDto | undefined {
  if (!isRecord(value) || ![1, 2, 3, HISTORY_SCHEMA_VERSION].includes(Number(value.schemaVersion))) return undefined;
  const threadId = safeText(value.threadId, 300);
  const projectPath = safeText(value.projectPath, 32_000);
  const projectName = safeText(value.projectName, 200);
  const title = safeText(value.title, 300);
  const model = safeText(value.model, 200);
  if (!threadId || !projectPath || !path.isAbsolute(projectPath) || !projectName || !title || !model) return undefined;
  if (value.provider !== "evren-desktop" || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) return undefined;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    threadId,
    projectPath: path.normalize(projectPath),
    projectName,
    title,
    model,
    provider: "evren-desktop",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(validTimestamp(value.lastOpenedAt) ? { lastOpenedAt: value.lastOpenedAt } : {}),
    pinned: value.pinned === true,
    archived: value.archived === true,
    available: value.available !== false,
    ...(safeText(value.lastUserPreview, MAX_PREVIEW) ? { lastUserPreview: sanitizeVisibleText(String(value.lastUserPreview)) } : {}),
    ...(safeText(value.lastAssistantPreview, MAX_PREVIEW) ? { lastAssistantPreview: sanitizeVisibleText(String(value.lastAssistantPreview)) } : {}),
    ...(parseInsights(value.insights) ? { insights: parseInsights(value.insights)! } : {}),
    ...(parseChangeSummary(value.changes) ? { changes: parseChangeSummary(value.changes)! } : {}),
  };
}

function parseThreadCache(value: unknown, threadId: string): HistoryThreadFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.threadId !== threadId || !Array.isArray(value.messages)) {
    throw new Error("invalid_history_thread_cache");
  }
  const messages = value.messages.slice(-MAX_CACHED_MESSAGES).flatMap((message) => {
    if (!isRecord(message) || (message.kind !== "userMessage" && message.kind !== "assistantMessage")) return [];
    const text = safeText(message.text, MAX_VISIBLE_MESSAGE);
    return text ? [{ kind: message.kind as "userMessage" | "assistantMessage", text: sanitizeVisibleText(text, MAX_VISIBLE_MESSAGE) }] : [];
  });
  return { schemaVersion: 1, threadId, messages };
}

function previewsFromItems(items: ConversationItemDto[]): { user?: string; assistant?: string } {
  const result: { user?: string; assistant?: string } = {};
  for (const item of items) {
    if (item.kind === "userMessage") result.user = sanitizeVisibleText(item.text);
    if (item.kind === "assistantMessage") result.assistant = sanitizeVisibleText(item.text);
  }
  return result;
}

function emptyChangeSummary(): ConversationChangeSummaryDto {
  return { filesChanged: 0, additions: 0, deletions: 0, created: 0, modified: 0, deleted: 0, renamed: 0 };
}

function emptyThreadMetrics(): PersistedThreadMetrics {
  return {
    sources: [], seenActivities: [], seenTurns: [], commandCalls: 0, commandTimeMs: 0,
    packageTimeMs: 0, testBuildTimeMs: 0, repeatedCommandCalls: 0, seenCommandHashes: [],
    elapsedMs: 0, completedTurns: 0, changes: emptyChangeSummary(),
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US").slice(0, 20_000);
}

function classifyCommand(command: string | undefined): "package" | "test_build" | "other" {
  if (!command) return "other";
  const normalized = normalizeCommand(command);
  if (/\b(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn|bun)\s+(?:run\s+)?(?:test|build|typecheck|lint)\b/.test(normalized)
    || /\b(?:vitest|jest|tsc|eslint|cargo\s+test|dotnet\s+(?:test|build))\b/.test(normalized)) return "test_build";
  if (/\b(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn|bun|npx(?:\.cmd)?)\b/.test(normalized)) return "package";
  return "other";
}

function addChangeSummary(
  left: ConversationChangeSummaryDto,
  right: ConversationChangeSummaryDto,
): ConversationChangeSummaryDto {
  return {
    filesChanged: left.filesChanged + right.filesChanged,
    additions: left.additions + right.additions,
    deletions: left.deletions + right.deletions,
    created: left.created + right.created,
    modified: left.modified + right.modified,
    deleted: left.deleted + right.deleted,
    renamed: left.renamed + right.renamed,
    ...((left.coverage === "observed" || right.coverage === "observed") ? { coverage: "observed" as const } : { coverage: "complete" as const }),
  };
}

function mergeProviderSource(previous: PersistedProviderSource, next: PersistedProviderSource): PersistedProviderSource {
  return {
    ...next,
    requests: Math.max(previous.requests, next.requests),
    inferences: Math.max(previous.inferences, next.inferences),
    toolCalls: Math.max(previous.toolCalls, next.toolCalls),
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
    totalTokens: Math.max(previous.totalTokens, next.totalTokens),
    replayBytes: Math.max(previous.replayBytes, next.replayBytes),
    payloadBytes: Math.max(previous.payloadBytes, next.payloadBytes),
    peakPayloadBytes: Math.max(previous.peakPayloadBytes, next.peakPayloadBytes),
    instructionBytes: Math.max(previous.instructionBytes, next.instructionBytes),
    toolCatalogBytes: Math.max(previous.toolCatalogBytes, next.toolCatalogBytes),
    toolResultBytes: Math.max(previous.toolResultBytes, next.toolResultBytes),
    sessionMetadataBytes: Math.max(previous.sessionMetadataBytes, next.sessionMetadataBytes),
    protocolWrapperBytes: Math.max(previous.protocolWrapperBytes, next.protocolWrapperBytes),
    encodedImageBytes: Math.max(previous.encodedImageBytes, next.encodedImageBytes),
    sourceImageBytes: Math.max(previous.sourceImageBytes, next.sourceImageBytes),
    providerWaitMs: Math.max(previous.providerWaitMs, next.providerWaitMs),
    responseParseMs: Math.max(previous.responseParseMs, next.responseParseMs),
    resultProcessingMs: Math.max(previous.resultProcessingMs, next.resultProcessingMs),
    requestSerializationMs: Math.max(previous.requestSerializationMs, next.requestSerializationMs),
    peakInferenceInputTokens: Math.max(previous.peakInferenceInputTokens, next.peakInferenceInputTokens),
    inferenceReasons: maxInferenceReasonCounts(previous.inferenceReasons, next.inferenceReasons),
    compactions: Math.max(previous.compactions, next.compactions),
    accountingCertain: previous.accountingCertain && next.accountingCertain,
    observedAt: Math.max(previous.observedAt, next.observedAt),
    ...(previous.cachedTokens === undefined && next.cachedTokens === undefined
      ? {} : { cachedTokens: Math.max(previous.cachedTokens ?? 0, next.cachedTokens ?? 0) }),
    ...(previous.peakContextBytes === undefined && next.peakContextBytes === undefined
      ? {} : { peakContextBytes: Math.max(previous.peakContextBytes ?? 0, next.peakContextBytes ?? 0) }),
  };
}

function insightsFromMetrics(metrics: PersistedThreadMetrics): ConversationInsightsDto {
  const latest = [...metrics.sources].sort((left, right) => right.observedAt - left.observedAt)[0];
  const cachedObserved = metrics.sources.some((source) => source.cachedTokens !== undefined);
  return {
    requests: sum(metrics.sources, "requests"),
    inferences: sum(metrics.sources, "inferences"),
    toolCalls: sum(metrics.sources, "toolCalls"),
    commandCalls: metrics.commandCalls,
    inputTokens: sum(metrics.sources, "inputTokens"),
    outputTokens: sum(metrics.sources, "outputTokens"),
    ...(cachedObserved ? { cachedTokens: metrics.sources.reduce((total, source) => total + (source.cachedTokens ?? 0), 0) } : {}),
    totalTokens: sum(metrics.sources, "totalTokens"),
    elapsedMs: metrics.elapsedMs,
    commandTimeMs: metrics.commandTimeMs,
    packageTimeMs: metrics.packageTimeMs,
    testBuildTimeMs: metrics.testBuildTimeMs,
    providerWaitMs: sum(metrics.sources, "providerWaitMs"),
    responseParseMs: sum(metrics.sources, "responseParseMs"),
    resultProcessingMs: sum(metrics.sources, "resultProcessingMs"),
    requestSerializationMs: sum(metrics.sources, "requestSerializationMs"),
    repeatedCommandCalls: metrics.repeatedCommandCalls,
    ...(latest?.activeContextBytes === undefined ? {} : { activeContextBytes: latest.activeContextBytes }),
    ...(metrics.sources.some((source) => source.peakContextBytes !== undefined)
      ? { peakContextBytes: Math.max(...metrics.sources.map((source) => source.peakContextBytes ?? 0)) } : {}),
    replayBytes: sum(metrics.sources, "replayBytes"),
    payloadBytes: sum(metrics.sources, "payloadBytes"),
    peakPayloadBytes: maximum(metrics.sources, "peakPayloadBytes"),
    instructionBytes: sum(metrics.sources, "instructionBytes"),
    toolCatalogBytes: sum(metrics.sources, "toolCatalogBytes"),
    toolResultBytes: sum(metrics.sources, "toolResultBytes"),
    sessionMetadataBytes: sum(metrics.sources, "sessionMetadataBytes"),
    protocolWrapperBytes: sum(metrics.sources, "protocolWrapperBytes"),
    encodedImageBytes: sum(metrics.sources, "encodedImageBytes"),
    sourceImageBytes: sum(metrics.sources, "sourceImageBytes"),
    peakInferenceInputTokens: maximum(metrics.sources, "peakInferenceInputTokens"),
    inferenceReasons: sumInferenceReasonCounts(metrics.sources.map((source) => source.inferenceReasons)),
    compactions: sum(metrics.sources, "compactions"),
    completedTurns: metrics.completedTurns,
    accountingCertain: metrics.sources.every((source) => source.accountingCertain),
    updatedAt: Math.max(Date.now(), ...metrics.sources.map((source) => source.observedAt)),
  };
}

function sum<K extends "requests" | "inferences" | "toolCalls" | "inputTokens" | "outputTokens" | "totalTokens"
  | "replayBytes" | "payloadBytes" | "instructionBytes" | "toolCatalogBytes" | "toolResultBytes"
  | "sessionMetadataBytes" | "protocolWrapperBytes" | "encodedImageBytes" | "sourceImageBytes"
  | "providerWaitMs" | "responseParseMs" | "resultProcessingMs" | "requestSerializationMs" | "compactions">(
  sources: PersistedProviderSource[],
  key: K,
): number {
  return sources.reduce((total, source) => total + source[key], 0);
}

function maximum<K extends "peakPayloadBytes" | "peakInferenceInputTokens">(
  sources: PersistedProviderSource[],
  key: K,
): number {
  return sources.reduce((largest, source) => Math.max(largest, source[key]), 0);
}

function emptyInferenceReasonCounts(): InferenceReasonCountsDto {
  return {
    initialTurn: 0,
    conversationContinuation: 0,
    toolResult: 0,
    compaction: 0,
    compactionContinuation: 0,
    prewarm: 0,
    memory: 0,
    protocolRepair: 0,
    other: 0,
  };
}

function maxInferenceReasonCounts(
  previous: InferenceReasonCountsDto,
  next: InferenceReasonCountsDto,
): InferenceReasonCountsDto {
  return mapInferenceReasonCounts((key) => Math.max(previous[key], next[key]));
}

function sumInferenceReasonCounts(values: InferenceReasonCountsDto[]): InferenceReasonCountsDto {
  return mapInferenceReasonCounts((key) => values.reduce((total, value) => total + value[key], 0));
}

function mapInferenceReasonCounts(
  select: (key: keyof InferenceReasonCountsDto) => number,
): InferenceReasonCountsDto {
  const keys: Array<keyof InferenceReasonCountsDto> = [
    "initialTurn", "conversationContinuation", "toolResult", "compaction", "compactionContinuation",
    "prewarm", "memory", "protocolRepair", "other",
  ];
  return Object.fromEntries(keys.map((key) => [key, select(key)])) as unknown as InferenceReasonCountsDto;
}

function parseMetrics(value: unknown): Record<string, PersistedThreadMetrics> {
  if (!isRecord(value)) return {};
  const result: Record<string, PersistedThreadMetrics> = {};
  for (const [threadId, raw] of Object.entries(value).slice(0, MAX_RECORDS)) {
    if (!safeText(threadId, 300) || !isRecord(raw)) continue;
    const sources = Array.isArray(raw.sources)
      ? raw.sources.slice(-32).flatMap((source) => parseProviderSource(source) ? [parseProviderSource(source)!] : [])
      : [];
    result[threadId] = {
      sources,
      seenActivities: parseIdentifierList(raw.seenActivities, 500),
      seenTurns: parseIdentifierList(raw.seenTurns, 500),
      commandCalls: safeCount(raw.commandCalls),
      commandTimeMs: safeCount(raw.commandTimeMs),
      packageTimeMs: safeCount(raw.packageTimeMs),
      testBuildTimeMs: safeCount(raw.testBuildTimeMs),
      repeatedCommandCalls: safeCount(raw.repeatedCommandCalls),
      seenCommandHashes: parseIdentifierList(raw.seenCommandHashes, 500),
      elapsedMs: safeCount(raw.elapsedMs),
      completedTurns: safeCount(raw.completedTurns),
      changes: parseChangeSummary(raw.changes) ?? emptyChangeSummary(),
    };
  }
  return result;
}

function parseProviderSource(value: unknown): PersistedProviderSource | undefined {
  if (!isRecord(value) || typeof value.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceId)) return undefined;
  const required = ["requests", "inferences", "toolCalls", "inputTokens", "outputTokens", "totalTokens", "replayBytes", "payloadBytes", "compactions", "observedAt"] as const;
  if (required.some((key) => !validCount(value[key]))) return undefined;
  return {
    sourceId: value.sourceId,
    requests: value.requests as number,
    inferences: value.inferences as number,
    toolCalls: value.toolCalls as number,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    totalTokens: value.totalTokens as number,
    replayBytes: value.replayBytes as number,
    payloadBytes: value.payloadBytes as number,
    peakPayloadBytes: safeCount(value.peakPayloadBytes),
    instructionBytes: safeCount(value.instructionBytes),
    toolCatalogBytes: safeCount(value.toolCatalogBytes),
    toolResultBytes: safeCount(value.toolResultBytes),
    sessionMetadataBytes: safeCount(value.sessionMetadataBytes),
    protocolWrapperBytes: safeCount(value.protocolWrapperBytes),
    encodedImageBytes: safeCount(value.encodedImageBytes),
    sourceImageBytes: safeCount(value.sourceImageBytes),
    providerWaitMs: safeCount(value.providerWaitMs),
    responseParseMs: safeCount(value.responseParseMs),
    resultProcessingMs: safeCount(value.resultProcessingMs),
    requestSerializationMs: safeCount(value.requestSerializationMs),
    peakInferenceInputTokens: safeCount(value.peakInferenceInputTokens),
    inferenceReasons: parseInferenceReasonCounts(value.inferenceReasons),
    compactions: value.compactions as number,
    accountingCertain: value.accountingCertain !== false,
    observedAt: value.observedAt as number,
    ...(validCount(value.cachedTokens) ? { cachedTokens: value.cachedTokens as number } : {}),
    ...(validCount(value.activeContextBytes) ? { activeContextBytes: value.activeContextBytes as number } : {}),
    ...(validCount(value.peakContextBytes) ? { peakContextBytes: value.peakContextBytes as number } : {}),
  };
}

function parseInsights(value: unknown): ConversationInsightsDto | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["requests", "inferences", "toolCalls", "commandCalls", "inputTokens", "outputTokens", "totalTokens", "elapsedMs", "commandTimeMs", "replayBytes", "payloadBytes", "compactions", "completedTurns", "updatedAt"] as const;
  if (required.some((key) => !validCount(value[key]))) return undefined;
  return {
    requests: value.requests as number,
    inferences: value.inferences as number,
    toolCalls: value.toolCalls as number,
    commandCalls: value.commandCalls as number,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    totalTokens: value.totalTokens as number,
    elapsedMs: value.elapsedMs as number,
    commandTimeMs: value.commandTimeMs as number,
    packageTimeMs: safeCount(value.packageTimeMs),
    testBuildTimeMs: safeCount(value.testBuildTimeMs),
    providerWaitMs: safeCount(value.providerWaitMs),
    responseParseMs: safeCount(value.responseParseMs),
    resultProcessingMs: safeCount(value.resultProcessingMs),
    requestSerializationMs: safeCount(value.requestSerializationMs),
    repeatedCommandCalls: safeCount(value.repeatedCommandCalls),
    replayBytes: value.replayBytes as number,
    payloadBytes: value.payloadBytes as number,
    peakPayloadBytes: safeCount(value.peakPayloadBytes),
    instructionBytes: safeCount(value.instructionBytes),
    toolCatalogBytes: safeCount(value.toolCatalogBytes),
    toolResultBytes: safeCount(value.toolResultBytes),
    sessionMetadataBytes: safeCount(value.sessionMetadataBytes),
    protocolWrapperBytes: safeCount(value.protocolWrapperBytes),
    encodedImageBytes: safeCount(value.encodedImageBytes),
    sourceImageBytes: safeCount(value.sourceImageBytes),
    peakInferenceInputTokens: safeCount(value.peakInferenceInputTokens),
    inferenceReasons: parseInferenceReasonCounts(value.inferenceReasons),
    compactions: value.compactions as number,
    completedTurns: value.completedTurns as number,
    accountingCertain: value.accountingCertain !== false,
    updatedAt: value.updatedAt as number,
    ...(validCount(value.cachedTokens) ? { cachedTokens: value.cachedTokens as number } : {}),
    ...(validCount(value.activeContextBytes) ? { activeContextBytes: value.activeContextBytes as number } : {}),
    ...(validCount(value.peakContextBytes) ? { peakContextBytes: value.peakContextBytes as number } : {}),
  };
}

function parseChangeSummary(value: unknown): ConversationChangeSummaryDto | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["filesChanged", "additions", "deletions", "created", "modified", "deleted", "renamed"] as const;
  if (keys.some((key) => !validCount(value[key]))) return undefined;
  return {
    ...Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as ConversationChangeSummaryDto,
    ...(value.coverage === "observed" ? { coverage: "observed" as const } : { coverage: "complete" as const }),
  };
}

function parseInferenceReasonCounts(value: unknown): InferenceReasonCountsDto {
  if (!isRecord(value)) return emptyInferenceReasonCounts();
  return mapInferenceReasonCounts((key) => safeCount(value[key]));
}

function parseIdentifierList(value: unknown, maximum: number): string[] {
  return Array.isArray(value)
    ? value.slice(-maximum).filter((entry): entry is string => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry))
    : [];
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeCount(value: unknown): number {
  return validCount(value) ? value as number : 0;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareRecords(left: HistoryRecordDto, right: HistoryRecordDto): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return right.updatedAt - left.updatedAt;
}

function canonicalPath(value: string): string {
  return path.normalize(value).toLocaleLowerCase("en-US");
}

function safeLabel(value: string, fallback: string): string {
  return sanitizeVisibleText(value, 300) || fallback;
}

function safeText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function validTimestamp(value: unknown): value is number {
  return Number.isFinite(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
