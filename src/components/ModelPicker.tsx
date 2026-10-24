import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { ModelEntry } from "../types";

export function ModelPicker({
  models,
  selected,
  disabled,
  onSelect,
}: {
  models: ModelEntry[];
  selected: ModelEntry | null;
  disabled?: boolean;
  onSelect: (entry: ModelEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const map = new Map<string, { name: string; entries: ModelEntry[] }>();
    for (const entry of models) {
      if (
        query &&
        !entry.model.toLowerCase().includes(query) &&
        !(entry.sub_name || "").toLowerCase().includes(query)
      ) {
        continue;
      }
      const key = entry.sub_id || "default";
      const group = map.get(key);
      if (group) group.entries.push(entry);
      else map.set(key, { name: entry.sub_name || "默认", entries: [entry] });
    }
    return [...map.entries()].map(([id, group]) => ({ id, ...group }));
  }, [models, search]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-trigger"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={selected?.sub_name || "选择模型"}
      >
        <span className="model-trigger-name">{selected?.model || "选择模型"}</span>
        <ChevronDown size={13} className={`chevron ${open ? "open" : ""}`} />
      </button>

      {open && (
        <div className="model-popover">
          <div className="model-search">
            <Search size={13} />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索模型 / 订阅"
            />
          </div>
          <div className="model-list">
            {groups.map((group) => (
              <div className="model-group" key={group.id}>
                <div className="model-group-title">{group.name}</div>
                {group.entries.map((entry) => {
                  const active =
                    selected?.sub_id === entry.sub_id && selected?.model === entry.model;
                  const dot =
                    entry.status === "normal"
                      ? "ok"
                      : entry.status === "offline"
                        ? "warn"
                        : "off";
                  return (
                    <button
                      type="button"
                      key={`${entry.sub_id}|${entry.model}`}
                      className={`model-option ${active ? "active" : ""}`}
                      disabled={entry.status === "disabled"}
                      onClick={() => {
                        onSelect(entry);
                        setOpen(false);
                      }}
                    >
                      <span className={`model-dot ${dot}`} />
                      <span className="model-option-name">{entry.model}</span>
                      {entry.vision && <span className="model-vision" title="视觉">👁</span>}
                      {active && <Check size={13} className="model-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length && <div className="model-empty">没有匹配的模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}
