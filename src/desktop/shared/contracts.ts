export const DESKTOP_IPC = {
  stateGet: "desktop:state:get",
  stateChanged: "desktop:state:changed",
  credentialTest: "desktop:credential:test",
  credentialSave: "desktop:credential:save",
  credentialClear: "desktop:credential:clear",
  modelSelect: "desktop:model:select",
  retryStartup: "desktop:startup:retry",
  projectOpen: "desktop:project:open",
  projectOpenRecent: "desktop:project:open-recent",
  threadList: "desktop:thread:list",
  threadStart: "desktop:thread:start",
  threadResume: "desktop:thread:resume",
  threadLoadEarlier: "desktop:thread:load-earlier",
  threadArchive: "desktop:thread:archive",
  chatSend: "desktop:chat:send",
  chatInterrupt: "desktop:chat:interrupt",
  approvalRespond: "desktop:approval:respond",
  changeDiffGet: "desktop:change:diff-get",
  changeKeep: "desktop:change:keep",
  changeRevert: "desktop:change:revert",
  attachmentChooseImage: "desktop:attachment:choose-image",
  attachmentRemovePending: "desktop:attachment:remove-pending",
  attachmentChooseProjectFile: "desktop:attachment:choose-project-file",
  historyContinue: "desktop:history:continue",
  historyPin: "desktop:history:pin",
  historyRename: "desktop:history:rename",
  historyArchive: "desktop:history:archive",
  settingsUpdate: "desktop:settings:update",
  usageApplyLimits: "desktop:usage:apply-limits",
  updatesCheck: "desktop:updates:check",
  updatesDownload: "desktop:updates:download",
  updatesInstall: "desktop:updates:install",
  runtimeUpdateInstall: "desktop:runtime-update:install",
  diagnosticsGet: "desktop:diagnostics:get",
} as const;

export type PersistenceMode = "session" | "secure";
export type DesktopStage =
  | "BOOTING"
  | "NEEDS_API_KEY"
  | "CONNECTING_EVREN"
  | "STARTING_BRIDGE"
  | "READY_NO_CODEX"
  | "STARTING_CODEX"
  | "READY"
  | "ERROR";

export interface SafeErrorDto {
  code: string;
  message: string;
  detail?: string;
}

export interface CredentialStatusDto {
  exists: boolean;
  persistence: "none" | PersistenceMode;
  securePersistenceAvailable: boolean;
}

export interface ModelPricingDto {
  mode: "free" | "paid" | "unknown" | "invalid";
  promptTokenPrice?: number;
  completionTokenPrice?: number;
  currency?: "CR";
  freeUntil?: string;
}

export interface ModelDto {
  id: string;
  task?: string;
  modalities: string[];
  ownedBy?: string;
  kind: "routing" | "chat" | "dedicated" | "unknown";
  selectable: boolean;
  synthetic: boolean;
  pricing: ModelPricingDto;
}

export interface CodexStatusDto {
  found: boolean;
  version?: string;
  testedVersion: "0.157.1";
  compatibility: "tested" | "newer-unverified" | "older" | "unknown" | "unavailable";
  ready: boolean;
  warning?: string;
}

export interface BridgeStatusDto {
  running: boolean;
  host?: "127.0.0.1";
  port?: number;
  model?: string;
  pricing?: ModelPricingDto;
  creditsRemaining?: number;
}

export interface HistoryRecordDto {
  schemaVersion: 4;
  threadId: string;
  projectPath: string;
  projectName: string;
  title: string;
  model: string;
  provider: "evren-desktop";
  createdAt: number;
  /** Last meaningful conversation activity; read-only opens must not change it. */
  updatedAt: number;
  lastOpenedAt?: number;
  pinned: boolean;
  archived: boolean;
  available: boolean;
  lastUserPreview?: string;
  lastAssistantPreview?: string;
  insights?: ConversationInsightsDto;
  changes?: ConversationChangeSummaryDto;
}

