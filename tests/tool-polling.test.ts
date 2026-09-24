import { describe, expect, it } from "vitest";
import { recognizeToolPoll } from "../src/bridge/tool-polling.js";

describe("stable tool polling recognition", () => {
  it("recognizes function and custom-wrapper write_stdin identities only as hashes", () => {
    const direct = recognizeToolPoll("write_stdin", { session_id: "private-process-id", chars: "" });
    const wrapped = recognizeToolPoll("write_stdin", {
      input: JSON.stringify({ session_id: "private-wrapped-id", chars: "" }),
    });
    expect(direct?.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(wrapped?.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([direct, wrapped])).not.toContain("private-");
  });

  it("does not classify same-named calls without process identity or other tools", () => {
    expect(recognizeToolPoll("write_stdin", { chars: "" })).toBeUndefined();
    expect(recognizeToolPoll("exec_command", { session_id: "process" })).toBeUndefined();
    expect(recognizeToolPoll("write_stdin_backup", { session_id: "process" })).toBeUndefined();
    expect(recognizeToolPoll("functions.write_stdin", { session_id: "process" })).toBeUndefined();
  });
});
