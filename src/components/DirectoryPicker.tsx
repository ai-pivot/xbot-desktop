import { useEffect, useState } from "react";
import { ArrowUp, ChevronRight, CornerDownLeft, Folder, FolderOpen, Loader2, X } from "lucide-react";
import { api } from "../api";
import { logError } from "../log";
import type { FsEntry } from "../types";

export function DirectoryPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [pathInput, setPathInput] = useState(initialPath || "/");
  const [rootPath, setRootPath] = useState(initialPath || "/");
  const [selected, setSelected] = useState(initialPath || "/");
  const [children, setChildren] = useState<Record<string, FsEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [initialPath || "/"]: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await api.listDir(path);
      setChildren((current) => ({ ...current, [path]: entries }));
    } catch (reason) {
      logError("fs", reason, `list ${path}`);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = async (path: string) => {
    const next = path.trim() || "/";
    setRootPath(next);
    setPathInput(next);
    setSelected(next);
    setExpanded({ [next]: true });
    setChildren({});
    await load(next);
  };

  const parentPath = (path: string): string => {
    const clean = path.replace(/\/+$/, "") || "/";
    if (clean === "/") return "/";
    const index = clean.lastIndexOf("/");
    return index <= 0 ? "/" : clean.slice(0, index);
  };

  const toggle = async (path: string) => {
    setSelected(path);
    setPathInput(path);
    const open = !expanded[path];
    setExpanded((current) => ({ ...current, [path]: open }));
    if (open && children[path] === undefined) await load(path);
  };

  return (
    <div className="modal-backdrop dir-picker-backdrop" onMouseDown={onClose}>
      <div className="dir-picker" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">选择工作目录</div>
            <div className="muted small">浏览 xbot 服务端的目录，选中后作为会话工作目录</div>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="dir-pathbar">
          <button className="icon-button" title="上一级" onClick={() => void go(parentPath(rootPath))}>
            <ArrowUp size={15} />
          </button>
          <input
            className="input"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void go(pathInput);
              if (event.key === "Escape") onClose();
            }}
            placeholder="/home/user/project"
          />
          <button className="button secondary" onClick={() => void go(pathInput)}>
            <CornerDownLeft size={14} />
            转到
          </button>
          <button className="button ghost" onClick={() => void go("/")}>
            根目录
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <div className="dir-tree">
          <DirNode
            path={rootPath}
            name={rootPath}
            depth={0}
            selected={selected}
            expanded={expanded}
            childrenByPath={children}
            onToggle={(path) => void toggle(path)}
            onSelect={(path) => {
              setSelected(path);
              setPathInput(path);
            }}
          />
          {loading && (
            <div className="dir-loading">
              <Loader2 size={14} className="spin" />
              加载目录…
            </div>
          )}
          {!loading && children[rootPath]?.filter((entry) => entry.isDir).length === 0 && (
            <div className="dir-empty">这个目录下没有子目录</div>
          )}
        </div>

        <div className="dir-foot">
          <div className="dir-selected" title={selected}>
            <Folder size={14} />
            <span>{selected}</span>
          </div>
          <div className="settings-actions">
            <button className="button ghost" onClick={onClose}>
              取消
            </button>
            <button className="button primary" onClick={() => onSelect(selected)}>
              使用此目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DirNode({
  path,
  name,
  depth,
  selected,
  expanded,
  childrenByPath,
  onToggle,
  onSelect,
}: {
  path: string;
  name: string;
  depth: number;
  selected: string;
  expanded: Record<string, boolean>;
  childrenByPath: Record<string, FsEntry[] | undefined>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const open = !!expanded[path];
  const entries = childrenByPath[path];
  const dirs = (entries ?? [])
    .filter((entry) => entry.isDir)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="dir-node">
      <div
        className={`dir-node-row ${selected === path ? "selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 18 }}
        onClick={() => onSelect(path)}
      >
        <button
          className={`dir-chevron ${open ? "open" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(path);
          }}
        >
          <ChevronRight size={13} />
        </button>
        {open ? <FolderOpen size={15} /> : <Folder size={15} />}
        <span className="dir-name">{name}</span>
      </div>
      {open && (
        <div className="dir-children">
          {dirs.map((entry) => {
            const childPath = path.endsWith("/") ? `${path}${entry.name}` : `${path}/${entry.name}`;
            return (
              <DirNode
                key={childPath}
                path={childPath}
                name={entry.name}
                depth={depth + 1}
                selected={selected}
                expanded={expanded}
                childrenByPath={childrenByPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