export interface ConversationInsightsDto {
  requests: number;
  inferences: number;
  toolCalls: number;
  commandCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  totalTokens: number;
  elapsedMs: number;
  commandTimeMs: number;
  packageTimeMs: number;
  testBuildTimeMs: number;
  providerWaitMs: number;
  responseParseMs: number;
  resultProcessingMs: number;
  requestSerializationMs: number;
  repeatedCommandCalls: number;
  activeContextBytes?: number;
  peakContextBytes?: number;
  replayBytes: number;
  payloadBytes: number;
  peakPayloadBytes: number;
  instructionBytes: number;
  toolCatalogBytes: number;
  toolResultBytes: number;
  sessionMetadataBytes: number;
  protocolWrapperBytes: number;
  encodedImageBytes: number;
  sourceImageBytes: number;
  peakInferenceInputTokens: number;
  inferenceReasons: InferenceReasonCountsDto;
  compactions: number;
  completedTurns: number;
  accountingCertain: boolean;
  updatedAt: number;
}

export interface InferenceReasonCountsDto {
  initialTurn: number;
  conversationContinuation: number;
  toolResult: number;
  compaction: number;
  compactionContinuation: number;
  prewarm: number;
  memory: number;
  protocolRepair: number;
  other: number;
}

export interface ConversationChangeSummaryDto {
  filesChanged: number;
  additions: number;
  deletions: number;
  created: number;
  modified: number;
  deleted: number;
  renamed: number;
  /** Git diffs are complete; non-Git totals contain only structured file activity observed from Codex. */
  coverage?: "complete" | "observed";
}

export interface UsageDto {
  available: boolean;
  sessionTokens?: number;
  sessionTokenLimit: number;
  dailyTokens?: number;
  dailyTokenLimit: number;
  requests?: number;
  requestLimit: number;
  toolCalls?: number;
  toolCallLimit: number;
  inferences?: number;
  polls?: number;
  cachedTokens?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  activeContextBytes?: number;
  peakContextBytes?: number;
  replayBytes?: number;
  payloadBytes?: number;
  peakPayloadBytes?: number;
  providerWaitMs?: number;
  responseParseMs?: number;
  resultProcessingMs?: number;
  requestSerializationMs?: number;
  compactions?: number;
  windowNumber?: number;
  accountingCertain?: boolean;
  creditSpendAccounting: "authoritative" | "unavailable";
  limitRecovery?: {
    name: "MAX_SESSION_TOKENS" | "MAX_REQUESTS_PER_SESSION" | "MAX_TOOL_CALLS_PER_SESSION";
    current: number;
    limit: number;
    recommended?: number;
    recoverable: boolean;
  };
}

export interface SafeDesktopSettingsDto {
  schemaVersion: 2;
  theme: "dark" | "light" | "navy";
  startupBehavior: "restore" | "home";
  recentProjectsEnabled: boolean;
  approvalPolicy: "on-request";
  sandboxMode: "workspace-write";
  desktopUpdateChecks: boolean;
  runtimeUpdateChecks: boolean;
  limits: {
    preset: "Standard" | "Coding" | "Custom";
    maxSessionTokens: number;
    maxDailyTokens: number;
    maxRequestsPerSession: number;
    maxToolCallsPerSession: number;
    maxSessionCredits: number;
    maxDailyCredits: number;
    minCreditsRemaining: number;
  };
}

export interface UpdateCenterDto {
  desktop: {
    installedVersion: string;
    status: "not_checked" | "checking" | "downloading" | "downloaded" | "unpublished" | "error" | "disabled" | "up_to_date" | "update_available" | "local_newer" | "offline" | "timeout" | "rate_limited" | "http_error" | "malformed_response" | "invalid_tag";
    availableVersion?: string;
    checkedAt?: string;
    progressPercent?: number;
    releaseNotes?: string;
    technicalCode?: string;
    signed: boolean;
  };
  runtime: {
    installedVersion?: string;
    testedVersion: "0.157.1";
    source: "bundled" | "verified-update" | "system" | "unavailable";
    status: "not_checked" | "checking" | "up_to_date" | "update_available" | "downloading" | "validating" | "installing" | "restart_required" | "offline" | "not_configured" | "source_unavailable" | "blocked_active_turn" | "error";
    verifiedVersion?: string;
    upstreamVersion?: string;
    error?: string;
  };
}

export interface EvrenConnectionDto {
  status: "not_checked" | "connecting" | "connected" | "error";
  error?: SafeErrorDto;
}

export interface ProjectDto {
  path: string;
  name: string;
  exists: boolean;
}

