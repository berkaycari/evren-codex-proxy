import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: "function" | "custom";
  strict?: boolean;
}

const toolCallSchema = z.object({
  kind: z.literal("tool_call"),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

const finalSchema = z.object({
  kind: z.literal("final"),
  content: z.string(),
}).strict();

export type ModelDecision = z.infer<typeof toolCallSchema> | z.infer<typeof finalSchema>;

export class ToolProtocolError extends Error {
  readonly code = "invalid_tool_protocol";
  constructor(message: string, public readonly repairable = true) {
    super(message);
  }
}

export function normalizeTools(input: unknown): NormalizedTool[] {
  if (!Array.isArray(input)) return [];
  const byName = new Map<string, NormalizedTool>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const nested = raw.function && typeof raw.function === "object"
      ? raw.function as Record<string, unknown>
      : undefined;
    const name = stringValue(raw.name) ?? stringValue(nested?.name);
    if (!name || name.length > 256) continue;
    const type = stringValue(raw.type);
    const kind: NormalizedTool["kind"] = type === "custom" ? "custom" : "function";
    const description = (stringValue(raw.description) ?? stringValue(nested?.description) ?? "No description provided.")
      .slice(0, 2_000);
    const schemaCandidate = raw.parameters ?? raw.input_schema ?? nested?.parameters ?? nested?.input_schema;
    const inputSchema = isRecord(schemaCandidate)
      ? schemaCandidate
      : kind === "custom"
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        : { type: "object", additionalProperties: true };
    const strictCandidate = raw.strict ?? nested?.strict;
    byName.set(name, {
      name,
      description,
      inputSchema,
      kind,
      ...(typeof strictCandidate === "boolean" ? { strict: strictCandidate } : {}),
    });
  }
  return [...byName.values()];
}

export function renderToolCatalog(tools: NormalizedTool[]): string {
  if (tools.length === 0) return "No tools are available for this turn.";
  return tools.map((tool) => JSON.stringify({
    name: tool.name,
    kind: tool.kind,
    description: tool.description,
    arguments_schema: tool.inputSchema,
  })).join("\n");
}

export function parseModelDecision(text: string, tools: Map<string, NormalizedTool>): ModelDecision {
  const jsonText = unwrapExactJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ToolProtocolError("Model output is not valid JSON.");
  }
  const decision = z.union([toolCallSchema, finalSchema]).safeParse(parsed);
  if (!decision.success) throw new ToolProtocolError("Model output does not match the required tool protocol schema.");
  if (decision.data.kind === "final") return decision.data;
  const tool = tools.get(decision.data.name);
  if (!tool) throw new ToolProtocolError(`Model requested unknown tool: ${decision.data.name}`, false);
  validateArguments(tool, decision.data.arguments);
  return decision.data;
}

function unwrapExactJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  throw new ToolProtocolError("Model output must be a JSON object, optionally inside one JSON code fence.");
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<NormalizedTool, ValidateFunction>();

function validateArguments(tool: NormalizedTool, args: Record<string, unknown>): void {
  let validate: ValidateFunction;
  try {
    const cached = validators.get(tool);
    if (cached) {
      validate = cached;
    } else {
      const compiled = ajv.compile(tool.inputSchema);
      validators.set(tool, compiled);
      validate = compiled;
    }
  } catch {
    throw new ToolProtocolError(`Tool schema is invalid for ${tool.name}.`, false);
  }
  if (!validate(args)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new ToolProtocolError(`Arguments do not satisfy the schema for ${tool.name}: ${detail}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
