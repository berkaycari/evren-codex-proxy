import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    document.documentElement.dataset.evrenDesktopFatal = "CHAT_RENDER_FAILED";
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="onboarding">
        <section className="onboarding-card" role="alert">
          <div className="setup-badge">EVREN CODEX BRIDGE</div>
          <h1>Sohbet görünümü kurtarılamadı.</h1>
          <p className="lead">Güvenli kurtarma için uygulamayı yeniden başlatın.</p>
          <code>CHAT_RENDER_FAILED</code>
        </section>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Desktop renderer root is missing.");

if (!window.evrenDesktop) {
  document.documentElement.dataset.evrenDesktopFatal = "PRELOAD_UNAVAILABLE";
  createRoot(root).render(
    <main className="onboarding">
      <section className="onboarding-card" role="alert" aria-labelledby="fatal-title">
        <div className="setup-badge">EVREN CODEX BRIDGE</div>
        <h1 id="fatal-title">EVREN Codex Bridge başlatılamadı.</h1>
        <p className="lead">Masaüstü güvenli köprüsü yüklenemedi.</p>
        <code>PRELOAD_UNAVAILABLE</code>
      </section>
    </main>,
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <div data-testid="evren-desktop-root">
        <RendererErrorBoundary><App /></RendererErrorBoundary>
      </div>
    </StrictMode>,
  );
}
