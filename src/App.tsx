import { useEffect } from "react";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsModal } from "./components/SettingsModal";
import { UpdateModal } from "./components/UpdateModal";
import { useStore } from "./state/store";

export default function App() {
  const screen = useStore((state) => state.screen);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const updateOpen = useStore((state) => state.updateOpen);
  const toast = useStore((state) => state.toast);
  const setToast = useStore((state) => state.setToast);
  const contentWidth = useStore((state) => state.contentWidth);
  const bootstrap = useStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  return (
    <div
      className="app-root"
      style={{ ["--content-width" as string]: contentWidth > 0 ? `${contentWidth}px` : "100%" }}
    >
      <ErrorBoundary>
        {screen === "loading" && (
          <div className="splash">
            <div className="splash-logo">x</div>
            <div className="splash-title">xbot</div>
            <div className="splash-sub">正在连接…</div>
          </div>
        )}
        {screen === "login" && <Login />}
        {screen === "shell" && <Shell />}
        {settingsOpen && <SettingsModal />}
        {updateOpen && <UpdateModal />}
      </ErrorBoundary>
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
