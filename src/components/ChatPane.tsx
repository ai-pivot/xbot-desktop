import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpCircle, Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useStore } from "../state/store";
import { copyText } from "../utils/clipboard";
import { TurnView } from "./TurnView";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { ContextMenu } from "./ContextMenu";
import { AskUserPanel } from "./AskUserPanel";

export function ChatPane() {
  const chat = useStore((state) => state.chat);
  const sessions = useStore((state) => state.sessions);
  const activeChatId = useStore((state) => state.activeChatId);
  const models = useStore((state) => state.models);
  const selectedModel = useStore((state) => state.selectedModel);
  const selectModel = useStore((state) => state.selectModel);
  const loadMore = useStore((state) => state.loadMore);
  const refreshStatus = useStore((state) => state.refreshStatus);
  const cancelQueued = useStore((state) => state.cancelQueued);
  const dismissAskUser = useStore((state) => state.dismissAskUser);
  const updateInfo = useStore((state) => state.updateInfo);
  const updateOpen = useStore((state) => state.updateOpen);
  const setUpdateOpen = useStore((state) => state.setUpdateOpen);
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; selected: boolean } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Captured when "load earlier" is clicked so the viewport can stay on the
  // same message after older history is prepended above it.
  const loadAnchorRef = useRef<{ height: number; top: number; firstTurnId: number } | null>(null);

  const active = sessions.find((node) => node.chat_id === activeChatId);
  const title = active?.label || chat.title || "xbot";
  const busy = chat.busy || chat.sessionRunning;
  const live = chat.turns.find((turn) => turn.turnId === chat.liveTurnId);
  const liveIteration = live?.iterations.find((iteration) => iteration.index === chat.liveIteration);
  const showThinking =
    busy &&
    (!liveIteration ||
      (!liveIteration.content && !liveIteration.reasoning && liveIteration.tools.length === 0));

  useEffect(() => {
    if (!chat.turns.length) return;
    if (!stickRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    const run = () => {
      if (node && stickRef.current) node.scrollTop = node.scrollHeight;
    };
    requestAnimationFrame(run);
    const timer = window.setTimeout(run, 80);
    return () => window.clearTimeout(timer);
  }, [chat.turns, chat.liveIteration, chat.busy]);

  useLayoutEffect(() => {
    // Opening a session must land at the bottom immediately — CSS smooth
    // scrolling made it visibly slide from the top on every re-entry.
    stickRef.current = true;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      if (node && stickRef.current) node.scrollTop = node.scrollHeight;
    });
  }, [activeChatId]);

  useLayoutEffect(() => {
    // Prepending older history must not move the viewport: keep the message
    // the user was reading at the same screen position by adding the height of
    // the inserted block to scrollTop (before paint, so there is no jump).
    const node = scrollRef.current;
    const anchor = loadAnchorRef.current;
    if (!node || !anchor) return;
    const firstTurnId = chat.turns[0]?.turnId ?? 0;
    if (firstTurnId === anchor.firstTurnId) return;
    loadAnchorRef.current = null;
    const delta = node.scrollHeight - anchor.height;
    if (delta > 0) node.scrollTop = anchor.top + delta;
    stickRef.current = false;
  }, [chat.turns]);

  const loadEarlier = () => {
    const node = scrollRef.current;
    if (node) {
      loadAnchorRef.current = {
        height: node.scrollHeight,
        top: node.scrollTop,
        firstTurnId: chat.turns[0]?.turnId ?? 0,
      };
    }
    void loadMore();
  };

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
  };

  const onContextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    const turnEl = target.closest<HTMLElement>("[data-turn-id]");
    if (!turnEl) return;
    event.preventDefault();
    const turn = chat.turns.find((item) => String(item.turnId) === turnEl.dataset.turnId);
    if (!turn) return;
    const selection = window.getSelection()?.toString().trim() ?? "";
    const text = selection || turnText(turn);
    if (!text) return;
    setMenu({ x: event.clientX, y: event.clientY, text, selected: !!selection });
  };

  if (!activeChatId) {
    return (
      <main className="chat empty-chat">
        <div className="empty-state">
          <div className="empty-logo">x</div>
          <h2>选择一个会话</h2>
          <p className="muted">从左侧选择会话，或新建一个开始。</p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title-block">
          <div className="chat-title">{title}</div>
          <div className="chat-sub">
            <span className={`conn ${chat.connected ? "on" : "off"}`}>
              {chat.connected ? <Wifi size={11} /> : <WifiOff size={11} />}
              {chat.connected ? "已连接" : "重连中"}
            </span>
            {chat.cwd && <span className="cwd" title={chat.cwd}>{chat.cwd}</span>}
          </div>
        </div>

        <div className="chat-header-tools">
          {chat.context && (
            <div className="context-meter" title={`${formatTokens(chat.context.promptTokens)} / ${chat.context.maxContextTokens > 0 ? formatTokens(chat.context.maxContextTokens) : "?"}`}>
              <div className="context-bar">
                <div style={{ width: `${Math.min(100, chat.context.percent * 100)}%` }} />
              </div>
              <span>{Math.round(chat.context.percent * 100)}%</span>
            </div>
          )}
          <ModelPicker
            models={models}
            selected={selectedModel}
            disabled={busy}
            onSelect={(entry) => void selectModel(entry)}
          />
          <button className="icon-button" title="刷新状态" onClick={() => void refreshStatus()}>
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      {updateInfo && !updateOpen && (
        <div className="update-banner">
          <ArrowUpCircle size={15} />
          <span>新版本 {updateInfo.version} 可用</span>
          <button className="button small primary" onClick={() => setUpdateOpen(true)}>
            查看更新
          </button>
        </div>
      )}

      <div className="messages" ref={scrollRef} onScroll={onScroll} onContextMenu={onContextMenu}>
        <div className="messages-inner">
          {chat.hasMore && (
            <button className="load-more" onClick={loadEarlier} disabled={chat.loadingMore}>
              {chat.loadingMore ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}
              加载更早的消息
            </button>
          )}

          {!chat.turns.length && !chat.loading && (
            <div className="empty-state compact">
              <div className="empty-logo small">x</div>
              <h2>开始对话</h2>
              <p className="muted">在下方输入消息。Enter 发送，Shift+Enter 换行。</p>
            </div>
          )}

          {chat.turns.map((turn) => (
            <TurnView key={turn.turnId} turn={turn} />
          ))}

          {chat.pendingUserText && (
            <div className="user-row">
              <div className="user-bubble pending">{chat.pendingUserText}</div>
            </div>
          )}

          {showThinking && (
            <div className="inline-thinking">
              <Loader2 size={14} className="spin" />
              思考中…
            </div>
          )}

          {chat.error && <div className="error-box">{chat.error}</div>}
        </div>
      </div>

      {chat.askUser && (
        <AskUserPanel prompt={chat.askUser} onSubmit={useStore.getState().answerAskUser} onLater={dismissAskUser} />
      )}

      {chat.queue.length > 0 && (
        <div className="queue-tray">
          <div className="queue-title">待发送队列</div>
          {chat.queue.map((item) => (
            <div className="queue-item" key={item.msgId}>
              <span>{item.preview || item.content}</span>
              <button className="icon-button tiny" onClick={() => void cancelQueued(item.msgId)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <Composer />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...(menu.selected
              ? [{ label: "复制选中内容", action: () => void copyText(menu.text) }]
              : []),
            { label: "复制本条消息", action: () => void copyText(menu.text) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </main>
  );
}

function turnText(turn: { userText: string; iterations: { content: string }[]; finalText: string }): string {
  const parts = [turn.userText, ...turn.iterations.map((iteration) => iteration.content), turn.finalText]
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.filter((value, index) => parts.indexOf(value) === index).join("\n\n");
}

function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
