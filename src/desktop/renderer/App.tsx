import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from "react";
import type {
  ApprovalDecisionDto,
  ApprovalRequestDto,
  ChangeDiffDto,
  ChangeFileDto,
  ConversationItemDto,
  DesktopStateDto,
  HistoryRecordDto,
  PersistenceMode,
  UsageLimitsInput,
} from "../shared/contracts.js";
import { displayDiff, displayFilePath, displayProjectLocation } from "../shared/display-path.js";
import {
  applicationErrorIsVisible,
  formatTurnDuration,
  groupConversationItems,
  imageInputPresentation,
  modelControlPresentation,
  routeErrorIsVisible,
  turnStatusLabel,
  type DesktopPage,
  type ScopedUiError,
} from "./presentation.js";

type Page = DesktopPage;
type InspectorTab = "changes" | "permissions" | "conversation";
type Runner = (operation: () => Promise<DesktopStateDto>) => Promise<boolean>;
interface RenameTarget { threadId: string; title: string }
const BRAND_ASSET_URL = new URL("../../../resources/branding/evren-codex-bridge.png", import.meta.url).href;

export function App(): JSX.Element {
  const [state, setState] = useState<DesktopStateDto>();
  const [fatal, setFatal] = useState<string>();
  const [uiError, setUiError] = useState<ScopedUiError>();
  const [dismissedChatError, setDismissedChatError] = useState<string>();
  const [page, setPage] = useState<Page>("home");
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("changes");

  useEffect(() => {
    let active = true;
    void window.evrenDesktop.state.get().then((next) => { if (active) setState(next); }).catch(() => { if (active) setFatal("CHAT_INITIALIZATION_FAILED"); });
    const unsubscribe = window.evrenDesktop.state.subscribe(setState);
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (fatal || (state && state.stage !== "BOOTING")) document.documentElement.dataset.evrenDesktopReady = "true";
  }, [fatal, state]);
  useEffect(() => {
    const theme = state?.settings.theme ?? "navy";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  }, [state?.settings.theme]);

  if (fatal) return <RecoveryScreen onRetry={() => window.location.reload()} />;
  if (!state || state.stage === "BOOTING") return <LoadingScreen label="EVREN Codex Bridge hazırlanıyor" />;
  if (state.stage === "NEEDS_API_KEY") return <Onboarding state={state} onState={setState} />;

  const run: Runner = async (operation) => {
    setUiError(undefined);
    try { setState(await operation()); return true; }
    catch (error) { setUiError({ scope: page, message: readError(error) }); return false; }
  };
  const goChat = (): void => setPage("chat");
  const openInspector = (tab: InspectorTab): void => { setInspectorTab(tab); setInspectorOpen(true); };
  const chatErrorKey = state.workspace.error ? `${state.workspace.error.code}:${state.workspace.error.message}:${state.workspace.error.detail ?? ""}` : undefined;
  const chatError = state.workspace.error ? chatErrorCopy(state.workspace.error) : undefined;

  return (
    <div className="product-shell">
      <Sidebar state={state} page={page} setPage={setPage} run={run} goChat={goChat} onRename={setRenameTarget} />
      <section className="workspace">
        <TopBar state={state} page={page} setPage={setPage} run={run} />
        {applicationErrorIsVisible(state.error) && <ErrorBanner message={state.error!.message} {...(state.error!.detail ? { detail: state.error!.detail } : {})} />}
        {routeErrorIsVisible(uiError, page) && !(page === "chat" && state.workspace.error) && <ErrorBanner message={uiError!.message} onDismiss={() => setUiError(undefined)} />}
        {page === "chat" && state.workspace.error && chatError && chatErrorKey !== dismissedChatError && <ErrorBanner label={chatError.label} message={state.workspace.error.message} hint={chatError.hint} {...(state.workspace.error.detail ? { detail: state.workspace.error.detail } : {})} onDismiss={() => setDismissedChatError(chatErrorKey)} />}
        <ApprovalDock approvals={state.workspace.approvals} state={state} run={run} />
        {page === "home" && <HomePage state={state} run={run} goChat={goChat} />}
        {page === "chat" && <Conversation state={state} run={run} inspectorOpen={inspectorOpen} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} closeInspector={() => setInspectorOpen(false)} openInspector={openInspector} />}
        {page === "history" && <HistoryPage state={state} run={run} goChat={goChat} onRename={setRenameTarget} />}
        {page === "usage" && <UsagePage state={state} run={run} />}
        {page === "settings" && <SettingsPage state={state} run={run} />}
        {page === "help" && <HelpPage />}
        {page === "updates" && <UpdatesPage state={state} run={run} />}
        {state.usage.limitRecovery && <LimitRecovery state={state} run={run} setPage={setPage} />}
        {renameTarget && <RenameDialog target={renameTarget} run={run} onClose={() => setRenameTarget(undefined)} />}
      </section>
      <StatusRibbon state={state} />
    </div>
  );
}

function Sidebar({ state, page, setPage, run, goChat, onRename }: { state: DesktopStateDto; page: Page; setPage(page: Page): void; run: Runner; goChat(): void; onRename(target: RenameTarget): void }): JSX.Element {
  const project = state.workspace.activeProject;
  const recent = state.history.filter((record) => !record.archived).slice(0, 7);
  const navigate = (next: Page): void => setPage(next);
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate("home")}><BrandMark /><span><strong>EVREN</strong><small>Codex Brıdge</small></span></button>
      <div className="project-block">
        <span className="eyebrow">ETKİN PROJE</span>
        {project ? <div className="project-name" title={project.path}><strong>{project.name}</strong><small>Yerel çalışma alanı</small></div> : <p className="muted">Açık proje yok</p>}
        <button className="button secondary full" onClick={() => void run(() => window.evrenDesktop.projects.openFolder())}>Proje Aç</button>
        <button className="button primary full" disabled={!project || isTurnBusy(state)} onClick={() => void run(async () => { const next = await window.evrenDesktop.threads.start(); goChat(); return next; })}>＋ Yeni Sohbet</button>
      </div>
      <nav className="primary-nav" aria-label="Ana gezinme">
        <NavButton active={page === "home"} label="Ana Sayfa" icon="⌂" onClick={() => navigate("home")} />
        <NavButton active={page === "history"} label="Geçmiş" icon="◷" onClick={() => navigate("history")} />
        <NavButton active={page === "usage"} label="Kullanım" icon="◫" onClick={() => navigate("usage")} />
      </nav>
      <div className="recent-work">
        <div className="section-row"><span className="eyebrow">SON ÇALIŞMALAR</span><button onClick={() => navigate("history")}>Tümünü gör</button></div>
        <div className="thread-list">
          {recent.map((record) => <div className="thread-row-wrap" key={record.threadId}><button className={record.threadId === state.workspace.selectedThreadId ? "thread-row active" : "thread-row"} disabled={!record.available || !state.codex.ready} title={record.projectPath} onClick={() => void run(async () => { const next = await window.evrenDesktop.history.continue({ threadId: record.threadId }); goChat(); return next; })}><span>{record.pinned ? "◆ " : ""}{record.title}</span><small>{record.projectName} · {relativeTime(record.updatedAt)}</small></button><details className="thread-menu"><summary aria-label={`${record.title} işlemleri`}>•••</summary><div><button onClick={() => void run(() => window.evrenDesktop.history.pin({ threadId: record.threadId, pinned: !record.pinned }))}>{record.pinned ? "Sabitlemeyi kaldır" : "Sabitle"}</button><button onClick={() => onRename({ threadId: record.threadId, title: record.title })}>Yeniden adlandır</button><button className="remove" onClick={() => { if (window.confirm("Bu sohbet Codex'te arşivlenecek ve yerel geçmişten kaldırılacak. Proje dosyaları etkilenmez. Devam edilsin mi?")) void run(() => window.evrenDesktop.history.archive({ threadId: record.threadId, archived: true })); }}>Sohbeti kaldır</button></div></details></div>)}
          {recent.length === 0 && <p className="empty-list">İlk mesajınızı gönderdikten sonra çalışmalar burada görünür.</p>}
        </div>
      </div>
      <nav className="footer-nav">
        <NavButton active={page === "updates"} label="Güncellemeler" icon="↻" onClick={() => navigate("updates")} badge={state.updates.desktop.status === "update_available"} />
        <NavButton active={page === "settings"} label="Ayarlar" icon="⚙" onClick={() => navigate("settings")} />
        <NavButton active={page === "help"} label="Yardım" icon="?" onClick={() => navigate("help")} />
      </nav>
    </aside>
  );
}

function NavButton({ active, label, icon, onClick, badge = false }: { active: boolean; label: string; icon: string; onClick(): void; badge?: boolean }): JSX.Element {
  return <button className={active ? "nav-button active" : "nav-button"} aria-current={active ? "page" : undefined} title={label} onClick={onClick}><span aria-hidden="true">{icon}</span><b>{label}</b>{badge && <i aria-label="Güncelleme var" />}</button>;
}

