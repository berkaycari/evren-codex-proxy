import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC, type DesktopApi, type DesktopStateDto } from "../shared/contracts.js";

const desktopApi: DesktopApi = {
  state: {
    get: () => ipcRenderer.invoke(DESKTOP_IPC.stateGet),
    subscribe: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopStateDto): void => listener(state);
      ipcRenderer.on(DESKTOP_IPC.stateChanged, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_IPC.stateChanged, wrapped);
    },
  },
  credentials: {
    test: (input) => ipcRenderer.invoke(DESKTOP_IPC.credentialTest, input),
    save: (input) => ipcRenderer.invoke(DESKTOP_IPC.credentialSave, input),
    clear: () => ipcRenderer.invoke(DESKTOP_IPC.credentialClear),
  },
  models: {
    select: (input) => ipcRenderer.invoke(DESKTOP_IPC.modelSelect, input),
  },
  startup: {
    retry: () => ipcRenderer.invoke(DESKTOP_IPC.retryStartup),
  },
  projects: {
    openFolder: () => ipcRenderer.invoke(DESKTOP_IPC.projectOpen),
    openRecent: (input) => ipcRenderer.invoke(DESKTOP_IPC.projectOpenRecent, input),
    chooseFile: () => ipcRenderer.invoke(DESKTOP_IPC.attachmentChooseProjectFile),
  },
  threads: {
    list: () => ipcRenderer.invoke(DESKTOP_IPC.threadList),
    start: () => ipcRenderer.invoke(DESKTOP_IPC.threadStart),
    resume: (input) => ipcRenderer.invoke(DESKTOP_IPC.threadResume, input),
    loadEarlier: (input) => ipcRenderer.invoke(DESKTOP_IPC.threadLoadEarlier, input),
    archive: (input) => ipcRenderer.invoke(DESKTOP_IPC.threadArchive, input),
  },
  chat: {
    send: (input) => ipcRenderer.invoke(DESKTOP_IPC.chatSend, input),
    interrupt: (input) => ipcRenderer.invoke(DESKTOP_IPC.chatInterrupt, input),
  },
  approvals: {
    respond: (input) => ipcRenderer.invoke(DESKTOP_IPC.approvalRespond, input),
  },
  changes: {
    getDiff: (input) => ipcRenderer.invoke(DESKTOP_IPC.changeDiffGet, input),
    keep: (input) => ipcRenderer.invoke(DESKTOP_IPC.changeKeep, input),
    revert: (input) => ipcRenderer.invoke(DESKTOP_IPC.changeRevert, input),
  },
  attachments: {
    chooseImage: () => ipcRenderer.invoke(DESKTOP_IPC.attachmentChooseImage),
    removePending: () => ipcRenderer.invoke(DESKTOP_IPC.attachmentRemovePending),
  },
  history: {
    continue: (input) => ipcRenderer.invoke(DESKTOP_IPC.historyContinue, input),
    pin: (input) => ipcRenderer.invoke(DESKTOP_IPC.historyPin, input),
    rename: (input) => ipcRenderer.invoke(DESKTOP_IPC.historyRename, input),
    archive: (input) => ipcRenderer.invoke(DESKTOP_IPC.historyArchive, input),
  },
  settings: {
    update: (input) => ipcRenderer.invoke(DESKTOP_IPC.settingsUpdate, input),
  },
  usage: {
    applyLimits: (input) => ipcRenderer.invoke(DESKTOP_IPC.usageApplyLimits, input),
  },
  updates: {
    check: () => ipcRenderer.invoke(DESKTOP_IPC.updatesCheck),
    download: () => ipcRenderer.invoke(DESKTOP_IPC.updatesDownload),
    install: () => ipcRenderer.invoke(DESKTOP_IPC.updatesInstall),
    installRuntime: () => ipcRenderer.invoke(DESKTOP_IPC.runtimeUpdateInstall),
  },
  diagnostics: {
    get: () => ipcRenderer.invoke(DESKTOP_IPC.diagnosticsGet),
  },
};

contextBridge.exposeInMainWorld("evrenDesktop", desktopApi);
