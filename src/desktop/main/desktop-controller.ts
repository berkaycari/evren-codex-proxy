import { createHash } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../../config.js";
import { createBridgeRuntime, type BridgeRuntime, type BridgeRuntimeSnapshot } from "../../runtime/bridge-runtime.js";
import type { BridgeConfig } from "../../config.js";
import { generateLocalBridgeToken } from "../../runtime/local-auth.js";
import type {
  ApprovalResponseInput,
  ChangeDiffDto,
  ChangeReviewInput,
  ChatInterruptInput,
  ChatSendInput,
  CodexStatusDto,
  CredentialInput,
  DesktopStateDto,
  ImageAttachmentDto,
  InferenceReasonCountsDto,
  ModelRouteDto,
  ModelDto,
  ModelSelectionInput,
  ProjectFileReferenceDto,
  SafeErrorDto,
  ThreadInput,
  ThreadSummaryDto,
  TurnActivityDto,
  WorkspaceStateDto,
  DesktopSettingsUpdateInput,
  HistoryArchiveInput,
  HistoryPinInput,
  HistoryRenameInput,
  UsageDto,
  UsageLimitsInput,
} from "../shared/contracts.js";
import { AttachmentService, MAX_IMAGE_BYTES } from "./attachment-service.js";
import type { DesktopAppUpdateService, DesktopAppUpdateSnapshot } from "./app-update-service.js";
import { CodexApprovalService } from "./codex-approval-service.js";
import { CodexAppServerManager } from "./codex-app-server.js";
import { CodexEventProjector } from "./codex-event-projector.js";
import { buildCodexLaunchSpec, DESKTOP_PROVIDER_ID } from "./codex-launch.js";
import { CodexThreadService, CodexTurnService, type ResumedThread, type TurnUserInput } from "./codex-services.js";
import { detectCodex, TESTED_CODEX_VERSION } from "./codex-version.js";
import { CredentialService } from "./credential-service.js";
import { chooseInitialModel, EvrenCatalogService, ModelCatalogError } from "./model-catalog.js";
import { ProjectService } from "./project-service.js";
import { ChangeReviewService } from "./change-review-service.js";
import { DesktopHistoryStore, type ConversationProviderSnapshot } from "./history-service.js";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./runtime-resolver.js";
import { assertRuntimeUpdateIdle, type RuntimeUpdateService, type RuntimeUpdateSnapshot } from "./runtime-update.js";
import { DesktopSettingsStore, safeDesktopSettings, type DesktopSettings, type WindowBoundsSetting } from "./settings-service.js";

export interface DesktopControllerOptions {
  version: string;
  userDataDir: string;
  cwd: string;
  credentialService: CredentialService;
  settingsStore: DesktopSettingsStore;
  catalogService?: EvrenCatalogService;
  detectCodex?: typeof detectCodex;
  createRuntime?: typeof createBridgeRuntime;
  createCodexManager?: (onExit: () => void) => CodexAppServerManager;
  projectService?: ProjectService;
  attachmentService?: AttachmentService;
  pickProject?: () => Promise<string | undefined>;
  pickImage?: () => Promise<string | undefined>;
  pickProjectFile?: (projectRoot: string) => Promise<string | undefined>;
  historyStore?: DesktopHistoryStore;
  changeReviewService?: ChangeReviewService;
  appPackaged?: boolean;
  resourcesPath?: string;
  resolveRuntime?: () => Promise<ResolvedCodexRuntime>;
  appUpdater?: DesktopAppUpdateService;
  runtimeUpdater?: RuntimeUpdateService;
}

export class DesktopController {
  private settings: DesktopSettings = {};
  private runtime: BridgeRuntime | undefined;
  private codex: CodexAppServerManager | undefined;
  private threadService: CodexThreadService | undefined;
  private turnService: CodexTurnService | undefined;
  private approvalService: CodexApprovalService | undefined;
  private localBridgeToken: string | undefined;
  private activeBridgeModel: string | undefined;
  private readonly projector = new CodexEventProjector();
  private readonly projectService: ProjectService;
  private readonly attachmentService: AttachmentService;
  private readonly historyStore: DesktopHistoryStore;
  private readonly changeReviewService: ChangeReviewService;
  private readonly listeners = new Set<(state: DesktopStateDto) => void>();
  private readonly locallyStartedThreads = new Map<string, ThreadSummaryDto>();
  private readonly modelRoutesByThread = new Map<string, ModelRouteDto[]>();
  private readonly terminalTurnErrors = new Map<string, SafeErrorDto>();
  private readonly declinedApprovalTurns = new Set<string>();
  private readonly protocolUnsubscribers: Array<() => void> = [];
  private operation: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private threadStartInFlight = false;
  private emitTimer: NodeJS.Timeout | undefined;
  private changeRefreshTimer: NodeJS.Timeout | undefined;
  private conversationUsageTimer: NodeJS.Timeout | undefined;
  private pendingConversationUsage: { threadId: string; snapshot: ConversationProviderSnapshot } | undefined;
  private runtimeUnsubscribe: (() => void) | undefined;
  private appUpdaterUnsubscribe: (() => void) | undefined;
  private codexExecutable = "codex";
  private state: DesktopStateDto;

  constructor(private readonly options: DesktopControllerOptions) {
    this.projectService = options.projectService ?? new ProjectService();
    this.attachmentService = options.attachmentService ?? new AttachmentService();
    this.historyStore = options.historyStore ?? new DesktopHistoryStore(path.join(options.userDataDir, "history"));
    this.changeReviewService = options.changeReviewService ?? new ChangeReviewService();
    const config = loadConfig();
    const defaultLimits = limitsFromConfig(config, "Standard");
    this.state = {
      stage: "BOOTING",
      version: options.version,
      credential: { exists: false, persistence: "none", securePersistenceAvailable: false },
      evren: { status: "not_checked" },
      models: [],
      bridge: { running: false },
      codex: unavailableCodexStatus(),
      workspace: emptyWorkspace(),
      history: [],
      usage: emptyUsage(config),
      settings: safeDesktopSettings({}, defaultLimits),
      updates: {
        desktop: { installedVersion: options.version, status: "not_checked", signed: false },
        runtime: { testedVersion: TESTED_CODEX_VERSION, source: "unavailable", status: "not_checked" },
      },
    };
    if (options.appUpdater) {
      this.applyAppUpdateSnapshot(options.appUpdater.snapshot());
      this.appUpdaterUnsubscribe = options.appUpdater.subscribe((snapshot) => {
        this.applyAppUpdateSnapshot(snapshot);
        this.scheduleEmit();
      });
    }
    if (options.runtimeUpdater) this.applyRuntimeUpdateSnapshot(options.runtimeUpdater.snapshot());
  }