export type ThreadStateDto = "notLoaded" | "idle" | "active" | "systemError";

export interface ThreadSummaryDto {
  id: string;
  name?: string;
  preview: string;
  cwd: string;
  model: string;
  modelProvider: "evren-desktop";
  updatedAt: number;
  state: ThreadStateDto;
}

export type TurnPhaseDto = "idle" | "starting" | "running" | "awaitingApproval" | "interrupting" | "interrupted" | "completed" | "failed";
export type TurnOutcomeDto = "success" | "failed" | "interrupted" | "approvalDeclined";
export type TurnActivityDto =
  | "codexOrchestration"
  | "sendingToEvren"
  | "waitingForEvren"
  | "evrenResponding"
  | "runningCommand"
  | "applyingFileChange"
  | "processingResult";
export type ActivityStatusDto = "running" | "completed" | "failed" | "declined";

export interface ModelRouteDto {
  threadId: string;
  turnId?: string;
  desktopSelectedModel: string;
  codexRequestedModel: string;
  bridgeEffectiveModel: string;
  upstreamEffectiveModel?: string;
  providerId: "evren-desktop";
  status: "configured" | "pending" | "verified" | "mismatch";
  inferenceNumber?: number;
  observedAt?: number;
}

interface ConversationItemBaseDto {
  id: string;
  turnId: string;
  status: ActivityStatusDto;
}

export type ConversationItemDto =
  | ConversationItemBaseDto & { kind: "userMessage"; text: string; attachments: string[] }
  | ConversationItemBaseDto & { kind: "assistantMessage"; text: string }
  | ConversationItemBaseDto & {
    kind: "command";
    command: string;
    cwd: string;
    output?: string;
    outputTruncated?: boolean;
    exitCode?: number;
    durationMs?: number;
  }
  | ConversationItemBaseDto & {
    kind: "fileChange";
    changes: Array<{ path: string; action: "added" | "modified" | "deleted"; diff?: string }>;
  }
  | ConversationItemBaseDto & { kind: "diff"; diff: string; truncated: boolean }
  | ConversationItemBaseDto & {
    kind: "plan";
    explanation?: string;
    steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  }
  | ConversationItemBaseDto & { kind: "tool"; label: string; detail?: string }
  | ConversationItemBaseDto & { kind: "status"; message: string; tone: "info" | "warning" | "error" };

export type ApprovalDecisionDto = "accept" | "acceptForSession" | "decline";

export interface ApprovalRequestDto {
  id: string;
  type: "command" | "fileChange";
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  availableDecisions: ApprovalDecisionDto[];
  context: string[];
  createdAt: number;
}

export interface SessionPermissionDto {
  id: string;
  threadId: string;
  type: "command" | "fileChange";
  scope: string;
  detail?: string;
  grantedAt: number;
  revocable: false;
  revokeReason: string;
}

export interface PermissionActivityDto {
  id: string;
  threadId: string;
  type: "approvedOnce" | "approvedForSession" | "declined" | "expired" | "cancelled";
  operation: "command" | "fileChange";
  summary: string;
  occurredAt: number;
}

export interface PermissionCenterDto {
  grants: SessionPermissionDto[];
  history: PermissionActivityDto[];
  supportsRevocation: false;
  revocationReason: string;
}

export type ChangeFileStatusDto = "added" | "modified" | "deleted" | "renamed";

export interface ChangeFileDto {
  id: string;
  path: string;
  previousPath?: string;
  status: ChangeFileStatusDto;
  additions: number;
  deletions: number;
  binary: boolean;
  diffPreview?: string;
  diffTruncated: boolean;
  reviewState: "pending" | "kept";
  canRevert: boolean;
  revertBlockedReason?: string;
}

export interface ChangeReviewDto extends ConversationChangeSummaryDto {
  phase: "idle" | "tracking" | "ready" | "nonGit" | "error";
  turnId?: string;
  git: boolean;
  baselineDirty: boolean;
  branch?: string;
  head?: string;
  files: ChangeFileDto[];
  updatedAt?: number;
  message?: string;
}

export interface ChangeDiffDto {
  changeId: string;
  path: string;
  previousPath?: string;
  status: ChangeFileStatusDto;
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
  truncated: boolean;
}

