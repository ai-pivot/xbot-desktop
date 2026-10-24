import type {
  AskUserQuestion,
  AskUserUi,
  ChatState,
  ContextBudget,
  HistoryIteration,
  HistoryMessage,
  HistoryResponse,
  IterationUi,
  ProgressEvent,
  QueueItemUi,
  SseEnvelope,
  ToolProgress,
  ToolUi,
  TurnUi,
  WsMessage,
} from "../types";

export function emptyChat(chatId: string, channel: string, title = ""): ChatState {
  return {
    chatId,
    channel,
    title,
    loading: true,
    busy: false,
    connected: false,
    error: null,
    turns: [],
    liveTurnId: 0,
    liveIteration: 0,
    pendingUserText: null,
    hasMore: false,
    oldestId: 0,
    loadingMore: false,
    needsReload: false,
    reloadReplaces: false,
    askUser: null,
    queue: [],
    context: null,
    cwd: "",
    sessionRunning: false,
  };
}

export function withConnected(state: ChatState, connected: boolean): ChatState {
  return state.connected === connected ? state : { ...state, connected };
}

export function withError(state: ChatState, error: string | null): ChatState {
  return state.error === error ? state : { ...state, error };
}

export function withSessionStatus(
  state: ChatState,
  cwd: string,
  usage: ProgressEvent["token_usage"] | null,
): ChatState {
  return {
    ...state,
    cwd: cwd || state.cwd,
    context: budgetFromUsage(usage),
  };
}

export function budgetFromUsage(
  usage: ProgressEvent["token_usage"] | null | undefined,
): ContextBudget | null {
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens ?? 0;
  const maxContextTokens = usage.max_context_tokens ?? 0;
  // usage_percent is nil/0 until the provider returns an exact count.
  // Never let a placeholder 0 hide a real prompt/max ratio.
  const percent =
    usage.usage_percent != null && usage.usage_percent > 0
      ? usage.usage_percent / 100
      : maxContextTokens > 0
        ? promptTokens / maxContextTokens
        : 0;
  if (!usage.available && !promptTokens && usage.usage_percent == null) return null;
  return {
    promptTokens,
    maxContextTokens,
    percent: Math.max(0, Math.min(1, percent)),
    model: usage.model ?? "",
  };
}

export function withHistory(state: ChatState, response: HistoryResponse, replace = true): ChatState {
  const map = new Map<number, TurnUi>();
  const order: number[] = [];
  for (const message of response.messages ?? []) mergeHistoryMessage(map, order, message);

  const active = response.active_progress;
  const activeRunning = !!active && isRunning(active);
  let next: ChatState = {
    ...state,
    loading: false,
    error: null,
    turns: order.sort((a, b) => a - b).map((id) => map.get(id)!),
    busy: response.processing || activeRunning,
    hasMore: response.has_more,
    oldestId: response.oldest_id,
    loadingMore: false,
    needsReload: false,
    reloadReplaces: false,
    pendingUserText: null,
    ...(replace ? {} : {}),
  };
  if (active && (active.turn_id > 0 || activeRunning)) next = applyProgress(next, active);
  return next;
}

export function mergeLatestHistory(state: ChatState, response: HistoryResponse): ChatState {
  const map = new Map(state.turns.map((turn) => [turn.turnId, turn]));
  const order = state.turns.map((turn) => turn.turnId);
  for (const message of response.messages ?? []) mergeHistoryMessage(map, order, message);
  const active = response.active_progress;
  const activeRunning = !!active && isRunning(active);
  let next: ChatState = {
    ...state,
    loading: false,
    error: null,
    turns: order.sort((a, b) => a - b).map((id) => map.get(id)!),
    busy: response.processing || activeRunning,
    hasMore: state.oldestId > 0 && response.oldest_id > 0 && state.oldestId < response.oldest_id
      ? state.hasMore
      : response.has_more,
    oldestId: state.oldestId > 0 && response.oldest_id > 0 && state.oldestId < response.oldest_id
      ? state.oldestId
      : response.oldest_id,
    loadingMore: false,
    needsReload: false,
    reloadReplaces: false,
    pendingUserText: null,
  };
  if (active && (active.turn_id > 0 || activeRunning)) next = applyProgress(next, active);
  return next;
}

