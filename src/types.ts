export interface AskUserQuestion {
  question: string;
  options: string[];
  multi_select: boolean;
  allow_other: boolean;
}

export interface ToolProgress {
  name: string;
  label: string;
  status: string;
  elapsed_ms: number;
  iteration: number;
  summary: string;
  detail: string;
  args: string;
  tool_hints: string;
  ui_mode: string;
  call_id: string;
}

export interface ProgressEvent {
  iteration: number;
  content: string;
  reasoning: string;
  tool_calls: { id: string; name: string; args: string; status: string; elapsed: number }[];
  elapsed_wall: number;
  chat_id: string;
  seq: number;
  phase: string;
  active_tools: ToolProgress[];
  completed_tools: ToolProgress[];
  questions: AskUserQuestion[];
  request_id: string;
  stream_content: string;
  stream_delta: string;
  reasoning_stream_content: string;
  reasoning_stream_delta: string;
  // Two shapes share this field:
  //  - session_status: ContextUsage (has max_context_tokens / usage_percent)
  //  - progress events: TokenUsage (only prompt/completion/total/max_output)
  // Keep all fields optional so a streaming snapshot cannot clobber the
  // denominator with `undefined`.
  token_usage?: {
    available?: boolean;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    max_output_tokens?: number;
    max_context_tokens?: number;
    usage_percent?: number | null;
    context_usage_percent?: number;
    model?: string;
  } | null;
  cwd: string;
  turn_id: number;
  turn_start?: { trigger: string; content: string; request_id: string } | null;
  iteration_history: ProgressEvent[];
  history_compacted: boolean;
  resync_required: boolean;
}

export interface WsMessage {
  type: string;
  id?: string;
  seq?: number;
  content?: string;
  chat_id?: string;
  channel?: string;
  turn_id?: number;
  cancelled?: boolean;
  progress?: ProgressEvent;
  session?: {
    channel?: string;
    chat_id?: string;
    action?: string;
    label?: string;
    role?: string;
    instance?: string;
    parent_id?: string;
  };
  queue_state?: { items: QueueItemPayload[] };
  request_id?: string;
  reason?: string;
}

export interface QueueItemPayload {
  msg_id: string;
  turn_id: number;
  content: string;
  preview: string;
}

/**
 * Every SSE payload is wrapped by the Rust stream task with the identity of
 * the connection that produced it. Server progress payloads do not carry a
 * top-level chat_id, so without this stamp a torn-down stream's events would
 * be indistinguishable from the newly selected session's events.
 */
export interface SseEnvelope {
  stream_chat_id: string;
  stream_channel: string;
  message: WsMessage;
}

export interface SseSeqPayload {
  chat_id: string;
  channel: string;
  seq: number;
}

export interface SseStatusPayload {
  state: "connecting" | "connected" | "error" | "disconnected";
  message: string;
  chat_id: string;
  channel: string;
}

/** /api/history/rewind response. `draft` is the removed user message. */
export interface RewindResult {
  draft?: string;
  target_history_id?: number;
  history_rewound?: boolean;
  files_rewound?: boolean;
}

export interface HistoryIteration {
  iteration: number;
  content: string;
  reasoning: string;
  tools: ToolProgress[];
  elapsed_wall: number;
  tokens: number;
  ttft_ms: number;
  tokens_per_sec: number;
}

export interface HistoryMessage {
  id: number;
  history_id: number;
  role: string;
  content: string;
  reasoning_content: string;
  turn_id: number;
  iterations: HistoryIteration[];
  timestamp: string;
}

export interface HistoryResponse {
  messages: HistoryMessage[];
  processing: boolean;
  active_progress: ProgressEvent | null;
  last_seq: number;
  has_more: boolean;
  oldest_id: number;
}

export interface UserChat {
  chat_id: string;
  channel: string;
  label: string;
  work_dir: string;
  last_active: string;
  preview: string;
  running: boolean;
  type: string;
  role: string;
  instance: string;
  parent_chat_id: string;
  children: UserChat[];
}

export interface SessionNode extends UserChat {
  depth: number;
}

export interface ModelEntry {
  sub_id: string;
  sub_name: string;
  model: string;
  status: string;
  vision: boolean;
}

export interface ToolUi {
  key: string;
  name: string;
  label: string;
  status: string;
  args: string;
  detail: string;
  summary: string;
  hints: string;
  uiMode: string;
  elapsedMs: number;
  iteration: number;
}

export interface IterationUi {
  index: number;
  content: string;
  reasoning: string;
  tools: ToolUi[];
  done: boolean;
}

export interface TurnUi {
  turnId: number;
  userText: string;
  /** DB history_id of the user message — required by /api/history/rewind. */
  userHistoryId?: number;
  iterations: IterationUi[];
  finalText: string;
  cancelled: boolean;
}

export interface AskUserUi {
  requestId: string;
  questions: AskUserQuestion[];
}

export interface QueueItemUi {
  msgId: string;
  turnId: number;
  content: string;
  preview: string;
}

export interface ContextBudget {
  promptTokens: number;
  maxContextTokens: number;
  percent: number;
  model: string;
}

export interface ChatState {
  chatId: string;
  channel: string;
  title: string;
  loading: boolean;
  busy: boolean;
  connected: boolean;
  error: string | null;
  turns: TurnUi[];
  liveTurnId: number;
  liveIteration: number;
  pendingUserText: string | null;
  hasMore: boolean;
  oldestId: number;
  loadingMore: boolean;
  needsReload: boolean;
  reloadReplaces: boolean;
  askUser: AskUserUi | null;
  queue: QueueItemUi[];
  context: ContextBudget | null;
  cwd: string;
  sessionRunning: boolean;
}


export interface UpdateInfo {
  version: string;
  url: string;
  sha256: string;
  notes: string;
  published_at: string;
}

export interface UpdateCheck {
  current: string;
  available: UpdateInfo | null;
}


export interface FsEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mode: string;
  mod_time: string;
}

export interface FsListResponse {
  entries: FsEntry[];
}