export interface WorkspaceStateDto {
  activeProject?: ProjectDto;
  recentProjects: ProjectDto[];
  threads: ThreadSummaryDto[];
  draftActive: boolean;
  selectedThreadId?: string;
  selectedThreadModel?: string;
  items: ConversationItemDto[];
  historyCursor?: string;
  turn: {
    phase: TurnPhaseDto;
    id?: string;
    activity?: TurnActivityDto;
    outcome?: TurnOutcomeDto;
    errorCode?: string;
    startedAt?: number;
    completedAt?: number;
  };
  modelRoutes: ModelRouteDto[];
  approvals: ApprovalRequestDto[];
  permissions: PermissionCenterDto;
  changeReview: ChangeReviewDto;
  conversationInsights?: ConversationInsightsDto;
  pendingAttachment?: ImageAttachmentDto;
  error?: SafeErrorDto;
}

export interface ImageAttachmentDto {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ProjectFileReferenceDto {
  name: string;
  relativePath: string;
}

export interface DesktopStateDto {
  stage: DesktopStage;
  version: string;
  credential: CredentialStatusDto;
  evren: EvrenConnectionDto;
  models: ModelDto[];
  selectedModelId?: string;
  savedModelUnavailable?: string;
  bridge: BridgeStatusDto;
  codex: CodexStatusDto;
  workspace: WorkspaceStateDto;
  history: HistoryRecordDto[];
  usage: UsageDto;
  settings: SafeDesktopSettingsDto;
  updates: UpdateCenterDto;
  error?: SafeErrorDto;
}

export interface CredentialInput {
  apiKey: string;
  persistence: PersistenceMode;
}

export interface ModelSelectionInput {
  modelId: string;
}

export interface ProjectPathInput { path: string }
export interface ThreadInput { threadId: string }
export interface ChatSendInput {
  threadId?: string;
  text: string;
  attachmentIds: string[];
  clientUserMessageId: string;
}
export interface ChatInterruptInput { threadId: string; turnId: string }
export interface ApprovalResponseInput {
  approvalId: string;
  threadId: string;
  decision: ApprovalDecisionDto;
}
export interface ChangeReviewInput { changeId: string }
export interface HistoryThreadInput { threadId: string }
export interface HistoryPinInput { threadId: string; pinned: boolean }
export interface HistoryRenameInput { threadId: string; title: string }
export interface HistoryArchiveInput { threadId: string; archived: boolean }
export interface DesktopSettingsUpdateInput {
  theme?: "dark" | "light" | "navy";
  startupBehavior?: "restore" | "home";
  recentProjectsEnabled?: boolean;
  desktopUpdateChecks?: boolean;
  runtimeUpdateChecks?: boolean;
}
export interface UsageLimitsInput {
  preset: "Standard" | "Coding" | "Custom";
  maxSessionTokens: number;
  maxDailyTokens: number;
  maxRequestsPerSession: number;
  maxToolCallsPerSession: number;
  maxSessionCredits: number;
  maxDailyCredits: number;
  minCreditsRemaining: number;
}

export interface DesktopApi {
  state: {
    get(): Promise<DesktopStateDto>;
    subscribe(listener: (state: DesktopStateDto) => void): () => void;
  };
  credentials: {
    test(input: { apiKey: string }): Promise<{ ok: true; models: ModelDto[] } | { ok: false; error: SafeErrorDto }>;
    save(input: CredentialInput): Promise<DesktopStateDto>;
    clear(): Promise<DesktopStateDto>;
  };
  models: {
    select(input: ModelSelectionInput): Promise<DesktopStateDto>;
  };
  startup: {
    retry(): Promise<DesktopStateDto>;
  };
  projects: {
    openFolder(): Promise<DesktopStateDto>;
    openRecent(input: ProjectPathInput): Promise<DesktopStateDto>;
    chooseFile(): Promise<ProjectFileReferenceDto | undefined>;
  };
  threads: {
    list(): Promise<DesktopStateDto>;
    start(): Promise<DesktopStateDto>;
    resume(input: ThreadInput): Promise<DesktopStateDto>;
    loadEarlier(input: ThreadInput): Promise<DesktopStateDto>;
    archive(input: ThreadInput): Promise<DesktopStateDto>;
  };
  chat: {
    send(input: ChatSendInput): Promise<DesktopStateDto>;
    interrupt(input: ChatInterruptInput): Promise<DesktopStateDto>;
  };
  approvals: {
    respond(input: ApprovalResponseInput): Promise<DesktopStateDto>;
  };
  changes: {
    getDiff(input: ChangeReviewInput): Promise<ChangeDiffDto>;
    keep(input: ChangeReviewInput): Promise<DesktopStateDto>;
    revert(input: ChangeReviewInput): Promise<DesktopStateDto>;
  };
  attachments: {
    chooseImage(): Promise<ImageAttachmentDto | undefined>;
    removePending(): Promise<DesktopStateDto>;
  };
  history: {
    continue(input: HistoryThreadInput): Promise<DesktopStateDto>;
    pin(input: HistoryPinInput): Promise<DesktopStateDto>;
    rename(input: HistoryRenameInput): Promise<DesktopStateDto>;
    archive(input: HistoryArchiveInput): Promise<DesktopStateDto>;
  };
  settings: {
    update(input: DesktopSettingsUpdateInput): Promise<DesktopStateDto>;
  };
  usage: {
    applyLimits(input: UsageLimitsInput): Promise<DesktopStateDto>;
  };
  updates: {
    check(): Promise<DesktopStateDto>;
    download(): Promise<DesktopStateDto>;
    install(): Promise<void>;
    installRuntime(): Promise<DesktopStateDto>;
  };
  diagnostics: {
    get(): Promise<string>;
  };
}

export function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateCredentialInput(value: unknown): CredentialInput {
  if (!isExactRecord(value, ["apiKey", "persistence"])) throw new Error("invalid_credential_input");
  const apiKey = value.apiKey;
  const persistence = value.persistence;
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 10_000) {
    throw new Error("invalid_api_key");
  }
  if (persistence !== "session" && persistence !== "secure") throw new Error("invalid_persistence_mode");
  return { apiKey: apiKey.trim(), persistence };
}

