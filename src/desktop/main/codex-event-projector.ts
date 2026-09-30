import path from "node:path";
import type { ActivityStatusDto, ConversationItemDto, TurnActivityDto, TurnPhaseDto } from "../shared/contracts.js";

export const MAX_COMMAND_OUTPUT_CHARS = 128 * 1024;
export const MAX_DIFF_CHARS = 256 * 1024;

export interface ProjectedNotification {
  changed: boolean;
  turnPhase?: TurnPhaseDto;
  turnActivity?: TurnActivityDto;
  turnId?: string;
  completedTurnId?: string;
  resolvedRequestId?: string | number;
  completedItem?: ConversationItemDto;
  fileActivity?: Array<{ path: string; action: "added" | "modified" | "deleted" }>;
}

export class CodexEventProjector {
  private threadId: string | undefined;
  private projectRoot: string | undefined;
  private readonly items = new Map<string, ConversationItemDto>();
  private order: string[] = [];

  reset(threadId: string | undefined, projectRoot: string | undefined, history: ConversationItemDto[] = []): void {
    this.threadId = threadId;
    this.projectRoot = projectRoot;
    this.items.clear();
    this.order = [];
    for (const item of history) this.upsert(item);
  }

  prepend(history: ConversationItemDto[]): void {
    const keys: string[] = [];
    for (const item of history) {
      const key = itemKey(item.turnId, item.id);
      if (!this.items.has(key)) keys.push(key);
      this.items.set(key, item);
    }
    this.order = [...keys, ...this.order];
  }

  snapshot(): ConversationItemDto[] {
    return this.order.flatMap((key) => {
      const item = this.items.get(key);
      return item ? [structuredClone(item)] : [];
    });
  }

