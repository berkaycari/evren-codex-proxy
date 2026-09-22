import { describe, expect, it } from "vitest";
import { truncateToolOutput } from "../src/bridge/codex-to-evren.js";
import {
  normalizeTools,
  parseModelDecision,
  renderToolCatalog,
  ToolProtocolError,
} from "../src/bridge/tool-protocol.js";

const tools = normalizeTools([{ type: "function", name: "shell", description: "Run command", parameters: {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: false,
} }]);
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

describe("textual tool protocol", () => {
  it("converts real tool definitions into a textual catalog", () => {
    const catalog = renderToolCatalog(tools);
    expect(catalog).toContain('"name":"shell"');
    expect(catalog).toContain('"command"');
  });

  it("parses valid DeepSeek tool JSON", () => {
    expect(parseModelDecision('{"kind":"tool_call","name":"shell","arguments":{"command":"pwd"}}', toolMap))
      .toEqual({ kind: "tool_call", name: "shell", arguments: { command: "pwd" } });
  });

  it("parses a single exact markdown JSON fence", () => {
    expect(parseModelDecision('```json\n{"kind":"final","content":"ok"}\n```', toolMap))
      .toEqual({ kind: "final", content: "ok" });
  });

  it("rejects unknown tools", () => {
    expect(() => parseModelDecision('{"kind":"tool_call","name":"invented","arguments":{}}', toolMap))
      .toThrowError(ToolProtocolError);
  });

  it("validates arguments against the incoming schema", () => {
    expect(() => parseModelDecision('{"kind":"tool_call","name":"shell","arguments":{}}', toolMap))
      .toThrow(/Arguments do not satisfy/);
  });

  it("truncates tool output deterministically while retaining head and tail", () => {
    const output = `${"A".repeat(80)}${"Z".repeat(80)}`;
    const truncated = truncateToolOutput(output, 100);
    expect(truncated.length).toBeLessThanOrEqual(100);
    expect(truncated).toContain("[TRUNCATED");
    expect(truncated.startsWith("A")).toBe(true);
    expect(truncated.endsWith("Z")).toBe(true);
  });

  it("normalizes nested and custom tool shapes", () => {
    const normalized = normalizeTools([
      { type: "function", function: { name: "nested", parameters: { type: "object" } } },
      { type: "custom", name: "patch", description: "Apply patch" },
    ]);
    expect(normalized.map((tool) => [tool.name, tool.kind])).toEqual([
      ["nested", "function"], ["patch", "custom"],
    ]);
  });
});
