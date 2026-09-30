import path from "node:path";
import type { ConversationItemDto, ThreadSummaryDto } from "../shared/contracts.js";
import { DESKTOP_PROVIDER_ID } from "./codex-launch.js";
import { projectThreadItem } from "./codex-event-projector.js";

export interface CodexRpcClient {
  request(method: string, params: unknown): Promise<unknown>;
}

export interface ThreadHistoryPage {
  items: ConversationItemDto[];
  nextCursor?: string;
}

export interface ResumedThread {
  thread: ThreadSummaryDto;
  history: ThreadHistoryPage;
}

export interface ThreadConsistencyDiagnostic {
  transition: "thread_start_response" | "thread_resume_response";
  selectedModelId: string;
  bridgeModelId: string;
  requestedModelId: string;
  responseModelId?: string;
  threadModelId?: string;
  expectedProviderId: typeof DESKTOP_PROVIDER_ID;
  responseProviderId?: string;
  threadProviderId?: string;
  accepted: boolean;
}

export class CodexThreadService {
  constructor(private readonly rpc: CodexRpcClient, private readonly options: {
    onConsistencyDiagnostic?: (diagnostic: ThreadConsistencyDiagnostic) => void;
  } = {}) {}

  async list(cwd?: string): Promise<ThreadSummaryDto[]> {
    const response = asRecord(await this.rpc.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: [DESKTOP_PROVIDER_ID],
    }));
    if (!response || !Array.isArray(response.data)) throw protocolError("THREAD_LIST_INVALID", "Codex sohbet listesi okunamadı.");
    return response.data.flatMap((value) => {
      const thread = parseThread(value);
      return thread
        && thread.modelProvider === DESKTOP_PROVIDER_ID
        && (!cwd || samePath(thread.cwd, cwd))
        ? [thread]
        : [];
    });
  }

  async start(projectPath: string, model: string, bridgeModel = model): Promise<ThreadSummaryDto> {
    const response = asRecord(await this.rpc.request("thread/start", {
      model,
      modelProvider: DESKTOP_PROVIDER_ID,
      cwd: projectPath,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: false,
      threadSource: "evren-codex-desktop",
    }));
    const responseModel = safeString(response?.model);
    const responseProvider = safeString(response?.modelProvider);
    const responseCwd = safeString(response?.cwd, 32_000);
    const rawThread = asRecord(response?.thread);
    const thread = responseModel && responseProvider && responseCwd
      ? parseThread(response?.thread, { model: responseModel, modelProvider: responseProvider, cwd: responseCwd })
      : undefined;
    const accepted = Boolean(
      thread
      && model === bridgeModel
      && responseModel === model
      && responseProvider === DESKTOP_PROVIDER_ID
      && samePath(responseCwd, projectPath),
    );
    this.options.onConsistencyDiagnostic?.({
      transition: "thread_start_response",
      selectedModelId: model,
      bridgeModelId: bridgeModel,
      requestedModelId: model,
      ...(responseModel ? { responseModelId: responseModel } : {}),
      ...(safeString(rawThread?.model) ? { threadModelId: safeString(rawThread?.model)! } : {}),
      expectedProviderId: DESKTOP_PROVIDER_ID,
      ...(responseProvider ? { responseProviderId: responseProvider } : {}),
      ...(safeString(rawThread?.modelProvider) ? { threadProviderId: safeString(rawThread?.modelProvider)! } : {}),
      accepted,
    });
    if (!accepted || !thread) {
      throw protocolError("THREAD_MODEL_MISMATCH", "Codex sohbet modeli, sağlayıcısı veya proje yolu Desktop seçimiyle eşleşmedi.");
    }
    return thread;
  }

  async resume(threadId: string, expected: ThreadSummaryDto, projectRoot: string, bridgeModel = expected.model): Promise<ResumedThread> {
    const response = asRecord(await this.rpc.request("thread/resume", { threadId, excludeTurns: true }));
    const responseModel = safeString(response?.model);
    const responseProvider = safeString(response?.modelProvider);
    const responseCwd = safeString(response?.cwd, 32_000);
    const rawThread = asRecord(response?.thread);
    const thread = responseModel && responseProvider && responseCwd
      ? parseThread(response?.thread, { model: responseModel, modelProvider: responseProvider, cwd: responseCwd })
      : undefined;
    const accepted = Boolean(
      thread
      && thread.id === threadId
      && bridgeModel === expected.model
      && responseModel === expected.model
      && responseProvider === DESKTOP_PROVIDER_ID
      && samePath(responseCwd, expected.cwd),
    );
    this.options.onConsistencyDiagnostic?.({
      transition: "thread_resume_response",
      selectedModelId: expected.model,
      bridgeModelId: bridgeModel,
      requestedModelId: expected.model,
      ...(responseModel ? { responseModelId: responseModel } : {}),
      ...(safeString(rawThread?.model) ? { threadModelId: safeString(rawThread?.model)! } : {}),
      expectedProviderId: DESKTOP_PROVIDER_ID,
      ...(responseProvider ? { responseProviderId: responseProvider } : {}),
      ...(safeString(rawThread?.modelProvider) ? { threadProviderId: safeString(rawThread?.modelProvider)! } : {}),
      accepted,
    });
    if (!accepted || !thread) {
      throw protocolError("THREAD_MODEL_MISMATCH", "Sohbet güvenli biçimde sürdürülemedi; model veya proje bilgisi eşleşmiyor.");
    }
    return { thread, history: await this.history(threadId, projectRoot) };
  }

  async resumeSaved(
    threadId: string,
    projectRoot: string,
    expectedModel: string,
    bridgeModel = expectedModel,
  ): Promise<ResumedThread> {
    const expected: ThreadSummaryDto = {
      id: threadId,
      cwd: projectRoot,
      model: expectedModel,
      modelProvider: DESKTOP_PROVIDER_ID,
      preview: "",
      updatedAt: 0,
      state: "notLoaded" as const,
    };
    return this.resume(threadId, expected, projectRoot, bridgeModel);
  }

  async history(threadId: string, projectRoot: string, cursor?: string): Promise<ThreadHistoryPage> {
    const response = asRecord(await this.rpc.request("thread/turns/list", {
      threadId,
      ...(cursor ? { cursor } : {}),
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    }));
    if (!response || !Array.isArray(response.data)) throw protocolError("THREAD_HISTORY_INVALID", "Sohbet geçmişi okunamadı.");
    const turns = [...response.data].reverse();
    const items: ConversationItemDto[] = [];
    for (const rawTurn of turns) {
      const turn = asRecord(rawTurn);
      const turnId = safeString(turn?.id);
      if (!turnId || !Array.isArray(turn?.items)) continue;
      const completed = turn.status !== "inProgress";
      for (const rawItem of turn.items) {
        const projected = projectThreadItem(rawItem, turnId, projectRoot, completed);
        if (projected) items.push(projected);
      }
    }
    const nextCursor = safeString(response.nextCursor, 2_000);
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async archive(threadId: string): Promise<void> {
    await this.rpc.request("thread/archive", { threadId });
  }

  async rename(threadId: string, name: string): Promise<void> {
    await this.rpc.request("thread/name/set", { threadId, name });
  }
}

