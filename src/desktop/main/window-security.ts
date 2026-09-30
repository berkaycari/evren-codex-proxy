import type { BrowserWindow, WebContents } from "electron";

export function isAllowedRendererUrl(candidate: string, allowedUrl: string): boolean {
  try {
    const value = new URL(candidate);
    const allowed = new URL(allowedUrl);
    if (allowed.protocol === "file:") return value.protocol === "file:" && value.pathname === allowed.pathname;
    return value.origin === allowed.origin;
  } catch {
    return false;
  }
}

export function configureWindowSecurity(window: BrowserWindow, allowedUrl: string): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url, allowedUrl)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function isTrustedIpcSender(sender: WebContents, senderUrl: string, expected: WebContents, allowedUrl: string): boolean {
  return sender === expected && isAllowedRendererUrl(senderUrl, allowedUrl);
}
