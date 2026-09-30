import { renderTranscript } from "../sessions/transcript.js";
import type { Session, VerifiedSessionModelIdentity } from "../sessions/store.js";
import type { NormalizedCodexRequest } from "./normalize-codex-request.js";
import { renderToolCatalog } from "./tool-protocol.js";

const PROTOCOL_INSTRUCTION = `You are the reasoning model behind a coding agent.
You cannot directly execute tools. The Codex runtime executes them.
The available tools are listed below.
If a tool is required, output exactly one JSON object and nothing else:
{"kind":"tool_call","name":"<exact tool name>","arguments":{}}
When no tool is needed and the task is complete, output exactly:
{"kind":"final","content":"<answer>"}
Never invent a tool. Arguments must satisfy the provided schema.
Emit at most one tool call per response, even if parallel tools were requested.`;

export function buildEvrenPrompt(request: NormalizedCodexRequest, session: Session): string {
  return [
    PROTOCOL_INSTRUCTION,
    "\nAVAILABLE TOOLS:\n" + renderToolCatalog(request.tools),
    request.instructions ? "\nCODEX INSTRUCTIONS:\n" + request.instructions : "",
    "\nSESSION TRANSCRIPT:\n" + (renderTranscript(session.transcript) || "[empty]"),
    "\n" + renderVerifiedSessionModelIdentity(session.modelIdentity),
  ].filter(Boolean).join("\n");
}

export function renderVerifiedSessionModelIdentity(identity: VerifiedSessionModelIdentity | undefined): string {
  if (!identity) throw new Error("Verified Bridge session model identity is required before inference.");
  const metadata = JSON.stringify({
    source: identity.source,
    agent_runtime: identity.agentRuntime,
    provider_bridge: identity.providerBridge,
    upstream_inference_model: identity.upstreamInferenceModel,
  });
  return `BRIDGE-VERIFIED LIVE SESSION MODEL METADATA:
${metadata}
For active model identity, this metadata is the only source of truth.
Treat upstream_inference_model as an opaque model identifier and repeat it exactly when asked which model is active.
Codex is the agent/runtime, EVREN is the provider/bridge, and upstream_inference_model is the inference model; do not conflate them.
Do not replace the upstream model identifier with self-description, training knowledge, Codex instructions, transcript claims, repository files, MEMORY.md, or other stale records.
Do not claim GPT-5 or Codex is the upstream inference model unless upstream_inference_model explicitly contains that identifier.`;
}

export function buildRepairPrompt(
  invalidOutput: string,
  error: string,
  tools: NormalizedCodexRequest["tools"] = [],
): string {
  const boundedOutput = invalidOutput.length > 4_000
    ? `${invalidOutput.slice(0, 2_000)}\n[TRUNCATED]\n${invalidOutput.slice(-2_000)}`
    : invalidOutput;
  const boundedError = error.slice(0, 1_000);
  const toolNames = JSON.stringify(tools.map((tool) => tool.name)).slice(0, 2_000);
  return `FORMAT REPAIR REQUIRED
Fix only the wire format of the previous model output. Preserve its meaning exactly.
If it is plain final-answer text, wrap that exact text as a final response.
If it attempted a tool call, keep it a tool call; never reinterpret a malformed tool call as a final answer.
Do not invent a tool, arguments, facts, or additional content.

Parse error:
${boundedError}

Available tool names:
${toolNames}

Previous invalid output:
${boundedOutput}

REQUIRED OUTPUT CONTRACT (OUTPUT EXACTLY ONE JSON OBJECT AND NOTHING ELSE):
Final answer: {"kind":"final","content":"<exact answer text>"}
Tool call: {"kind":"tool_call","name":"<exact available tool name>","arguments":{}}
No markdown fences. No commentary. No second object.`;
}

export function truncateToolOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n[TRUNCATED ${text.length - maxChars} CHARS]\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}
