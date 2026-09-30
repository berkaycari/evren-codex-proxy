import { describe, expect, it, vi } from "vitest";
import { CodexApprovalService } from "../src/desktop/main/codex-approval-service.js";

function fixture() {
  const respondToServerRequest = vi.fn();
  const rejectServerRequest = vi.fn();
  const onChanged = vi.fn();
  const onUnsupported = vi.fn();
  const service = new CodexApprovalService(
    { respondToServerRequest, rejectServerRequest },
    { onChanged, onUnsupported, timeoutMs: 60_000 },
  );
  return { service, respondToServerRequest, rejectServerRequest, onChanged, onUnsupported };
}

function commandRequest(availableDecisions?: unknown) {
  return {
    id: "request-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      command: "npm test",
      cwd: "C:\\work",
      reason: "Run tests",
      ...(availableDecisions === undefined ? {} : { availableDecisions }),
      additionalPermissions: { network: { enabled: true } },
    },
  };
}

describe("Desktop Permission Center", () => {
  it("publishes pending approvals and real context through one synchronized snapshot", () => {
    const { service, onChanged } = fixture();
    service.handle(commandRequest());
    const snapshot = service.snapshot();
    expect(snapshot.approvals[0]).toMatchObject({
      type: "command",
      command: "npm test",
      cwd: "C:\\work",
      availableDecisions: ["decline", "acceptForSession", "accept"],
    });
    expect(snapshot.approvals[0]!.context[0]).toContain("Ek izin");
    expect(onChanged).toHaveBeenLastCalledWith(snapshot);
  });

  it("allows only decisions exposed by the Codex request", () => {
    const { service, respondToServerRequest } = fixture();
    service.handle(commandRequest(["accept", "decline"]));
    const approval = service.list()[0]!;
    expect(() => service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "acceptForSession" }, "thread-1"))
      .toThrow("Codex tarafından mevcut istek için sunulmadı");
    expect(respondToServerRequest).not.toHaveBeenCalled();
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "accept" }, "thread-1");
  });

  it("fails closed when a request exposes only unsupported decision shapes", () => {
    const { service, rejectServerRequest, onUnsupported } = fixture();
    service.handle(commandRequest([{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm"] } }]));
    expect(service.list()).toEqual([]);
    expect(rejectServerRequest).toHaveBeenCalledWith("request-1", -32601, expect.any(String));
    expect(onUnsupported).toHaveBeenCalledWith("item/commandExecution/requestApproval:decisions");
  });

  it("records approve-once and reject activity without creating session grants", () => {
    const { service } = fixture();
    service.handle(commandRequest());
    let approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "accept" }, "thread-1");
    service.handle({ ...commandRequest(), id: "request-2" });
    approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "decline" }, "thread-1");
    expect(service.snapshot().grants).toEqual([]);
    expect(service.snapshot().history.map((item) => item.type)).toEqual(["declined", "approvedOnce"]);
  });

  it("shows session grants with truthful non-revocable protocol scope", () => {
    const { service } = fixture();
    service.handle(commandRequest());
    const approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "acceptForSession" }, "thread-1");
    const snapshot = service.snapshot();
    expect(snapshot.grants[0]).toMatchObject({
      threadId: "thread-1",
      type: "command",
      scope: "Codex oturum onayı önbelleği",
      detail: "npm test",
      revocable: false,
    });
    expect(snapshot.supportsRevocation).toBe(false);
    expect(snapshot.revocationReason).toContain("revoke yöntemi sunmuyor");
  });

  it("clears transient grants and activity only when the App Server session resets", () => {
    const { service } = fixture();
    service.handle(commandRequest());
    const approval = service.list()[0]!;
    service.respond({ approvalId: approval.id, threadId: "thread-1", decision: "acceptForSession" }, "thread-1");
    expect(service.snapshot().grants).toHaveLength(1);
    service.resetSession();
    expect(service.snapshot()).toMatchObject({ approvals: [], grants: [], history: [], supportsRevocation: false });
  });
});