function TopBar({ state, page, setPage, run }: { state: DesktopStateDto; page: Page; setPage(page: Page): void; run: Runner }): JSX.Element {
  const displayModel = state.workspace.selectedThreadModel ?? state.selectedModelId ?? "";
  const heading = page === "chat" ? (state.workspace.draftActive ? "Yeni Sohbet" : state.history.find((record) => record.threadId === state.workspace.selectedThreadId)?.title ?? state.workspace.activeProject?.name ?? "Sohbet") : pageTitle(page);
  const selectModel = async (modelId: string): Promise<void> => {
    if (state.workspace.selectedThreadId && modelId !== state.workspace.selectedThreadModel) {
      if (!window.confirm("Mevcut sohbetin modeli değiştirilemez. Seçtiğiniz modelle yeni bir sohbet taslağı açılsın mı?")) return;
      await run(async () => { await window.evrenDesktop.models.select({ modelId }); setPage("chat"); return window.evrenDesktop.threads.start(); });
      return;
    }
    await run(() => window.evrenDesktop.models.select({ modelId }));
  };
  const modelControl = modelControlPresentation(state, isTurnBusy(state));
  const selectableModels = state.models.filter((model) => model.selectable);
  const codexStatus = codexRuntimeStatus(state);
  const evrenStatus = evrenRuntimeStatus(state);
  const linkTone = evrenStatus.tone === "danger" || codexStatus.tone === "danger" ? "danger" : evrenStatus.tone === "warn" || codexStatus.tone === "warn" ? "warn" : evrenStatus.tone === "busy" || codexStatus.tone === "busy" ? "active" : "idle";
  return (
    <header className="topbar">
      <div className="topbar-title"><span className="topbar-kicker">EVREN // {page === "chat" ? "AKTİF SOHBET" : "ÇALIŞMA ALANI"}</span><h1>{heading}</h1><p><span className="project-led" />{state.workspace.activeProject?.name ?? "Yerel proje seçilmedi"}</p></div>
      <div className="topbar-controls">
        <label className="model-control"><span className="model-glyph" aria-hidden="true">◇</span><span className="model-control-copy"><small>ÇALIŞMA MODELİ</small><select value={selectableModels.length ? displayModel : ""} disabled={modelControl.disabled} aria-busy={modelControl.placeholder === "Modeller yükleniyor…"} onChange={(event) => void selectModel(event.target.value)}>{modelControl.placeholder && <option value="">{modelControl.placeholder}</option>}{selectableModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select></span></label>
        <div className={`runtime-cluster ${linkTone}`} aria-label="EVREN ve Codex çalışma zamanı durumu">
          <ConnectionBadge label="EVREN" state={evrenStatus.label} tone={evrenStatus.tone} />
          <span className={`runtime-link ${linkTone}`} aria-hidden="true"><i /></span>
          <ConnectionBadge label="Codex" state={codexStatus.label} tone={codexStatus.tone} />
        </div>
      </div>
    </header>
  );
}

function HomePage({ state, run, goChat }: { state: DesktopStateDto; run: Runner; goChat(): void }): JSX.Element {
  const next = state.history.find((record) => !record.archived);
  return <main className="page home-page"><section className="hero"><div><span className="eyebrow">EVREN CODEX BRIDGE</span><h2>Projenizle güvenli ve odaklı çalışın.</h2><p>Yerel bir proje açın, Codex'e görevinizi anlatın ve daha sonra aynı gerçek sohbete kaldığınız yerden dönün.</p></div>{!state.workspace.activeProject && <button className="button primary" onClick={() => void run(() => window.evrenDesktop.projects.openFolder())}>Proje Aç</button>}</section>{next && <section className="continue-card"><div className="continue-icon">↳</div><div><span className="eyebrow">ÇALIŞMAYA DEVAM ET</span><h3>{next.title}</h3><p>{next.lastUserPreview || next.lastAssistantPreview || "Yeni bir istek göndermeden gerçek Codex sohbetini sürdürün."}</p><div className="metadata"><span>{next.projectName}</span><span>{next.model}</span><span>{relativeTime(next.updatedAt)}</span>{!next.available && <span className="warning-text">Codex'te kullanılamıyor</span>}</div></div><button className="button primary" disabled={!next.available || !state.codex.ready} onClick={() => void run(async () => { const result = await window.evrenDesktop.history.continue({ threadId: next.threadId }); goChat(); return result; })}>Çalışmaya Devam Et</button></section>}<section className="home-grid"><div className="panel"><div className="panel-heading"><h3>Son Projeler</h3></div>{state.workspace.recentProjects.length ? state.workspace.recentProjects.map((project) => <button className="project-card" key={project.path} disabled={!project.exists} title={project.path} onClick={() => void run(() => window.evrenDesktop.projects.openRecent({ path: project.path }))}><span className="folder-icon">▱</span><span><strong>{project.name}</strong><small>{project.exists ? "Yerel proje" : "Klasör kullanılamıyor"}</small></span></button>) : <p className="empty-list">Başlamak için sol menüden bir proje açın.</p>}</div><div className="panel quick-start"><h3>Yeni bir kodlama sohbeti</h3><p>{state.workspace.activeProject ? "Hazır olduğunuzda sol menüdeki Yeni Sohbet düğmesiyle başlayın. Codex, onay ayarlarınıza bağlı olarak proje dosyalarını inceleyebilir ve düzenleyebilir." : "Önce denetiminizdeki yerel bir proje klasörünü açın; uygulama klasörü otomatik olarak taramaz."}</p></div></section></main>;
}

function HistoryPage({ state, run, goChat, onRename }: { state: DesktopStateDto; run: Runner; goChat(): void; onRename(target: RenameTarget): void }): JSX.Element {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const projects = [...new Set(state.history.map((record) => record.projectName))];
  const records = state.history.filter((record) => !record.archived && (project === "all" || record.projectName === project) && searchRecord(record, query));
  return <main className="page"><section className="page-intro"><div><h2>Geçmiş</h2><p>Gezinme için güvenli yerel dizin. Sohbetlerin asıl kaynağı Codex'tir.</p></div></section><div className="toolbar"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Başlıklarda ve görünür önizlemelerde ara" /><select value={project} onChange={(event) => setProject(event.target.value)}><option value="all">Tüm projeler</option>{projects.map((name) => <option key={name}>{name}</option>)}</select></div><section className="history-list">{records.map((record) => <HistoryCard key={record.threadId} record={record} state={state} run={run} goChat={goChat} onRename={onRename} />)}{records.length === 0 && <div className="empty-panel">Eşleşen sohbet bulunamadı.</div>}</section></main>;
}

function HistoryCard({ record, state, run, goChat, onRename }: { record: HistoryRecordDto; state: DesktopStateDto; run: Runner; goChat(): void; onRename(target: RenameTarget): void }): JSX.Element {
  const continueWork = (): void => void run(async () => { const next = await window.evrenDesktop.history.continue({ threadId: record.threadId }); goChat(); return next; });
  return <article className={record.pinned ? "history-card pinned" : "history-card"}>
    <button className="history-main" disabled={!record.available || !state.codex.ready} onClick={continueWork} aria-label={`${record.title} sohbetine devam et`}>
      <span className={record.available ? "history-status available" : "history-status"} aria-hidden="true" />
      <span className="history-content">
        <span className="history-title-row"><strong>{record.title}</strong>{record.pinned && <small>★ SABİT</small>}</span>
        <span className="history-meta"><span>{record.projectName}</span><span>{record.model}</span><span>{relativeTime(record.updatedAt)}</span></span>
        <p>{record.lastUserPreview || record.lastAssistantPreview || "Henüz görünür mesaj önizlemesi yok."}</p>
        {(record.insights || record.changes) && <span className="history-insights">{record.insights && <i>{formatCompact(record.insights.totalTokens)} token · {record.insights.toolCalls} araç</i>}{record.changes && <i>{record.changes.filesChanged} dosya · +{record.changes.additions} −{record.changes.deletions}</i>}</span>}
      </span>
    </button>
    <div className="history-actions" aria-label={`${record.title} sohbet işlemleri`}>
      <button className={record.pinned ? "history-action icon pin active" : "history-action icon pin"} title={record.pinned ? "Sabitlemeyi kaldır" : "Sabitle"} aria-label={record.pinned ? "Sabitlemeyi kaldır" : "Sabitle"} aria-pressed={record.pinned} onClick={() => void run(() => window.evrenDesktop.history.pin({ threadId: record.threadId, pinned: !record.pinned }))}><HistoryIcon name="star" filled={record.pinned} /></button>
      <button className="history-action icon" title="Yeniden adlandır" aria-label="Yeniden adlandır" onClick={() => onRename({ threadId: record.threadId, title: record.title })}><HistoryIcon name="edit" /></button>
      <button className="history-action icon remove" title="Sohbeti kaldır" aria-label="Sohbeti kaldır" onClick={() => { if (window.confirm("Bu sohbet Codex'te arşivlenecek ve yerel geçmişten kaldırılacak. Proje dosyaları etkilenmez. Devam edilsin mi?")) void run(() => window.evrenDesktop.history.archive({ threadId: record.threadId, archived: true })); }}><HistoryIcon name="trash" /></button>
      <button className="history-action resume" disabled={!record.available || !state.codex.ready} onClick={continueWork}><span>Devam Et</span><HistoryIcon name="resume" /></button>
    </div>
  </article>;
}

function RenameDialog({ target, run, onClose }: { target: RenameTarget; run: Runner; onClose(): void }): JSX.Element {
  const [title, setTitle] = useState(target.title);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) { setError("Sohbet adı boş bırakılamaz."); return; }
    setError(undefined);
    await run(async () => {
      const next = await window.evrenDesktop.history.rename({ threadId: target.threadId, title: nextTitle });
      onClose();
      return next;
    });
  };
  return <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title"><span className="eyebrow">SOHBET ADI</span><h2 id="rename-title">Yeniden adlandır</h2><form onSubmit={(event) => void submit(event)}><label className="credential-field"><span>Yeni ad</span><input autoFocus value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></label>{error && <p className="notice error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>İptal</button><button className="button primary" type="submit">Kaydet</button></div></form></section></div>;
}

function Conversation({ state, run, inspectorOpen, inspectorTab, setInspectorTab, closeInspector, openInspector }: {
  state: DesktopStateDto;
  run: Runner;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  setInspectorTab(tab: InspectorTab): void;
  closeInspector(): void;
  openInspector(tab: InspectorTab): void;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const elapsedMs = useTurnElapsed(state.workspace.turn);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [state.workspace.items, state.workspace.turn.phase]);
  if (!state.workspace.activeProject) return <EmptyState title="Bir proje açın" text="EVREN yalnızca seçtiğiniz yerel klasör içinde çalışır." action="Proje Aç" onAction={() => void run(() => window.evrenDesktop.projects.openFolder())} />;
  if (!state.workspace.selectedThreadId && !state.workspace.draftActive) return <EmptyState title="Yeni bir sohbet başlatın" text="Taslak, ilk geçerli mesajı gönderene kadar geçmişe eklenmez." action="Yeni Sohbet" onAction={() => void run(() => window.evrenDesktop.threads.start())} />;
  const projectRoot = state.workspace.activeProject?.path;
  const groups = groupConversationItems(state.workspace.items);
  const status = turnStatusLabel(state.workspace.turn);
  const statusWithDuration = status && elapsedMs !== undefined ? `${status} · ${formatTurnDuration(elapsedMs)}` : status;
  const settled = state.workspace.turn.phase === "completed" || state.workspace.turn.phase === "failed" || state.workspace.turn.phase === "interrupted";
  return <div className={inspectorOpen ? "chat-workspace inspector-open" : "chat-workspace"}><div className="conversation-layout"><ModelRoutePanel state={state} /><main className="conversation" aria-live="polite">{state.workspace.historyCursor && <button className="load-earlier" onClick={() => void run(() => window.evrenDesktop.threads.loadEarlier({ threadId: state.workspace.selectedThreadId! }))}>Önceki mesajları yükle</button>}{state.workspace.items.length === 0 && <div className="conversation-empty"><BrandMark motion /><span className="eyebrow">YENİ KODLAMA SOHBETİ</span><h2>Ne üzerinde çalışalım?</h2><p>Hedefinizi ve beklediğiniz sonucu anlatın. Codex proje içinde çalışırken komut, dosya ve onay etkinlikleri burada görünür kalır.</p><div className="starter-hints" aria-label="Başlangıç ipuçları"><span>Bir hatayı incele</span><span>Bir özellik geliştir</span><span>Kodu açıkla</span></div>{state.workspace.draftActive && <small>Bu taslak ilk başarılı gönderime kadar geçmişe kaydedilmez.</small>}</div>}{groups.map((group) => group.kind === "completedCommands" ? <CompletedCommands key={`commands:${group.items[0]!.id}`} items={group.items} {...(projectRoot ? { projectRoot } : {})} /> : <ConversationItem key={`${group.item.turnId}:${group.item.id}`} item={group.item} {...(projectRoot ? { projectRoot } : {})} />)}{statusWithDuration && settled && <WorkingIndicator label={statusWithDuration} tone={turnOutcomeTone(state.workspace.turn)} />}{settled && state.workspace.changeReview.phase === "ready" && state.workspace.changeReview.filesChanged > 0 && <button className="turn-change-summary" onClick={() => openInspector("changes")}><span><strong>Değişiklikler</strong><small>{state.workspace.changeReview.filesChanged} dosya</small></span><b>+{state.workspace.changeReview.additions}</b><b>−{state.workspace.changeReview.deletions}</b><em>İncele</em></button>}<div ref={endRef} /></main><Composer state={state} run={run} inspectorOpen={inspectorOpen} onToggleInspector={() => inspectorOpen ? closeInspector() : openInspector(inspectorTab)} openInsights={() => openInspector("conversation")} {...(statusWithDuration ? { statusLabel: statusWithDuration } : {})} /></div>{inspectorOpen && <WorkspaceInspector state={state} run={run} activeTab={inspectorTab} setActiveTab={setInspectorTab} onClose={closeInspector} />}</div>;
}