  async initialize(): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.settings = await this.options.settingsStore.load();
      this.state.history = await this.historyStore.load();
      const config = applyStoredLimits(loadConfig(), this.settings.limits);
      this.state.usage = emptyUsage(config);
      this.state.settings = safeDesktopSettings(this.settings, limitsFromConfig(config, this.settings.limits?.preset ?? "Custom"));
      this.state.workspace.recentProjects = this.settings.recentProjectsEnabled === false
        ? [] : await this.projectService.describeRecent(this.settings.recentProjects ?? []);
      if (this.settings.startupBehavior !== "home" && this.settings.lastActiveProject) {
        try {
          this.state.workspace.activeProject = await this.projectService.open(this.settings.lastActiveProject);
        } catch {
          delete this.state.workspace.activeProject;
        }
      }
      this.state.credential = await this.options.credentialService.getStatus();
      if (!this.state.credential.exists) {
        this.setState({ stage: "NEEDS_API_KEY" });
        return;
      }
      await this.startServices();
      await this.restoreWorkspace();
    });
    return this.getState();
  }

  getState(): DesktopStateDto {
    return structuredClone(this.state);
  }

  subscribe(listener: (state: DesktopStateDto) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async testCredential(apiKey: string): Promise<{ ok: true; models: ModelDto[] } | { ok: false; error: SafeErrorDto }> {
    try {
      const catalog = await this.catalogService().load(apiKey);
      return { ok: true, models: catalog.models };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async saveCredential(input: CredentialInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const test = await this.testCredential(input.apiKey);
      if (!test.ok) {
        this.setState({ stage: "ERROR", evren: { status: "error", error: test.error }, error: test.error });
        return;
      }
      await this.options.credentialService.setCredential(input.apiKey, input.persistence);
      this.state.credential = await this.options.credentialService.getStatus();
      await this.startServices(test.models);
      await this.restoreWorkspace();
    });
    return this.getState();
  }

  async clearCredential(): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      await this.stopServices();
      this.attachmentService.clear();
      await this.options.credentialService.clearCredential();
      this.state = {
        ...this.state,
        stage: "NEEDS_API_KEY",
        credential: await this.options.credentialService.getStatus(),
        evren: { status: "not_checked" },
        models: [],
        bridge: { running: false },
        codex: unavailableCodexStatus(),
        workspace: {
          ...this.state.workspace,
          items: [],
          approvals: [],
          permissions: emptyPermissionCenter(),
          changeReview: this.changeReviewService.clear(),
          turn: { phase: "idle" },
        },
      };
      delete this.state.selectedModelId;
      delete this.state.savedModelUnavailable;
      delete this.state.error;
      this.emit();
    });
    return this.getState();
  }

  async selectModel(input: ModelSelectionInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const model = this.state.models.find((candidate) => candidate.id === input.modelId);
      if (!model?.selectable) throw desktopError("MODEL_NOT_SELECTABLE", "Bu model Codex ajanı için seçilemez.");
      const appliesToNewThread = Boolean(
        this.state.workspace.selectedThreadId && this.state.workspace.selectedThreadModel !== model.id,
      );
      this.settings = { ...this.settings, selectedModelId: model.id };
      await this.options.settingsStore.save(this.settings);
      this.setState({ selectedModelId: model.id });
      delete this.state.savedModelUnavailable;
      if (!appliesToNewThread) await this.ensureServicesForModel(model.id);
    });
    return this.getState();
  }

  async retry(): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.state.credential = await this.options.credentialService.getStatus();
      if (!this.state.credential.exists) {
        this.setState({ stage: "NEEDS_API_KEY" });
        return;
      }
      await this.startServices(this.state.models, this.state.workspace.selectedThreadModel ?? this.state.selectedModelId);
      await this.restoreWorkspace();
    });
    return this.getState();
  }

  async openProject(): Promise<DesktopStateDto> {
    const selected = await this.options.pickProject?.();
    if (!selected) return this.getState();
    return this.openProjectPath(selected);
  }

  async openRecentProject(projectPath: string): Promise<DesktopStateDto> {
    return this.openProjectPath(projectPath);
  }

  async listThreads(): Promise<DesktopStateDto> {
    await this.enqueue(() => this.refreshThreads());
    return this.getState();
  }

  async startThread(): Promise<DesktopStateDto> {
    if (this.threadStartInFlight) throw desktopError("THREAD_START_IN_PROGRESS", "Yeni sohbet zaten başlatılıyor.");
    this.threadStartInFlight = true;
    try {
      await this.enqueue(async () => {
        const project = this.requireProject();
        this.requireSelectedModel();
        if (isBusyPhase(this.state.workspace.turn.phase)) {
          throw desktopError("TURN_ACTIVE", "Etkin işlem tamamlanmadan yeni sohbet açılamaz.");
        }
        this.approvalService?.clearThread(this.state.workspace.selectedThreadId ?? "", true);
        this.attachmentService.clear();
        this.projector.reset(undefined, project.path);
        this.state.workspace.changeReview = this.changeReviewService.clear();
        this.state.workspace = {
          ...this.state.workspace,
          draftActive: true,
          items: [],
          turn: { phase: "idle" },
          modelRoutes: [],
          approvals: [],
          changeReview: this.state.workspace.changeReview,
        };
        delete this.state.workspace.selectedThreadId;
        delete this.state.workspace.selectedThreadModel;
        delete this.state.workspace.historyCursor;
        delete this.state.workspace.pendingAttachment;
        delete this.state.workspace.error;
        delete this.state.workspace.conversationInsights;
        delete this.settings.lastSelectedThreadId;
        await this.options.settingsStore.save(this.settings);
        this.emit();
      });
    } finally {
      this.threadStartInFlight = false;
    }
    return this.getState();
  }

  async resumeThread(input: ThreadInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => this.resumeThreadInternal(input.threadId));
    return this.getState();
  }

  async loadEarlier(input: ThreadInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      if (this.state.workspace.selectedThreadId !== input.threadId) throw desktopError("THREAD_SCOPE_MISMATCH", "Sohbet seçimi değişti.");
      const cursor = this.state.workspace.historyCursor;
      if (!cursor) return;
      const project = this.requireProject();
      const page = await this.requireThreadService().history(input.threadId, project.path, cursor);
      this.projector.prepend(page.items);
      this.state.workspace.items = this.projector.snapshot();
      if (page.nextCursor) this.state.workspace.historyCursor = page.nextCursor;
      else delete this.state.workspace.historyCursor;
      this.emit();
    });
    return this.getState();
  }

  async archiveThread(input: ThreadInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      await this.archiveThreadAuthoritative(input.threadId);
      await this.historyStore.setArchived(input.threadId, true).catch(() => undefined);
      this.state.history = this.historyStore.snapshot();
    });
    return this.getState();
  }

  async sendChat(input: ChatSendInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const project = this.requireProject();
      const draft = this.state.workspace.draftActive;
      if (draft && input.threadId !== undefined) {
        throw desktopError("THREAD_SCOPE_MISMATCH", "Yeni sohbet taslağı eski bir sohbet kimliğiyle gönderilemez.");
      }
      let thread = draft ? undefined : this.requireSelectedThread(input.threadId ?? "");
      const selectedModel = draft ? this.requireSelectedModel() : undefined;
      if (selectedModel) await this.ensureServicesForModel(selectedModel.id);
      const runtimeSnapshot = this.runtime && typeof this.runtime.snapshot === "function" ? this.runtime.snapshot() : undefined;
      if (runtimeSnapshot && runtimeSnapshot.status !== "running") {
        this.state.bridge = { running: false };
        this.activeBridgeModel = undefined;
      }
      const expectedModel = thread?.model ?? selectedModel!.id;
      if (!this.state.bridge.running || !this.state.codex.ready || this.activeBridgeModel !== expectedModel) {
        throw desktopError("BRIDGE_MODEL_MISMATCH", "Bridge, Codex ve sohbet modeli eşleşmiyor; yeniden deneyin.");
      }
      let createdForDraft = false;
      try {
        const images = await this.attachmentService.resolve(input.attachmentIds);
        if (images.length > 0) {
          if (images.reduce((total, image) => total + image.sizeBytes, 0) > MAX_IMAGE_BYTES) {
            throw desktopError("IMAGE_TOTAL_SIZE_INVALID", "Görsel eklerinin toplam boyutu 20 MB'yi geçemez.");
          }
          const model = this.state.models.find((candidate) => candidate.id === expectedModel);
          if (!model?.modalities.includes("image")) {
            throw desktopError("MODEL_IMAGE_UNSUPPORTED", "Seçili model görsel girdiyi desteklediğini bildirmiyor.");
          }
        }
        const userInput: TurnUserInput[] = [];
        if (input.text.trim()) userInput.push({ type: "text", text: input.text, text_elements: [] });
        userInput.push(...images.map((image) => ({ type: "localImage" as const, path: image.path })));
        this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "starting");
        this.terminalTurnErrors.clear();
        this.declinedApprovalTurns.clear();
        delete this.state.workspace.error;
        this.emit();
        if (!thread) {
          const bridgeModel = this.effectiveBridgeModel();
          if (bridgeModel !== expectedModel) {
            this.logThreadConsistency("thread_start_blocked", {
              selectedModelId: expectedModel,
              bridgeModelId: bridgeModel,
              requestedModelId: expectedModel,
              expectedProviderId: DESKTOP_PROVIDER_ID,
            });
            throw desktopError("BRIDGE_MODEL_MISMATCH", "Bridge, Codex ve seçili model eşleşmiyor; yeni sohbet başlatılmadı.");
          }
          thread = await this.requireThreadService().start(project.path, expectedModel, bridgeModel);
          createdForDraft = true;
          this.locallyStartedThreads.set(thread.id, thread);
          this.projector.reset(thread.id, project.path);
          this.state.workspace = {
            ...this.state.workspace,
            draftActive: false,
            threads: upsertThread(this.state.workspace.threads, thread),
            selectedThreadId: thread.id,
            selectedThreadModel: thread.model,
            items: [],
            modelRoutes: [],
          };
          this.recordConfiguredModelRoute(thread, bridgeModel);
        }
        this.cancelChangeRefresh();
        try {
          this.state.workspace.changeReview = await this.changeReviewService.begin(project.path);
        } catch {
          this.changeReviewService.clear();
          this.state.workspace.changeReview = failedChangeReview("Çalışma ağacı başlangıç durumu alınamadı; otomatik geri alma devre dışı.");
        }
        const turnId = await this.requireTurnService().start(
          thread.id,
          userInput,
          input.clientUserMessageId,
          thread.model,
        );
        if (!createdForDraft) {
          await this.historyStore.markMeaningfulActivity(thread.id);
          this.state.history = this.historyStore.snapshot();
        }
        if (this.state.workspace.changeReview.phase !== "error") {
          this.state.workspace.changeReview = this.changeReviewService.attachTurn(turnId);
        }
        this.recordPendingTurnModelRoute(thread, turnId);
        const latestRuntimeSnapshot = this.runtime && typeof this.runtime.snapshot === "function"
          ? this.runtime.snapshot()
          : undefined;
        if (latestRuntimeSnapshot?.upstreamModelObservations) {
          this.applyUpstreamModelObservations(latestRuntimeSnapshot.upstreamModelObservations);
        }
        this.attachmentService.remove(input.attachmentIds);
        delete this.state.workspace.pendingAttachment;
        this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "running", turnId, "codexOrchestration");
        if (createdForDraft) {
          this.settings = { ...this.settings, lastSelectedThreadId: thread.id };
          await this.options.settingsStore.save(this.settings);
          await this.historyStore.upsertThread(thread, project.name, { available: true, items: [] });
          this.state.history = this.historyStore.snapshot();
        }
      } catch (error) {
        this.state.workspace.changeReview = this.changeReviewService.clear();
        if (createdForDraft && thread) {
          await this.requireThreadService().archive(thread.id).catch(() => undefined);
          this.locallyStartedThreads.delete(thread.id);
          this.modelRoutesByThread.delete(thread.id);
          this.projector.reset(undefined, project.path);
          this.state.workspace = {
            ...this.state.workspace,
            draftActive: true,
            threads: this.state.workspace.threads.filter((candidate) => candidate.id !== thread!.id),
            items: [],
            approvals: [],
            modelRoutes: [],
          };
          delete this.state.workspace.selectedThreadId;
          delete this.state.workspace.selectedThreadModel;
          delete this.settings.lastSelectedThreadId;
        }
        this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "failed");
        const safe = safeError(error);
        this.state.workspace.error = safe;
        throw desktopError(safe.code, safe.message);
      } finally {
        this.emit();
      }
    });
    return this.getState();
  }

  async interruptChat(input: ChatInterruptInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.requireSelectedThread(input.threadId);
      if (this.state.workspace.turn.id !== input.turnId) throw desktopError("TURN_NOT_ACTIVE", "Etkin işlem artık bulunamadı.");
      this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "interrupting", input.turnId);
      this.approvalService?.clearTurn(input.threadId, input.turnId, true);
      this.emit();
      await this.requireTurnService().interrupt(input.threadId, input.turnId);
      this.requireTurnService().noteCompleted(input.threadId, input.turnId);
      this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "interrupted", input.turnId);
      await this.finalizeTurn(input.threadId, input.turnId);
      this.emit();
    });
    return this.getState();
  }

  async respondApproval(input: ApprovalResponseInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      if (input.decision === "decline" && this.state.workspace.turn.id) {
        this.declinedApprovalTurns.add(this.state.workspace.turn.id);
      }
      this.approvalService?.respond(input, this.state.workspace.selectedThreadId);
      if (this.state.workspace.approvals.length === 0 && this.state.workspace.turn.id) {
        this.state.workspace.turn = transitionTurn(
          this.state.workspace.turn,
          "running",
          this.state.workspace.turn.id,
          "processingResult",
        );
      }
      this.emit();
    });
    return this.getState();
  }

  getChangeDiff(input: ChangeReviewInput): ChangeDiffDto {
    return this.changeReviewService.getDiff(input.changeId);
  }

  async keepChange(input: ChangeReviewInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.state.workspace.changeReview = this.changeReviewService.keep(input.changeId);
      this.emit();
    });
    return this.getState();
  }

  async revertChange(input: ChangeReviewInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.state.workspace.changeReview = await this.changeReviewService.revert(input.changeId);
      this.emit();
    });
    return this.getState();
  }

  async chooseImage(): Promise<ImageAttachmentDto | undefined> {
    const filePath = await this.options.pickImage?.();
    if (!filePath) return undefined;
    const attachment = await this.attachmentService.addImage(filePath);
    this.state.workspace.pendingAttachment = attachment;
    this.emit();
    return attachment;
  }

  async removePendingAttachment(): Promise<DesktopStateDto> {
    const pending = this.state.workspace.pendingAttachment;
    if (pending) this.attachmentService.remove([pending.id]);
    delete this.state.workspace.pendingAttachment;
    this.emit();
    return this.getState();
  }

  async chooseProjectFile(): Promise<ProjectFileReferenceDto | undefined> {
    const project = this.requireProject();
    const selected = await this.options.pickProjectFile?.(project.path);
    return selected ? this.projectService.projectFile(project.path, selected) : undefined;
  }

  async continueWork(threadId: string): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const record = this.historyStore.find(threadId);
      if (!record) throw desktopError("HISTORY_NOT_FOUND", "Bu çalışma yerel geçmişte bulunamadı.");
      if (!this.state.credential.exists || !this.state.codex.ready) {
        throw desktopError("CREDENTIAL_REQUIRED", "Devam etmek için EVREN API anahtarını girin.");
      }
      if (!this.state.workspace.activeProject || !samePath(this.state.workspace.activeProject.path, record.projectPath)) {
        const project = await this.projectService.open(record.projectPath);
        this.projector.reset(undefined, project.path);
        this.state.workspace = {
          ...emptyWorkspace(),
          activeProject: project,
          recentProjects: await this.updateRecentProjects(project.path),
        };
        this.settings = { ...this.settings, lastActiveProject: project.path };
        await this.options.settingsStore.save(this.settings);
      }
      await this.refreshThreads();
      if (!this.state.workspace.threads.some((thread) => thread.id === threadId)) {
        await this.historyStore.reconcile(record.projectPath, this.state.workspace.threads);
        this.state.history = this.historyStore.snapshot();
        throw desktopError("THREAD_NOT_FOUND", "Codex sohbeti artık kullanılamıyor; yerel kayıt yalnızca geçmiş olarak korunuyor.");
      }
      await this.resumeThreadInternal(threadId);
    });
    return this.getState();
  }

  async pinHistory(input: HistoryPinInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      await this.historyStore.setPinned(input.threadId, input.pinned);
      this.state.history = this.historyStore.snapshot();
      this.emit();
    });
    return this.getState();
  }

  async renameHistory(input: HistoryRenameInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      try {
        await this.requireThreadService().rename(input.threadId, input.title);
        await this.historyStore.renameThread(input.threadId, input.title);
        this.state.workspace.threads = this.state.workspace.threads.map((thread) =>
          thread.id === input.threadId ? { ...thread, name: input.title } : thread,
        );
        const localThread = this.locallyStartedThreads.get(input.threadId);
        if (localThread) this.locallyStartedThreads.set(input.threadId, { ...localThread, name: input.title });
        this.state.history = this.historyStore.snapshot();
        this.emit();
      } catch {
        throw desktopError("THREAD_RENAME_FAILED", "Sohbet adı güncellenemedi.");
      }
    });
    return this.getState();
  }

  async archiveHistory(input: HistoryArchiveInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const record = this.state.history.find((candidate) => candidate.threadId === input.threadId);
      if (input.archived && record?.available) {
        if (isBusyPhase(this.state.workspace.turn.phase)) {
          throw desktopError("TURN_ACTIVE", "Etkin işlem tamamlanmadan sohbet arşivlenemez.");
        }
        await this.requireThreadService().archive(input.threadId);
        this.locallyStartedThreads.delete(input.threadId);
        this.modelRoutesByThread.delete(input.threadId);
        this.state.workspace.threads = this.state.workspace.threads.filter((thread) => thread.id !== input.threadId);
        if (this.state.workspace.selectedThreadId === input.threadId) this.clearSelectedThread();
      }
      await this.historyStore.setArchived(input.threadId, input.archived);
      this.state.history = this.historyStore.snapshot();
      this.emit();
    });
    return this.getState();
  }

  async updateSettings(input: DesktopSettingsUpdateInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      this.settings = { ...this.settings, schemaVersion: 2, ...input };
      await this.options.settingsStore.save(this.settings);
      this.state.settings = safeDesktopSettings(this.settings, this.state.settings.limits);
      if (input.recentProjectsEnabled === false) this.state.workspace.recentProjects = [];
      else if (input.recentProjectsEnabled === true) {
        this.state.workspace.recentProjects = await this.projectService.describeRecent(this.settings.recentProjects ?? []);
      }
      this.emit();
    });
    return this.getState();
  }

  async applyUsageLimits(input: UsageLimitsInput): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      const runtime = this.runtime;
      if (!runtime) throw desktopError("BRIDGE_UNAVAILABLE", "Bridge çalışmıyor.");
      const limits = input.preset === "Standard"
        ? { ...input, maxSessionTokens: 1_200_000, maxDailyTokens: 10_000_000, maxRequestsPerSession: 60, maxToolCallsPerSession: 80 }
        : input.preset === "Coding"
          ? { ...input, maxSessionTokens: 3_000_000, maxDailyTokens: 10_000_000, maxRequestsPerSession: 120, maxToolCallsPerSession: 140 }
          : input;
      const nextConfig = applyStoredLimits({ ...runtime.config }, limits);
      await runtime.applyConfiguration(nextConfig);
      this.settings = { ...this.settings, schemaVersion: 2, limits };
      await this.options.settingsStore.save(this.settings);
      this.state.settings = safeDesktopSettings(this.settings, limits);
      this.applyRuntimeSnapshot(runtime.snapshot());
    });
    return this.getState();
  }

  async checkForUpdates(): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      if (this.options.appUpdater) this.applyAppUpdateSnapshot(await this.options.appUpdater.check());
      else {
        const update = await this.runtime?.updateChecker.checkOnce();
        if (update) this.applyRuntimeSnapshot(this.runtime!.snapshot());
      }
      if (this.options.runtimeUpdater && this.settings.runtimeUpdateChecks !== false) {
        this.applyRuntimeUpdateSnapshot(await this.options.runtimeUpdater.check(this.state.codex.version));
      }
      this.emit();
    });
    return this.getState();
  }

  async downloadDesktopUpdate(): Promise<DesktopStateDto> {
    if (isBusyPhase(this.state.workspace.turn.phase)) throw desktopError("TURN_ACTIVE", "Etkin görev tamamlanmadan güncelleme indirilemez.");
    if (!this.options.appUpdater) throw desktopError("APP_UPDATE_UNAVAILABLE", "Desktop updater is unavailable in this build.");
    this.applyAppUpdateSnapshot(await this.options.appUpdater.download());
    this.emit();
    return this.getState();
  }

  installDesktopUpdate(): void {
    if (isBusyPhase(this.state.workspace.turn.phase)) throw desktopError("TURN_ACTIVE", "Etkin görev tamamlanmadan güncelleme kurulamaz.");
    if (!this.options.appUpdater) throw desktopError("APP_UPDATE_UNAVAILABLE", "Desktop updater is unavailable in this build.");
    this.options.appUpdater.install();
  }

  async installRuntimeUpdate(): Promise<DesktopStateDto> {
    const activeTurn = isBusyPhase(this.state.workspace.turn.phase);
    try {
      assertRuntimeUpdateIdle(activeTurn);
    } catch {
      this.state.updates.runtime = { ...this.state.updates.runtime, status: "blocked_active_turn" };
      this.emit();
      throw desktopError("TURN_ACTIVE", "Finish or stop the active task before updating Codex Runtime.");
    }
    if (!this.options.runtimeUpdater) throw desktopError("RUNTIME_UPDATE_UNAVAILABLE", "Runtime updater is unavailable in this build.");
    await this.enqueue(async () => {
      const installedVersion = this.state.codex.version;
      const shouldRestart = Boolean(this.runtime || this.codex);
      const models = [...this.state.models];
      const selectedModel = this.state.workspace.selectedThreadModel ?? this.state.selectedModelId;
      if (shouldRestart) await this.stopServices();
      let failure: unknown;
      try {
        this.applyRuntimeUpdateSnapshot(await this.options.runtimeUpdater!.install(installedVersion));
      } catch (error) {
        failure = error;
        this.applyRuntimeUpdateSnapshot(this.options.runtimeUpdater!.snapshot());
      }
      if (shouldRestart && this.state.credential.exists) {
        try {
          await this.startServices(models, selectedModel);
          await this.restoreWorkspace();
          if (!failure && this.state.codex.version) {
            this.applyRuntimeUpdateSnapshot(this.options.runtimeUpdater!.markActivated(this.state.codex.version));
          }
        } catch (error) {
          failure ??= error;
        }
      }
      this.emit();
      if (failure) throw failure;
    });
    return this.getState();
  }

  getDiagnostics(): string {
    const selectedModel = this.state.workspace.selectedThreadModel ?? this.state.selectedModelId ?? "unavailable";
    const lines = [
      `EVREN Codex Bridge: ${this.state.version}`,
      `Platform: ${process.platform} ${process.arch}`,
      `EVREN: ${this.state.evren.status}`,
      `Bridge: ${this.state.bridge.running ? "running" : "stopped"}`,
      `Codex: ${this.state.codex.ready ? "ready" : "unavailable"}`,
      `Codex Runtime: ${this.state.codex.version ?? "unavailable"}`,
      `Runtime source: ${this.state.updates.runtime.source}`,
      `Model: ${selectedModel}`,
      `Session token limit: ${this.state.usage.sessionTokenLimit}`,
      `Request limit: ${this.state.usage.requestLimit}`,
      `Tool-call limit: ${this.state.usage.toolCallLimit}`,
    ];
    const latestRoute = this.state.workspace.modelRoutes.at(-1);
    if (latestRoute) {
      lines.push(
        `Model route status: ${latestRoute.status}`,
        `Desktop selected model: ${latestRoute.desktopSelectedModel}`,
        `Codex requested model: ${latestRoute.codexRequestedModel}`,
        `Bridge effective model: ${latestRoute.bridgeEffectiveModel}`,
        `Upstream effective model: ${latestRoute.upstreamEffectiveModel ?? "not yet observed"}`,
        `Provider ID: ${latestRoute.providerId}`,
      );
    }
    return lines.join("\n");
  }

  async updateWindowBounds(windowBounds: WindowBoundsSetting): Promise<void> {
    await this.enqueue(async () => {
      this.settings = { ...this.settings, windowBounds };
      await this.options.settingsStore.save(this.settings);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.cancelChangeRefresh();
    await this.enqueue(async () => {
      await this.stopServices();
      this.attachmentService.clear();
      this.options.credentialService.clearSessionMemory();
      this.listeners.clear();
      this.appUpdaterUnsubscribe?.();
      this.appUpdaterUnsubscribe = undefined;
    });
  }

  private async openProjectPath(projectPath: string): Promise<DesktopStateDto> {
    await this.enqueue(async () => {
      if (["starting", "running", "awaitingApproval", "interrupting"].includes(this.state.workspace.turn.phase)) {
        throw desktopError("TURN_ACTIVE", "Etkin işlem tamamlanmadan proje değiştirilemez.");
      }
      const project = await this.projectService.open(projectPath);
      this.approvalService?.clear(false);
      this.projector.reset(undefined, project.path);
      this.cancelChangeRefresh();
      this.changeReviewService.clear();
      this.state.workspace = {
        ...emptyWorkspace(),
        activeProject: project,
        recentProjects: await this.updateRecentProjects(project.path),
      };
      this.settings = { ...this.settings, lastActiveProject: project.path };
      delete this.settings.lastSelectedThreadId;
      await this.options.settingsStore.save(this.settings);
      await this.refreshThreads();
      this.emit();
    });
    return this.getState();
  }

  private async archiveThreadAuthoritative(threadId: string): Promise<void> {
    if (this.state.workspace.turn.phase === "running" || this.state.workspace.turn.phase === "awaitingApproval") {
      throw desktopError("TURN_ACTIVE", "Etkin işlem tamamlanmadan sohbet arşivlenemez.");
    }
    await this.requireThreadService().archive(threadId);
    this.locallyStartedThreads.delete(threadId);
    if (this.state.workspace.selectedThreadId === threadId) this.clearSelectedThread();
    await this.refreshThreads();
  }

  private async updateRecentProjects(projectPath: string): Promise<WorkspaceStateDto["recentProjects"]> {
    const key = projectPath.toLocaleLowerCase("en-US");
    const paths = [projectPath, ...(this.settings.recentProjects ?? []).filter(
      (candidate) => candidate.toLocaleLowerCase("en-US") !== key,
    )].slice(0, 10);
    this.settings = { ...this.settings, recentProjects: paths };
    return this.settings.recentProjectsEnabled === false ? [] : this.projectService.describeRecent(paths);
  }

  private async restoreWorkspace(): Promise<void> {
    if (!this.state.workspace.activeProject || !this.threadService) return;
    await this.refreshThreads();
    const lastThreadId = this.settings.lastSelectedThreadId;
    if (!lastThreadId) return;
    if (this.state.workspace.threads.some((thread) => thread.id === lastThreadId)) {
      await this.resumeThreadInternal(lastThreadId);
      return;
    }
    try {
      const project = this.requireProject();
      const model = this.requireSelectedModel();
      const resumed = await this.requireThreadService().resumeSaved(
        lastThreadId,
        project.path,
        model.id,
        this.effectiveBridgeModel(),
      );
      this.locallyStartedThreads.set(resumed.thread.id, resumed.thread);
      await this.adoptResumedThread(resumed);
    } catch (error) {
      this.logThreadConsistency("thread_restore_pointer_rejected", {
        threadId: lastThreadId,
        errorCode: safeError(error).code,
      });
      delete this.settings.lastSelectedThreadId;
      await this.options.settingsStore.save(this.settings);
    }
  }

  private async refreshThreads(): Promise<void> {
    const project = this.state.workspace.activeProject;
    if (!project || !this.threadService || !this.state.codex.ready) {
      this.state.workspace.threads = [];
      this.emit();
      return;
    }
    const listed = await this.threadService.list(project.path);
    for (const thread of listed) this.locallyStartedThreads.set(thread.id, thread);
    this.state.workspace.threads = reconcileThreads(
      listed,
      [...this.locallyStartedThreads.values()].filter((thread) => samePath(thread.cwd, project.path)),
      (thread) => this.locallyStartedThreads.set(thread.id, thread),
    );
    for (const thread of this.state.workspace.threads) {
      await this.historyStore.upsertThread(thread, project.name, { available: true });
    }
    await this.historyStore.reconcile(project.path, this.state.workspace.threads);
    this.state.history = this.historyStore.snapshot();
    this.emit();
  }

  private async resumeThreadInternal(threadId: string): Promise<void> {
    const project = this.requireProject();
    let thread = this.state.workspace.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      await this.refreshThreads();
      thread = this.state.workspace.threads.find((candidate) => candidate.id === threadId);
    }
    if (!thread) throw desktopError("THREAD_NOT_FOUND", "Sohbet bu EVREN projesinde bulunamadı.");
    if (!samePath(thread.cwd, project.path)) throw desktopError("THREAD_PROJECT_MISMATCH", "Sohbet farklı bir projeye ait.");
    if (["starting", "running", "awaitingApproval", "interrupting"].includes(this.state.workspace.turn.phase)) {
      throw desktopError("TURN_ACTIVE", "Etkin işlem tamamlanmadan sohbet değiştirilemez.");
    }
    this.approvalService?.clearThread(this.state.workspace.selectedThreadId ?? "", true);
    await this.ensureServicesForModel(thread.model);
    const resumed = await this.requireThreadService().resume(threadId, thread, project.path, this.effectiveBridgeModel());
    await this.adoptResumedThread(resumed);
  }

  private async adoptResumedThread(resumed: ResumedThread): Promise<void> {
    const project = this.requireProject();
    this.locallyStartedThreads.set(resumed.thread.id, resumed.thread);
    this.projector.reset(resumed.thread.id, project.path, resumed.history.items);
    this.state.workspace = {
      ...this.state.workspace,
      draftActive: false,
      threads: upsertThread(this.state.workspace.threads, resumed.thread),
      selectedThreadId: resumed.thread.id,
      selectedThreadModel: resumed.thread.model,
      items: this.projector.snapshot(),
      turn: { phase: "idle" },
      modelRoutes: this.modelRoutesByThread.get(resumed.thread.id) ?? [],
      approvals: [],
      permissions: this.approvalService?.snapshot() ?? emptyPermissionCenter(),
      changeReview: this.changeReviewService.clear(),
    };
    if (this.state.workspace.modelRoutes.length === 0) {
      this.recordConfiguredModelRoute(resumed.thread, this.effectiveBridgeModel());
    }
    this.state.selectedModelId = resumed.thread.model;
    if (resumed.history.nextCursor) this.state.workspace.historyCursor = resumed.history.nextCursor;
    else delete this.state.workspace.historyCursor;
    delete this.state.workspace.error;
    this.settings = {
      ...this.settings,
      selectedModelId: resumed.thread.model,
      lastSelectedThreadId: resumed.thread.id,
    };
    await this.options.settingsStore.save(this.settings);
    await this.historyStore.upsertThread(resumed.thread, project.name, {
      available: true,
      items: this.state.workspace.items,
    });
    await this.historyStore.markOpened(resumed.thread.id);
    this.state.history = this.historyStore.snapshot();
    this.syncSelectedConversationInsights();
    this.emit();
  }

  private clearSelectedThread(): void {
    this.projector.reset(undefined, this.state.workspace.activeProject?.path);
    this.state.workspace = {
      ...this.state.workspace,
      draftActive: false,
      items: [], approvals: [], modelRoutes: [], turn: { phase: "idle" },
      changeReview: this.changeReviewService.clear(),
    };
    delete this.state.workspace.selectedThreadId;
    delete this.state.workspace.selectedThreadModel;
    delete this.state.workspace.historyCursor;
    delete this.state.workspace.conversationInsights;
    delete this.settings.lastSelectedThreadId;
  }

  private async ensureServicesForModel(model: string): Promise<void> {
    if (this.state.codex.ready
      && this.state.bridge.running
      && this.activeBridgeModel === model
      && this.effectiveBridgeModel() === model) return;
    await this.startServices(this.state.models, model);
  }

  private async startServices(prefetchedModels?: ModelDto[], modelOverride?: string): Promise<void> {
    await this.stopServices();
    delete this.state.error;
    this.setState({ stage: "CONNECTING_EVREN", evren: { status: "connecting" } });
    try {
      await this.options.credentialService.withCredential(async (apiKey) => {
        const models = prefetchedModels?.length ? prefetchedModels : (await this.catalogService().load(apiKey)).models;
        const selection = chooseInitialModel(models, this.settings.selectedModelId);
        this.state.models = models;
        this.state.evren = { status: "connected" };
        if (selection.selectedModelId) {
          this.state.selectedModelId = selection.selectedModelId;
          this.settings = { ...this.settings, selectedModelId: selection.selectedModelId };
          await this.options.settingsStore.save(this.settings);
        } else {
          delete this.state.selectedModelId;
        }
        if (selection.savedModelUnavailable) this.state.savedModelUnavailable = selection.savedModelUnavailable;
        else delete this.state.savedModelUnavailable;
        const runtimeModel = modelOverride ?? this.state.selectedModelId;
        if (!runtimeModel || !models.some((model) => model.id === runtimeModel && model.selectable)) {
          throw desktopError("MODEL_NOT_SELECTABLE", "Codex için seçilebilir EVREN modeli bulunamadı.");
        }

        this.setState({ stage: "STARTING_BRIDGE" });
        this.localBridgeToken = generateLocalBridgeToken();
        const runtimeConfig = applyStoredLimits(loadConfig(), this.settings.limits);
        runtimeConfig.updateCheckEnabled = this.settings.desktopUpdateChecks !== false;
        const runtime = (this.options.createRuntime ?? createBridgeRuntime)({
          apiKey,
          currentVersion: this.options.version,
          dataDir: path.join(this.options.userDataDir, "data"),
          logsDir: path.join(this.options.userDataDir, "logs"),
          config: runtimeConfig,
          modelOverride: runtimeModel,
          port: 0,
          localClientAuthToken: this.localBridgeToken,
          dashboardEnabled: false,
          consoleLogging: false,
        });
        this.runtime = runtime;
        const bridge = await runtime.start();
        if (typeof runtime.subscribe === "function") {
          this.runtimeUnsubscribe = runtime.subscribe((snapshot) => {
            this.applyRuntimeSnapshot(snapshot);
            this.scheduleEmit();
          });
        }
        if (bridge.model !== runtimeModel) {
          this.logThreadConsistency("bridge_start_rejected", {
            selectedModelId: this.state.selectedModelId,
            bridgeModelId: bridge.model,
            requestedModelId: runtimeModel,
            expectedProviderId: DESKTOP_PROVIDER_ID,
          });
          throw desktopError("BRIDGE_MODEL_MISMATCH", "Bridge etkin modeli Desktop seçimiyle eşleşmiyor.");
        }
        this.activeBridgeModel = bridge.model;
        this.state.bridge = {
          running: true,
          host: bridge.host,
          ...(bridge.port === undefined ? {} : { port: bridge.port }),
          model: bridge.model,
          ...(bridge.pricing.pricing === undefined ? {} : {
            pricing: {
              mode: bridge.pricing.pricing.promptTokenPrice === 0 && bridge.pricing.pricing.completionTokenPrice === 0 ? "free" : "paid",
              promptTokenPrice: bridge.pricing.pricing.promptTokenPrice,
              completionTokenPrice: bridge.pricing.pricing.completionTokenPrice,
              currency: "CR",
              ...(bridge.pricing.pricing.freeUntil === undefined ? {} : { freeUntil: bridge.pricing.pricing.freeUntil }),
            },
          }),
          ...(bridge.credits.remaining === undefined ? {} : { creditsRemaining: bridge.credits.remaining }),
        };

        const resolved = this.options.resolveRuntime
          ? await this.options.resolveRuntime()
          : this.options.detectCodex
            ? { executable: "codex", source: "system" as const, status: await this.options.detectCodex() }
            : await resolveCodexRuntime({
                packaged: this.options.appPackaged ?? false,
                resourcesPath: this.options.resourcesPath ?? process.cwd(),
                userDataDir: this.options.userDataDir,
                ...(process.env.EVREN_CODEX_DEV_EXECUTABLE ? { developmentExecutable: process.env.EVREN_CODEX_DEV_EXECUTABLE } : {}),
              });
        this.codexExecutable = resolved.executable || "codex";
        const codexStatus = resolved.status;
        this.state.codex = codexStatus;
        this.state.updates.runtime = {
          ...this.state.updates.runtime,
          ...(codexStatus.version ? { installedVersion: codexStatus.version } : {}),
          source: resolved.source,
          status: codexStatus.found ? "up_to_date" : "error",
        };
        if (!codexStatus.found || !bridge.port) {
          this.setState({ stage: "READY_NO_CODEX" });
          return;
        }

        this.setState({ stage: "STARTING_CODEX" });
        const manager = (this.options.createCodexManager ?? ((onExit) => new CodexAppServerManager({ onExit })))(
          () => this.handleCodexExit(),
        );
        this.codex = manager;
        await manager.start(buildCodexLaunchSpec({
          executable: this.codexExecutable,
          cwd: this.options.cwd,
          host: "127.0.0.1",
          port: bridge.port,
          model: runtimeModel,
          localBridgeToken: this.localBridgeToken!,
        }), this.options.version);
        this.configureProtocolServices(manager);
        this.state.codex = { ...codexStatus, ready: true };
        this.applyRuntimeSnapshot(bridge);
        this.setState({ stage: "READY" });
      });
    } catch (error) {
      await this.stopServices();
      const safe = safeError(error);
      this.setState({
        stage: "ERROR",
        evren: this.state.evren.status === "connected" ? this.state.evren : { status: "error", error: safe },
        error: safe,
      });
    }
  }

  private configureProtocolServices(manager: CodexAppServerManager): void {
    this.threadService = new CodexThreadService(manager, {
      onConsistencyDiagnostic: (diagnostic) => this.logThreadConsistency(diagnostic.transition, { ...diagnostic }),
    });
    this.turnService = new CodexTurnService(manager);
    this.approvalService = new CodexApprovalService(manager, {
      onChanged: (permissionState) => {
        this.state.workspace.approvals = permissionState.approvals;
        this.state.workspace.permissions = {
          grants: permissionState.grants,
          history: permissionState.history,
          supportsRevocation: false,
          revocationReason: permissionState.revocationReason,
        };
        if (permissionState.approvals.some((approval) => approval.threadId === this.state.workspace.selectedThreadId)) {
          this.state.workspace.turn = transitionTurn(
            this.state.workspace.turn,
            "awaitingApproval",
            this.state.workspace.turn.id,
            this.state.workspace.turn.activity,
          );
        }
        this.emit();
      },
      onUnsupported: (method) => {
        this.state.workspace.error = { code: "UNSUPPORTED_SERVER_REQUEST", message: `Codex isteği desteklenmiyor: ${method}` };
        this.emit();
      },
    });
    this.protocolUnsubscribers.push(
      manager.onNotification((method, params) => this.handleNotification(method, params)),
      manager.onServerRequest((request) => this.approvalService?.handle(request)),
    );
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "error") {
      const context = protocolErrorContext(params);
      const safe = safeProtocolNotificationError(params);
      const currentThreadId = this.state.workspace.selectedThreadId;
      const currentTurnId = this.state.workspace.turn.id;
      if (context && context.threadId === currentThreadId && context.turnId === currentTurnId) {
        if (!context.willRetry) {
          this.terminalTurnErrors.set(context.turnId, safe);
          this.state.workspace.error = safe;
          this.state.workspace.turn = {
            ...transitionTurn(this.state.workspace.turn, "failed", context.turnId),
            outcome: "failed",
            errorCode: safe.code,
          };
        }
      } else if (!context) {
        // The pinned 0.157.1 contract includes threadId/turnId. A malformed or
        // future unscoped error is visible, but must not decide a turn outcome.
        this.state.workspace.error = safe;
      }
      this.scheduleEmit();
      return;
    }
    const result = this.projector.apply(method, params);
    const terminalError = result.turnId ? this.terminalTurnErrors.get(result.turnId) : undefined;
    const effectivePhase = result.turnPhase === "completed" && terminalError ? "failed" : result.turnPhase;
    if (result.turnId && !this.acceptTurnNotification(result.turnId, effectivePhase)) return;
    if (result.resolvedRequestId !== undefined) this.approvalService?.resolveRequest(result.resolvedRequestId);
    if (result.turnId && result.turnPhase === "running" && this.state.workspace.selectedThreadId) {
      this.turnService?.noteStarted(this.state.workspace.selectedThreadId, result.turnId);
      const thread = this.state.workspace.threads.find((candidate) => candidate.id === this.state.workspace.selectedThreadId);
      if (thread) this.recordPendingTurnModelRoute(thread, result.turnId);
    }
    if (result.completedTurnId && this.state.workspace.selectedThreadId) {
      this.turnService?.noteCompleted(this.state.workspace.selectedThreadId, result.completedTurnId);
      this.approvalService?.clearTurn(this.state.workspace.selectedThreadId, result.completedTurnId, false);
    }
    if (result.fileActivity) {
      this.changeReviewService.noteFileActivity(result.fileActivity);
      this.scheduleChangeRefresh();
    } else if (result.completedItem?.kind === "command") {
      this.scheduleChangeRefresh();
    }
    if (result.completedItem?.kind === "command" && this.state.workspace.selectedThreadId) {
      void this.historyStore.recordCommandActivity(
        this.state.workspace.selectedThreadId,
        `${result.completedItem.turnId}:${result.completedItem.id}`,
        result.completedItem.durationMs,
        result.completedItem.command,
      ).then(() => {
        this.state.history = this.historyStore.snapshot();
        this.syncSelectedConversationInsights();
        this.scheduleEmit();
      }).catch(() => undefined);
    }
    if (effectivePhase) {
      const nextTurn = transitionTurn(
        this.state.workspace.turn,
        effectivePhase,
        result.turnId,
        result.turnActivity,
      );
      if (effectivePhase === "completed") {
        nextTurn.outcome = result.turnId && this.declinedApprovalTurns.has(result.turnId) ? "approvalDeclined" : "success";
      } else if (effectivePhase === "failed") {
        nextTurn.outcome = "failed";
        if (terminalError) nextTurn.errorCode = terminalError.code;
      } else if (effectivePhase === "interrupted") {
        nextTurn.outcome = "interrupted";
      }
      this.state.workspace.turn = nextTurn;
    } else if (result.turnActivity && result.turnId === this.state.workspace.turn.id) {
      this.state.workspace.turn = {
        ...this.state.workspace.turn,
        activity: result.turnActivity,
      };
    }
    if (result.changed) {
      this.state.workspace.items = this.projector.snapshot();
      void this.persistSelectedHistory();
    }
    if (result.completedTurnId && this.state.workspace.selectedThreadId) {
      const threadId = this.state.workspace.selectedThreadId;
      void this.enqueue(() => this.finalizeTurn(threadId, result.completedTurnId!)).catch(() => undefined);
      this.terminalTurnErrors.delete(result.completedTurnId);
      this.declinedApprovalTurns.delete(result.completedTurnId);
    }
    this.scheduleEmit();
  }

  private acceptTurnNotification(turnId: string, phase: WorkspaceStateDto["turn"]["phase"] | undefined): boolean {
    const current = this.state.workspace.turn;
    if (current.phase === "completed" || current.phase === "failed" || current.phase === "interrupted") {
      return current.phase === "failed" && current.id === turnId && phase === "failed" && this.terminalTurnErrors.has(turnId);
    }
    if (current.id === turnId) return !(phase === "running" && !isBusyPhase(current.phase) && current.phase !== "starting");
    return current.phase === "starting" && current.id === undefined;
  }

  private async stopServices(): Promise<void> {
    await this.flushConversationUsagePersistence();
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    for (const unsubscribe of this.protocolUnsubscribers.splice(0)) unsubscribe();
    this.approvalService?.resetSession();
    this.turnService?.clear();
    this.approvalService = undefined;
    this.threadService = undefined;
    this.turnService = undefined;
    const codex = this.codex;
    const runtime = this.runtime;
    this.codex = undefined;
    this.runtime = undefined;
    if (codex) await codex.stop().catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    this.localBridgeToken = undefined;
    this.activeBridgeModel = undefined;
    this.state.bridge = { running: false };
    this.state.workspace.approvals = [];
    this.state.workspace.permissions = emptyPermissionCenter();
    if (!this.shuttingDown) this.state.codex = unavailableCodexStatus();
  }

  private handleCodexExit(): void {
    if (this.shuttingDown) return;
    void this.flushConversationUsagePersistence().catch(() => undefined);
    for (const unsubscribe of this.protocolUnsubscribers.splice(0)) unsubscribe();
    this.approvalService?.resetSession();
    this.turnService?.clear();
    this.threadService = undefined;
    this.turnService = undefined;
    this.approvalService = undefined;
    if (["starting", "running", "awaitingApproval", "interrupting"].includes(this.state.workspace.turn.phase)) {
      this.state.workspace.turn = transitionTurn(
        this.state.workspace.turn,
        "failed",
        this.state.workspace.turn.id,
      );
    }
    this.state.workspace.approvals = [];
    this.state.workspace.permissions = emptyPermissionCenter();
    this.state.codex = { ...this.state.codex, ready: false, warning: "Codex App Server beklenmedik biçimde kapandı." };
    this.setState({ stage: "READY_NO_CODEX" });
  }

  private async persistSelectedHistory(): Promise<void> {
    const threadId = this.state.workspace.selectedThreadId;
    if (!threadId) return;
    await this.historyStore.cacheVisibleItems(threadId, this.state.workspace.items).catch(() => undefined);
    this.state.history = this.historyStore.snapshot();
    this.scheduleEmit();
  }

  private async finalizeTurn(threadId: string, turnId: string): Promise<void> {
    this.cancelChangeRefresh();
    const review = await this.changeReviewService.refresh("ready");
    if (review.turnId && review.turnId !== turnId) return;
    this.state.workspace.changeReview = review;
    const turn = this.state.workspace.turn;
    const elapsedMs = turn.id === turnId && turn.startedAt !== undefined
      ? Math.max(0, (turn.completedAt ?? Date.now()) - turn.startedAt)
      : 0;
    await this.historyStore.recordCompletedTurn(threadId, turnId, elapsedMs, this.changeReviewService.summary());
    this.state.history = this.historyStore.snapshot();
    this.syncSelectedConversationInsights();
    this.emit();
  }

  private scheduleChangeRefresh(): void {
    if (!this.state.workspace.changeReview.turnId) return;
    if (this.changeRefreshTimer) clearTimeout(this.changeRefreshTimer);
    this.changeRefreshTimer = setTimeout(() => {
      this.changeRefreshTimer = undefined;
      void this.changeReviewService.refresh("tracking").then((review) => {
        if (review.turnId !== this.state.workspace.turn.id) return;
        this.state.workspace.changeReview = review;
        this.scheduleEmit();
      }).catch(() => undefined);
    }, 250);
    this.changeRefreshTimer.unref();
  }

  private cancelChangeRefresh(): void {
    if (this.changeRefreshTimer) clearTimeout(this.changeRefreshTimer);
    this.changeRefreshTimer = undefined;
  }

  private scheduleConversationUsagePersistence(snapshot: BridgeRuntimeSnapshot): void {
    const threadId = this.state.workspace.selectedThreadId;
    const session = snapshot.session;
    if (!threadId || !session?.threadIdentityHash || session.threadIdentityHash !== digestIdentity(threadId)) return;
    this.pendingConversationUsage = {
      threadId,
      snapshot: {
        sessionId: session.id,
        requests: session.requestCount,
        inferences: session.inferenceCount,
        toolCalls: session.toolCallCount,
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        ...(session.usage.cachedTokens === undefined ? {} : { cachedTokens: session.usage.cachedTokens }),
        totalTokens: session.usage.totalTokens,
        activeContextBytes: session.contextObservability.currentActiveContextBytes,
        peakContextBytes: session.contextObservability.peakActiveContextBytes,
        replayBytes: session.contextObservability.canonicalHistoryReplayBytes,
        payloadBytes: session.contextObservability.totalUpstreamPayloadBytes,
        peakPayloadBytes: session.contextObservability.peakPayloadBytes,
        instructionBytes: session.contextObservability.instructionBytes,
        toolCatalogBytes: session.contextObservability.toolCatalogBytes,
        toolResultBytes: session.contextObservability.acceptedToolOutputReplayBytes,
        sessionMetadataBytes: session.contextObservability.sessionMetadataBytes,
        protocolWrapperBytes: session.contextObservability.protocolWrapperBytes,
        encodedImageBytes: session.contextObservability.encodedImageBytes,
        sourceImageBytes: session.contextObservability.sourceImageBytes,
        providerWaitMs: session.performanceObservability.providerWaitMs,
        responseParseMs: session.performanceObservability.responseParseMs,
        resultProcessingMs: session.performanceObservability.resultProcessingMs,
        requestSerializationMs: session.performanceObservability.requestSerializationMs,
        peakInferenceInputTokens: session.performanceObservability.peakInferenceInputTokens,
        inferenceReasons: inferenceReasonCounts(session.performanceObservability.reasonCounts),
        compactions: session.acceptedCompactionCount,
        accountingCertain: snapshot.dailyUsage?.accountingCertain !== false,
        observedAt: Date.now(),
      },
    };
    if (this.conversationUsageTimer) return;
    this.conversationUsageTimer = setTimeout(() => {
      this.conversationUsageTimer = undefined;
      const pending = this.pendingConversationUsage;
      this.pendingConversationUsage = undefined;
      if (!pending) return;
      void this.historyStore.recordProviderSnapshot(pending.threadId, pending.snapshot).then(() => {
        this.state.history = this.historyStore.snapshot();
        this.syncSelectedConversationInsights();
        this.scheduleEmit();
      }).catch(() => undefined);
    }, 300);
    this.conversationUsageTimer.unref();
  }

  private async flushConversationUsagePersistence(): Promise<void> {
    if (this.conversationUsageTimer) clearTimeout(this.conversationUsageTimer);
    this.conversationUsageTimer = undefined;
    const pending = this.pendingConversationUsage;
    this.pendingConversationUsage = undefined;
    if (!pending) return;
    await this.historyStore.recordProviderSnapshot(pending.threadId, pending.snapshot).catch(() => undefined);
    this.state.history = this.historyStore.snapshot();
    this.syncSelectedConversationInsights();
  }

  private syncSelectedConversationInsights(): void {
    const threadId = this.state.workspace.selectedThreadId;
    const insights = threadId ? this.state.history.find((record) => record.threadId === threadId)?.insights : undefined;
    if (insights) this.state.workspace.conversationInsights = insights;
    else delete this.state.workspace.conversationInsights;
  }

  private applyRuntimeSnapshot(snapshot: BridgeRuntimeSnapshot): void {
    this.state.usage = usageFromSnapshot(snapshot, this.runtime?.config ?? loadConfig());
    this.scheduleConversationUsagePersistence(snapshot);
    this.state.bridge = {
      running: snapshot.status === "running",
      host: snapshot.host,
      ...(snapshot.port === undefined ? {} : { port: snapshot.port }),
      model: snapshot.model,
      ...(snapshot.pricing.pricing === undefined ? {} : {
        pricing: {
          mode: snapshot.pricing.pricing.promptTokenPrice === 0 && snapshot.pricing.pricing.completionTokenPrice === 0 ? "free" : "paid",
          promptTokenPrice: snapshot.pricing.pricing.promptTokenPrice,
          completionTokenPrice: snapshot.pricing.pricing.completionTokenPrice,
          currency: "CR",
          ...(snapshot.pricing.pricing.freeUntil === undefined ? {} : { freeUntil: snapshot.pricing.pricing.freeUntil }),
        },
      }),
      ...(snapshot.credits.remaining === undefined ? {} : { creditsRemaining: snapshot.credits.remaining }),
    };
    this.applyUpstreamModelObservations(snapshot.upstreamModelObservations ?? []);
    this.applyBridgeActivity(snapshot);
    this.state.updates.desktop = {
      installedVersion: this.options.version,
      status: snapshot.update.status,
      ...(snapshot.update.updateAvailableVersion ? { availableVersion: snapshot.update.updateAvailableVersion } : {}),
      ...(snapshot.update.checkedAt ? { checkedAt: snapshot.update.checkedAt } : {}),
      signed: false,
    };
  }

  private applyBridgeActivity(snapshot: BridgeRuntimeSnapshot): void {
    const activity = snapshot.activity;
    const turn = this.state.workspace.turn;
    if (!activity || !["running", "awaitingApproval"].includes(turn.phase)) return;
    if (activity.threadId && activity.threadId !== this.state.workspace.selectedThreadId) return;
    if (activity.turnId && activity.turnId !== turn.id) return;
    if (activity.phase === "failed") return;
    const projected: TurnActivityDto = activity.phase === "sending"
      ? "sendingToEvren"
      : activity.phase === "waiting"
        ? "waitingForEvren"
        : "processingResult";
    this.state.workspace.turn = {
      ...turn,
      activity: projected,
      ...(turn.startedAt === undefined ? { startedAt: activity.observedAt } : {}),
    };
  }

  private applyAppUpdateSnapshot(snapshot: DesktopAppUpdateSnapshot): void {
    this.state.updates.desktop = {
      installedVersion: this.options.version,
      status: snapshot.status,
      ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
      ...(snapshot.progressPercent === undefined ? {} : { progressPercent: snapshot.progressPercent }),
      ...(snapshot.releaseNotes ? { releaseNotes: snapshot.releaseNotes } : {}),
      ...(snapshot.technicalCode ? { technicalCode: snapshot.technicalCode } : {}),
      signed: false,
    };
  }

  private applyRuntimeUpdateSnapshot(snapshot: RuntimeUpdateSnapshot): void {
    this.state.updates.runtime = {
      ...this.state.updates.runtime,
      status: snapshot.status,
      ...(snapshot.installedVersion ? { installedVersion: snapshot.installedVersion } : {}),
      ...(snapshot.verifiedVersion ? { verifiedVersion: snapshot.verifiedVersion } : {}),
      ...(snapshot.upstreamVersion ? { upstreamVersion: snapshot.upstreamVersion } : {}),
      ...(snapshot.error && snapshot.status !== "source_unavailable" ? { error: snapshot.error } : {}),
    };
  }

  private effectiveBridgeModel(): string | undefined {
    if (this.runtime && typeof this.runtime.snapshot === "function") {
      try {
        return this.runtime.snapshot().model;
      } catch {
        return undefined;
      }
    }
    return this.state.bridge.model;
  }

  private recordConfiguredModelRoute(thread: ThreadSummaryDto, bridgeModel: string | undefined): void {
    const effectiveBridgeModel = bridgeModel ?? "unavailable";
    this.upsertModelRoute({
      threadId: thread.id,
      desktopSelectedModel: thread.model,
      codexRequestedModel: thread.model,
      bridgeEffectiveModel: effectiveBridgeModel,
      providerId: thread.modelProvider,
      status: effectiveBridgeModel === thread.model ? "configured" : "mismatch",
    });
  }

  private recordPendingTurnModelRoute(thread: ThreadSummaryDto, turnId: string): void {
    const current = this.modelRoutesByThread.get(thread.id)?.find((route) => route.turnId === turnId);
    if (current?.status === "verified" || current?.status === "mismatch") return;
    const bridgeModel = this.effectiveBridgeModel() ?? "unavailable";
    this.upsertModelRoute({
      threadId: thread.id,
      turnId,
      desktopSelectedModel: thread.model,
      codexRequestedModel: thread.model,
      bridgeEffectiveModel: bridgeModel,
      providerId: thread.modelProvider,
      status: bridgeModel === thread.model ? "pending" : "mismatch",
    });
  }

  private applyUpstreamModelObservations(observations: NonNullable<BridgeRuntimeSnapshot["upstreamModelObservations"]>): void {
    for (const observation of observations) {
      if (!observation.threadId || !observation.turnId || !observation.codexRequestedModel) continue;
      const thread = this.state.workspace.threads.find((candidate) => candidate.id === observation.threadId)
        ?? this.locallyStartedThreads.get(observation.threadId);
      if (!thread) continue;
      const accepted = thread.modelProvider === DESKTOP_PROVIDER_ID
        && thread.model === observation.codexRequestedModel
        && thread.model === observation.bridgeModel
        && thread.model === observation.upstreamModel;
      this.upsertModelRoute({
        threadId: thread.id,
        turnId: observation.turnId,
        desktopSelectedModel: thread.model,
        codexRequestedModel: observation.codexRequestedModel,
        bridgeEffectiveModel: observation.bridgeModel,
        upstreamEffectiveModel: observation.upstreamModel,
        providerId: thread.modelProvider,
        status: accepted ? "verified" : "mismatch",
        inferenceNumber: observation.inferenceNumber,
        observedAt: observation.observedAt,
      });
      if (!accepted && this.state.workspace.selectedThreadId === thread.id) {
        this.state.workspace.turn = transitionTurn(this.state.workspace.turn, "failed", observation.turnId);
        this.state.workspace.error = {
          code: "UPSTREAM_MODEL_MISMATCH",
          message: "Model yönlendirmesi doğrulanamadı; istek güvenli biçimde durduruldu.",
        };
      }
    }
  }

  private upsertModelRoute(route: ModelRouteDto): void {
    const current = this.modelRoutesByThread.get(route.threadId) ?? [];
    const sameRoute = (candidate: ModelRouteDto): boolean => candidate.turnId === route.turnId;
    const next = [...current.filter((candidate) => !sameRoute(candidate)), route].slice(-101);
    this.modelRoutesByThread.set(route.threadId, next);
    if (this.state.workspace.selectedThreadId === route.threadId) this.state.workspace.modelRoutes = next;
  }

  private logThreadConsistency(transition: string, data: Record<string, unknown>): void {
    const logger = this.runtime?.logger;
    if (!logger || typeof logger.log !== "function") return;
    logger.log({
      event: "DESKTOP_THREAD_CONSISTENCY",
      level: data.accepted === false || transition.endsWith("rejected") || transition.endsWith("blocked") ? "warn" : "info",
      data: { transition, ...data },
    });
  }

  private catalogService(): EvrenCatalogService {
    const config = loadConfig();
    return this.options.catalogService ?? new EvrenCatalogService({
      baseUrl: config.evrenBaseUrl,
      timeoutMs: config.requestTimeoutMs,
    });
  }

  private requireProject() {
    const project = this.state.workspace.activeProject;
    if (!project?.exists) throw desktopError("PROJECT_REQUIRED", "Önce bir proje klasörü açın.");
    return project;
  }

  private requireSelectedModel(): ModelDto {
    const model = this.state.models.find((candidate) => candidate.id === this.state.selectedModelId && candidate.selectable);
    if (!model) throw desktopError("MODEL_REQUIRED", "Önce kullanılabilir bir model seçin.");
    return model;
  }

  private requireSelectedThread(threadId: string) {
    if (this.state.workspace.selectedThreadId !== threadId) throw desktopError("THREAD_SCOPE_MISMATCH", "Sohbet seçimi değişti.");
    const thread = this.state.workspace.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw desktopError("THREAD_STATE_INCONSISTENT", "Seçili sohbet listede bulunamadı; sohbetleri yenileyip yeniden deneyin.");
    }
    if (this.state.workspace.selectedThreadModel !== thread.model) {
      throw desktopError("THREAD_MODEL_MISMATCH", "Sohbet modeli Desktop durumuyla eşleşmiyor.");
    }
    return thread;
  }

  private requireThreadService(): CodexThreadService {
    if (!this.threadService) throw desktopError("CODEX_UNAVAILABLE", "Codex App Server kullanılamıyor.");
    return this.threadService;
  }

  private requireTurnService(): CodexTurnService {
    if (!this.turnService) throw desktopError("CODEX_UNAVAILABLE", "Codex App Server kullanılamıyor.");
    return this.turnService;
  }

  private setState(patch: Partial<DesktopStateDto>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, 40);
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.operation.then(operation, operation);
    this.operation = queued.catch(() => undefined);
    await queued;
  }
}