  apply(method: string, params: unknown): ProjectedNotification {
    if (method.includes("reasoning")) return { changed: false };
    const record = asRecord(params);
    if (!record) return { changed: false };
    const threadId = safeString(record.threadId);
    if (this.threadId && threadId && threadId !== this.threadId) return { changed: false };
    if (method === "turn/started") {
      const turn = asRecord(record.turn);
      const turnId = safeString(turn?.id);
      return turnId ? { changed: false, turnPhase: "running", turnActivity: "codexOrchestration", turnId } : { changed: false };
    }
    if (method === "turn/completed") {
      const turn = asRecord(record.turn);
      const turnId = safeString(turn?.id);
      const status = safeString(turn?.status);
      if (!turnId) return { changed: false };
      return {
        changed: false,
        turnPhase: status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed",
        turnActivity: "processingResult",
        turnId,
        completedTurnId: turnId,
      };
    }
    if (method === "item/started" || method === "item/completed") {
      const turnId = safeString(record.turnId);
      if (!turnId) return { changed: false };
      const item = projectThreadItem(record.item, turnId, this.projectRoot, method === "item/completed");
      if (!item) return { changed: false };
      this.upsert(item);
      return {
        changed: true,
        turnId,
        turnActivity: method === "item/completed" ? "processingResult" : activityForItem(item),
        ...(method === "item/completed" ? { completedItem: item } : {}),
        ...(item.kind === "fileChange" ? { fileActivity: item.changes.map(({ path, action }) => ({ path, action })) } : {}),
      };
    }
    if (method === "item/agentMessage/delta") {
      const turnId = safeString(record.turnId);
      const id = safeString(record.itemId);
      const delta = safeString(record.delta, 1_000_000, true);
      if (!turnId || !id || delta === undefined) return { changed: false };
      const current = this.items.get(itemKey(turnId, id));
      const text = current?.kind === "assistantMessage" ? current.text + delta : delta;
      this.upsert({ id, turnId, kind: "assistantMessage", text, status: "running" });
      return { changed: true, turnId, turnActivity: "evrenResponding" };
    }
    if (method === "item/commandExecution/outputDelta") {
      const turnId = safeString(record.turnId);
      const id = safeString(record.itemId);
      const delta = safeString(record.delta, 2_000_000, true);
      const current = turnId && id ? this.items.get(itemKey(turnId, id)) : undefined;
      if (!turnId || !id || delta === undefined || current?.kind !== "command") return { changed: false };
      const bounded = appendBoundedOutput(current.output ?? "", delta);
      this.upsert({ ...current, output: bounded.text, outputTruncated: bounded.truncated });
      return { changed: true, turnId, turnActivity: "runningCommand" };
    }
    if (method === "item/fileChange/patchUpdated") {
      const turnId = safeString(record.turnId);
      const id = safeString(record.itemId);
      if (!turnId || !id) return { changed: false };
      const item = projectFileChange(id, turnId, record.changes, this.projectRoot, "running");
      if (!item) return { changed: false };
      this.upsert(item);
      return {
        changed: true,
        turnId,
        turnActivity: "applyingFileChange",
        fileActivity: item.changes.map(({ path: filePath, action }) => ({ path: filePath, action })),
      };
    }
    if (method === "turn/diff/updated") {
      const turnId = safeString(record.turnId);
      const rawDiff = safeString(record.diff, 2_000_000, true);
      if (!turnId || rawDiff === undefined) return { changed: false };
      const bounded = boundText(rawDiff, MAX_DIFF_CHARS);
      this.upsert({
        id: `${turnId}:diff`, turnId, kind: "diff", diff: bounded.text,
        truncated: bounded.truncated, status: "running",
      });
      return { changed: true, turnId, turnActivity: "applyingFileChange" };
    }
    if (method === "turn/plan/updated") {
      const turnId = safeString(record.turnId);
      if (!turnId || !Array.isArray(record.plan)) return { changed: false };
      const steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> = record.plan.flatMap((value) => {
        const step = asRecord(value);
        const text = safeString(step?.step, 4_000);
        const status = safeString(step?.status);
        return text && (status === "pending" || status === "inProgress" || status === "completed")
          ? [{ step: text, status: status as "pending" | "inProgress" | "completed" }] : [];
      });
      this.upsert({
        id: `${turnId}:plan`, turnId, kind: "plan", steps,
        ...(safeString(record.explanation, 20_000) ? { explanation: safeString(record.explanation, 20_000)! } : {}),
        status: "running",
      });
      return { changed: true, turnId, turnActivity: "codexOrchestration" };
    }
    if (method === "serverRequest/resolved") {
      const requestId = record.requestId;
      return typeof requestId === "string" || typeof requestId === "number"
        ? { changed: false, resolvedRequestId: requestId }
        : { changed: false };
    }
    return { changed: false };
  }

  private upsert(item: ConversationItemDto): void {
    const key = itemKey(item.turnId, item.id);
    if (!this.items.has(key)) this.order.push(key);
    this.items.set(key, item);
  }
}

function activityForItem(item: ConversationItemDto): TurnActivityDto {
  if (item.kind === "command") return "runningCommand";
  if (item.kind === "fileChange" || item.kind === "diff") return "applyingFileChange";
  if (item.kind === "assistantMessage") return "evrenResponding";
  return "codexOrchestration";
}