export function prependHistory(state: ChatState, response: HistoryResponse): ChatState {
  const map = new Map(state.turns.map((turn) => [turn.turnId, turn]));
  const order = state.turns.map((turn) => turn.turnId);
  for (const message of response.messages ?? []) mergeHistoryMessage(map, order, message);
  return {
    ...state,
    turns: order.sort((a, b) => a - b).map((id) => map.get(id)!),
    hasMore: response.has_more,
    oldestId: response.oldest_id,
    loading: false,
    loadingMore: false,
  };
}

export function sendAccepted(
  state: ChatState,
  text: string,
  turnId: number,
  queued: boolean,
): ChatState {
  if (turnId <= 0) return { ...state, pendingUserText: text, error: null };
  const existing = state.turns.find((turn) => turn.turnId === turnId);
  const turn: TurnUi = existing
    ? { ...existing, userText: existing.userText || text }
    : { turnId, userText: text, iterations: [], finalText: "", cancelled: false };
  return {
    ...state,
    turns: upsertTurn(state.turns, turn),
    pendingUserText: null,
    busy: existing ? state.busy : true,
    liveTurnId: turnId,
    error: null,
  };
}

export function applyEvent(state: ChatState, message: WsMessage): ChatState {
  switch (message.type) {
    case "progress_structured":    case "progress":
    case "sync_progress":
    case "stream_content":
    case "turn_started":
      return message.progress ? applyProgress(state, message.progress) : state;
    case "text":
      return applyText(state, message);
    case "user_echo":
    case "inject_user":
      return applyUserEcho(state, message);
    case "session":
      return applySession(state, message);
    case "ask_user":
      return applyAskUser(state, message);
    case "ask_user_resolved":
      return applyAskUserResolved(state, message);
    case "queue_state":
      return {
        ...state,
        queue: (message.queue_state?.items ?? []).map((item) => ({
          msgId: item.msg_id,
          turnId: item.turn_id,
          content: item.content,
          preview: item.preview,
        })),
      };
    case "resync_required":
      return { ...state, needsReload: true };
    default:
      return state;
  }
}

/**
 * Applies a batch of SSE events, but only those produced by the stream whose
 * session is currently rendered. Events from a stream that was torn down by a
 * session switch (or that arrived after the switch) must never mutate another
 * session's state — that is what made A's iterations appear in B.
 *
 * Returns the identical state reference when nothing belongs to `state`.
 */
export function applyStreamEvents(state: ChatState, envelopes: SseEnvelope[]): ChatState {
  if (!state.chatId) return state;
  let chat = state;
  for (const envelope of envelopes) {
    if (!envelope.stream_chat_id || envelope.stream_chat_id !== state.chatId) continue;
    if (envelope.stream_channel && envelope.stream_channel !== state.channel) continue;
    chat = applyEvent(chat, envelope.message);
  }
  return chat;
}

