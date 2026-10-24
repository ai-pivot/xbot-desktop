import { useEffect, useRef } from "react";
import { ArrowUp, Loader2, Paperclip, Square, X } from "lucide-react";
import { useStore } from "../state/store";

export function Composer() {
  const draft = useStore((state) => state.draft);
  const setDraft = useStore((state) => state.setDraft);
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const addPastedFile = useStore((state) => state.addPastedFile);
  const send = useStore((state) => state.send);
  const cancel = useStore((state) => state.cancel);
  const busy = useStore((state) => state.chat.busy || state.chat.sessionRunning);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !!draft.trim() || attachments.length > 0;

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(180, Math.max(52, node.scrollHeight))}px`;
  }, [draft]);

  const submit = () => {
    if (!canSend) return;
    void send();
    textareaRef.current?.focus();
  };

  const takeFiles = (event: React.ClipboardEvent | React.DragEvent): File[] => {
    const files: File[] = [];
    const transfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
    for (const item of Array.from(transfer?.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    for (const file of Array.from(transfer?.files ?? [])) {
      if (!files.some((item) => item.name === file.name && item.size === file.size)) {
        files.push(file);
      }
    }
    return files;
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = takeFiles(event);
    if (!files.length) return; // plain text paste stays native
    event.preventDefault();
    for (const file of files) void addPastedFile(file);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = takeFiles(event);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) void addPastedFile(file);
  };

  return (
    <div className="composer" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
      <div className="composer-inner">
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((item) => (
              <div className="attachment-chip" key={item.path}>
                <Paperclip size={12} />
                <span className="attachment-name">{item.name}</span>
                <span className="muted tiny">{formatSize(item.size)}</span>
                <button className="chip-x" onClick={() => removeAttachment(item.path)}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="给 xbot 发消息…"
          rows={1}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (event.nativeEvent.isComposing) return;
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <button className="icon-button" title="附件" onClick={() => void addAttachment()}>
              <Paperclip size={16} />
            </button>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行 · 可粘贴图片/文件</span>
          </div>
          <div className="composer-actions">
            {busy && (
              <button className="button danger" onClick={() => void cancel()}>
                <Square size={13} />
                停止
              </button>
            )}
            <button className="button primary send-button" disabled={!canSend} onClick={submit}>
              {busy ? <span>排队发送</span> : <><ArrowUp size={15} />发送</>}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}
