export type TranscriptRole = "developer" | "user" | "assistant" | "tool";

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  toolName?: string;
  callId?: string;
}

export function renderTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((entry, index) => {
      const label = entry.role === "tool"
        ? `TOOL ${entry.toolName ?? "unknown"} (${entry.callId ?? "unknown"})`
        : entry.role.toUpperCase();
      return `[${index + 1}] ${label}:\n${entry.text}`;
    })
    .join("\n\n");
}