export function applyProgress(state: ChatState, progress: ProgressEvent): ChatState {
  let next = state;
  if (progress.token_usage) {
    const usage = progress.token_usage;
    const hasMax = (usage.max_context_tokens ?? 0) > 0;
    if (hasMax) {
      const budget = budgetFromUsage(usage);
      if (budget) next = { ...next, context: budget };
    } else if (next.context && (usage.prompt_tokens ?? 0) > 0) {
      // Progress events carry TokenUsage (no max_context_tokens). Keep the
      // denominator from session_status and only advance the numerator.
      const prompt = usage.prompt_tokens ?? 0;
      const max = next.context.maxContextTokens;
      next = {
        ...next,
        context: {
          ...next.context,
          promptTokens: prompt,
          percent: max > 0 ? Math.max(0, Math.min(1, prompt / max)) : next.context.percent,
        },
      };
    }
  }
  if (progress.cwd) next = { ...next, cwd: progress.cwd };

  let turnId = progress.turn_id > 0 ? progress.turn_id : next.liveTurnId;
  if (progress.turn_start) {
    if (turnId <= 0) {
      turnId = (next.turns.length ? Math.max(...next.turns.map((turn) => turn.turnId)) : 0) + 1;
    }
    next = ensureTurn(next, turnId, progress.turn_start.content);
    next = { ...next, pendingUserText: null, liveTurnId: turnId, busy: true };
  }

  if (turnId <= 0) {
    return isTerminal(progress)
      ? { ...next, busy: false, liveTurnId: 0, liveIteration: 0 }
      : next;
  }

  if (progress.iteration_history?.length) {
    const incoming = progress.iteration_history.map(toIterationUi);
    next = updateTurn(next, turnId, (turn) => ({
      ...turn,
      iterations: mergeIterations(turn.iterations, incoming),
    }));
  }

  const current = next.turns.find((turn) => turn.turnId === turnId);
  const fallbackIteration = current?.iterations.length
    ? Math.max(...current.iterations.map((iteration) => iteration.index))
    : 0;
  const index = progress.iteration > 0 ? progress.iteration : fallbackIteration || 1;

  next = ensureTurn(next, turnId, "");
  next = updateTurn(next, turnId, (turn) => {
    const existing = turn.iterations.find((iteration) => iteration.index === index);
    let iteration: IterationUi = existing ?? { index, content: "", reasoning: "", tools: [], done: false };

    const incomingTools: ToolProgress[] = [
      ...(progress.active_tools ?? []),
      ...(progress.completed_tools ?? []),
      ...(progress.tool_calls ?? []).map((call) => ({
        name: call.name,
        label: call.name,
        status: call.status,
        elapsed_ms: call.elapsed,
        iteration: index,
        summary: "",
        detail: "",
        args: call.args,
        tool_hints: "",
        ui_mode: "",
        call_id: call.id,
      })),
    ];
    if (incomingTools.length) {
      iteration = {
        ...iteration,
        tools: mergeTools(iteration.tools, incomingTools.map((tool) => toToolUi(tool, index))),
      };
    }

    if (progress.stream_content) iteration = { ...iteration, content: progress.stream_content };
    else if (progress.stream_delta) iteration = { ...iteration, content: iteration.content + progress.stream_delta };
    else if (progress.content) iteration = { ...iteration, content: progress.content };

    if (progress.reasoning_stream_content) iteration = { ...iteration, reasoning: progress.reasoning_stream_content };
    else if (progress.reasoning_stream_delta) iteration = { ...iteration, reasoning: iteration.reasoning + progress.reasoning_stream_delta };
    else if (progress.reasoning) iteration = { ...iteration, reasoning: progress.reasoning };

    if (isTerminal(progress)) iteration = { ...iteration, done: true };

    return {
      ...turn,
      iterations: upsertIteration(turn.iterations, iteration),
      finalText: isTerminal(progress) && progress.content && !turn.finalText ? progress.content : turn.finalText,
    };
  });

  const finished = isTerminal(progress);
  return {
    ...next,
    busy: !finished,
    sessionRunning: finished ? false : next.sessionRunning,
    liveTurnId: finished ? 0 : turnId,
    liveIteration: finished ? 0 : index,
  };
}

export function applyText(state: ChatState, message: WsMessage): ChatState {
  const turnId = message.turn_id && message.turn_id > 0 ? message.turn_id : state.liveTurnId;
  if (turnId <= 0) {
    if (!message.content) return state;
    const id = (state.turns.length ? Math.max(...state.turns.map((turn) => turn.turnId)) : 0) + 1;
    return {
      ...state,
      turns: upsertTurn(state.turns, {
        turnId: id,
        userText: "",
        iterations: [],
        finalText: message.content,
        cancelled: !!message.cancelled,
      }),
      busy: false,
      sessionRunning: false,
    };
  }
  let next = ensureTurn(state, turnId, "");
  next = updateTurn(next, turnId, (turn) => ({
    ...turn,
    finalText: message.content || turn.finalText,
    cancelled: !!message.cancelled,
  }));
  return { ...next, busy: false, sessionRunning: false, liveTurnId: 0, liveIteration: 0 };
}

export function applyUserEcho(state: ChatState, message: WsMessage): ChatState {
  const turnId = message.turn_id ?? 0;
  if (turnId <= 0) return state;
  let next = ensureTurn(state, turnId, message.content ?? "");
  next = updateTurn(next, turnId, (turn) => ({
    ...turn,
    userText: turn.userText || message.content || "",
  }));
  return { ...next, pendingUserText: null, busy: true, liveTurnId: turnId };
}

export function applySession(state: ChatState, message: WsMessage): ChatState {
  const event = message.session;
  if (!event) return state;
  if (event.chat_id && state.chatId && event.chat_id !== state.chatId) return state;
  switch (event.action) {
    case "busy":
      return { ...state, busy: true, sessionRunning: true };
    case "idle":
      if (state.sessionRunning && state.liveTurnId > 0) return state;
      return { ...state, busy: false, sessionRunning: false, liveTurnId: 0, liveIteration: 0 };
    case "deleted":
      return { ...state, busy: false, sessionRunning: false };
    case "history_rewound":
      return { ...state, needsReload: true, reloadReplaces: true };
    default:
      return state;
  }
}