export type TurnUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export class CodexTurnService {
  private readonly active = new Map<string, string>();
  private readonly starting = new Set<string>();

  constructor(private readonly rpc: CodexRpcClient) {}

  async start(threadId: string, input: TurnUserInput[], clientUserMessageId: string, model: string): Promise<string> {
    if (this.starting.has(threadId) || this.active.has(threadId)) {
      throw protocolError("TURN_ALREADY_ACTIVE", "Bu sohbette zaten etkin bir işlem var.");
    }
    this.starting.add(threadId);
    try {
      const response = asRecord(await this.rpc.request("turn/start", { threadId, input, clientUserMessageId, model }));
      const turn = asRecord(response?.turn);
      const turnId = safeString(turn?.id);
      if (!turnId) throw protocolError("TURN_START_INVALID", "Codex işlemi başlatılamadı.");
      this.active.set(threadId, turnId);
      return turnId;
    } finally {
      this.starting.delete(threadId);
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (this.active.get(threadId) !== turnId) throw protocolError("TURN_NOT_ACTIVE", "Etkin işlem artık bulunamadı.");
    await this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  noteStarted(threadId: string, turnId: string): void {
    this.active.set(threadId, turnId);
  }

  noteCompleted(threadId: string, turnId: string): void {
    if (this.active.get(threadId) === turnId) this.active.delete(threadId);
  }

  clear(): void {
    this.active.clear();
    this.starting.clear();
  }
}

function parseThread(value: unknown, authoritative?: {
  model: string;
  modelProvider: string;
  cwd: string;
}): ThreadSummaryDto | undefined {
  const thread = asRecord(value);
  if (!thread) return undefined;
  const id = safeString(thread.id);
  const reportedCwd = safeString(thread.cwd, 32_000);
  const reportedModel = safeString(thread.model);
  const reportedProvider = safeString(thread.modelProvider);
  if (authoritative) {
    if (reportedCwd && !samePath(reportedCwd, authoritative.cwd)) return undefined;
    if (reportedModel && reportedModel !== authoritative.model) return undefined;
    if (reportedProvider && reportedProvider !== authoritative.modelProvider) return undefined;
  }
  const cwd = reportedCwd ?? authoritative?.cwd;
  const model = reportedModel ?? authoritative?.model;
  const modelProvider = reportedProvider ?? authoritative?.modelProvider;
  const preview = safeString(thread.preview, 20_000) ?? "";
  const updatedAt = Number.isFinite(thread.updatedAt) ? thread.updatedAt as number : undefined;
  if (!id || !cwd || !model || modelProvider !== DESKTOP_PROVIDER_ID || updatedAt === undefined) return undefined;
  const status = asRecord(thread.status);
  const state = status?.type === "active" || status?.type === "idle" || status?.type === "systemError" || status?.type === "notLoaded"
    ? status.type : "notLoaded";
  const name = safeString(thread.name, 500);
  return {
    id, cwd, model, modelProvider: DESKTOP_PROVIDER_ID, preview, updatedAt, state,
    ...(name ? { name } : {}),
  };
}

function samePath(left: string | undefined, right: string): boolean {
  return left !== undefined && canonicalPathKey(left) === canonicalPathKey(right);
}

function canonicalPathKey(value: string): string {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  const normalized = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return normalized.toLocaleLowerCase("en-US");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeString(value: unknown, maximum = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function protocolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