function WorkspaceInspector({ state, run, activeTab, setActiveTab, onClose }: {
  state: DesktopStateDto;
  run: Runner;
  activeTab: InspectorTab;
  setActiveTab(tab: InspectorTab): void;
  onClose(): void;
}): JSX.Element {
  const tabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    { id: "changes", label: "Değişiklikler", count: state.workspace.changeReview.filesChanged },
    { id: "permissions", label: "İzinler", count: state.workspace.approvals.filter((approval) => approval.threadId === state.workspace.selectedThreadId).length },
    { id: "conversation", label: "Sohbet" },
  ];
  return <aside className="workspace-inspector" aria-label="Çalışma alanı denetçisi"><header><div role="tablist" aria-label="Denetçi sekmeleri">{tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.count ? <span>{tab.count}</span> : null}</button>)}</div><button className="inspector-close" aria-label="Denetçiyi kapat" title="Kapat" onClick={onClose}>×</button></header><div className="inspector-body" role="tabpanel">{activeTab === "changes" && <ChangeReviewPanel state={state} run={run} />}{activeTab === "permissions" && <PermissionCenter state={state} run={run} />}{activeTab === "conversation" && <ConversationInsights state={state} />}</div></aside>;
}

function ChangeReviewPanel({ state, run }: { state: DesktopStateDto; run: Runner }): JSX.Element {
  const review = state.workspace.changeReview;
  const [selectedId, setSelectedId] = useState<string>();
  const [diff, setDiff] = useState<ChangeDiffDto>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const selected = review.files.find((file) => file.id === selectedId) ?? review.files[0];
  useEffect(() => {
    if (!selected) { setSelectedId(undefined); setDiff(undefined); return; }
    if (selectedId !== selected.id) setSelectedId(selected.id);
  }, [review.files, selected, selectedId]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setLoading(true); setError(undefined); setExpanded(false);
    void window.evrenDesktop.changes.getDiff({ changeId: selected.id })
      .then((next) => { if (active) setDiff(next); })
      .catch((reason) => { if (active) setError(readError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selected?.id]);
  if (review.phase === "idle") return <InspectorEmpty title="Henüz görev değişikliği yok" text="Yeni bir Codex turu başladığında çalışma ağacı baseline'ı burada izlenir." />;
  if (review.phase === "error" || review.phase === "nonGit") return <div className="inspector-section"><h3>Değişiklikler</h3><p className="inspector-notice">{review.message}</p>{review.files.map((file) => <ChangeRow key={file.id} file={file} selected={false} onSelect={() => undefined} />)}</div>;
  const lines = diff?.diff.split(/\r?\n/) ?? [];
  const visibleLines = lines.slice(0, expanded ? 2_500 : 500);
  const keep = (): void => { if (selected) void run(() => window.evrenDesktop.changes.keep({ changeId: selected.id })); };
  const revert = (): void => {
    if (!selected || !selected.canRevert) return;
    const target = selected.previousPath ? `${selected.previousPath} → ${selected.path}` : selected.path;
    if (window.confirm(`${target} için yalnızca bu Codex turunun farkı geri alınacak. Devam edilsin mi?`)) {
      void run(() => window.evrenDesktop.changes.revert({ changeId: selected.id }));
    }
  };
  return <div className="change-review"><section className="change-summary"><div><strong>{review.filesChanged} dosya</strong><span>+{review.additions}</span><span>−{review.deletions}</span></div><small>{review.phase === "tracking" ? "Canlı izleniyor" : "Tur farkı hazır"}</small>{review.baselineDirty && <p>Başlangıç çalışma ağacı kirliydi. Liste yalnızca bu turdan sonra oluşan net farkı gösterir.</p>}</section><div className="change-file-list" aria-label="Değişen dosyalar">{review.files.map((file) => <ChangeRow key={file.id} file={file} selected={file.id === selected?.id} onSelect={() => setSelectedId(file.id)} />)}{review.files.length === 0 && <InspectorEmpty title="Net değişiklik yok" text="Mevcut çalışma ağacı tur başlangıcıyla aynı." />}</div>{selected && <section className="diff-view"><header><div><span className={`file-status ${selected.status}`}>{changeStatusCode(selected.status)}</span><strong title={selected.path}>{selected.path}</strong>{selected.previousPath && <small>{selected.previousPath} konumundan</small>}</div><div><button className="button secondary" disabled={selected.reviewState === "kept"} onClick={keep}>{selected.reviewState === "kept" ? "Korundu" : "Değişikliği Koru"}</button><button className="button danger" disabled={!selected.canRevert} title={selected.revertBlockedReason} onClick={revert}>Geri Al</button></div></header>{!selected.canRevert && selected.revertBlockedReason && <p className="revert-warning">{selected.revertBlockedReason}</p>}{loading && <p className="muted">Diff yükleniyor…</p>}{error && <p className="notice error">{error}</p>}{diff && <><pre className="unified-diff" aria-label={`${selected.path} unified diff`}>{visibleLines.map((line, index) => <span className={diffLineClass(line)} key={`${index}:${line.slice(0, 24)}`}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre>{lines.length > visibleLines.length && <button className="load-more-diff" onClick={() => setExpanded(true)} disabled={expanded}>{expanded ? `İlk ${visibleLines.length} satır gösteriliyor` : `${Math.min(2_500, lines.length) - visibleLines.length} satır daha göster`}</button>}{diff.truncated && <p className="revert-warning">Diff güvenli aktarım sınırında kısaltıldı; değişiklik özeti gizlenmedi.</p>}</>}</section>}</div>;
}

function ChangeRow({ file, selected, onSelect }: { file: ChangeFileDto; selected: boolean; onSelect(): void }): JSX.Element {
  return <button className={selected ? "change-row selected" : "change-row"} onClick={onSelect}><span className={`file-status ${file.status}`}>{changeStatusCode(file.status)}</span><span><strong>{file.path}</strong>{file.previousPath && <small>{file.previousPath}</small>}</span><b>+{file.additions}</b><b>−{file.deletions}</b>{file.reviewState === "kept" && <em>Korundu</em>}</button>;
}

function PermissionCenter({ state, run }: { state: DesktopStateDto; run: Runner }): JSX.Element {
  const threadId = state.workspace.selectedThreadId;
  const pending = state.workspace.approvals.filter((approval) => approval.threadId === threadId);
  const grants = state.workspace.permissions.grants.filter((grant) => grant.threadId === threadId);
  const history = state.workspace.permissions.history.filter((activity) => activity.threadId === threadId).slice(0, 20);
  return <div className="permission-center"><section className="inspector-section"><span className="eyebrow">BEKLEYEN İSTEKLER</span><h3>{pending.length ? `${pending.length} karar bekliyor` : "Bekleyen izin yok"}</h3>{pending.map((approval) => <article className="permission-request" key={approval.id}><strong>{approval.type === "command" ? "Komut çalıştırma" : "Dosya değişikliği"}</strong>{approval.command && <code>{approval.command}</code>}{approval.cwd && <small>Çalışma dizini · {displayProjectLocation(approval.cwd, state.workspace.activeProject?.path)}</small>}{approval.grantRoot && <small>İstenen kök · {displayProjectLocation(approval.grantRoot, state.workspace.activeProject?.path)}</small>}{approval.reason && <p>{approval.reason}</p>}{approval.context.map((context) => <small key={context}>{context}</small>)}<ApprovalActions approval={approval} run={run} compact /></article>)}</section><section className="inspector-section"><span className="eyebrow">OTURUM İZİNLERİ</span><h3>{grants.length ? `${grants.length} etkin onay` : "Etkin oturum onayı yok"}</h3>{grants.map((grant) => <article className="permission-grant" key={grant.id}><strong>{grant.scope}</strong>{grant.detail && <code>{grant.detail}</code>}<small>{new Date(grant.grantedAt).toLocaleTimeString("tr-TR")}</small><p>{grant.revokeReason}</p></article>)}{grants.length > 0 && <p className="inspector-notice">{state.workspace.permissions.revocationReason} Bu, çalışan komutları veya tamamlanmış yan etkileri geri almaz.</p>}</section><section className="inspector-section"><span className="eyebrow">BU SOHBETTEKİ KARARLAR</span>{history.length === 0 ? <p className="muted">Henüz onay etkinliği yok.</p> : <ol className="permission-history">{history.map((activity) => <li key={activity.id}><span>{permissionActivityLabel(activity.type)}</span><strong>{activity.summary}</strong><small>{new Date(activity.occurredAt).toLocaleTimeString("tr-TR")}</small></li>)}</ol>}</section></div>;
}

function ConversationInsights({ state }: { state: DesktopStateDto }): JSX.Element {
  const insights = state.workspace.conversationInsights;
  const record = state.history.find((candidate) => candidate.threadId === state.workspace.selectedThreadId);
  if (!insights) return <InspectorEmpty title="Henüz kullanım verisi yok" text="İlk doğrulanmış EVREN yanıtından sonra bu sohbete ait sayaçlar kalıcı olarak görünür." />;
  return <div className="conversation-insights">
    <section className="insight-hero"><span className="eyebrow">BU SOHBET</span><strong>{formatCompact(insights.totalTokens)} token</strong><div><span>{insights.inferences} inference</span><span>{insights.toolCalls} araç</span><span>{formatDuration(insights.elapsedMs)}</span></div></section>
    <dl className="insight-grid"><dt>Input</dt><dd>{formatCompact(insights.inputTokens)} token</dd><dt>Output</dt><dd>{formatCompact(insights.outputTokens)} token</dd>{insights.cachedTokens !== undefined && <><dt>Cached</dt><dd>{formatCompact(insights.cachedTokens)} token</dd></>}<dt>EVREN istekleri</dt><dd>{insights.requests}</dd><dt>Komutlar</dt><dd>{insights.commandCalls}</dd><dt>Komut süresi</dt><dd>{formatDuration(insights.commandTimeMs)}</dd><dt>Tamamlanan turlar</dt><dd>{insights.completedTurns}</dd></dl>
    {record?.changes && <section className="inspector-section"><span className="eyebrow">DEĞİŞİKLİK ETKİNLİĞİ</span><p>{record.changes.coverage === "observed" ? `${record.changes.filesChanged} gözlenen dosya · satır toplamı doğrulanmadı` : `${record.changes.filesChanged} dosya · +${record.changes.additions} −${record.changes.deletions}`}</p>{record.changes.coverage === "observed" && <small>Git olmayan projelerde yalnızca Codex'in yapılandırılmış dosya olayları sayılır; kabuk komutlarının ürettiği dosyalar eksik olabilir.</small>}</section>}
    <details className="insight-details"><summary>Performans ve bağlam tanılaması</summary><dl className="insight-grid"><dt>Aktif bağlam</dt><dd>{formatBytesMaybe(insights.activeContextBytes, "Yok")}</dd><dt>Tepe bağlam</dt><dd>{formatBytesMaybe(insights.peakContextBytes, "Yok")}</dd><dt>Replay</dt><dd>{formatBytes(insights.replayBytes)}</dd><dt>Upstream yükü</dt><dd>{formatBytes(insights.payloadBytes)}</dd><dt>Tepe upstream yükü</dt><dd>{formatBytes(insights.peakPayloadBytes)}</dd><dt>Talimat yükü</dt><dd>{formatBytes(insights.instructionBytes)}</dd><dt>Araç kataloğu yükü</dt><dd>{formatBytes(insights.toolCatalogBytes)}</dd><dt>EVREN / sağlayıcı</dt><dd>{formatDuration(insights.providerWaitMs)}</dd><dt>Yanıt ayrıştırma</dt><dd>{formatDuration(insights.responseParseMs)}</dd><dt>Yerel sonuç işleme</dt><dd>{formatDuration(insights.resultProcessingMs)}</dd><dt>Paket komutları</dt><dd>{formatDuration(insights.packageTimeMs)}</dd><dt>Test / build</dt><dd>{formatDuration(insights.testBuildTimeMs)}</dd><dt>Tekrarlanan komutlar</dt><dd>{insights.repeatedCommandCalls}</dd><dt>Sıkıştırma</dt><dd>{insights.compactions}</dd></dl><p>Bu değerler bayttır; token olarak sunulmaz.</p></details>
    {!insights.accountingCertain && <p className="revert-warning">Sağlayıcı muhasebesinin bir bölümü kesin değil.</p>}
  </div>;
}

function InspectorEmpty({ title, text }: { title: string; text: string }): JSX.Element {
  return <div className="inspector-empty"><span aria-hidden="true">◇</span><strong>{title}</strong><p>{text}</p></div>;
}

function CompletedCommands({ items, projectRoot }: { items: Array<ConversationItemDto & { kind: "command" }>; projectRoot?: string }): JSX.Element {
  return <details className="activity-card command-group"><summary><span className="activity-icon">✓</span><span className="activity-heading"><strong>{items.length} komut tamamlandı</strong><small>Başarılı etkinlik grubu</small></span><span className="activity-disclosure">Ayrıntılar</span></summary><div className="activity-body">{items.map((item) => <details className="grouped-command" key={item.id}><summary><code title={item.command}>{item.command}</code><small>{item.durationMs === undefined ? "Tamamlandı" : `${item.durationMs} ms`}</small></summary><div><small title={item.cwd}>{displayProjectLocation(item.cwd, projectRoot)}{item.exitCode === undefined ? "" : ` · çıkış ${item.exitCode}`}</small>{item.output && <pre>{item.output}</pre>}</div></details>)}</div></details>;
}

function ModelRoutePanel({ state }: { state: DesktopStateDto }): JSX.Element {
  const routes = state.workspace.modelRoutes;
  const latest = routes.at(-1);
  if (!latest) return <></>;
  const label = latest.status === "verified"
    ? `Upstream model doğrulandı · ${latest.upstreamEffectiveModel}`
    : latest.status === "mismatch"
      ? "Model yönlendirmesi uyuşmuyor"
      : latest.status === "pending"
        ? `Upstream doğrulaması bekleniyor · ${latest.codexRequestedModel}`
        : `Sohbet modeli yapılandırıldı · ${latest.codexRequestedModel}`;
  return <details className={`model-route ${latest.status}`}><summary><span aria-hidden="true">{latest.status === "verified" ? "✓" : latest.status === "mismatch" ? "!" : "◌"}</span><strong>{label}</strong><small>Model kanıtı</small></summary><div className="model-route-list">{[...routes].reverse().map((route) => <article key={route.turnId ?? `${route.threadId}:thread`}><div><b>{route.turnId ? `İşlem ${shortId(route.turnId)}` : "Sohbet"}</b><em>{modelRouteStatus(route.status)}</em></div><dl><dt>Desktop seçimi</dt><dd>{route.desktopSelectedModel}</dd><dt>Codex isteği</dt><dd>{route.codexRequestedModel}</dd><dt>Bridge etkin model</dt><dd>{route.bridgeEffectiveModel}</dd><dt>EVREN upstream</dt><dd>{route.upstreamEffectiveModel ?? "İlk inference bekleniyor"}</dd><dt>Provider ID</dt><dd>{route.providerId}</dd></dl>{route.inferenceNumber !== undefined && <small>Bridge inference #{route.inferenceNumber}{route.observedAt ? ` · ${new Date(route.observedAt).toLocaleTimeString("tr-TR")}` : ""}</small>}</article>)}</div></details>;
}

function ConversationItem({ item, projectRoot }: { item: ConversationItemDto; projectRoot?: string }): JSX.Element {
  if (item.kind === "userMessage") return <article className="message user"><div className="message-label">Siz</div><p>{item.text}</p>{item.attachments.map((name) => <span className="attachment-chip" key={name}>Görsel · {name}</span>)}</article>;
  if (item.kind === "assistantMessage") return <article className="message assistant"><div className="message-label">EVREN Codex Bridge</div><div className="message-text">{item.text}</div></article>;
  if (item.kind === "command") return <details className={`activity-card command-card ${item.status}`} open={item.status === "running" || item.status === "failed"}><summary><span className="activity-icon">{activityIcon(item.status)}</span><span className="activity-heading"><strong>{item.status === "running" ? "Komut çalışıyor" : item.status === "failed" ? "Komut başarısız" : "Komut"}</strong><small>{activityStatusText(item.status)}</small></span><code title={item.command}>{item.command}</code></summary><div className="activity-body"><small title={item.cwd}>{displayProjectLocation(item.cwd, projectRoot)}{item.exitCode === undefined ? "" : ` · çıkış ${item.exitCode}`}{item.durationMs === undefined ? "" : ` · ${item.durationMs} ms`}</small>{item.output && <pre>{item.output}</pre>}</div></details>;
  if (item.kind === "fileChange") return <details className={`activity-card file-card ${item.status}`} open={item.status === "running" || item.status === "failed"}><summary><span className="activity-icon">{activityIcon(item.status)}</span><span className="activity-heading"><strong>Dosya değişiklikleri</strong><small>{activityStatusText(item.status)}</small></span><span className="activity-disclosure">{item.changes.length} dosya</span></summary><div className="activity-body file-list">{item.changes.map((change, index) => <div key={`${change.path}:${index}`}><span className={`change ${change.action}`}>{changeLabel(change.action)}</span><code title={change.path}>{displayFilePath(change.path, projectRoot)}</code>{change.diff && <pre>{displayDiff(change.diff, projectRoot)}</pre>}</div>)}</div></details>;
  if (item.kind === "diff") return <details className="activity-card diff-card"><summary><span className="activity-icon">±</span><span className="activity-heading"><strong>İşlem farkı</strong><small>Değişiklik özeti</small></span></summary><div className="activity-body"><pre>{displayDiff(item.diff, projectRoot)}</pre></div></details>;
  if (item.kind === "plan") return <section className="activity-card plan-card"><div className="plan-title">Plan</div>{item.explanation && <p>{item.explanation}</p>}<ol>{item.steps.map((step, index) => <li className={step.status} key={`${step.step}:${index}`}>{step.step}</li>)}</ol></section>;
  if (item.kind === "tool") return <article className={`activity-card compact ${item.status}`}><span className="activity-icon">{activityIcon(item.status)}</span><span className="activity-heading"><strong>{item.label}</strong><small>{item.detail || activityStatusText(item.status)}</small></span></article>;
  return <article className={`status-note ${item.tone}`}>{item.message}</article>;
}

function Composer({ state, run, statusLabel, inspectorOpen, onToggleInspector, openInsights }: { state: DesktopStateDto; run: Runner; statusLabel?: string; inspectorOpen: boolean; onToggleInspector(): void; openInsights(): void }): JSX.Element {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const threadId = state.workspace.selectedThreadId;
  const busy = isTurnBusy(state);
  const imageInput = imageInputPresentation(state);
  const imageBlocked = Boolean(state.workspace.pendingAttachment && !imageInput.supported);
  const send = async (): Promise<void> => { if (sending || busy || imageBlocked || (!text.trim() && !state.workspace.pendingAttachment)) return; setSending(true); const draft = text; try { const accepted = await run(() => window.evrenDesktop.chat.send({ ...(threadId ? { threadId } : {}), text: draft, attachmentIds: state.workspace.pendingAttachment ? [state.workspace.pendingAttachment.id] : [], clientUserMessageId: crypto.randomUUID() })); if (accepted) setText(""); } finally { setSending(false); } };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } };
  const addProjectFile = async (): Promise<void> => { const file = await window.evrenDesktop.projects.chooseFile(); if (file) setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${file.relativePath} `); };
  const chooseImage = async (): Promise<void> => {
    setAttachmentError(undefined);
    try { await window.evrenDesktop.attachments.chooseImage(); }
    catch (error) { setAttachmentError(readError(error)); }
  };
  const insights = state.workspace.conversationInsights;
  const inspectorCount = state.workspace.changeReview.filesChanged + state.workspace.approvals.length;
  return <footer className="composer-wrap">{busy && statusLabel && <div className="active-turn-bar" role="status"><WorkingIndicator label={statusLabel} /><span>Codex çalışıyor</span>{state.workspace.turn.id && threadId && <button className="stop-button" onClick={() => void run(() => window.evrenDesktop.chat.interrupt({ threadId, turnId: state.workspace.turn.id! }))}><span aria-hidden="true">■</span> Durdur</button>}</div>}{state.workspace.pendingAttachment && <div className={imageBlocked ? "selected-attachment blocked" : "selected-attachment"} role="status"><span className="attachment-preview" aria-hidden="true">IMG</span><span className="attachment-copy"><strong>{state.workspace.pendingAttachment.name}</strong><small>{state.workspace.pendingAttachment.mimeType.replace("image/", "").toUpperCase()} · {formatBytes(state.workspace.pendingAttachment.sizeBytes)} · {imageBlocked ? "Model desteği yok" : "Gönderime hazır"}</small></span><button title="Görseli kaldır" aria-label="Görseli kaldır" disabled={busy} onClick={() => void run(() => window.evrenDesktop.attachments.removePending())}>×</button></div>}{attachmentError && <div className="attachment-notice danger" role="alert"><strong>Görsel seçilemedi.</strong><span>{attachmentError} PNG, JPEG veya WebP biçiminde, en fazla 20 MB bir dosya deneyin.</span><button aria-label="Uyarıyı kapat" onClick={() => setAttachmentError(undefined)}>×</button></div>}{imageBlocked && <div className="attachment-notice warning" role="alert"><strong>Bu model görsel kabul etmiyor.</strong><span>Görsel destekli bir modelle yeni sohbet açın veya eki kaldırarak metin gönderin. İstek EVREN'e gönderilmedi.</span></div>}<div className="composer-shell"><div className="composer-utilities" aria-label="Sohbet araçları"><button className="composer-usage" title="Sohbet kullanım ayrıntılarını aç" onClick={openInsights}><span aria-hidden="true">◫</span><strong>{insights ? `${formatCompact(insights.totalTokens)} token · ${insights.toolCalls} araç` : "Sohbet ölçümü yok"}</strong></button><button className={inspectorOpen ? "composer-inspector active" : "composer-inspector"} aria-label={inspectorOpen ? "Denetçiyi kapat" : "Denetçiyi aç"} title={inspectorOpen ? "Denetçiyi kapat" : "Denetçiyi aç"} aria-expanded={inspectorOpen} aria-pressed={inspectorOpen} onClick={onToggleInspector}><span aria-hidden="true">▥</span>{inspectorCount > 0 && <i>{inspectorCount}</i>}</button></div><div className="composer"><textarea aria-label="Sohbet iletisi" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} onKeyDown={keyDown} placeholder={busy ? "Etkin görev tamamlandığında yeni ileti gönderebilirsiniz" : "EVREN'e bir görev verin…"} rows={3} /><div className="composer-actions"><div><button title={imageInput.supported ? "Görsel ekle" : imageInput.label} disabled={busy || !imageInput.supported} onClick={() => void chooseImage()}>▧ Görsel</button><button title="Proje dosyasına başvur" disabled={busy} onClick={() => void addProjectFile()}>＠ Dosya</button><span className={imageInput.supported ? "image-capability supported" : "image-capability"}><i />{imageInput.label}</span></div><button className="send-button" disabled={sending || busy || imageBlocked || (!text.trim() && !state.workspace.pendingAttachment)} onClick={() => void send()}>{sending ? "Gönderiliyor…" : "Gönder ↑"}</button></div></div></div><small className="composer-help">Enter gönderir · Shift+Enter yeni satır ekler · Görsel istekleri otomatik yinelenmez</small></footer>;
}

function UsagePage({ state, run }: { state: DesktopStateDto; run: Runner }): JSX.Element {
  const usage = state.usage;
  const [limits, setLimits] = useState<UsageLimitsInput>(state.settings.limits);
  useEffect(() => setLimits(state.settings.limits), [state.settings.limits]);
  const apply = (): void => void run(() => window.evrenDesktop.usage.applyLimits(limits));
  return <main className="page"><section className="page-intro"><div><span className="eyebrow">KULLANIM VE SINIRLAR</span><h2>Kullanım</h2><p>Sağlayıcı tokenları, istek etkinliği ve token olmayan bağlam ölçümleri birbirinden açıkça ayrılır.</p></div></section><UsageSection title="Geçerli oturum" description="Bu kodlama oturumunun doğrulanmış sağlayıcı ölçümleri."><Metric label="Sohbet tokenları" value={formatPair(usage.sessionTokens, usage.sessionTokenLimit, "İlk istekten sonra görünür")} tone="accent" /><Metric label="Son girdi" value={formatTokenMaybe(usage.lastInputTokens, "Bu oturumda henüz ölçülmedi")} /><Metric label="Son çıktı" value={formatTokenMaybe(usage.lastOutputTokens, "Bu oturumda henüz ölçülmedi")} /><Metric label="Günlük tokenlar" value={formatPair(usage.dailyTokens, usage.dailyTokenLimit, "Henüz veri yok")} {...(usage.accountingCertain === false ? { note: "Sağlayıcı muhasebesi kesin değil" } : {})} /></UsageSection><UsageSection title="İstekler ve araçlar" description="Codex ile Bridge arasındaki gerçek etkinlik sayaçları."><Metric label="İstekler" value={formatPair(usage.requests, usage.requestLimit, "İlk istekten sonra görünür")} /><Metric label="Araç çağrıları" value={formatPair(usage.toolCalls, usage.toolCallLimit, "Henüz araç çağrısı yok")} /><Metric label="Inference" value={formatMaybe(usage.inferences, "İlk istekten sonra görünür")} /><Metric label="Polling" value={formatMaybe(usage.polls, "Henüz polling yapılmadı")} /></UsageSection><UsageSection title="Sağlayıcı ve kredi" description="Yalnızca EVREN tarafından sunulan fiyat ve kredi bilgileri."><Metric label="Fiyatlandırma" value={formatPricing(state)} /><Metric label="Kalan kredi" value={state.bridge.creditsRemaining === undefined ? "Sağlayıcı bu metriği sunmuyor" : `${state.bridge.creditsRemaining} CR`} /><Metric label="En az kalan" value={`${limits.minCreditsRemaining} CR`} /><Metric label="Harcama muhasebesi" value="Kullanılamıyor" note="EVREN güvenilir harcama birimi sunmuyor" /></UsageSection><details className="advanced-metrics"><summary><span><strong>Gelişmiş bağlam tanılaması</strong><small>Bayt, replay ve sıkıştırma ayrıntıları</small></span><b>GÖSTER</b></summary><div className="metric-grid"><Metric label="Aktif bağlam" value={formatBytesMaybe(usage.activeContextBytes, "Bu oturumda henüz ölçülmedi")} note="Bayt; token değildir" /><Metric label="Tepe bağlam" value={formatBytesMaybe(usage.peakContextBytes, "Bu oturumda henüz ölçülmedi")} note="Bayt; token değildir" /><Metric label="Sıkıştırmalar" value={formatMaybe(usage.compactions, "Henüz sıkıştırma yok")} /><Metric label="Bağlam penceresi" value={formatMaybe(usage.windowNumber, "Sağlayıcı bu metriği henüz sunmadı")} /><Metric label="Geçmiş tekrar yükü" value={formatBytesMaybe(usage.replayBytes, "Bu oturumda henüz ölçülmedi")} note="Kanonik geçmiş baytı" /><Metric label="Upstream yükü" value={formatBytesMaybe(usage.payloadBytes, "Bu oturumda henüz ölçülmedi")} note="Bayt; token değildir" /></div></details><section className="settings-card limit-card"><div className="panel-heading"><div><span className="eyebrow">KORUYUCU SINIRLAR</span><h3>Kodlama limitleri</h3><p>Limit değişikliği başarısız isteği yeniden göndermez.</p></div><select aria-label="Limit ön ayarı" value={limits.preset} onChange={(event) => setLimits(presetLimits(event.target.value as UsageLimitsInput["preset"], limits))}><option value="Standard">Standart</option><option value="Coding">Kodlama</option><option value="Custom">Özel</option></select></div><LimitFields limits={limits} setLimits={setLimits} /><button className="button primary" onClick={apply}>Limitleri Uygula</button></section></main>;
}

function LimitFields({ limits, setLimits }: { limits: UsageLimitsInput; setLimits(value: UsageLimitsInput): void }): JSX.Element {
  const field = (key: keyof Omit<UsageLimitsInput, "preset">, label: string, step = "1"): JSX.Element => <label><span>{label}</span><input type="number" min="0" step={step} value={limits[key]} onChange={(event) => setLimits({ ...limits, preset: "Custom", [key]: Number(event.target.value) })} /></label>;
  return <div className="form-grid">{field("maxSessionTokens", "Oturum tokenları")}{field("maxDailyTokens", "Günlük tokenlar")}{field("maxRequestsPerSession", "Oturum istekleri")}{field("maxToolCallsPerSession", "Oturum araçları")}{field("minCreditsRemaining", "En az kalan CR", "0.01")}{field("maxSessionCredits", "Oturum CR limiti", "0.01")}{field("maxDailyCredits", "Günlük CR limiti", "0.01")}</div>;
}

function SettingsPage({ state, run }: { state: DesktopStateDto; run: Runner }): JSX.Element {
  const [changingCredential, setChangingCredential] = useState(false);
  const credential = state.credential.persistence === "secure" ? "Bu cihazda güvenli saklanıyor" : state.credential.persistence === "session" ? "Yalnızca bu oturum" : "Yapılandırılmadı";
  const copyDiagnostics = async (): Promise<void> => { const summary = await window.evrenDesktop.diagnostics.get(); await navigator.clipboard.writeText(summary); };
  return <main className="page"><section className="page-intro"><div><span className="eyebrow">ÜRÜN TERCİHLERİ</span><h2>Ayarlar</h2><p>Görünüm, EVREN bağlantısı, model kataloğu, çalışma zamanı ve güvenli tanılama.</p></div></section><section className="settings-grid"><SettingsSection title="Görünüm" description="Arayüz anında uygulanır ve bu cihazda saklanır." className="settings-wide"><ThemePicker value={state.settings.theme} onChange={(theme) => void run(() => window.evrenDesktop.settings.update({ theme }))} /><Toggle label="Başlangıçta son çalışma alanını aç" checked={state.settings.startupBehavior === "restore"} onChange={(checked) => void run(() => window.evrenDesktop.settings.update({ startupBehavior: checked ? "restore" : "home" }))} /><Toggle label="Son projeleri göster" checked={state.settings.recentProjectsEnabled} onChange={(checked) => void run(() => window.evrenDesktop.settings.update({ recentProjectsEnabled: checked }))} /></SettingsSection><SettingsSection title="EVREN bağlantısı" description="Anahtar değeri hiçbir zaman bu ekrana geri gönderilmez."><SettingRow label="Kimlik bilgisi" value={credential} /><SettingRow label="Bağlantı" value={connectionText(state.evren.status)} /><div className="row-actions"><button className="button secondary" onClick={() => void run(() => window.evrenDesktop.startup.retry())}>Bağlantıyı Sına</button><button className="button secondary" onClick={() => setChangingCredential(true)}>API Anahtarını Değiştir</button></div></SettingsSection><SettingsSection title="Modeller ve ajan" description="Katalog EVREN'den dinamik olarak yüklenir."><SettingRow label="Varsayılan model" value={state.selectedModelId ?? "Kullanılamıyor"} /><SettingRow label="Onay politikası" value="İstek üzerine (sabit)" /><SettingRow label="Sandbox" value="Çalışma alanına yazma (sabit)" /><p className="section-note">Model değişiklikleri yeni sohbet taslaklarına uygulanır; etkin sohbetin özgün modeli değişmez.</p><div className="model-list">{state.models.map((model) => <div key={model.id}><span><strong>{model.id}</strong><small>{model.kind}{model.selectable ? " · sohbette seçilebilir" : " · yalnızca bilgi"}</small></span><small>{model.modalities.join(", ") || "modalite bilgisi yok"} · {model.pricing.mode.toUpperCase()}</small></div>)}</div></SettingsSection><SettingsSection title="Çalışma zamanı" description="Kurulu ve EVREN doğrulanmış Codex durumu."><SettingRow label="Codex sürümü" value={state.codex.version ?? "Kullanılamıyor"} /><SettingRow label="Kaynak" value={state.updates.runtime.source} /><SettingRow label="Uyumluluk" value={compatibilityText(state.codex.compatibility)} /></SettingsSection><SettingsSection title="Güncellemeler" description="Uygulama ve Codex Runtime ayrı kanallardır."><Toggle label="EVREN Codex Bridge güncellemelerini denetle" checked={state.settings.desktopUpdateChecks} onChange={(checked) => void run(() => window.evrenDesktop.settings.update({ desktopUpdateChecks: checked }))} /><Toggle label="Doğrulanmış Codex Runtime güncellemelerini denetle" checked={state.settings.runtimeUpdateChecks} onChange={(checked) => void run(() => window.evrenDesktop.settings.update({ runtimeUpdateChecks: checked }))} /></SettingsSection><SettingsSection title="Gelişmiş ve tanılama" description="Paylaşılabilir özet hassas içerikleri dışarıda bırakır."><p className="section-note">Kimlik bilgileri, yetkilendirme tokenları, istemler, sohbetler, komut çıktıları ve ortam değişkenleri dahil edilmez.</p><button className="button secondary" onClick={() => void copyDiagnostics()}>Güvenli Tanılama Özetini Kopyala</button></SettingsSection><SettingsSection title="Tehlikeli bölge" description="Yerel geçmiş korunur; yalnızca EVREN kimlik bilgisi kaldırılır." className="danger-zone settings-wide"><button className="button danger" onClick={() => { if (window.confirm("EVREN API anahtarı uygulamadan kaldırılsın mı? Yerel geçmiş korunur.")) void run(() => window.evrenDesktop.credentials.clear()); }}>API Anahtarını Kaldır</button></SettingsSection></section>{changingCredential && <CredentialDialog state={state} run={run} onClose={() => setChangingCredential(false)} />}</main>;
}

function CredentialDialog({ state, run, onClose }: { state: DesktopStateDto; run: Runner; onClose(): void }): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [persistence, setPersistence] = useState<PersistenceMode>(state.credential.persistence === "secure" ? "secure" : "session");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const test = async (): Promise<boolean> => {
    if (!apiKey.trim()) return false;
    setBusy(true); setResult(undefined);
    try {
      const response = await window.evrenDesktop.credentials.test({ apiKey });
      setResult(response.ok ? { ok: true, message: `${response.models.length} model güvenli biçimde yüklendi.` } : { ok: false, message: response.error.message });
      return response.ok;
    } finally { setBusy(false); }
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!await test()) return;
    setBusy(true);
    try { await run(() => window.evrenDesktop.credentials.save({ apiKey, persistence })); setApiKey(""); onClose(); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="change-key-title"><span className="eyebrow">EVREN KİMLİK BİLGİSİ</span><h2 id="change-key-title">API Anahtarını Değiştir</h2><form onSubmit={(event) => void submit(event)}><label className="credential-field"><span>Yeni EVREN API anahtarı</span><input autoFocus type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><label className="radio-row"><input type="radio" checked={persistence === "session"} onChange={() => setPersistence("session")} /><span><strong>Yalnızca bu oturum</strong><small>Uygulama kapanınca bellekten silinir.</small></span></label><label className={`radio-row ${state.credential.securePersistenceAvailable ? "" : "disabled"}`}><input type="radio" checked={persistence === "secure"} disabled={!state.credential.securePersistenceAvailable} onChange={() => setPersistence("secure")} /><span><strong>Bu cihazda güvenli sakla</strong><small>Düz metin yedekleme yapılmaz.</small></span></label>{result && <p className={result.ok ? "notice success" : "notice error"}>{result.message}</p>}<div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>İptal</button><button className="button secondary" type="button" disabled={busy || !apiKey.trim()} onClick={() => void test()}>Bağlantıyı Sına</button><button className="button primary" type="submit" disabled={busy || !apiKey.trim()}>Anahtarı Kaydet</button></div></form></section></div>;
}

function UpdatesPage({ state, run }: { state: DesktopStateDto; run: Runner }): JSX.Element {
  const desktop = state.updates.desktop;
  const runtime = state.updates.runtime;
  const unverifiedUpstream = runtime.upstreamVersion && runtime.verifiedVersion && runtime.upstreamVersion !== runtime.verifiedVersion;
  return <main className="page"><section className="page-intro"><div><h2>Güncelleme Merkezi</h2><p>EVREN Codex Bridge ve Codex Runtime birbirinden bağımsız güncellenir.</p></div><button className="button primary" disabled={isTurnBusy(state) || desktop.status === "checking" || runtime.status === "checking"} onClick={() => void run(() => window.evrenDesktop.updates.check())}>Güncellemeleri Kontrol Et</button></section><section className="update-grid"><article className="update-card"><span className="eyebrow">EVREN CODEX BRIDGE</span><h3>{desktop.installedVersion}</h3><SettingRow label="Durum" value={updateStatusText(desktop.status)} />{desktop.availableVersion && <SettingRow label="Kullanılabilir sürüm" value={desktop.availableVersion} />}{desktop.releaseNotes && <p>{desktop.releaseNotes}</p>}{desktop.progressPercent !== undefined && <p>İndirme %{Math.round(desktop.progressPercent)}</p>}<p>{desktop.signed ? "Kod imzalı derleme." : "Bu RC derlemesi kod imzalı değildir. Windows SmartScreen uyarı gösterebilir."}</p>{desktop.status === "update_available" && <button className="button primary" disabled={isTurnBusy(state)} onClick={() => void run(() => window.evrenDesktop.updates.download())}>Güncellemeyi İndir</button>}{desktop.status === "downloaded" && <button className="button primary" disabled={isTurnBusy(state)} onClick={() => void window.evrenDesktop.updates.install()}>Yeniden Başlat ve Güncelle</button>}</article><article className="update-card"><span className="eyebrow">CODEX RUNTIME</span><h3>{runtime.installedVersion ?? "Kullanılamıyor"}</h3><SettingRow label="Durum" value={updateStatusText(runtime.status)} /><SettingRow label="EVREN doğrulanmış" value={runtime.verifiedVersion ?? runtime.testedVersion} />{runtime.upstreamVersion && <SettingRow label="Upstream en yeni" value={runtime.upstreamVersion} />}<SettingRow label="Kaynak" value={runtime.source} /><p>Yalnızca güvenilen HTTPS kaynağındaki EVREN doğrulanmış manifestler kabul edilir. Atomik geçişten önce SHA-256, dosya karmaları, sürüm ve App Server el sıkışması doğrulanır; hata durumunda geri alınır.</p>{unverifiedUpstream && <p className="warning-text">Daha yeni bir Codex sürümü var ancak henüz EVREN tarafından doğrulanmadı. Doğrulanmış runtime kullanılmaya devam eder.</p>}{runtime.error && <p className="warning-text">Runtime güncellemesi güvenli biçimde başarısız oldu: {runtime.error}</p>}{isTurnBusy(state) && <p className="warning-text">Codex Runtime güncellemesinden önce etkin görevi bitirin veya durdurun.</p>}{runtime.status === "update_available" && <button className="button primary" disabled={isTurnBusy(state)} onClick={() => void run(() => window.evrenDesktop.updates.installRuntime())}>Runtime'ı Güncelle</button>}</article></section></main>;
}

function HelpPage(): JSX.Element {
  const sections = [
    { icon: "01", title: "Başlarken", items: [{ q: "Proje açma", a: "Sol menüden denetiminizdeki yerel klasörü açın. Uygulama klasörü kendiliğinden taramaz." }, { q: "İlk sohbet", a: "Yeni Sohbet'i seçip hedefinizi yazın. Taslak, ilk başarılı gönderimde gerçek ve kalıcı Codex sohbetine dönüşür." }, { q: "Model seçimi", a: "Modeller EVREN canlı kataloğundan gelir. Model değişikliği yeni sohbetlere uygulanır; etkin sohbetin modeli değişmez." }] },
    { icon: "02", title: "Güvenli çalışma", items: [{ q: "Onaylar", a: "Komut ve dosya işlemleri görünür kalır. Onay isteyen eylem siz karar verene kadar uygulanmaz; bilinmeyen istekler reddedilir." }, { q: "Görseller", a: "PNG, JPEG ve WebP ekleri yalnızca seçilen model canlı katalogda görsel desteği bildirdiğinde kullanılabilir." }, { q: "API anahtarı", a: "EVREN anahtarı Electron Main sürecinde kalır ve Codex'e aktarılmaz. Güvenli saklama yoksa düz metin yedek oluşturulmaz." }] },
    { icon: "03", title: "Devam ve bakım", items: [{ q: "Çalışmaya Devam Et / Geçmiş", a: "Gerçek Codex sohbetini yeni bir istem göndermeden sürdürür. Yerel geçmiş yalnızca güvenli bir gezinme dizinidir; model belleği değildir." }, { q: "Güncellemeler", a: "Uygulama ve doğrulanmış Codex Runtime ayrı güncellenir. Doğrulanmamış runtime sessizce kurulmaz ve etkin görev sırasında değiştirilmez." }, { q: "Yaygın hatalar", a: "EVREN çevrimdışıysa bağlantıyı yeniden sınayın; Codex kullanılamıyorsa kurulu runtime durumunu kontrol edin. HTTP 429 sonrasında kısa süre bekleyip isteği açıkça yeniden gönderin." }] },
    { icon: "04", title: "Klasik terminal Bridge", items: [{ q: "Terminal kullanımına devam edebilir miyim?", a: "Evet. Desktop, mevcut Bridge çekirdeğini kullanır; klasik geliştirme akışı ayrı bir uyumluluk yüzeyi olarak korunur." }, { q: "Tanılama paylaşma", a: "Ayarlar → Gelişmiş ve tanılama bölümünden güvenli özeti kopyalayın. Özet anahtarları, istemleri, sohbetleri ve komut çıktılarını içermez." }] },
  ];
  return <main className="page"><section className="page-intro"><div><span className="eyebrow">KISA ÜRÜN REHBERİ</span><h2>Yardım</h2><p>Projeyi açmaktan güvenli onaylara ve çalışmaya devam etmeye kadar temel akışlar.</p></div></section><section className="help-grid">{sections.map((section) => <article className="help-section" key={section.title}><header><span>{section.icon}</span><h3>{section.title}</h3></header><div className="help-list">{section.items.map((item) => <details key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>)}</div></article>)}</section></main>;
}

function LimitRecovery({ state, run, setPage }: { state: DesktopStateDto; run: Runner; setPage(page: Page): void }): JSX.Element {
  const recovery = state.usage.limitRecovery!;
  const [open, setOpen] = useState(true);
  if (!open) return <></>;
  const raise = (): void => { if (!recovery.recommended) return; const limits = { ...state.settings.limits, preset: "Custom" as const }; if (recovery.name === "MAX_SESSION_TOKENS") limits.maxSessionTokens = recovery.recommended; if (recovery.name === "MAX_REQUESTS_PER_SESSION") limits.maxRequestsPerSession = recovery.recommended; if (recovery.name === "MAX_TOOL_CALLS_PER_SESSION") limits.maxToolCallsPerSession = recovery.recommended; void run(() => window.evrenDesktop.usage.applyLimits(limits)); };
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true"><span className="eyebrow">LİMİTE ULAŞILDI</span><h2>{limitTitle(recovery.name)}</h2><div className="limit-summary"><SettingRow label="Kullanılan" value={recovery.current.toLocaleString("tr-TR")} /><SettingRow label="Geçerli limit" value={recovery.limit.toLocaleString("tr-TR")} />{recovery.recommended && <SettingRow label="Önerilen" value={recovery.recommended.toLocaleString("tr-TR")} />}</div><p>Hiçbir istek otomatik yinelenmez. Düzenleyiciye dönüp açıkça yeniden gönderin.</p><div className="modal-actions"><button className="button secondary" onClick={() => setOpen(false)}>İptal</button><button className="button secondary" onClick={() => { setOpen(false); setPage("usage"); }}>Özel Ayar</button><button className="button primary" disabled={!recovery.recoverable || !recovery.recommended} onClick={raise}>Limiti Yükselt</button></div></section></div>;
}

function ApprovalDock({ approvals, state, run }: { approvals: ApprovalRequestDto[]; state: DesktopStateDto; run: Runner }): JSX.Element {
  const approval = approvals.find((item) => item.threadId === state.workspace.selectedThreadId);
  if (!approval) return <></>;
  const title = approval.type === "command" ? "Komut çalıştırma isteği" : "Proje dosyalarını değiştirme isteği";
  return <section className="approval-dock" role="dialog" aria-modal="false" aria-live="assertive" aria-labelledby="approval-title"><div className="approval-icon" aria-hidden="true">!</div><div className="approval-content"><span className="approval-kicker">KARARINIZ BEKLENİYOR</span><h2 id="approval-title">{title}</h2><p className="approval-explanation">Codex bu adımı uygulamadan önce açık onayınızı istiyor.</p>{approval.command && <code title={approval.command}>{approval.command}</code>}{approval.cwd && <small title={approval.cwd}>Hedef · {displayProjectLocation(approval.cwd, state.workspace.activeProject?.path)}</small>}{approval.reason && <p>{approval.reason}</p>}</div><ApprovalActions approval={approval} run={run} /></section>;
}

function ApprovalActions({ approval, run, compact = false }: { approval: ApprovalRequestDto; run: Runner; compact?: boolean }): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (decision: ApprovalDecisionDto): Promise<void> => {
    if (submitting || !approval.availableDecisions.includes(decision)) return;
    setSubmitting(true);
    try { await run(() => window.evrenDesktop.approvals.respond({ approvalId: approval.id, threadId: approval.threadId, decision })); }
    finally { setSubmitting(false); }
  };
  return <div className={compact ? "approval-actions compact" : "approval-actions"}>{approval.availableDecisions.includes("decline") && <button disabled={submitting} className="reject" onClick={() => void respond("decline")}><strong>Reddet</strong><small>İşlemi uygulama</small></button>}{approval.availableDecisions.includes("acceptForSession") && <button disabled={submitting} onClick={() => void respond("acceptForSession")}><strong>Oturum İçin Onayla</strong><small>Codex oturum önbelleği</small></button>}{approval.availableDecisions.includes("accept") && <button disabled={submitting} className="approve" onClick={() => void respond("accept")}><strong>Bir Kez Onayla</strong><small>Yalnızca bu işlem</small></button>}</div>;
}

function Onboarding({ state, onState }: { state: DesktopStateDto; onState(state: DesktopStateDto): void }): JSX.Element {
  const [apiKey, setApiKey] = useState(""); const [persistence, setPersistence] = useState<PersistenceMode>("session"); const [testing, setTesting] = useState(false); const [saving, setSaving] = useState(false); const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const test = async (): Promise<void> => { if (!apiKey.trim()) return; setTesting(true); setResult(undefined); try { const response = await window.evrenDesktop.credentials.test({ apiKey }); setResult(response.ok ? { ok: true, message: `${response.models.length} model güvenli biçimde yüklendi.` } : { ok: false, message: response.error.message }); } finally { setTesting(false); } };
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); if (!apiKey.trim()) return; const input = { apiKey, persistence }; setApiKey(""); setSaving(true); try { onState(await window.evrenDesktop.credentials.save(input)); } finally { setSaving(false); } };
  return (
    <main className="onboarding">
      <section className="onboarding-frame" aria-labelledby="setup-title">
        <header className="onboarding-chrome"><span className="signal-pixel" aria-hidden="true" /><strong>EVREN WORKSPACE</strong><small>// v{state.version} [{state.credential.securePersistenceAvailable ? "WIN64-DPAPI" : "SESSION-ONLY"}]</small><span className="chrome-state"><i /> YEREL KÖPRÜ</span></header>
        <div className="onboarding-grid">
          <section className="onboarding-story">
            <div className="onboarding-brand"><BrandMark /><div><div className="setup-badge">EVREN <b>CODEX BRIDGE</b></div><span>Güvenli kodlama ajanı ve yerel derleyici köprüsü</span></div></div>
            <div className="onboarding-copy"><span className="eyebrow">GÜVENLİ ÇALIŞMA ALANI</span><h1 id="setup-title">Kodlama çalışma alanınızı EVREN'e bağlayın.</h1><p className="lead">API anahtarınızı doğrulayın, saklama tercihinizi seçin ve canlı model kataloğuyla çalışmaya başlayın.</p><ul><li>OpenAI veya ChatGPT oturumu gerekmez</li><li>Codex gerçek EVREN anahtarını görmez</li><li>Projeler yalnızca siz açtığınızda kullanılır</li></ul></div>
            <div className="trust-grid" aria-label="Güvenlik özellikleri"><span><b>◇</b><strong>Masaüstü İzolasyonu</strong><small>Korumalı sandbox</small></span><span><b>◎</b><strong>Yerel Proje Sınırı</strong><small>Yalnız seçilen klasör</small></span><span><b>ϟ</b><strong>Ayrık Kimlik Akışı</strong><small>Codex anahtarı görmez</small></span></div>
          </section>
          <section className="onboarding-connect">
            <div className="connect-heading"><div><span className="eyebrow">■ KİMLİK DOĞRULAMA</span><h2>EVREN'e Bağlan</h2><p>Geliştirme oturumunu başlatmak için EVREN API anahtarını girin.</p></div><span className="live-mode">YEREL MOD</span></div>
            <form onSubmit={(event) => void submit(event)}><label htmlFor="api-key">EVREN Gizli Anahtarı (API Key)</label><div className="key-field"><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API anahtarını yapıştırın" /><span aria-hidden="true">••••</span></div><p className="encryption-note">▣ Windows güvenli saklama akışı · anahtar Codex'e aktarılmaz</p><fieldset><legend>BELLEK SAKLAMA POLİTİKASI</legend><label className="radio-row"><input type="radio" checked={persistence === "session"} onChange={() => setPersistence("session")} /><span><strong>Yalnızca bu oturum boyunca kullan</strong><small>Uygulama kapanınca bellekten silinir.</small></span></label><label className={`radio-row ${state.credential.securePersistenceAvailable ? "" : "disabled"}`}><input type="radio" checked={persistence === "secure"} disabled={!state.credential.securePersistenceAvailable} onChange={() => setPersistence("secure")} /><span><strong>Bu cihazda güvenli şekilde hatırla <em>ÖNERİLEN</em></strong><small>{state.credential.securePersistenceAvailable ? "Windows güvenli kasasıyla korunur; düz metin yedek yoktur." : "Bu cihazda güvenli saklama kullanılamıyor."}</small></span></label></fieldset>{result && <p className={result.ok ? "notice success" : "notice error"} role="status">{result.message}</p>}<div className="connect-status"><span><i />{testing ? "Canlı model kataloğu denetleniyor." : result?.ok ? "Bağlantı doğrulandı." : "Bağlantı doğrulaması bekleniyor."}</span><small>{result?.ok ? "1/1 İŞLEM" : "0/1 İŞLEM"}</small></div><div className="actions"><button className="button secondary" type="button" disabled={!apiKey.trim() || testing || saving} onClick={() => void test()}>{testing ? "Modeller yükleniyor…" : "Bağlantıyı Sına"}</button><button className="button primary" type="submit" disabled={!apiKey.trim() || saving || testing}>{saving ? "Çalışma alanı açılıyor…" : "EVREN ile Devam Et"}</button></div></form>
            {state.history.length > 0 && <div className="onboarding-history"><span className="eyebrow">YEREL GEÇMİŞ KORUNDU</span><strong>{state.history[0]!.title}</strong><small>{state.history[0]!.projectName} · gerçek sohbete devam etmek için anahtarınızı girin</small></div>}
          </section>
        </div>
        <footer className="onboarding-status"><span><i /> Bağlantı: Doğrulama Bekliyor</span><span>Windows DPAPI {state.credential.securePersistenceAvailable ? "Kullanılabilir" : "Kullanılamıyor"}</span></footer>
      </section>
    </main>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "accent" }): JSX.Element { return <article className={tone ? `metric ${tone}` : "metric"}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>; }
function UsageSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }): JSX.Element { return <section className="usage-section"><div className="section-heading"><h3>{title}</h3>{description && <p>{description}</p>}</div><div className="metric-grid">{children}</div></section>; }
function SettingsSection({ title, description, className, children }: { title: string; description?: string; className?: string; children: React.ReactNode }): JSX.Element { return <section className={className ? `settings-card ${className}` : "settings-card"}><div className="section-heading"><h3>{title}</h3>{description && <p>{description}</p>}</div>{children}</section>; }
function SettingRow({ label, value }: { label: string; value: string }): JSX.Element { return <div className="setting-row"><span>{label}</span><strong>{value}</strong></div>; }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): JSX.Element { return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }
function ThemePicker({ value, onChange }: { value: DesktopStateDto["settings"]["theme"]; onChange(value: DesktopStateDto["settings"]["theme"]): void }): JSX.Element {
  const themes = [{ id: "dark" as const, label: "Koyu", colors: ["#0a0d12", "#171c24", "#64b5f6"] }, { id: "light" as const, label: "Açık", colors: ["#f5f7fa", "#ffffff", "#1769aa"] }, { id: "navy" as const, label: "Lacivert / EVREN", colors: ["#07111d", "#0d1b2a", "#3da2f2"] }];
  return <fieldset className="theme-picker"><legend>Renk teması</legend>{themes.map((theme) => <label className={value === theme.id ? "theme-option selected" : "theme-option"} key={theme.id}><input type="radio" name="theme" value={theme.id} checked={value === theme.id} onChange={() => onChange(theme.id)} /><span className="theme-preview" aria-hidden="true">{theme.colors.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{theme.label}</strong><small>{value === theme.id ? "Etkin" : "Uygula"}</small></label>)}</fieldset>;
}
function BrandMark({ motion = false }: { motion?: boolean }): JSX.Element { return <span className={motion ? "brand-mark brand-motion" : "brand-mark"} aria-hidden="true"><img src={BRAND_ASSET_URL} alt="" /></span>; }
function EmptyState({ title, text, action, onAction }: { title: string; text: string; action: string; onAction(): void }): JSX.Element { return <main className="empty-state"><BrandMark motion /><h2>{title}</h2><p>{text}</p><button className="button primary" onClick={onAction}>{action}</button></main>; }
function RecoveryScreen({ onRetry }: { onRetry(): void }): JSX.Element { return <main className="onboarding"><section className="onboarding-card" role="alert"><BrandMark /><div className="setup-badge">EVREN CODEX BRIDGE</div><h1>Kodlama çalışma alanı başlatılamadı.</h1><p className="lead">Güvenli Desktop hizmetlerini yeniden yükleyip tekrar deneyin.</p><button className="button primary" onClick={onRetry}>Yeniden Yükle</button></section></main>; }
function ErrorBanner({ label, message, hint, detail, onDismiss }: { label?: string; message: string; hint?: string; detail?: string; onDismiss?: () => void }): JSX.Element { return <div className="inline-error" role="alert"><span className="error-mark">!</span><div className="error-copy">{label && <small>{label}</small>}<strong>{message}</strong>{hint && <p>{hint}</p>}{detail && detail !== message && <details><summary>Teknik ayrıntılar</summary><code>{detail}</code></details>}</div>{onDismiss && <button aria-label="Hatayı kapat" title="Kapat" onClick={onDismiss}>×</button>}</div>; }
function ConnectionBadge({ label, state, tone }: { label: string; state: string; tone: "ready" | "busy" | "warn" | "danger" | "offline" }): JSX.Element { return <span className={`connection ${label.toLocaleLowerCase("en-US")} ${tone}`}><i /><span><b>{label}</b><small>{state}</small></span></span>; }
function StatusRibbon({ state }: { state: DesktopStateDto }): JSX.Element { const failed = state.workspace.turn.phase === "failed"; return <footer className="status-ribbon"><span><i className={!failed && state.evren.status === "connected" ? "ready" : failed ? "danger" : ""} />{failed ? "Son görev tamamlanamadı" : state.evren.status === "connected" && state.codex.ready ? "Sistem Hazır" : "Sistem Denetleniyor"}</span><span>UTF-8</span><span>Yerel Çalışma Alanı</span><span className="status-spacer" /><span>{state.credential.persistence === "secure" ? "Windows DPAPI Hazır" : "Oturum Anahtarı"}</span><strong>EVREN :: v{state.version}</strong></footer>; }
function WorkingIndicator({ label, tone }: { label: string; tone?: "success" | "warning" | "danger" }): JSX.Element { return <div className={tone ? `working settled ${tone}` : "working"}>{tone ? <b>{tone === "success" ? "✓" : tone === "warning" ? "!" : "×"}</b> : <><span /><span /><span /></>}<em>{label}</em></div>; }
function HistoryIcon({ name, filled = false }: { name: "star" | "edit" | "trash" | "resume"; filled?: boolean }): JSX.Element {
  const path = name === "star" ? "M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.6-4.4 6.3-.9L12 2.8z" : name === "edit" ? "M4 16.8V20h3.2L17.8 9.4l-3.2-3.2L4 16.8zm16.3-10.9a.85.85 0 000-1.2l-2-2a.85.85 0 00-1.2 0l-1.6 1.6 3.2 3.2 1.6-1.6z" : name === "trash" ? "M7 20a2 2 0 01-2-2V6h14v12a2 2 0 01-2 2H7zm3-11v8m4-8v8M4 6h16M9 6V3h6v3" : "M8 7h8v8m0-8L7 16";
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={path} fill={name === "star" && filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function LoadingScreen({ label }: { label: string }): JSX.Element { return <main className="loading"><BrandMark motion /><p>{label}</p></main>; }
function useTurnElapsed(turn: DesktopStateDto["workspace"]["turn"]): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  const active = ["running", "awaitingApproval"].includes(turn.phase) && turn.completedAt === undefined;
  useEffect(() => {
    if (!active || turn.startedAt === undefined) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, turn.startedAt]);
  if (turn.startedAt === undefined) return undefined;
  return Math.max(0, (turn.completedAt ?? now) - turn.startedAt);
}
function isTurnBusy(state: DesktopStateDto): boolean { return ["starting", "running", "awaitingApproval", "interrupting"].includes(state.workspace.turn.phase); }
function codexRuntimeStatus(state: DesktopStateDto): { label: string; tone: "ready" | "busy" | "warn" | "danger" | "offline" } {
  if (!state.codex.ready) return { label: "Kullanılamıyor", tone: "offline" };
  if (state.workspace.turn.phase === "awaitingApproval") return { label: "Onay bekliyor", tone: "warn" };
  if (state.workspace.turn.phase === "interrupting") return { label: "Durduruluyor", tone: "warn" };
  if (state.workspace.turn.phase === "starting") return { label: "Başlatılıyor", tone: "busy" };
  if (state.workspace.turn.phase === "running") {
    const toolActive = state.workspace.items.some((item) => (item.kind === "command" || item.kind === "tool" || item.kind === "fileChange") && item.status === "running");
    return { label: toolActive ? "Araç çalıştırıyor" : "Çalışıyor", tone: "busy" };
  }
  if (state.workspace.turn.phase === "interrupted") return { label: "Durduruldu", tone: "warn" };
  if (state.workspace.turn.phase === "failed") return state.workspace.turn.errorCode?.startsWith("UPSTREAM_")
    ? { label: "Hazır", tone: "ready" }
    : { label: "İşlem hatası", tone: "danger" };
  return { label: "Hazır", tone: "ready" };
}
function evrenRuntimeStatus(state: DesktopStateDto): { label: string; tone: "ready" | "busy" | "warn" | "danger" | "offline" } {
  if (state.evren.status === "connecting") return { label: "Bağlanıyor", tone: "busy" };
  if (state.evren.status === "error") return { label: "Bağlantı hatası", tone: "danger" };
  if (state.evren.status !== "connected") return { label: "Denetlenmedi", tone: "offline" };
  if (state.workspace.turn.phase === "failed" && state.workspace.turn.errorCode === "UPSTREAM_RATE_LIMIT") return { label: "Hız sınırı", tone: "danger" };
  if (state.workspace.turn.phase === "failed" && state.workspace.turn.errorCode?.startsWith("UPSTREAM_")) return { label: "İstek hatası", tone: "danger" };
  if (["sendingToEvren", "waitingForEvren", "evrenResponding"].includes(state.workspace.turn.activity ?? "")) return { label: state.workspace.turn.activity === "evrenResponding" ? "Yanıtlıyor" : "Yanıt bekliyor", tone: "busy" };
  return { label: "Bağlı", tone: "ready" };
}
function turnOutcomeTone(turn: DesktopStateDto["workspace"]["turn"]): "success" | "warning" | "danger" {
  if (turn.phase === "completed" && turn.outcome !== "approvalDeclined") return "success";
  if (turn.outcome === "interrupted" || turn.outcome === "approvalDeclined") return "warning";
  return "danger";
}
function activityIcon(status: string): string { return status === "running" ? "●" : status === "completed" ? "✓" : "!"; }
function activityStatusText(status: string): string { return status === "running" ? "Etkin" : status === "completed" ? "Tamamlandı" : status === "declined" ? "Reddedildi" : "Başarısız"; }
function changeLabel(action: "added" | "modified" | "deleted"): string { return action === "added" ? "Eklendi" : action === "deleted" ? "Silindi" : "Değişti"; }
function changeStatusCode(status: ChangeFileDto["status"]): string { return status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M"; }
function diffLineClass(line: string): string { return line.startsWith("@@") ? "meta" : line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("---") || line.startsWith("+++") ? "header" : "context"; }
function permissionActivityLabel(type: DesktopStateDto["workspace"]["permissions"]["history"][number]["type"]): string { return type === "approvedOnce" ? "Bir kez onaylandı" : type === "approvedForSession" ? "Oturum için onaylandı" : type === "declined" ? "Reddedildi" : type === "expired" ? "Süresi doldu" : "İptal edildi"; }
function modelRouteStatus(status: "configured" | "pending" | "verified" | "mismatch"): string { return status === "verified" ? "Doğrulandı" : status === "mismatch" ? "Uyuşmazlık" : status === "pending" ? "Bekleniyor" : "Yapılandırıldı"; }
function shortId(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 8)}…`; }
function relativeTime(timestamp: number): string { const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp)); if (seconds < 60) return "şimdi"; if (seconds < 3600) return `${Math.floor(seconds / 60)} dk`; if (seconds < 86_400) return `${Math.floor(seconds / 3600)} sa`; return `${Math.floor(seconds / 86_400)} gün`; }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatBytesMaybe(value: number | undefined, reason: string): string { return value === undefined ? reason : formatBytes(value); }
function formatMaybe(value: number | undefined, reason: string): string { return value === undefined ? reason : value.toLocaleString("tr-TR"); }
function formatTokenMaybe(value: number | undefined, reason: string): string { return value === undefined ? reason : `${value.toLocaleString("tr-TR")} token`; }
function formatPricing(state: DesktopStateDto): string { const pricing = state.bridge.pricing; if (!pricing) return "Sağlayıcı bu metriği sunmuyor"; if (pricing.mode === "free") return "ÜCRETSİZ"; if (pricing.mode !== "paid") return pricing.mode === "invalid" ? "Geçersiz fiyat bilgisi" : "Henüz veri yok"; return `${pricing.promptTokenPrice ?? "?"} / ${pricing.completionTokenPrice ?? "?"} CR`; }
function formatPair(value: number | undefined, limit: number, reason: string): string { return value === undefined ? reason : `${value.toLocaleString("tr-TR")} / ${limit.toLocaleString("tr-TR")}`; }
function formatCompact(value: number): string { return new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatDuration(milliseconds: number): string { const seconds = Math.round(milliseconds / 1_000); if (seconds < 60) return `${seconds} sn`; const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; return remainder ? `${minutes} dk ${remainder} sn` : `${minutes} dk`; }
function pageTitle(page: Page): string { return ({ home: "Ana Sayfa", chat: "Sohbet", history: "Geçmiş", usage: "Kullanım", settings: "Ayarlar", help: "Yardım", updates: "Güncelleme Merkezi" })[page]; }
function searchRecord(record: HistoryRecordDto, query: string): boolean { const needle = query.trim().toLocaleLowerCase(); return !needle || [record.title, record.projectName, record.lastUserPreview, record.lastAssistantPreview].some((value) => value?.toLocaleLowerCase().includes(needle)); }
function presetLimits(preset: UsageLimitsInput["preset"], current: UsageLimitsInput): UsageLimitsInput { return preset === "Standard" ? { ...current, preset, maxSessionTokens: 1_200_000, maxDailyTokens: 10_000_000, maxRequestsPerSession: 60, maxToolCallsPerSession: 80 } : preset === "Coding" ? { ...current, preset, maxSessionTokens: 3_000_000, maxDailyTokens: 10_000_000, maxRequestsPerSession: 120, maxToolCallsPerSession: 140 } : { ...current, preset }; }
function limitTitle(name: string): string { return name === "MAX_SESSION_TOKENS" ? "Oturum token limitine ulaşıldı" : name === "MAX_REQUESTS_PER_SESSION" ? "Oturum istek limitine ulaşıldı" : "Oturum araç çağrısı limitine ulaşıldı"; }
function connectionText(value: DesktopStateDto["evren"]["status"]): string { return value === "connected" ? "Bağlı" : value === "connecting" ? "Bağlanıyor" : value === "error" ? "Hata" : "Henüz denetlenmedi"; }
function compatibilityText(value: DesktopStateDto["codex"]["compatibility"]): string { return value === "tested" ? "EVREN doğrulanmış" : value === "newer-unverified" ? "Daha yeni, doğrulanmamış" : value === "older" ? "Eski sürüm" : value === "unavailable" ? "Kullanılamıyor" : "Bilinmiyor"; }
function updateStatusText(value: string): string { return ({ not_checked: "Henüz kontrol edilmedi", checking: "Kontrol ediliyor", up_to_date: "Güncel", update_available: "Güncelleme var", downloading: "İndiriliyor", downloaded: "İndirildi", installing: "Kuruluyor", disabled: "Devre dışı", unpublished: "Güncelleme kaynağında yayımlanmış uygun bir sürüm yok.", invalid_tag: "Güncelleme kaynağında yayımlanmış uygun bir sürüm yok.", source_unavailable: "Doğrulanmış runtime güncelleme kaynağı henüz yayımlanmadı.", http_error: "Güncelleme kaynağına şu anda ulaşılamıyor; kurulu sürüm kullanılabilir.", error: "Güncelleme denetlenemedi; kurulu sürüm kullanılabilir." } as Record<string, string>)[value] ?? value.replaceAll("_", " "); }
function readError(error: unknown): string { if (!(error instanceof Error) || !error.message) return "İstek tamamlanamadı."; const message = error.message.replace(/^Error invoking remote method '[^']+': Error: /, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim(); return !message || message.startsWith("{") || message.startsWith("[") || /\"(?:error|message|authorization)\"\s*:/i.test(message) ? "İstek tamamlanamadı." : message.slice(0, 300); }

function chatErrorCopy(error: { code: string }): { label: string; hint: string } {
  if (error.code === "UPSTREAM_RATE_LIMIT") return { label: "EVREN / SAĞLAYICI SINIRI", hint: "İstek upstream katmanına ulaştı ancak HTTP 429 ile reddedildi. Otomatik yeniden gönderilmedi; kısa süre bekleyip isteği açıkça tekrar gönderin. İstek görsel içeriyorsa görseli yeniden ekleyin." };
  if (error.code === "UPSTREAM_MEDIA_UNSUPPORTED") return { label: "SAĞLAYICI GÖRSELİ REDDETTİ", hint: "Yerel görsel doğrulandı ve istek EVREN'e ulaştı. Farklı bir görsel destekli model veya desteklenen PNG, JPEG ya da WebP dosyası deneyin." };
  if (error.code === "MODEL_IMAGE_UNSUPPORTED") return { label: "MODEL YETENEĞİ", hint: "İstek EVREN'e gönderilmedi. Görsel destekli bir modelle yeni sohbet açın veya eki kaldırın." };
  if (error.code.startsWith("IMAGE_") || error.code.startsWith("ATTACHMENT_")) return { label: "YEREL GÖRSEL DOĞRULAMA", hint: "Dosya upstream katmanına gönderilmedi. Görseli yeniden seçip biçim ve boyutunu kontrol edin." };
  return { label: "SOHBET İŞLEMİ", hint: "İstek otomatik olarak yinelenmedi. Durumu kontrol edip yeniden denemeye siz karar verin." };
}