export function applyAskUser(state: ChatState, message: WsMessage): ChatState {
  const progress = message.progress;
  let questions = progress?.questions ?? [];
  let requestId = progress?.request_id ?? "";
  if (!questions.length) {
    const parsed = parseAskUserContent(message.content ?? "");
    questions = parsed.questions;
    requestId = parsed.requestId;
  }
  if (!questions.length) return state;
  return { ...state, askUser: { requestId, questions } };
}

export function applyAskUserResolved(state: ChatState, message: WsMessage): ChatState {
  if (!state.askUser) return state;
  if (message.request_id && state.askUser.requestId && message.request_id !== state.askUser.requestId) {
    return state;
  }
  return { ...state, askUser: null };
}

export function dismissAskUser(state: ChatState): ChatState {
  return { ...state, askUser: null };
}

export function acknowledgeReload(state: ChatState): ChatState {
  return { ...state, needsReload: false, reloadReplaces: false };
}

function isTerminal(progress: ProgressEvent): boolean {
  return progress.phase === "done" || progress.phase === "cancelled" || progress.phase === "error";
}

function isRunning(progress: ProgressEvent): boolean {
  return !!progress.phase && !isTerminal(progress);
}

function mergeHistoryMessage(
  map: Map<number, TurnUi>,
  order: number[],
  message: HistoryMessage,
): void {
  if (!message.turn_id || message.turn_id <= 0) return;
  let turn = map.get(message.turn_id);
  if (!turn) {
    turn = { turnId: message.turn_id, userText: "", iterations: [], finalText: "", cancelled: false };
    map.set(message.turn_id, turn);
    order.push(message.turn_id);
  }
  if (message.role === "user") {
    turn.userText = message.content || turn.userText;
    // Needed to rewind: /api/history/rewind truncates at this DB history_id.
    const historyId = message.history_id || message.id;
    if (historyId > 0) turn.userHistoryId = historyId;
  } else if (message.role === "assistant") {
    if (message.iterations?.length) {
      turn.iterations = mergeIterations(turn.iterations, message.iterations.map(toIterationUi));
    }
    if (message.content) turn.finalText = message.content;
  }
}

function toIterationUi(iteration: HistoryIteration | ProgressEvent): IterationUi {
  if ("iteration_history" in iteration) {
    const progress = iteration as ProgressEvent;
    return {
      index: progress.iteration > 0 ? progress.iteration : 1,
      // Progress events only carry the fields that changed; `content` /
      // `reasoning` can be absent on tool-only or delta-only snapshots. The UI
      // calls string methods on them, so normalize at the boundary.
      content: progress.content ?? "",
      reasoning: progress.reasoning ?? "",
      tools: [...(progress.active_tools ?? []), ...(progress.completed_tools ?? [])].map((tool) =>
        toToolUi(tool, progress.iteration),
      ),
      done: progress.phase === "done",
    };
  }
  const history = iteration as HistoryIteration;
  return {
    index: history.iteration > 0 ? history.iteration : 1,
    content: history.content ?? "",
    reasoning: history.reasoning ?? "",
    tools: (history.tools ?? []).map((tool) => toToolUi(tool, history.iteration)),
    done: true,
  };
}

function toToolUi(tool: ToolProgress, fallbackIteration: number): ToolUi {
  return {
    key: tool.call_id || `${tool.name}_${tool.iteration || fallbackIteration}_${tool.label}`,
    name: tool.name,
    label: tool.label,
    status: tool.status,
    args: tool.args,
    detail: tool.detail,
    summary: tool.summary,
    hints: tool.tool_hints,
    uiMode: tool.ui_mode,
    elapsedMs: tool.elapsed_ms,
    iteration: tool.iteration || fallbackIteration,
  };
}

