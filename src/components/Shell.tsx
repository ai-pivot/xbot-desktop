import { useMemo, useState } from "react";
import {
  Bot,
  Loader2,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useStore } from "../state/store";
import type { SessionNode } from "../types";
import { ChatPane } from "./ChatPane";
import { ContextMenu } from "./ContextMenu";
import { DirectoryPicker } from "./DirectoryPicker";

type DialogMode = "new" | "rename" | "fork";

export function Shell() {
  const sessions = useStore((state) => state.sessions);
  const activeChatId = useStore((state) => state.activeChatId);
  const selectSession = useStore((state) => state.selectSession);
  const newSession = useStore((state) => state.newSession);
  const renameSession = useStore((state) => state.renameSession);
  const deleteSession = useStore((state) => state.deleteSession);
  const forkSession = useStore((state) => state.forkSession);
  const refreshSessions = useStore((state) => state.refreshSessions);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const checkUpdate = useStore((state) => state.checkUpdate);
  const updateChecking = useStore((state) => state.updateChecking);
  const serverUrl = useStore((state) => state.serverUrl);

  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{
    mode: DialogMode;
    value: string;
    workDir: string;
    target: SessionNode | null;
  } | null>(null);
  const [menu, setMenu] = useState<{ node: SessionNode; x: number; y: number } | null>(null);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  const active = sessions.find((node) => node.chat_id === activeChatId);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (node) =>
        node.label.toLowerCase().includes(needle) ||
        node.preview.toLowerCase().includes(needle) ||
        node.chat_id.toLowerCase().includes(needle),
    );
  }, [sessions, search]);

  const openDialog = (mode: DialogMode, target: SessionNode | null = null) => {
    if ((mode === "rename" || mode === "fork") && !target) return;
    setMenu(null);
    setDirPickerOpen(false);
    setDialog({
      mode,
      value:
        mode === "new"
          ? "新会话"
          : mode === "fork"
            ? `${target?.label ?? ""} (fork)`
            : target?.label ?? "",
      workDir: "",
      target,
    });
  };

  const submitDialog = () => {
    if (!dialog) return;
    const value = dialog.value.trim();
    if (!value) return;
    if (dialog.mode === "new") void newSession(value, dialog.workDir.trim());
    if (dialog.mode === "rename") void renameSession(value, dialog.target ?? undefined);
    if (dialog.mode === "fork") void forkSession(value, dialog.target ?? undefined);
    setDialog(null);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <div className="brand-mark">
            <Bot size={19} />
          </div>
          <div className="brand-text">
            <div className="brand-name">xbot</div>
            <div className="muted tiny">desktop</div>
          </div>
          <button
            className="icon-button"
            title="刷新会话"
            onClick={() => void refreshSessions(true)}
          >
            <Search size={15} />
          </button>
        </div>

        <div className="side-search">
          <Search size={14} className="input-icon" />
          <input
            className="input"
            placeholder="搜索会话…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <button className="button primary new-session" onClick={() => openDialog("new")}>
          <Plus size={15} />
          新建会话
        </button>

        <div className="session-list">
          {filtered.map((node) => (
            <SessionItem
              key={node.chat_id}
              node={node}
              active={node.chat_id === activeChatId}
              onSelect={() => void selectSession(node)}
              onMenu={(x, y) => setMenu({ node, x, y })}
            />
          ))}
          {!filtered.length && (
            <div className="side-empty">
              <div className="muted small">{search ? "没有匹配的会话" : "还没有会话"}</div>
              {!search && (
                <button className="button ghost small" onClick={() => openDialog("new")}>
                  新建会话
                </button>
              )}
            </div>
          )}
        </div>

        <div className="side-footer">
          <div className="side-server" title={serverUrl}>
            {serverUrl.replace(/^https?:\/\//, "")}
          </div>
          <div className="side-footer-actions">
            <button className="icon-button" title="设置" onClick={() => setSettingsOpen(true)}>
              <Settings size={15} />
            </button>
            <button
              className="icon-button"
              title="检查更新"
              onClick={() => void checkUpdate(true)}
              disabled={updateChecking}
            >
              {updateChecking ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            </button>
          </div>
        </div>
      </aside>

      <ChatPane />

      {dirPickerOpen && dialog?.mode === "new" && (
        <DirectoryPicker
          initialPath={dialog.workDir || active?.work_dir || "/"}
          onSelect={(path) => {
            if (dialog) setDialog({ ...dialog, workDir: path });
            setDirPickerOpen(false);
          }}
          onClose={() => setDirPickerOpen(false)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "重命名",
              action: () => openDialog("rename", menu.node),
            },
            {
              label: "Fork 会话",
              action: () => openDialog("fork", menu.node),
            },
            {
              label: "删除",
              danger: true,
              action: () => {
                if (window.confirm(`确定删除会话「${menu.node.label || menu.node.chat_id}」？`)) {
                  void deleteSession(menu.node);
                }
              },
            },
          ]}
        />
      )}

      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => { setDialog(null); setDirPickerOpen(false); }}>
          <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">
                {dialog.mode === "new" ? "新建会话" : dialog.mode === "rename" ? "重命名会话" : "Fork 会话"}
              </div>
              <button className="icon-button" onClick={() => { setDialog(null); setDirPickerOpen(false); }}>
                <X size={16} />
              </button>
            </div>
            <label className="field">
              <span className="field-label">会话名称</span>
              <input
                className="input"
                autoFocus
                value={dialog.value}
                onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitDialog();
                  if (event.key === "Escape") setDialog(null);
                }}
              />
            </label>
            {dialog.mode === "new" && (
              <label className="field">
                <span className="field-label">工作目录（服务器路径，可留空）</span>
                <div className="input-row">
                  <input
                    className="input"
                    value={dialog.workDir}
                    placeholder="/home/user/project"
                    onChange={(event) => setDialog({ ...dialog, workDir: event.target.value })}
                  />
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setDirPickerOpen(true)}
                  >
                    浏览
                  </button>
                </div>
              </label>
            )}
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button className="button primary" onClick={submitDialog}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionItem({
  node,
  active,
  onSelect,
  onMenu,
}: {
  node: SessionNode;
  active: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className={`session-item ${active ? "active" : ""}`}
      style={{ paddingLeft: 10 + node.depth * 14 }}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      title={node.chat_id}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="session-main">
        <div className="session-top">
          <span className="session-label">{node.label || node.chat_id}</span>
          {node.role && <span className="session-badge">{node.role}</span>}
        </div>
        {node.preview ? <div className="session-preview">{node.preview}</div> : null}
      </div>
      <div className="session-side">
        {node.running && <span className="running-dot" />}
        <span className="session-time">{formatTime(node.last_active)}</span>
        <button
          className="session-more"
          title="会话操作"
          aria-label="会话操作"
          onClick={(event) => {
            // Keep the row's select handler from firing.
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(rect.right - 6, rect.bottom + 2);
          }}
        >
          <MoreVertical size={13} />
        </button>
      </div>
    </div>
  );
}

function formatTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