export function validateApiKeyTestInput(value: unknown): { apiKey: string } {
  if (!isExactRecord(value, ["apiKey"])) throw new Error("invalid_api_key_input");
  if (typeof value.apiKey !== "string" || !value.apiKey.trim() || value.apiKey.length > 10_000) {
    throw new Error("invalid_api_key");
  }
  return { apiKey: value.apiKey.trim() };
}

export function validateModelSelectionInput(value: unknown): ModelSelectionInput {
  if (!isExactRecord(value, ["modelId"])) throw new Error("invalid_model_selection");
  if (typeof value.modelId !== "string" || !value.modelId.trim() || value.modelId.length > 200) {
    throw new Error("invalid_model_selection");
  }
  return { modelId: value.modelId.trim() };
}

export function validateProjectPathInput(value: unknown): ProjectPathInput {
  if (!isExactRecord(value, ["path"]) || typeof value.path !== "string") throw new Error("invalid_project_path");
  const projectPath = value.path.trim();
  if (!projectPath || projectPath.length > 32_000 || /[\u0000-\u001f\u007f]/.test(projectPath)) {
    throw new Error("invalid_project_path");
  }
  return { path: projectPath };
}

export function validateThreadInput(value: unknown): ThreadInput {
  if (!isExactRecord(value, ["threadId"])) throw new Error("invalid_thread_input");
  return { threadId: validateOpaqueId(value.threadId, "invalid_thread_input") };
}

export function validateChatSendInput(value: unknown): ChatSendInput {
  const exactDraftInput = isExactRecord(value, ["text", "attachmentIds", "clientUserMessageId"]);
  const exactThreadInput = isExactRecord(value, ["threadId", "text", "attachmentIds", "clientUserMessageId"]);
  if (!exactDraftInput && !exactThreadInput) {
    throw new Error("invalid_chat_input");
  }
  const threadId = value.threadId === undefined
    ? undefined
    : validateOpaqueId(value.threadId, "invalid_chat_input");
  const clientUserMessageId = validateOpaqueId(value.clientUserMessageId, "invalid_chat_input");
  if (typeof value.text !== "string" || value.text.length > 100_000) throw new Error("invalid_chat_input");
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 8) throw new Error("invalid_chat_input");
  const attachmentIds = value.attachmentIds.map((id) => validateOpaqueId(id, "invalid_chat_input"));
  if (!value.text.trim() && attachmentIds.length === 0) throw new Error("empty_chat_input");
  return { ...(threadId === undefined ? {} : { threadId }), text: value.text, attachmentIds, clientUserMessageId };
}