function emptyWorkspace(): WorkspaceStateDto {
  return {
    recentProjects: [], threads: [], draftActive: false, items: [], turn: { phase: "idle" }, modelRoutes: [], approvals: [],
    permissions: emptyPermissionCenter(),
    changeReview: emptyChangeReview(),
  };
}

function emptyPermissionCenter(): WorkspaceStateDto["permissions"] {
  return {
    grants: [], history: [], supportsRevocation: false,
    revocationReason: "Codex 0.157.1 oturum onayı önbelleği için güvenli bir revoke yöntemi sunmuyor.",
  };
}

function emptyChangeReview(): WorkspaceStateDto["changeReview"] {
  return {
    phase: "idle", git: false, baselineDirty: false, files: [], filesChanged: 0,
    additions: 0, deletions: 0, created: 0, modified: 0, deleted: 0, renamed: 0,
  };
}

function failedChangeReview(message: string): WorkspaceStateDto["changeReview"] {
  return { ...emptyChangeReview(), phase: "error", message };
}

function upsertThread(threads: ThreadSummaryDto[], thread: ThreadSummaryDto): ThreadSummaryDto[] {
  return [thread, ...threads.filter((candidate) => candidate.id !== thread.id)];
}

function reconcileThreads(
  listed: ThreadSummaryDto[],
  locallyStarted: ThreadSummaryDto[],
  onObserved: (thread: ThreadSummaryDto) => void,
): ThreadSummaryDto[] {
  const merged = [...listed];
  for (const local of locallyStarted) {
    const authoritative = listed.find((thread) => thread.id === local.id);
    if (authoritative) {
      if (authoritative.model !== local.model
        || authoritative.modelProvider !== local.modelProvider
        || !samePath(authoritative.cwd, local.cwd)) {
        throw desktopError("THREAD_MODEL_MISMATCH", "Codex sohbet listesi yeni sohbetin model veya proje bilgisiyle eşleşmiyor.");
      }
      onObserved(authoritative);
    } else {
      merged.push(local);
    }
  }
  return merged.sort((left, right) => right.updatedAt - left.updatedAt);
}