function mergeIterations(existing: IterationUi[], incoming: IterationUi[]): IterationUi[] {
  if (!incoming.length) return existing;
  const result = [...existing];
  for (const candidate of incoming) {
    const index = result.findIndex((iteration) => iteration.index === candidate.index);
    if (index < 0) {
      result.push(candidate);
      continue;
    }
    const previous = result[index];
    result[index] = {
      ...previous,
      content: candidate.content || previous.content,
      reasoning: candidate.reasoning || previous.reasoning,
      tools: mergeTools(previous.tools, candidate.tools),
      done: previous.done || candidate.done,
    };
  }
  return result.sort((a, b) => a.index - b.index);
}

function mergeTools(existing: ToolUi[], incoming: ToolUi[]): ToolUi[] {
  if (!incoming.length) return existing;
  const result = [...existing];
  for (const candidate of incoming) {
    const index = result.findIndex((tool) => tool.key === candidate.key);
    if (index < 0) {
      result.push(candidate);
      continue;
    }
    const previous = result[index];
    result[index] = {
      ...previous,
      name: candidate.name || previous.name,
      label: candidate.label || previous.label,
      status: candidate.status || previous.status,
      args: candidate.args || previous.args,
      detail: candidate.detail || previous.detail,
      summary: candidate.summary || previous.summary,
      hints: candidate.hints || previous.hints,
      uiMode: candidate.uiMode || previous.uiMode,
      elapsedMs: Math.max(previous.elapsedMs, candidate.elapsedMs),
      iteration: candidate.iteration || previous.iteration,
    };
  }
  return result;
}

function upsertIteration(iterations: IterationUi[], iteration: IterationUi): IterationUi[] {
  const result = [...iterations];
  const index = result.findIndex((item) => item.index === iteration.index);
  if (index < 0) result.push(iteration);
  else {
    const previous = result[index];
    result[index] = {
      ...previous,
      content: iteration.content || previous.content,
      reasoning: iteration.reasoning || previous.reasoning,
      tools: mergeTools(previous.tools, iteration.tools),
      done: previous.done || iteration.done,
    };
  }
  return result.sort((a, b) => a.index - b.index);
}

function ensureTurn(state: ChatState, turnId: number, userText: string): ChatState {
  if (turnId <= 0) return state;
  const existing = state.turns.find((turn) => turn.turnId === turnId);
  const turn: TurnUi = existing
    ? { ...existing, userText: existing.userText || userText }
    : { turnId, userText, iterations: [], finalText: "", cancelled: false };
  return { ...state, turns: upsertTurn(state.turns, turn) };
}

function updateTurn(
  state: ChatState,
  turnId: number,
  transform: (turn: TurnUi) => TurnUi,
): ChatState {
  const turns = [...state.turns];
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  if (index < 0) return state;
  turns[index] = transform(turns[index]);
  return { ...state, turns };
}

function upsertTurn(turns: TurnUi[], turn: TurnUi): TurnUi[] {
  const result = [...turns];
  const index = result.findIndex((item) => item.turnId === turn.turnId);
  if (index < 0) result.push(turn);
  else result[index] = turn;
  return result.sort((a, b) => a.turnId - b.turnId);
}

export function parseAskUserContent(raw: string): { questions: AskUserQuestion[]; requestId: string } {
  if (!raw) return { questions: [], requestId: "" };
  try {
    const object = JSON.parse(raw) as { request_id?: string; questions?: unknown };
    const requestId = typeof object.request_id === "string" ? object.request_id : "";
    if (typeof object.questions === "string") {
      return { questions: JSON.parse(object.questions) as AskUserQuestion[], requestId };
    }
    if (Array.isArray(object.questions)) {
      return { questions: object.questions as AskUserQuestion[], requestId };
    }
  } catch {
    // not JSON
  }
  return { questions: [], requestId: "" };
}

export function turnShowsFinalText(turn: TurnUi): boolean {
  if (!turn.finalText.trim()) return false;
  const last = turn.iterations[turn.iterations.length - 1]?.content ?? "";
  return turn.finalText.trim() !== last.trim();
}

/**
 * A turn that already has assistant output but no user text means the page
 * boundary split the turn: its user message lives further back in history.
 * The server paginates by raw message id, so this happens for any turn whose
 * rows exceed one page.
 */
export function turnNeedsUserMessage(turn: TurnUi): boolean {
  return !turn.userText && (turn.iterations.length > 0 || !!turn.finalText.trim());
}

export function needsOlderHistory(state: ChatState): boolean {
  return state.turns.some(turnNeedsUserMessage);
}

export function queueToUi(items: QueueItemUi[]): QueueItemUi[] {
  return items;
}
