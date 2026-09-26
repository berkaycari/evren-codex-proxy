import type { BuiltCodexResponse } from "./evren-to-codex.js";

function event(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

export function encodeResponseSse(built: BuiltCodexResponse): string {
  const { response } = built;
  const events: string[] = [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    event("response.in_progress", { response: { ...response, status: "in_progress", output: [] } }),
  ];
  for (const [outputIndex, item] of response.output.entries()) {
    events.push(event("response.output_item.added", { output_index: outputIndex, item: pendingItem(item) }));
    if (item.type === "message") {
      const content = item.content as Array<Record<string, unknown>>;
      const text = String(content[0]?.text ?? "");
      const itemId = String(item.id);
      events.push(
        event("response.content_part.added", {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
        event("response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: text }),
        event("response.output_text.done", { item_id: itemId, output_index: outputIndex, content_index: 0, text }),
        event("response.content_part.done", { item_id: itemId, output_index: outputIndex, content_index: 0, part: content[0] ?? {} }),
      );
    } else if (item.type === "function_call") {
      const args = String(item.arguments ?? "{}");
      events.push(
        event("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          call_id: item.call_id,
          delta: args,
        }),
        event("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: outputIndex,
          call_id: item.call_id,
          arguments: args,
        }),
      );
    } else if (item.type === "custom_tool_call") {
      const input = String(item.input ?? "");
      events.push(
        event("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: outputIndex,
          call_id: item.call_id,
          delta: input,
        }),
        event("response.custom_tool_call_input.done", {
          item_id: item.id,
          output_index: outputIndex,
          call_id: item.call_id,
          input,
        }),
      );
    }
    events.push(event("response.output_item.done", { output_index: outputIndex, item }));
  }
  events.push(event("response.completed", { response }));
  return events.join("");
}

function pendingItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === "message") return { ...item, status: "in_progress", content: [] };
  if (item.type === "function_call") return { ...item, status: "in_progress", arguments: "" };
  if (item.type === "custom_tool_call") return { ...item, status: "in_progress", input: "" };
  return item;
}
