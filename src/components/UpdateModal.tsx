import { CheckCircle2, Download, Loader2, RefreshCw, X } from "lucide-react";
import { useStore } from "../state/store";

export function UpdateModal() {
  const info = useStore((state) => state.updateInfo);
  const current = useStore((state) => state.appVersion);
  const checking = useStore((state) => state.updateChecking);
  const progress = useStore((state) => state.updateProgress);
  const readyPath = useStore((state) => state.updateReadyPath);
  const error = useStore((state) => state.updateError);
  const download = useStore((state) => state.downloadUpdate);
  const apply = useStore((state) => state.applyUpdate);
  const setOpen = useStore((state) => state.setUpdateOpen);

  if (!info) return null;
  const downloading = progress > 0 && progress < 100 && !readyPath;

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal update-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">软件更新</div>
            <div className="muted small">新版本已准备好</div>
          </div>
          <button className="icon-button" onClick={() => setOpen(false)}>
            <X size={17} />
          </button>
        </div>

        <div className="update-version">
          <span className="muted">{current || "0.0.0"}</span>
          <span className="update-arrow">→</span>
          <span className="update-new">{info.version}</span>
        </div>

        <div className="update-notes">{info.notes || "无更新说明"}</div>

        {(downloading || progress > 0 || readyPath) && (
          <div className="update-progress-wrap">
            <div className="update-progress">
              <div style={{ width: `${Math.min(100, progress)}%` }} />
            </div>
            <div className="update-progress-text">
              {readyPath ? (
                <>
                  <CheckCircle2 size={13} /> 下载完成，校验通过
                </>
              ) : downloading ? (
                <>
                  <Loader2 size={13} className="spin" /> 正在下载 {Math.round(progress)}%
                </>
              ) : (
                <>准备下载…</>
              )}
            </div>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button className="button ghost" onClick={() => setOpen(false)}>
            稍后
          </button>
          {readyPath ? (
            <button className="button primary" onClick={() => void apply()}>
              <RefreshCw size={14} />
              重启并更新
            </button>
          ) : (
            <button
              className="button primary"
              onClick={() => void download()}
              disabled={checking || downloading}
            >
              <Download size={14} />
              下载并更新
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