export function projectThreadItem(
  value: unknown,
  turnId: string,
  projectRoot?: string,
  completed = true,
): ConversationItemDto | undefined {
  const item = asRecord(value);
  const type = safeString(item?.type);
  const id = safeString(item?.id);
  if (!item || !type || !id || type === "reasoning" || type === "hookPrompt") return undefined;
  const lifecycleStatus: ActivityStatusDto = completed ? "completed" : "running";
  if (type === "userMessage") {
    if (!Array.isArray(item.content)) return undefined;
    const texts: string[] = [];
    const attachments: string[] = [];
    for (const raw of item.content) {
      const content = asRecord(raw);
      if (content?.type === "text" && typeof content.text === "string") texts.push(content.text);
      if (content?.type === "localImage" && typeof content.path === "string") attachments.push(path.basename(content.path));
    }
    return { id, turnId, kind: "userMessage", text: texts.join("\n"), attachments, status: lifecycleStatus };
  }
  if (type === "agentMessage") {
    const text = safeString(item.text, 2_000_000, true);
    return text === undefined ? undefined : { id, turnId, kind: "assistantMessage", text, status: lifecycleStatus };
  }
  if (type === "commandExecution") {
    const command = safeString(item.command, 100_000, true);
    const cwd = safeString(item.cwd, 32_000, true);
    if (command === undefined || cwd === undefined) return undefined;
    const rawStatus = safeString(item.status);
    const status = activityStatus(rawStatus, completed);
    const output = typeof item.aggregatedOutput === "string" ? boundText(item.aggregatedOutput, MAX_COMMAND_OUTPUT_CHARS) : undefined;
    return {
      id, turnId, kind: "command", command, cwd: displayPath(cwd, projectRoot), status,
      ...(output === undefined ? {} : { output: output.text, outputTruncated: output.truncated }),
      ...(Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode as number } : {}),
      ...(Number.isFinite(item.durationMs) && (item.durationMs as number) >= 0 ? { durationMs: item.durationMs as number } : {}),
    };
  }
  if (type === "fileChange") {
    return projectFileChange(id, turnId, item.changes, projectRoot, activityStatus(safeString(item.status), completed));
  }
  if (type === "plan") {
    const text = safeString(item.text, 100_000, true);
    return text === undefined ? undefined : {
      id, turnId, kind: "plan", steps: [{ step: text, status: completed ? "completed" : "inProgress" }], status: lifecycleStatus,
    };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = safeString(item.tool, 500) ?? "Araç";
    const server = safeString(item.server, 500);
    return {
      id, turnId, kind: "tool", label: server ? `${server} · ${tool}` : tool,
      status: activityStatus(safeString(item.status), completed),
    };
  }
  if (type === "contextCompaction") {
    return { id, turnId, kind: "status", message: "Sohbet bağlamı sıkıştırıldı.", tone: "info", status: lifecycleStatus };
  }
  return undefined;
}

export function appendBoundedOutput(current: string, delta: string): { text: string; truncated: boolean } {
  return boundText(current + delta, MAX_COMMAND_OUTPUT_CHARS);
}

function projectFileChange(
  id: string,
  turnId: string,
  value: unknown,
  projectRoot: string | undefined,
  status: ActivityStatusDto,
): Extract<ConversationItemDto, { kind: "fileChange" }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: Array<{ path: string; action: "added" | "modified" | "deleted"; diff?: string }> = value.flatMap((raw) => {
    const change = asRecord(raw);
    const filePath = safeString(change?.path, 32_000, true);
    const kind = asRecord(change?.kind);
    const type = safeString(kind?.type);
    if (!filePath || (type !== "add" && type !== "delete" && type !== "update")) return [];
    const action: "added" | "modified" | "deleted" = type === "add" ? "added" : type === "delete" ? "deleted" : "modified";
    const diff = safeString(change?.diff, 1_000_000, true);
    const bounded = diff === undefined ? undefined : boundText(diff, 64 * 1024);
    return [{
      path: displayPath(filePath, projectRoot), action,
      ...(bounded === undefined ? {} : { diff: bounded.text }),
    }];
  });
  return { id, turnId, kind: "fileChange", changes, status };
}

function displayPath(value: string, projectRoot?: string): string {
  if (!projectRoot || !path.isAbsolute(value)) return value;
  const relative = path.relative(projectRoot, value);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(value);
}

function activityStatus(value: string | undefined, completed: boolean): ActivityStatusDto {
  if (value === "failed") return "failed";
  if (value === "declined") return "declined";
  if (value === "completed" || completed) return "completed";
  return "running";
}

function boundText(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: `… UI çıktısı kısaltıldı …\n${value.slice(-maximum)}`, truncated: true };
}

function itemKey(turnId: string, id: string): string {
  return `${turnId}\u0000${id}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeString(value: unknown, maximum = 500, allowControls = false): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  if (!allowControls && /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}
