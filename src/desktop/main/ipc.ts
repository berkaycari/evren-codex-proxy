import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_IPC,
  validateApiKeyTestInput,
  validateCredentialInput,
  validateApprovalResponseInput,
  validateChangeReviewInput,
  validateChatInterruptInput,
  validateChatSendInput,
  validateModelSelectionInput,
  validateProjectPathInput,
  validateThreadInput,
  validateDesktopSettingsUpdateInput,
  validateHistoryArchiveInput,
  validateHistoryPinInput,
  validateHistoryRenameInput,
  validateUsageLimitsInput,
} from "../shared/contracts.js";
import type { DesktopController } from "./desktop-controller.js";
import { isTrustedIpcSender } from "./window-security.js";

export function registerDesktopIpc(options: {
  ipcMain: IpcMain;
  window: BrowserWindow;
  allowedUrl: string;
  controller: DesktopController;
}): () => void {
  const { ipcMain, window, allowedUrl, controller } = options;
  const trusted = (event: IpcMainInvokeEvent): void => {
    const senderFrame = event.senderFrame;
    if (!senderFrame || !isTrustedIpcSender(event.sender, senderFrame.url, window.webContents, allowedUrl)) {
      throw new Error("untrusted_ipc_sender");
    }
  };
  ipcMain.handle(DESKTOP_IPC.stateGet, async (event) => {
    trusted(event);
    return controller.getState();
  });
  ipcMain.handle(DESKTOP_IPC.credentialTest, async (event, raw: unknown) => {
    trusted(event);
    return controller.testCredential(validateApiKeyTestInput(raw).apiKey);
  });
  ipcMain.handle(DESKTOP_IPC.credentialSave, async (event, raw: unknown) => {
    trusted(event);
    return controller.saveCredential(validateCredentialInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.credentialClear, async (event) => {
    trusted(event);
    return controller.clearCredential();
  });
  ipcMain.handle(DESKTOP_IPC.modelSelect, async (event, raw: unknown) => {
    trusted(event);
    return controller.selectModel(validateModelSelectionInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.retryStartup, async (event) => {
    trusted(event);
    return controller.retry();
  });
  ipcMain.handle(DESKTOP_IPC.projectOpen, async (event) => {
    trusted(event);
    return controller.openProject();
  });
  ipcMain.handle(DESKTOP_IPC.projectOpenRecent, async (event, raw: unknown) => {
    trusted(event);
    return controller.openRecentProject(validateProjectPathInput(raw).path);
  });
  ipcMain.handle(DESKTOP_IPC.threadList, async (event) => {
    trusted(event);
    return controller.listThreads();
  });
  ipcMain.handle(DESKTOP_IPC.threadStart, async (event) => {
    trusted(event);
    return controller.startThread();
  });
  ipcMain.handle(DESKTOP_IPC.threadResume, async (event, raw: unknown) => {
    trusted(event);
    return controller.resumeThread(validateThreadInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.threadLoadEarlier, async (event, raw: unknown) => {
    trusted(event);
    return controller.loadEarlier(validateThreadInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.threadArchive, async (event, raw: unknown) => {
    trusted(event);
    return controller.archiveThread(validateThreadInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.chatSend, async (event, raw: unknown) => {
    trusted(event);
    return controller.sendChat(validateChatSendInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.chatInterrupt, async (event, raw: unknown) => {
    trusted(event);
    return controller.interruptChat(validateChatInterruptInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.approvalRespond, async (event, raw: unknown) => {
    trusted(event);
    return controller.respondApproval(validateApprovalResponseInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.changeDiffGet, async (event, raw: unknown) => {
    trusted(event);
    return controller.getChangeDiff(validateChangeReviewInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.changeKeep, async (event, raw: unknown) => {
    trusted(event);
    return controller.keepChange(validateChangeReviewInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.changeRevert, async (event, raw: unknown) => {
    trusted(event);
    return controller.revertChange(validateChangeReviewInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.attachmentChooseImage, async (event) => {
    trusted(event);
    return controller.chooseImage();
  });
  ipcMain.handle(DESKTOP_IPC.attachmentRemovePending, async (event) => {
    trusted(event);
    return controller.removePendingAttachment();
  });
  ipcMain.handle(DESKTOP_IPC.attachmentChooseProjectFile, async (event) => {
    trusted(event);
    return controller.chooseProjectFile();
  });
  ipcMain.handle(DESKTOP_IPC.historyContinue, async (event, raw: unknown) => {
    trusted(event);
    return controller.continueWork(validateThreadInput(raw).threadId);
  });
  ipcMain.handle(DESKTOP_IPC.historyPin, async (event, raw: unknown) => {
    trusted(event);
    return controller.pinHistory(validateHistoryPinInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.historyRename, async (event, raw: unknown) => {
    trusted(event);
    return controller.renameHistory(validateHistoryRenameInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.historyArchive, async (event, raw: unknown) => {
    trusted(event);
    return controller.archiveHistory(validateHistoryArchiveInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.settingsUpdate, async (event, raw: unknown) => {
    trusted(event);
    return controller.updateSettings(validateDesktopSettingsUpdateInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.usageApplyLimits, async (event, raw: unknown) => {
    trusted(event);
    return controller.applyUsageLimits(validateUsageLimitsInput(raw));
  });
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    trusted(event);
    return controller.checkForUpdates();
  });
  ipcMain.handle(DESKTOP_IPC.updatesDownload, async (event) => {
    trusted(event);
    return controller.downloadDesktopUpdate();
  });
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    trusted(event);
    controller.installDesktopUpdate();
  });
  ipcMain.handle(DESKTOP_IPC.runtimeUpdateInstall, async (event) => {
    trusted(event);
    return controller.installRuntimeUpdate();
  });
  ipcMain.handle(DESKTOP_IPC.diagnosticsGet, async (event) => {
    trusted(event);
    return controller.getDiagnostics();
  });
  const unsubscribe = controller.subscribe((state) => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.stateChanged, state);
  });
  return () => {
    unsubscribe();
    for (const channel of [
      DESKTOP_IPC.stateGet,
      DESKTOP_IPC.credentialTest,
      DESKTOP_IPC.credentialSave,
      DESKTOP_IPC.credentialClear,
      DESKTOP_IPC.modelSelect,
      DESKTOP_IPC.retryStartup,
      DESKTOP_IPC.projectOpen,
      DESKTOP_IPC.projectOpenRecent,
      DESKTOP_IPC.threadList,
      DESKTOP_IPC.threadStart,
      DESKTOP_IPC.threadResume,
      DESKTOP_IPC.threadLoadEarlier,
      DESKTOP_IPC.threadArchive,
      DESKTOP_IPC.chatSend,
      DESKTOP_IPC.chatInterrupt,
      DESKTOP_IPC.approvalRespond,
      DESKTOP_IPC.changeDiffGet,
      DESKTOP_IPC.changeKeep,
      DESKTOP_IPC.changeRevert,
      DESKTOP_IPC.attachmentChooseImage,
      DESKTOP_IPC.attachmentRemovePending,
      DESKTOP_IPC.attachmentChooseProjectFile,
      DESKTOP_IPC.historyContinue,
      DESKTOP_IPC.historyPin,
      DESKTOP_IPC.historyRename,
      DESKTOP_IPC.historyArchive,
      DESKTOP_IPC.settingsUpdate,
      DESKTOP_IPC.usageApplyLimits,
      DESKTOP_IPC.updatesCheck,
      DESKTOP_IPC.updatesDownload,
      DESKTOP_IPC.updatesInstall,
      DESKTOP_IPC.runtimeUpdateInstall,
      DESKTOP_IPC.diagnosticsGet,
    ]) ipcMain.removeHandler(channel);
  };
}
