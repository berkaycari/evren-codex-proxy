import type { ConversationItemDto, DesktopStateDto, SafeErrorDto, WorkspaceStateDto } from "../shared/contracts.js";

export type DesktopPage = "home" | "chat" | "history" | "usage" | "settings" | "help" | "updates";

export interface ScopedUiError {
  scope: DesktopPage;
  message: string;
}

export type ConversationRenderGroup =
  | { kind: "item"; item: ConversationItemDto }
  | { kind: "completedCommands"; items: Array<ConversationItemDto & { kind: "command" }> };

export function routeErrorIsVisible(error: ScopedUiError | undefined, page: DesktopPage): boolean {
  return error?.scope === page;
}

export function applicationErrorIsVisible(error: SafeErrorDto | undefined): boolean {
  return error !== undefined;
}

export function modelControlPresentation(
  state: Pick<DesktopStateDto, "models" | "evren">,
  turnBusy: boolean,
): { disabled: boolean; placeholder?: string } {
  const ready = state.models.some((model) => model.selectable);
  if (ready) return { disabled: turnBusy };
  return {
    disabled: true,
    placeholder: state.evren.status === "connecting" ? "Modeller yükleniyor…" : "Kullanılabilir model yok",
  };
}

export interface ImageInputPresentation {
  modelId?: string;
  supported: boolean;
  label: string;
}

export function imageInputPresentation(
  state: Pick<DesktopStateDto, "models" | "selectedModelId"> & {
    workspace: Pick<WorkspaceStateDto, "selectedThreadModel">;
  },
): ImageInputPresentation {
  const modelId = state.workspace.selectedThreadModel ?? state.selectedModelId;
  const model = state.models.find((candidate) => candidate.id === modelId);
  if (!modelId || !model) return { supported: false, label: "Önce bir çalışma modeli seçin" };
  if (!model.modalities.includes("image")) {
    return { modelId, supported: false, label: "Bu model yalnızca metin kabul ediyor" };
  }
  return { modelId, supported: true, label: "Görsel girişi destekleniyor" };
}

export function turnStatusLabel(turn: WorkspaceStateDto["turn"]): string | undefined {
  if (turn.phase === "idle") return undefined;
  if (turn.phase === "starting") return "Görev başlatılıyor…";
  if (turn.phase === "awaitingApproval") return "Onay bekleniyor…";
  if (turn.phase === "interrupting") return "Görev durduruluyor…";
  if (turn.phase === "interrupted") return "Durduruldu";
  if (turn.phase === "completed") return turn.outcome === "approvalDeclined" ? "İzin reddedildi" : "Görev tamamlandı";
  if (turn.phase === "failed") return turn.errorCode === "UPSTREAM_RATE_LIMIT" ? "EVREN hız sınırı · görev tamamlanamadı" : "Görev tamamlanamadı";
  switch (turn.activity) {
    case "sendingToEvren": return "EVREN'e istek gönderiliyor…";
    case "waitingForEvren": return "EVREN yanıtı bekleniyor…";
    case "evrenResponding": return "EVREN yanıtlıyor…";
    case "runningCommand": return "Komut çalıştırılıyor…";
    case "applyingFileChange": return "Dosya değişikliği uygulanıyor…";
    case "processingResult": return "Sonuç işleniyor…";
    default: return "Codex çalışıyor…";
  }
}

export function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function groupConversationItems(items: ConversationItemDto[]): ConversationRenderGroup[] {
  const groups: ConversationRenderGroup[] = [];
  let completedCommands: Array<ConversationItemDto & { kind: "command" }> = [];
  const flush = (): void => {
    if (completedCommands.length === 1) groups.push({ kind: "item", item: completedCommands[0]! });
    if (completedCommands.length > 1) groups.push({ kind: "completedCommands", items: completedCommands });
    completedCommands = [];
  };
  for (const item of items) {
    if (item.kind === "command" && item.status === "completed") completedCommands.push(item);
    else {
      flush();
      groups.push({ kind: "item", item });
    }
  }
  flush();
  return groups;
}