function unavailableCodexStatus(): CodexStatusDto {
  return { found: false, ready: false, testedVersion: TESTED_CODEX_VERSION, compatibility: "unavailable" };
}

export function safeError(error: unknown): SafeErrorDto {
  if (error instanceof ModelCatalogError) return error.toDto();
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code : "desktop_operation_failed";
  const detail = sanitizeTechnicalDetail(error instanceof Error ? error.message : undefined);
  const upstream = upstreamProductError(code);
  if (upstream) return upstream;
  if (isRateLimitError(detail)) return rateLimitError();
  if (isPublicDesktopErrorCode(code) && detail && !looksLikeProviderPayload(detail)) {
    return { code, message: detail };
  }
  return { code, message: "İstek tamamlanamadı.", ...(detail ? { detail } : {}) };
}

function isPublicDesktopErrorCode(code: string): boolean {
  return /^(?:PROJECT|THREAD|TURN|BRIDGE|MODEL|CODEX|CREDENTIAL|HISTORY|LOCAL|ATTACHMENT|RUNTIME|UPDATE|UPSTREAM|UNSUPPORTED|CHANGE)_/.test(code);
}

function safeProtocolNotificationError(value: unknown): SafeErrorDto {
  if (containsLocalLimitCode(value)) {
    return {
      code: "LOCAL_BRIDGE_LIMIT",
      message: "Yerel Bridge limiti aşıldı. İstek EVREN'e gönderilmeden durduruldu.",
    };
  }
  const upstreamCode = findUpstreamErrorCode(value);
  if (upstreamCode) return upstreamProductError(upstreamCode)!;
  if (containsRateLimitError(value)) return rateLimitError();
  if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "CODEX_TURN_FAILED", message: "Codex işlemi başarısız oldu." };
  const error = (value as Record<string, unknown>).error;
  const record = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
  const detail = sanitizeTechnicalDetail(typeof record?.message === "string" ? record.message : undefined);
  return {
    code: "CODEX_TURN_FAILED",
    message: "İstek tamamlanamadı.",
    ...(detail ? { detail } : {}),
  };
}

