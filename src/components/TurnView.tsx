import { memo, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Loader2,
  Pencil,
  Trash2,
  Wrench,
} from "lucide-react";
import type { IterationUi, ToolUi, TurnUi } from "../types";
import { turnShowsFinalText } from "../chat/reducer";
import { useStore } from "../state/store";
import { copyText } from "../utils/clipboard";
import { Markdown } from "./Markdown";

export const TurnView = memo(function TurnView({ turn }: { turn: TurnUi }) {
  const rewindTurn = useStore((state) => state.rewindTurn);
  const assistantText = assistantTextOf(turn);
  return (
    <article className="turn" data-turn-id={turn.turnId}>
      {turn.userText && (
        <div className="user-row">
          <div className="user-block">
            <div className="user-bubble">{turn.userText}</div>
            <div className="msg-actions">
              <CopyButton text={turn.userText} />
              {turn.userHistoryId ? (
                <>
                  <button
                    className="msg-action"
                    title="编辑：回退到此消息，并把内容填回输入框"
                    onClick={() => void rewindTurn(turn.turnId, "edit")}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="msg-action danger"
                    title="删除这条消息及之后的所有对话"
                    onClick={() => {
                      if (window.confirm("删除这条消息及其之后的所有对话？此操作不可撤销。")) {
                        void rewindTurn(turn.turnId, "delete");
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* One continuous assistant message: iterations are internal steps, not
          separate cards. Only their content/reasoning/tools are rendered, in
          order, with no per-iteration chrome. */}
      <div className="assistant-body">
        {turn.iterations.map((iteration) => (
          <IterationFlow key={iteration.index} iteration={iteration} />
        ))}

        {turnShowsFinalText(turn) && <Markdown content={turn.finalText} />}

        {assistantText.trim() && (
          <div className="msg-actions assistant">
            <CopyButton text={assistantText} />
          </div>
        )}

        {turn.cancelled && <div className="cancelled-note">已取消</div>}
      </div>
    </article>
  );
});

function assistantTextOf(turn: TurnUi): string {
  if (turn.finalText.trim()) return turn.finalText;
  for (let index = turn.iterations.length - 1; index >= 0; index -= 1) {
    const content = turn.iterations[index].content ?? "";
    if (content.trim()) return content;
  }
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="msg-action"
      title="复制"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

const IterationFlow = memo(function IterationFlow({ iteration }: { iteration: IterationUi }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const running = !iteration.done;
  const content = iteration.content ?? "";
  const reasoning = iteration.reasoning ?? "";
  return (
    <>
      {reasoning && (
        <div className="reasoning">
          <button className="reasoning-head" onClick={() => setReasoningOpen((value) => !value)}>
            <span className={`chevron ${reasoningOpen ? "open" : ""}`}>
              <ChevronDown size={13} />
            </span>
            <span>思考过程</span>
            <span className="muted tiny">{reasoning.length} 字</span>
          </button>
          {reasoningOpen && <pre className="reasoning-body">{reasoning}</pre>}
        </div>
      )}

      <Markdown content={content} />

      {iteration.tools.length > 0 && (
        <div className="tools">
          {iteration.tools.map((tool) => (
            <ToolCard key={tool.key} tool={tool} />
          ))}
        </div>
      )}

      {running && !content && !reasoning && iteration.tools.length === 0 && (
        <div className="inline-thinking">
          <Loader2 size={14} className="spin" />
          思考中…
        </div>
      )}
    </>
  );
});

function ToolCard({ tool }: { tool: ToolUi }) {
  const [open, setOpen] = useState(false);
  const summary = describeTool(tool);
  const statusClass =
    tool.status === "error" || tool.status === "failed"
      ? "bad"
      : tool.status === "running" || tool.status === "executing"
        ? "busy"
        : "ok";
  return (
    <div className={`tool-card ${statusClass}`}>
      <button className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">
          {tool.status === "error" || tool.status === "failed" ? (
            <CircleAlert size={14} />
          ) : (
            <Wrench size={14} />
          )}
        </span>
        <span className="tool-name">{tool.label || tool.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-meta">
          {tool.elapsedMs > 0 && <span>{formatDuration(tool.elapsedMs)}</span>}
          <span className="tool-status">{tool.status || "done"}</span>
          <span className={`chevron ${open ? "open" : ""}`}>
            <ChevronDown size={12} />
          </span>
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {tool.args && (
            <>
              <div className="tool-label">参数</div>
              <pre>{pretty(tool.args)}</pre>
            </>
          )}
          {tool.detail && (
            <>
              <div className="tool-label">输出</div>
              <pre>{tool.detail}</pre>
            </>
          )}
          {!tool.args && !tool.detail && <div className="muted small">没有更多详情</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The server caps generic tool summaries at a fixed length, which leaves the
 * description short even on a wide window. When the cap fired (summary ends
 * with an ellipsis) rebuild a single-line description from the full arguments
 * and let CSS ellipsize it against the real available width.
 */
function describeTool(tool: ToolUi): string {
  const summary = (tool.summary ?? "").trim();
  const args = (tool.args ?? "").trim();
  if (!/(…|\.\.\.)$/.test(summary) || !args) return summary;
  const compact = args.replace(/\s+/g, " ");
  return `${tool.label || tool.name}: ${compact.slice(0, 400)}`;
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
