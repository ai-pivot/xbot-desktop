import { useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  Check,
  Info,
  Layers,
  Loader2,
  LogOut,
  Monitor,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import { api } from "../api";
import { dropCache, isFresh, readCache, writeCache } from "../cache";
import { useStore } from "../state/store";
import type { ModelEntry } from "../types";

interface Subscription {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  enabled: boolean;
}

interface ToolSetting {
  name: string;
  description: string;
  enabled: boolean;
}

interface SettingsSnapshot {
  models: ModelEntry[];
  subscriptions: Subscription[];
  tools: ToolSetting[];
  defaultModel: string;
  thinkingMode: string;
  contextMode: string;
  maxOutput: number;
  maxContext: number;
  compression: string;
  concurrency: number;
}

const SETTINGS_TTL = 10 * 60_000;

type Tab = "models" | "agent" | "tools" | "appearance" | "about";

export function SettingsModal() {
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const appVersion = useStore((state) => state.appVersion);
  const updateInfo = useStore((state) => state.updateInfo);
  const updateChecking = useStore((state) => state.updateChecking);
  const checkUpdate = useStore((state) => state.checkUpdate);
  const setUpdateOpen = useStore((state) => state.setUpdateOpen);
  const updateHost = useStore((state) => state.updateHost);
  const setUpdateHost = useStore((state) => state.setUpdateHost);
  const username = useStore((state) => state.username);
  const serverUrl = useStore((state) => state.serverUrl);
  const logout = useStore((state) => state.logout);
  const contentWidth = useStore((state) => state.contentWidth);
  const setContentWidth = useStore((state) => state.setContentWidth);
  const [tab, setTab] = useState<Tab>("models");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [tools, setTools] = useState<ToolSetting[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [thinkingMode, setThinkingMode] = useState("");
  const [contextMode, setContextMode] = useState("auto");
  const [maxOutput, setMaxOutput] = useState(0);
  const [maxContext, setMaxContext] = useState(0);
  const [compression, setCompression] = useState("");
  const [concurrency, setConcurrency] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const apply = (snap: SettingsSnapshot) => {
      setModels(snap.models);
      setSubscriptions(snap.subscriptions);
      setTools(snap.tools);
      setDefaultModel(snap.defaultModel);
      setThinkingMode(snap.thinkingMode);
      setContextMode(snap.contextMode);
      setMaxOutput(snap.maxOutput);
      setMaxContext(snap.maxContext);
      setCompression(snap.compression);
      setConcurrency(snap.concurrency);
    };
    const load = async () => {
      const cached = await readCache<SettingsSnapshot>("settings", "");
      if (cancelled) return;
      if (cached) {
        // Show the last known settings immediately; only re-query when stale.
        apply(cached.value);
        setLoading(false);
        setStatus("已加载");
      }
      if (isFresh(cached, SETTINGS_TTL)) return;
      setLoading(true);
      setStatus(cached ? "正在刷新设置…" : "正在加载设置…");
      const result = await Promise.allSettled([
        api.rpc<ModelEntry[]>("list_all_model_entries"),
        api.rpc<Subscription[]>("list_subscriptions"),
        api.rpc<{ tools?: ToolSetting[] } | ToolSetting[]>("get_tools_settings"),
        api.rpc<{ sub_id?: string; model?: string }>("get_default_model"),
        api.rpc<string>("get_user_thinking_mode"),
        api.rpc<string>("get_context_mode"),
        api.rpc<number>("get_user_max_output_tokens"),
        api.rpc<number>("get_user_max_context"),
        api.rpc<{ compression_threshold?: string | number }>("get_settings", { namespace: "agent" }),
        api.rpc<number>("get_llm_concurrency"),
      ] as const);
      if (cancelled) return;
      const errors: string[] = [];
      const [m, s, t, d, th, ctx, mo, mc, comp, conc] = result;
      const fallback = cached?.value;
      if (m.status === "rejected") errors.push(`模型：${reason(m.reason)}`);
      if (s.status === "rejected") errors.push(`订阅：${reason(s.reason)}`);
      if (t.status === "rejected") errors.push(`工具：${reason(t.reason)}`);
      const toolsValue = t.status === "fulfilled" ? t.value : null;
      const snapshot: SettingsSnapshot = {
        models: m.status === "fulfilled" ? (m.value ?? []) : (fallback?.models ?? []),
        subscriptions:
          s.status === "fulfilled" ? (s.value ?? []) : (fallback?.subscriptions ?? []),
        tools: toolsValue
          ? Array.isArray(toolsValue)
            ? toolsValue
            : (toolsValue.tools ?? [])
          : (fallback?.tools ?? []),
        defaultModel:
          d.status === "fulfilled"
            ? d.value?.sub_id && d.value?.model
              ? `${d.value.sub_id}|${d.value.model}`
              : ""
            : (fallback?.defaultModel ?? ""),
        thinkingMode:
          th.status === "fulfilled" ? (th.value ?? "") : (fallback?.thinkingMode ?? ""),
        contextMode:
          ctx.status === "fulfilled" ? ctx.value || "auto" : (fallback?.contextMode ?? "auto"),
        maxOutput: mo.status === "fulfilled" ? (mo.value ?? 0) : (fallback?.maxOutput ?? 0),
        maxContext: mc.status === "fulfilled" ? (mc.value ?? 0) : (fallback?.maxContext ?? 0),
        compression:
          comp.status === "fulfilled"
            ? comp.value?.compression_threshold != null
              ? String(comp.value.compression_threshold)
              : ""
            : (fallback?.compression ?? ""),
        concurrency:
          conc.status === "fulfilled" ? (conc.value ?? 0) : (fallback?.concurrency ?? 0),
      };
      apply(snapshot);
      // Only replace the cache when every field came from the server; a partial
      // failure must not overwrite good cached values with fallbacks.
      if (!errors.length) writeCache("settings", "", snapshot);
      setStatus(errors.length ? `部分加载失败：${errors.join("；")}` : "已加载");
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectable = useMemo(() => models.filter((model) => model.status !== "disabled"), [models]);
  const modelGroups = useMemo(() => {
    const map = new Map<string, { name: string; entries: ModelEntry[] }>();
    for (const model of models) {
      const key = model.sub_id || "default";
      const group = map.get(key);
      if (group) group.entries.push(model);
      else map.set(key, { name: model.sub_name || "默认", entries: [model] });
    }
    return [...map.entries()].map(([id, group]) => ({ id, ...group }));
  }, [models]);

  const save = async () => {
    setLoading(true);
    setStatus("正在保存…");
    const result = await Promise.allSettled([
      api.rpc("set_thinking_mode", { mode: thinkingMode }),
      api.rpc("set_context_mode", { mode: contextMode || "auto" }),
      maxOutput >= 0 ? api.rpc("set_user_max_output_tokens", { max_tokens: maxOutput }) : Promise.resolve(),
      maxContext >= 0 ? api.rpc("set_user_max_context", { max_context: maxContext }) : Promise.resolve(),
      compression ? api.rpc("set_compression_threshold", { threshold: Number(compression) }) : Promise.resolve(),
      concurrency > 0 ? api.rpc("set_llm_concurrency", { personal: concurrency }) : Promise.resolve(),
    ] as const);
    const failed = result.filter((item) => item.status === "rejected");
    // Settings changed: the cached snapshot is stale now.
    if (!failed.length) dropCache("settings");
    setStatus(failed.length ? `保存失败：${reason(failed[0].reason)}` : "已保存");
    setLoading(false);
  };

  const setDefault = async (value: string) => {
    setDefaultModel(value);
    const [subId, model] = value.split("|");
    if (!subId || !model) return;
    try {
      await api.rpc("set_default_model", { sub_id: subId, model });
      dropCache("settings");
      setStatus("默认模型已更新");
    } catch (error) {
      setStatus(`更新失败：${reason(error)}`);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-head">
          <div>
            <div className="settings-title">设置</div>
            <div className="muted small">模型、智能体、工具</div>
          </div>
          <button className="icon-button" onClick={() => setSettingsOpen(false)}>
            <X size={17} />
          </button>
        </div>

        <div className="settings-main">
          <nav className="settings-nav">
            {(
              [
                ["models", "模型", Layers],
                ["agent", "智能体", BrainCircuit],
                ["tools", "工具", Wrench],
                ["appearance", "外观", Monitor],
                ["about", "关于", Info],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                className={`settings-nav-item ${tab === key ? "active" : ""}`}
                onClick={() => setTab(key)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-body">
          {tab === "models" && (
            <>
              <Section title="默认模型">
                <select
                  className="select"
                  value={defaultModel}
                  onChange={(event) => void setDefault(event.target.value)}
                >
                  <option value="">未设置</option>
                  {selectable.map((model) => (
                    <option key={`${model.sub_id}|${model.model}`} value={`${model.sub_id}|${model.model}`}>
                      {model.sub_name ? `${model.sub_name} · ${model.model}` : model.model}
                    </option>
                  ))}
                </select>
              </Section>

              <Section title="订阅">
                {subscriptions.map((subscription) => (
                  <Toggle
                    key={subscription.id}
                    title={subscription.name || subscription.id}
                    subtitle={`${subscription.provider} · ${subscription.base_url}`}
                    checked={subscription.enabled}
                    onChange={async (value) => {
                      setSubscriptions((current) =>
                        current.map((item) =>
                          item.id === subscription.id ? { ...item, enabled: value } : item,
                        ),
                      );
                      try {
                        await api.rpc("set_subscription_enabled", {
                          sub_id: subscription.id,
                          enabled: value,
                        });
                        dropCache("settings");
                        dropCache("models");
                      } catch (error) {
                        setStatus(`更新订阅失败：${reason(error)}`);
                      }
                    }}
                  />
                ))}
              </Section>

              <div className="settings-group">
                <div className="settings-group-head">
                  <span>模型</span>
                  <span className="muted tiny">{models.length} 个</span>
                </div>
                {modelGroups.map((group) => (
                  <div className="settings-model-group" key={group.id}>
                    <div className="settings-model-group-title">{group.name}</div>
                    {group.entries.map((model) => {
                      const checked = model.status !== "disabled";
                      const dot = model.status === "normal" ? "ok" : model.status === "offline" ? "warn" : "off";
                      return (
                        <label className="settings-model-row" key={`${model.sub_id}|${model.model}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={async (event) => {
                              const value = event.target.checked;
                              setModels((current) =>
                                current.map((item) =>
                                  item.sub_id === model.sub_id && item.model === model.model
                                    ? { ...item, status: value ? "normal" : "disabled" }
                                    : item,
                                ),
                              );
                              try {
                                await api.rpc("set_model_enabled", {
                                  sub_id: model.sub_id,
                                  model: model.model,
                                  enabled: value,
                                });
                                dropCache("settings");
                                dropCache("models");
                              } catch (error) {
                                setStatus(`更新模型失败：${reason(error)}`);
                              }
                            }}
                          />
                          <span className={`model-dot ${dot}`} />
                          <span className="settings-model-name">{model.model}</span>
                          {model.vision && <span className="model-vision" title="视觉">👁</span>}
                          <span className="muted tiny settings-model-status">{model.status}</span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "agent" && (
            <>
              <Section title="思考模式（原样传给模型）">
                <input className="input" value={thinkingMode} onChange={(event) => setThinkingMode(event.target.value)} placeholder="enabled / disabled" />
              </Section>
              <Section title="上下文模式">
                <input className="input" value={contextMode} onChange={(event) => setContextMode(event.target.value)} placeholder="auto / none" />
              </Section>
              <Section title="Token 与并发">
                <div className="settings-grid">
                  <Field label="最大输出 tokens">
                    <input className="input" type="number" value={maxOutput} onChange={(event) => setMaxOutput(Number(event.target.value))} />
                  </Field>
                  <Field label="最大上下文 tokens">
                    <input className="input" type="number" value={maxContext} onChange={(event) => setMaxContext(Number(event.target.value))} />
                  </Field>
                  <Field label="压缩阈值（0-1）">
                    <input className="input" value={compression} onChange={(event) => setCompression(event.target.value)} />
                  </Field>
                  <Field label="LLM 并发数">
                    <input className="input" type="number" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
                  </Field>
                </div>
              </Section>
            </>
          )}

          {tab === "tools" && (
            <Section title="启用的工具">
              {tools.map((tool) => (
                <Toggle
                  key={tool.name}
                  title={tool.name}
                  subtitle={tool.description}
                  checked={tool.enabled}
                  onChange={async (value) => {
                    setTools((current) =>
                      current.map((item) => (item.name === tool.name ? { ...item, enabled: value } : item)),
                    );
                    try {
                      await api.rpc("set_tool_enabled", { name: tool.name, enabled: value });
                      dropCache("settings");
                    } catch (error) {
                      setStatus(`更新工具失败：${reason(error)}`);
                    }
                  }}
                />
              ))}
            </Section>
          )}

          {tab === "appearance" && (
            <Section title="内容宽度">
              <div className="muted small">
                正文与输入框共用同一最大宽度，只在本地保存，不写入服务器。
              </div>
              <div className="width-options">
                {[
                  [760, "窄"],
                  [980, "标准"],
                  [1200, "宽"],
                  [0, "全宽"],
                ].map(([value, label]) => (
                  <button
                    key={label}
                    className={`button ${contentWidth === value ? "primary" : "secondary"} small`}
                    onClick={() => setContentWidth(value as number)}
                  >
                    {label}
                    {value ? ` · ${value}px` : ""}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {tab === "about" && (
            <Section title="关于">
              <div className="about-name">xbot desktop</div>
              <div className="muted">Tauri 2 + React · 全新重写的界面，不沿用旧 Web UI</div>
              <div className="muted small" style={{ marginTop: 12 }}>
                当前版本：{appVersion || "—"}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                后端：REST + RPC + SSE（复用 xbot web channel）
              </div>
              <div className="settings-update-host">
                <div className="field-label">更新地址（latest.json 与下载 host）</div>
                <input
                  className="input"
                  value={updateHost}
                  onChange={(event) => setUpdateHost(event.target.value)}
                  placeholder="https://your-mirror.example.com/xbot-desktop/tauri"
                />
                <div className="muted tiny" style={{ marginTop: 4 }}>
                  默认从 MinIO 拉取；可替换成镜像地址，客户端会拉该地址的 latest.json，
                  下载时也使用该 host 下的同名 exe。
                </div>
                <button
                  className="button ghost small"
                  style={{ marginTop: 6 }}
                  onClick={() => setUpdateHost("https://minio.cjiw.site/uploads/share/xbot-desktop/tauri")}
                >
                  恢复默认
                </button>
              </div>
              <div className="about-update">
                <button className="button secondary" onClick={() => void checkUpdate(true)} disabled={updateChecking}>
                  {updateChecking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                  检查更新
                </button>
                {updateInfo && (
                  <button className="button primary" onClick={() => setUpdateOpen(true)}>
                    新版本 {updateInfo.version}
                  </button>
                )}
                <button
                  className="button ghost"
                  onClick={async () => {
                    try {
                      const path = await api.openLog();
                      setStatus(`日志：${path}`);
                    } catch (error) {
                      setStatus(`打开日志失败：${reason(error)}`);
                    }
                  }}
                >
                  打开日志
                </button>
              </div>
            </Section>
          )}

          {tab === "about" && (
            <Section title="账号">
              <div className="muted small">当前账号：{username || "—"}</div>
              <div className="muted small" style={{ marginTop: 4 }}>
                服务器：{serverUrl.replace(/^https?:\/\//, "") || "—"}
              </div>
              <button
                className="button danger"
                style={{ marginTop: 10 }}
                onClick={() => {
                  setSettingsOpen(false);
                  void logout();
                }}
              >
                <LogOut size={14} />
                退出登录
              </button>
            </Section>
          )}
          </div>
        </div>

        <div className="settings-foot">
          <div className="settings-status">
            {loading && <Loader2 size={14} className="spin" />}
            {status}
          </div>
          <div className="settings-actions">
            <button className="button ghost" onClick={() => setSettingsOpen(false)}>
              关闭
            </button>
            <button className="button primary" onClick={() => void save()} disabled={loading}>
              <Check size={14} />
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <div className="section-title">{title}</div>
      <div className="section-body">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field compact">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onChange: (value: boolean) => void | Promise<void>;
}) {
  return (
    <label className="toggle-row">
      <div className="toggle-text">
        <span>{title}</span>
        {subtitle && <span className="muted tiny">{subtitle}</span>}
      </div>
      <input type="checkbox" checked={checked} onChange={(event) => void onChange(event.target.checked)} />
    </label>
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