function protocolErrorContext(value: unknown): { threadId: string; turnId: string; willRetry: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== "string" || typeof record.turnId !== "string" || typeof record.willRetry !== "boolean") {
    return undefined;
  }
  return { threadId: record.threadId, turnId: record.turnId, willRetry: record.willRetry };
}

const UPSTREAM_ERROR_CODES = new Set([
  "upstream_authentication_failed",
  "upstream_authorization_failed",
  "upstream_invalid_request",
  "upstream_model_unsupported",
  "upstream_media_unsupported",
  "upstream_payload_too_large",
  "upstream_rate_limit",
  "upstream_overloaded",
  "upstream_provider_error",
  "upstream_http_error",
  "upstream_network_error",
  "upstream_timeout",
  "upstream_aborted",
  "upstream_malformed_response",
]);

function findUpstreamErrorCode(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") {
    if (UPSTREAM_ERROR_CODES.has(value)) return value;
    for (const code of UPSTREAM_ERROR_CODES) if (value.includes(code)) return code;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUpstreamErrorCode(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findUpstreamErrorCode(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function upstreamProductError(code: string): SafeErrorDto | undefined {
  switch (code) {
    case "upstream_authentication_failed":
      return { code: "UPSTREAM_AUTHENTICATION", message: "EVREN API anahtarı doğrulanamadı. Anahtarı kontrol edip yeniden bağlanın." };
    case "upstream_authorization_failed":
      return { code: "UPSTREAM_AUTHORIZATION", message: "EVREN bu model veya işlem için erişimi reddetti." };
    case "upstream_invalid_request":
      return { code: "UPSTREAM_INVALID_REQUEST", message: "EVREN isteği geçersiz buldu; istek içeriğini ve model seçimini kontrol edin." };
    case "upstream_model_unsupported":
      return { code: "UPSTREAM_MODEL_UNSUPPORTED", message: "Seçili model bu EVREN isteğini desteklemiyor." };
    case "upstream_media_unsupported":
      return { code: "UPSTREAM_MEDIA_UNSUPPORTED", message: "EVREN veya seçili model bu görsel türünü desteklemiyor." };
    case "upstream_payload_too_large":
      return { code: "UPSTREAM_PAYLOAD_TOO_LARGE", message: "İstek EVREN için çok büyük. Daha küçük veya daha az görsel deneyin." };
    case "upstream_rate_limit": return rateLimitError();
    case "upstream_overloaded":
      return { code: "UPSTREAM_OVERLOADED", message: "EVREN veya seçili sağlayıcı şu anda yoğun. Daha sonra açıkça yeniden deneyin." };
    case "upstream_provider_error":
    case "upstream_http_error":
      return { code: "UPSTREAM_PROVIDER_ERROR", message: "EVREN veya seçili sağlayıcı isteği tamamlayamadı." };
    case "upstream_network_error":
      return { code: "UPSTREAM_NETWORK_ERROR", message: "EVREN ağına ulaşılamadı. Bağlantıyı kontrol edip yeniden deneyin." };
    case "upstream_timeout":
      return { code: "UPSTREAM_TIMEOUT", message: "EVREN yanıtı zaman aşımına uğradı. İstek otomatik yinelenmedi." };
    case "upstream_aborted":
      return { code: "UPSTREAM_ABORTED", message: "EVREN isteği durduruldu." };
    case "upstream_malformed_response":
      return { code: "UPSTREAM_MALFORMED_RESPONSE", message: "EVREN geçerli bir yanıt döndürmedi." };
    default: return undefined;
  }
}

function rateLimitError(): SafeErrorDto {
  return {
    code: "UPSTREAM_RATE_LIMIT",
    message: "İstek şu anda yoğunluk veya hız sınırı nedeniyle tamamlanamadı. Bir süre sonra tekrar deneyin.",
    detail: "HTTP 429 · Too Many Requests",
  };
}

function isRateLimitError(value: string | undefined): boolean {
  return Boolean(value && (/\b429\b/.test(value) || /too many requests|exceeded retry limit/i.test(value)));
}

function containsRateLimitError(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") return isRateLimitError(value);
  if (Array.isArray(value)) return value.some((item) => containsRateLimitError(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsRateLimitError(item, depth + 1));
}

function sanitizeTechnicalDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|bridge[_ -]?token|token|secret|password)\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .trim();
  return sanitized ? sanitized.slice(0, 300) : undefined;
}

function looksLikeProviderPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /\"(?:error|message|authorization)\"\s*:/i.test(trimmed);
}

function containsLocalLimitCode(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") {
    return value.includes("MAX_SESSION_TOKENS")
      || value.includes("MAX_REQUESTS_PER_SESSION")
      || value.includes("MAX_TOOL_CALLS_PER_SESSION");
  }
  if (Array.isArray(value)) return value.some((item) => containsLocalLimitCode(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsLocalLimitCode(item, depth + 1));
}

function desktopError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLocaleLowerCase("en-US") === path.normalize(right).toLocaleLowerCase("en-US");
}

