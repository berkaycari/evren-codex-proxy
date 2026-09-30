import { randomUUID } from "node:crypto";
import type {
  ApprovalDecisionDto,
  ApprovalRequestDto,
  ApprovalResponseInput,
  PermissionActivityDto,
  PermissionCenterDto,
  SessionPermissionDto,
} from "../shared/contracts.js";
import type { JsonRpcServerRequest } from "./json-rpc-stdio.js";

interface ServerRequestResponder {
  respondToServerRequest(id: string | number, result: unknown): void;
  rejectServerRequest(id: string | number, code: number, message: string): void;
}

interface PendingApproval {
  dto: ApprovalRequestDto;
  requestId: string | number;
  timer: NodeJS.Timeout;
}

export class CodexApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly requestToApproval = new Map<string, string>();
  private readonly grants = new Map<string, SessionPermissionDto>();
  private readonly history: PermissionActivityDto[] = [];

  constructor(
    private readonly responder: ServerRequestResponder,
    private readonly options: {
      onChanged?: (snapshot: PermissionCenterDto & { approvals: ApprovalRequestDto[] }) => void;
      onUnsupported?: (method: string) => void;
      timeoutMs?: number;
    } = {},
  ) {}

  handle(request: JsonRpcServerRequest): void {
    if (request.method !== "item/commandExecution/requestApproval"
      && request.method !== "item/fileChange/requestApproval") {
      this.responder.rejectServerRequest(request.id, -32_601, "Server request is not supported by EVREN Codex Bridge.");
      this.options.onUnsupported?.(safeMethod(request.method));
      return;
    }
    const params = asRecord(request.params);
    const threadId = safeString(params?.threadId);
    const turnId = safeString(params?.turnId);
    const itemId = safeString(params?.itemId);
    if (!threadId || !turnId || !itemId) {
      this.responder.rejectServerRequest(request.id, -32_602, "Approval request parameters are invalid.");
      return;
    }
    const approvalId = randomUUID();
    const availableDecisions = parseAvailableDecisions(params?.availableDecisions);
    if (availableDecisions.length === 0) {
      this.responder.rejectServerRequest(request.id, -32_601, "Approval decisions are not supported by EVREN Codex Bridge.");
      this.options.onUnsupported?.(`${safeMethod(request.method)}:decisions`);
      return;
    }
    const context = [
      describeContext("Ek izin", params?.additionalPermissions),
      describeContext("Ağ bağlamı", params?.networkApprovalContext),
      describeContext("Komut ilkesi", params?.proposedExecpolicyAmendment),
      describeContext("Ağ ilkesi", params?.proposedNetworkPolicyAmendments),
    ].filter((value): value is string => value !== undefined);
    const dto: ApprovalRequestDto = {
      id: approvalId,
      type: request.method === "item/commandExecution/requestApproval" ? "command" : "fileChange",
      threadId,
      turnId,
      itemId,
      createdAt: Date.now(),
      ...(safeString(params?.command, 100_000, true) ? { command: safeString(params?.command, 100_000, true)! } : {}),
      ...(safeString(params?.cwd, 32_000, true) ? { cwd: safeString(params?.cwd, 32_000, true)! } : {}),
      ...(safeString(params?.reason, 4_000, true) ? { reason: safeString(params?.reason, 4_000, true)! } : {}),
      ...(safeString(params?.grantRoot, 32_000, true) ? { grantRoot: safeString(params?.grantRoot, 32_000, true)! } : {}),
      availableDecisions,
      context,
    };
    const timer = setTimeout(() => {
      const pending = this.pending.get(approvalId);
      if (!pending) return;
      this.pending.delete(approvalId);
      this.requestToApproval.delete(requestKey(pending.requestId));
      try {
        this.responder.respondToServerRequest(pending.requestId, { decision: "cancel" });
      } catch {
        // The App Server may have exited while the approval was pending.
      }
      this.recordActivity(pending.dto, "expired");
      this.emit();
    }, this.options.timeoutMs ?? 5 * 60_000);
    timer.unref();
    this.pending.set(approvalId, { dto, requestId: request.id, timer });
    this.requestToApproval.set(requestKey(request.id), approvalId);
    this.emit();
  }

  respond(input: ApprovalResponseInput, selectedThreadId: string | undefined): void {
    const pending = this.pending.get(input.approvalId);
    if (!pending || pending.dto.threadId !== input.threadId || selectedThreadId !== input.threadId) {
      throw approvalError("APPROVAL_SCOPE_MISMATCH", "Onay isteği bu sohbete ait değil veya artık geçerli değil.");
    }
    if (!pending.dto.availableDecisions.includes(input.decision)) {
      throw approvalError("APPROVAL_DECISION_UNAVAILABLE", "Bu karar Codex tarafından mevcut istek için sunulmadı.");
    }
    this.pending.delete(input.approvalId);
    this.requestToApproval.delete(requestKey(pending.requestId));
    clearTimeout(pending.timer);
    this.responder.respondToServerRequest(pending.requestId, { decision: input.decision });
    this.recordActivity(
      pending.dto,
      input.decision === "accept" ? "approvedOnce" : input.decision === "acceptForSession" ? "approvedForSession" : "declined",
    );
    if (input.decision === "acceptForSession") this.recordGrant(pending.dto);
    this.emit();
  }

  resolveRequest(requestId: string | number): void {
    const approvalId = this.requestToApproval.get(requestKey(requestId));
    if (!approvalId) return;
    this.remove(approvalId, false);
  }

  clearTurn(threadId: string, turnId: string, respondCancel: boolean): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.dto.threadId === threadId && pending.dto.turnId === turnId) this.remove(approvalId, respondCancel);
    }
  }

  clearThread(threadId: string, respondCancel: boolean): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.dto.threadId === threadId) this.remove(approvalId, respondCancel);
    }
  }

  clear(respondCancel: boolean): void {
    for (const approvalId of [...this.pending.keys()]) this.remove(approvalId, respondCancel);
  }

  resetSession(): void {
    this.clear(false);
    this.grants.clear();
    this.history.splice(0);
    this.emit();
  }

  list(): ApprovalRequestDto[] {
    return [...this.pending.values()].map(({ dto }) => structuredClone(dto));
  }

  snapshot(): PermissionCenterDto & { approvals: ApprovalRequestDto[] } {
    return {
      approvals: this.list(),
      grants: [...this.grants.values()].map((grant) => structuredClone(grant)),
      history: this.history.map((activity) => structuredClone(activity)),
      supportsRevocation: false,
      revocationReason: "Codex 0.157.1 oturum onayı önbelleği için güvenli bir revoke yöntemi sunmuyor. İzinler App Server oturumu sona erdiğinde temizlenir.",
    };
  }

  private remove(approvalId: string, respondCancel: boolean): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    this.requestToApproval.delete(requestKey(pending.requestId));
    clearTimeout(pending.timer);
    if (respondCancel) {
      try {
        this.responder.respondToServerRequest(pending.requestId, { decision: "cancel" });
      } catch {
        // A concurrent server resolution wins safely.
      }
      this.recordActivity(pending.dto, "cancelled");
    }
    this.emit();
  }

  private emit(): void {
    this.options.onChanged?.(this.snapshot());
  }

  private recordGrant(approval: ApprovalRequestDto): void {
    const detail = approval.type === "command" ? approval.command : approval.grantRoot;
    const scope = approval.type === "command"
      ? "Codex oturum onayı önbelleği"
      : approval.grantRoot
        ? `Yazma kökü: ${approval.grantRoot}`
        : "Aynı dosyalar için Codex oturum onayı";
    const grant: SessionPermissionDto = {
      id: randomUUID(),
      threadId: approval.threadId,
      type: approval.type,
      scope,
      ...(detail ? { detail } : {}),
      grantedAt: Date.now(),
      revocable: false,
      revokeReason: "Bu Codex sürümü oturum onayı önbelleğini tekil olarak kaldıran bir protokol yöntemi sunmuyor.",
    };
    this.grants.set(grant.id, grant);
  }

  private recordActivity(approval: ApprovalRequestDto, type: PermissionActivityDto["type"]): void {
    const summary = approval.type === "command"
      ? boundedSummary(approval.command ?? "Komut isteği")
      : boundedSummary(approval.grantRoot ? `Dosya değişikliği · ${approval.grantRoot}` : "Dosya değişikliği isteği");
    this.history.unshift({
      id: randomUUID(),
      threadId: approval.threadId,
      type,
      operation: approval.type,
      summary,
      occurredAt: Date.now(),
    });
    this.history.splice(50);
  }
}

function parseAvailableDecisions(value: unknown): ApprovalDecisionDto[] {
  if (!Array.isArray(value)) return ["decline", "acceptForSession", "accept"];
  const supported = value.filter((decision): decision is ApprovalDecisionDto =>
    decision === "accept" || decision === "acceptForSession" || decision === "decline");
  return [...new Set(supported)];
}

function describeContext(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized || serialized.length > 2_000) return `${label}: ayrıntı görüntüleme sınırını aşıyor`;
    return `${label}: ${serialized}`;
  } catch {
    return `${label}: kullanılamıyor`;
  }
}

function boundedSummary(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}…` : sanitized;
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function safeMethod(method: string): string {
  return method.length <= 200 && !/[\u0000-\u001f\u007f]/.test(method) ? method : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeString(value: unknown, maximum = 500, allowControls = false): string | undefined {
  if (typeof value !== "string" || !value || value.length > maximum) return undefined;
  return !allowControls && /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}

function approvalError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
