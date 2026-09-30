import { describe, expect, it } from "vitest";
import {
  CodexEventProjector,
  MAX_COMMAND_OUTPUT_CHARS,
  projectThreadItem,
} from "../src/desktop/main/codex-event-projector.js";

describe("safe Desktop Codex event projection", () => {
  it("aggregates assistant deltas by thread/turn/item and finalizes one message", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    projector.apply("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Mer" });
    projector.apply("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "haba" });
    expect(projector.snapshot()).toEqual([expect.objectContaining({ kind: "assistantMessage", text: "Merhaba", status: "running" })]);
    projector.apply("item/completed", {
      threadId: "thread-1", turnId: "turn-1", completedAtMs: 1,
      item: { type: "agentMessage", id: "item-1", text: "Merhaba", phase: null },
    });
    expect(projector.snapshot()).toEqual([expect.objectContaining({ text: "Merhaba", status: "completed" })]);
  });

  it("drops raw reasoning from history and live reasoning notifications", () => {
    expect(projectThreadItem({ type: "reasoning", id: "secret", summary: ["hidden"], content: ["private chain"] }, "turn-1"))
      .toBeUndefined();
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    expect(projector.apply("item/reasoning/textDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "secret", delta: "private chain",
    })).toEqual({ changed: false });
    expect(JSON.stringify(projector.snapshot())).not.toContain("private");
  });

  it("projects command lifecycle and bounds frequent output deltas", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    projector.apply("item/started", {
      threadId: "thread-1", turnId: "turn-1", startedAtMs: 1,
      item: {
        type: "commandExecution", id: "cmd-1", command: "npm test", cwd: "C:\\work",
        status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null,
      },
    });
    expect(projector.apply("item/commandExecution/outputDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "started",
    })).toMatchObject({ turnActivity: "runningCommand" });
    projector.apply("item/commandExecution/outputDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 500),
    });
    const command = projector.snapshot()[0];
    expect(command).toMatchObject({ kind: "command", command: "npm test", status: "running", outputTruncated: true });
    expect(command?.kind === "command" ? command.output!.length : 0).toBeLessThan(MAX_COMMAND_OUTPUT_CHARS + 100);
  });

  it("projects relative file changes and a bounded read-only turn diff", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    projector.apply("item/fileChange/patchUpdated", {
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
      changes: [{ path: "C:\\work\\src\\App.tsx", kind: { type: "update", move_path: null }, diff: "@@ changed" }],
    });
    projector.apply("turn/diff/updated", { threadId: "thread-1", turnId: "turn-1", diff: "+new line" });
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({ kind: "fileChange", changes: [expect.objectContaining({ path: "src/App.tsx", action: "modified" })] }),
      expect.objectContaining({ kind: "diff", diff: "+new line" }),
    ]);
  });

  it("projects plan state and ignores events belonging to another thread", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    projector.apply("turn/plan/updated", {
      threadId: "thread-1", turnId: "turn-1", explanation: "Safe plan",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Build", status: "inProgress" }],
    });
    projector.apply("item/agentMessage/delta", { threadId: "thread-2", turnId: "turn-x", itemId: "x", delta: "wrong" });
    expect(projector.snapshot()).toEqual([expect.objectContaining({ kind: "plan", explanation: "Safe plan" })]);
  });

  it("reports turn completion and server-request cleanup without exposing raw payloads", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    expect(projector.apply("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } }))
      .toMatchObject({ turnPhase: "interrupted", turnActivity: "processingResult", completedTurnId: "turn-1" });
    expect(projector.apply("serverRequest/resolved", { threadId: "thread-1", requestId: 42 }))
      .toEqual({ changed: false, resolvedRequestId: 42 });
  });

  it("projects truthful lifecycle stages without exposing reasoning", () => {
    const projector = new CodexEventProjector();
    projector.reset("thread-1", "C:\\work");
    expect(projector.apply("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }))
      .toMatchObject({ turnActivity: "codexOrchestration" });
    expect(projector.apply("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "yanıt",
    })).toMatchObject({ turnActivity: "evrenResponding" });
    expect(projector.apply("item/fileChange/patchUpdated", {
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1", changes: [],
    })).toMatchObject({ turnActivity: "applyingFileChange" });
  });
});