export function validateChatInterruptInput(value: unknown): ChatInterruptInput {
  if (!isExactRecord(value, ["threadId", "turnId"])) throw new Error("invalid_interrupt_input");
  return {
    threadId: validateOpaqueId(value.threadId, "invalid_interrupt_input"),
    turnId: validateOpaqueId(value.turnId, "invalid_interrupt_input"),
  };
}

export function validateApprovalResponseInput(value: unknown): ApprovalResponseInput {
  if (!isExactRecord(value, ["approvalId", "threadId", "decision"])) throw new Error("invalid_approval_input");
  if (value.decision !== "accept" && value.decision !== "acceptForSession" && value.decision !== "decline") {
    throw new Error("invalid_approval_decision");
  }
  return {
    approvalId: validateOpaqueId(value.approvalId, "invalid_approval_input"),
    threadId: validateOpaqueId(value.threadId, "invalid_approval_input"),
    decision: value.decision,
  };
}

export function validateChangeReviewInput(value: unknown): ChangeReviewInput {
  if (!isExactRecord(value, ["changeId"])) throw new Error("invalid_change_review_input");
  return { changeId: validateOpaqueId(value.changeId, "invalid_change_review_input") };
}

export function validateHistoryPinInput(value: unknown): HistoryPinInput {
  if (!isExactRecord(value, ["threadId", "pinned"]) || typeof value.pinned !== "boolean") throw new Error("invalid_history_pin");
  return { threadId: validateOpaqueId(value.threadId, "invalid_history_pin"), pinned: value.pinned };
}

export function validateHistoryRenameInput(value: unknown): HistoryRenameInput {
  if (!isExactRecord(value, ["threadId", "title"]) || typeof value.title !== "string") throw new Error("invalid_history_rename");
  const title = value.title.trim();
  if (!title || title.length > 300 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("invalid_history_rename");
  return { threadId: validateOpaqueId(value.threadId, "invalid_history_rename"), title };
}

export function validateHistoryArchiveInput(value: unknown): HistoryArchiveInput {
  if (!isExactRecord(value, ["threadId", "archived"]) || typeof value.archived !== "boolean") throw new Error("invalid_history_archive");
  return { threadId: validateOpaqueId(value.threadId, "invalid_history_archive"), archived: value.archived };
}

export function validateDesktopSettingsUpdateInput(value: unknown): DesktopSettingsUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_settings_update");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["theme", "startupBehavior", "recentProjectsEnabled", "desktopUpdateChecks", "runtimeUpdateChecks"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("invalid_settings_update");
  if (record.theme !== undefined && record.theme !== "dark" && record.theme !== "light" && record.theme !== "navy") throw new Error("invalid_settings_update");
  if (record.startupBehavior !== undefined && record.startupBehavior !== "restore" && record.startupBehavior !== "home") throw new Error("invalid_settings_update");
  for (const key of ["recentProjectsEnabled", "desktopUpdateChecks", "runtimeUpdateChecks"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") throw new Error("invalid_settings_update");
  }
  return record as DesktopSettingsUpdateInput;
}

export function validateUsageLimitsInput(value: unknown): UsageLimitsInput {
  const keys = ["preset", "maxSessionTokens", "maxDailyTokens", "maxRequestsPerSession", "maxToolCallsPerSession", "maxSessionCredits", "maxDailyCredits", "minCreditsRemaining"] as const;
  if (!isExactRecord(value, keys)) throw new Error("invalid_usage_limits");
  if (value.preset !== "Standard" && value.preset !== "Coding" && value.preset !== "Custom") throw new Error("invalid_usage_limits");
  for (const key of ["maxSessionTokens", "maxDailyTokens", "maxRequestsPerSession", "maxToolCallsPerSession"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0) throw new Error("invalid_usage_limits");
  }
  for (const key of ["maxSessionCredits", "maxDailyCredits", "minCreditsRemaining"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0) throw new Error("invalid_usage_limits");
  }
  return value as unknown as UsageLimitsInput;
}

function validateOpaqueId(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const id = value.trim();
  if (!id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error(code);
  return id;
}