function digestIdentity(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function isBusyPhase(phase: WorkspaceStateDto["turn"]["phase"]): boolean {
  return ["starting", "running", "awaitingApproval", "interrupting"].includes(phase);
}

function transitionTurn(
  current: WorkspaceStateDto["turn"],
  phase: WorkspaceStateDto["turn"]["phase"],
  id?: string,
  activity?: TurnActivityDto,
): WorkspaceStateDto["turn"] {
  const sameTurn = id !== undefined && current.id === id;
  if (phase === "idle" || phase === "starting") return { phase };
  const startedAt = sameTurn ? current.startedAt : Date.now();
  if (phase === "running" || phase === "awaitingApproval") {
    return {
      phase,
      ...(id === undefined ? {} : { id }),
      ...(activity === undefined ? {} : { activity }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  }
  const completedAt = current.completedAt ?? Date.now();
  return {
    phase,
    ...(id === undefined ? {} : { id }),
    ...(activity === undefined ? {} : { activity }),
    ...(phase === "completed" ? { outcome: "success" as const }
      : phase === "failed" ? { outcome: "failed" as const }
        : phase === "interrupted" ? { outcome: "interrupted" as const }
          : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    completedAt,
  };
}

function limitsFromConfig(config: BridgeConfig, preset: UsageLimitsInput["preset"]): UsageLimitsInput {
  return {
    preset,
    maxSessionTokens: config.maxSessionTokens,
    maxDailyTokens: config.maxDailyTokens,
    maxRequestsPerSession: config.maxRequestsPerSession,
    maxToolCallsPerSession: config.maxToolCallsPerSession,
    maxSessionCredits: config.maxSessionCredits,
    maxDailyCredits: config.maxDailyCredits,
    minCreditsRemaining: config.minCreditsRemaining,
  };
}

function applyStoredLimits(config: BridgeConfig, limits?: UsageLimitsInput): BridgeConfig {
  if (!limits) return config;
  return {
    ...config,
    maxSessionTokens: limits.maxSessionTokens,
    maxDailyTokens: limits.maxDailyTokens,
    maxRequestsPerSession: limits.maxRequestsPerSession,
    maxToolCallsPerSession: limits.maxToolCallsPerSession,
    maxSessionCredits: limits.maxSessionCredits,
    maxDailyCredits: limits.maxDailyCredits,
    minCreditsRemaining: limits.minCreditsRemaining,
  };
}

function emptyUsage(config: BridgeConfig): UsageDto {
  return {
    available: false,
    sessionTokenLimit: config.maxSessionTokens,
    dailyTokenLimit: config.maxDailyTokens,
    requestLimit: config.maxRequestsPerSession,
    toolCallLimit: config.maxToolCallsPerSession,
    creditSpendAccounting: "unavailable",
  };
}

function usageFromSnapshot(snapshot: BridgeRuntimeSnapshot, config: BridgeConfig): UsageDto {
  const session = snapshot.session;
  const recovery = session?.limitRecovery;
  const recoveryName = recovery && (
    recovery.limitName === "MAX_SESSION_TOKENS"
    || recovery.limitName === "MAX_REQUESTS_PER_SESSION"
    || recovery.limitName === "MAX_TOOL_CALLS_PER_SESSION"
  ) ? recovery.limitName : undefined;
  return {
    available: Boolean(session || snapshot.dailyUsage),
    sessionTokenLimit: config.maxSessionTokens,
    dailyTokenLimit: config.maxDailyTokens,
    requestLimit: config.maxRequestsPerSession,
    toolCallLimit: config.maxToolCallsPerSession,
    ...(session ? {
      sessionTokens: session.usage.totalTokens,
      requests: session.requestCount,
      toolCalls: session.toolCallCount,
      inferences: session.inferenceCount,
      polls: session.polling.totalPollInferences,
      ...(session.usage.cachedTokens === undefined ? {} : { cachedTokens: session.usage.cachedTokens }),
      ...(session.lastUsage ? {
        lastInputTokens: session.lastUsage.inputTokens,
        lastOutputTokens: session.lastUsage.outputTokens,
      } : {}),
      activeContextBytes: session.contextObservability.currentActiveContextBytes,
      peakContextBytes: session.contextObservability.peakActiveContextBytes,
      replayBytes: session.contextObservability.canonicalHistoryReplayBytes,
      payloadBytes: session.contextObservability.totalUpstreamPayloadBytes,
      peakPayloadBytes: session.contextObservability.peakPayloadBytes,
      providerWaitMs: session.performanceObservability.providerWaitMs,
      responseParseMs: session.performanceObservability.responseParseMs,
      resultProcessingMs: session.performanceObservability.resultProcessingMs,
      requestSerializationMs: session.performanceObservability.requestSerializationMs,
      compactions: session.acceptedCompactionCount,
      ...(session.context.windowNumber === undefined ? {} : { windowNumber: session.context.windowNumber }),
    } : {}),
    ...(snapshot.dailyUsage ? {
      dailyTokens: snapshot.dailyUsage.totalTokens,
      accountingCertain: snapshot.dailyUsage.accountingCertain,
    } : {}),
    creditSpendAccounting: "unavailable",
    ...(recovery && recoveryName ? {
      limitRecovery: {
        name: recoveryName,
        current: recovery.current,
        limit: recovery.limit,
        ...(recovery.recommended === undefined ? {} : { recommended: recovery.recommended }),
        recoverable: recovery.recoverable,
      },
    } : {}),
  };
}

function inferenceReasonCounts(counts: {
  initial_turn: number;
  conversation_continuation: number;
  tool_result: number;
  compaction: number;
  compaction_continuation: number;
  prewarm: number;
  memory: number;
  protocol_repair: number;
  other: number;
}): InferenceReasonCountsDto {
  return {
    initialTurn: counts.initial_turn,
    conversationContinuation: counts.conversation_continuation,
    toolResult: counts.tool_result,
    compaction: counts.compaction,
    compactionContinuation: counts.compaction_continuation,
    prewarm: counts.prewarm,
    memory: counts.memory,
    protocolRepair: counts.protocol_repair,
    other: counts.other,
  };
}
