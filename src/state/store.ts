import { create } from "zustand";
import { api, onSse, onSseHeartbeat, onSseSeq, onSseStatus, onUpdateProgress } from "../api";
import { logEvent } from "../log";
import {
  clearCache,
  dropCache,
  isFresh,
  readCache,
  setCacheScope,
  writeCache,
} from "../cache";
import {
  acknowledgeReload,
  applyStreamEvents,
  dismissAskUser,
  emptyChat,
  mergeLatestHistory,
  needsOlderHistory,
  prependHistory,
  sendAccepted,
  withConnected,
  withError,
  withHistory,
  withSessionStatus,
} from "../chat/reducer";
import type {
  ChatState,
  HistoryResponse,
  ModelEntry,
  SessionNode,
  SseEnvelope,
  ToolProgress,
  UpdateInfo,
  UserChat,
  WsMessage,
} from "../types";

export interface Attachment {
  path: string;
  uploadKey: string;
  name: string;
  size: number;
  mime: string;
}

type Screen = "loading" | "login" | "shell";

interface Store {
  screen: Screen;
  serverUrl: string;
  username: string;
  loginBusy: boolean;
  loginError: string | null;
  rememberLogin: boolean;
  setRememberLogin: (value: boolean) => void;
  loginHint: string | null;
  bootstrapAvailable: boolean;
  sessions: SessionNode[];
  activeChatId: string;
  activeChannel: string;
  chat: ChatState;
  models: ModelEntry[];
  selectedModel: ModelEntry | null;
  settingsOpen: boolean;
  contentWidth: number;
  draft: string;
  attachments: Attachment[];
  toast: string | null;
  lastSeq: Record<string, number>;
  appVersion: string;
  updateHost: string;
  updateInfo: UpdateInfo | null;
  updateChecking: boolean;
  updateProgress: number;
  updateReadyPath: string | null;
  updateOpen: boolean;
  updateError: string | null;

  bootstrap: () => Promise<void>;
  login: (serverUrl: string, username: string, password: string, remember?: boolean) => Promise<void>;
  register: (serverUrl: string, username: string, password: string, remember?: boolean) => Promise<void>;
  detectServer: (serverUrl: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSessions: (showError?: boolean) => Promise<void>;
  selectSession: (node: SessionNode) => Promise<void>;
  reloadHistory: (replaces?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  send: () => Promise<void>;
  cancel: () => Promise<void>;
  setDraft: (value: string) => void;
  addAttachment: () => Promise<void>;
  removeAttachment: (path: string) => void;
  answerAskUser: (answers: Record<string, string>) => Promise<void>;
  dismissAskUser: () => void;
  cancelQueued: (msgId: string) => Promise<void>;
  rewindTurn: (turnId: number, mode: "edit" | "delete") => Promise<void>;
  selectModel: (entry: ModelEntry) => Promise<void>;
  refreshStatus: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setContentWidth: (value: number) => void;
  setToast: (toast: string | null) => void;
  checkUpdate: (manual?: boolean) => Promise<void>;
  setUpdateHost: (host: string) => void;
  addPastedFile: (file: File) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  setUpdateOpen: (open: boolean) => void;
  newSession: (label: string, workDir: string) => Promise<void>;
  renameSession: (label: string) => Promise<void>;
  deleteSession: () => Promise<void>;
  forkSession: (label: string) => Promise<void>;
  loadModels: () => Promise<void>;
}

const LS_SERVER = "xbot.server";
const LS_USER = "xbot.username";
const LS_CHAT = "xbot.activeChat";
const LS_SEQ = "xbot.lastSeq";
const LS_UPDATE_HOST = "xbot.updateHost";
const LS_CONTENT_WIDTH = "xbot.contentWidth";
export const DEFAULT_UPDATE_HOST = "https://minio.cjiw.site/uploads/share/xbot-desktop/tauri";
/** Client-only display setting: shared max width for messages and the composer. */
export const DEFAULT_CONTENT_WIDTH = 980;

function readContentWidth(): number {
  try {
    const value = Number(localStorage.getItem(LS_CONTENT_WIDTH));
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {
    // storage disabled
  }
  return DEFAULT_CONTENT_WIDTH;
}

function isLocalServer(value: string): boolean {
  const text = (value || "").trim().toLowerCase();
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(text);
}

let bridgeInitialized = false;
let bootStarted = false;
let sseQueue: SseEnvelope[] = [];
let flushTimer: number | null = null;
let refreshTimer: number | null = null;

/**
 * Monotonic session generation. Every explicit switch bumps it; async work
 * captures the value it started under and refuses to touch state once the
 * user has moved on. Without this, a slow `/api/history` response for the
 * previous session could overwrite the freshly selected one (and start an SSE
 * stream for it).
 */
let sessionEpoch = 0;

/**
 * The stream the Rust side is currently running for us. History reloads must
 * NOT restart it: every restart emits `connecting`, which flips the header to
 * "重连中" for a moment even though the session never lost its feed. Only an
 * explicit session switch (or a watchdog-driven recovery) may replace it.
 */
let activeStream: { chatId: string; channel: string } | null = null;

/** Last time this stream produced anything (event, seq or heartbeat). */
let lastStreamAt = 0;

function flatten(nodes: UserChat[] | null | undefined, depth = 0): SessionNode[] {
  const result: SessionNode[] = [];
  for (const node of nodes ?? []) {
    if (!node?.chat_id) continue;
    result.push({ ...node, children: node.children ?? [], depth });
    result.push(...flatten(node.children, depth + 1));
  }
  return result;
}

function treeToSessions(tree: unknown): SessionNode[] {
  const value = tree as { sessions?: UserChat[]; orphan_subagents?: UserChat[] } | null;
  return [...flatten(value?.sessions), ...flatten(value?.orphan_subagents)];
}

function pickModel(
  models: ModelEntry[],
  current: { subscription_id?: string; model?: string } | null,
): ModelEntry | null {
  return (
    models.find(
      (entry) => entry.sub_id === current?.subscription_id && entry.model === current?.model,
    ) ??
    models.find((entry) => entry.status !== "disabled") ??
    null
  );
}

function readSeq(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LS_SEQ) || "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function persistSeq(chatId: string, seq: number) {
  const all = readSeq();
  all[chatId] = seq;
  localStorage.setItem(LS_SEQ, JSON.stringify(all));
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const envelopes = sseQueue;
    sseQueue = [];
    if (!envelopes.length) return;
    const store = useStore.getState();
    const before = store.chat;
    const wasBusy = before.busy;
    // Strict stream identity: only events from the stream that belongs to the
    // session on screen are allowed to mutate it.
    const chat = applyStreamEvents(before, envelopes);
    if (chat === before) return;
    useStore.setState({ chat });
    if (wasBusy && !chat.busy) void store.refreshStatus();
    if (chat.needsReload) {
      useStore.setState({ chat: acknowledgeReload(chat) });
      void store.reloadHistory(chat.reloadReplaces);
    }
  }, 80);
}

async function initBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  await onSse((envelope) => {
    const store = useStore.getState();
    // Drop anything from a stream that is not the current session's — the
    // previous stream keeps emitting for a moment after a switch.
    if (envelope.stream_chat_id !== store.chat.chatId) return;
    if (envelope.stream_channel && envelope.stream_channel !== store.chat.channel) return;
    lastStreamAt = Date.now();
    sseQueue.push(envelope);
    if (!store.chat.connected) {
      useStore.setState({ chat: withConnected(store.chat, true) });
    }
    scheduleFlush();
  });
  await onSseStatus((status) => {
    const store = useStore.getState();
    if (status.chat_id !== store.chat.chatId) return;
    if (status.channel && status.channel !== store.chat.channel) return;
    if (status.state === "connected") lastStreamAt = Date.now();
    useStore.setState({
      chat: withConnected(store.chat, status.state === "connected"),
    });
  });
  await onSseHeartbeat((payload) => {
    if (!payload?.chat_id) return;
    const store = useStore.getState();
    if (payload.chat_id !== store.chat.chatId) return;
    if (payload.channel && payload.channel !== store.chat.channel) return;
    // Idle sessions only ever see heartbeats: this is the liveness proof that
    // keeps "已连接" honest and lets a missed "connected" status self-heal.
    lastStreamAt = Date.now();
    if (!store.chat.connected) {
      useStore.setState({ chat: withConnected(store.chat, true) });
    }
  });
  await onUpdateProgress((progress) => {
    useStore.setState({ updateProgress: progress.percent });
  });
  await onSseSeq((payload) => {
    if (!payload?.chat_id) return;
    // The cursor belongs to the stream that produced it — persist it there,
    // never onto whichever chat happens to be selected right now.
    persistSeq(payload.chat_id, payload.seq);
    const store = useStore.getState();
    if (payload.chat_id === store.chat.chatId) {
      lastStreamAt = Date.now();
      useStore.setState({
        lastSeq: { ...store.lastSeq, [payload.chat_id]: payload.seq },
        chat: withConnected(store.chat, true),
      });
    } else {
      useStore.setState({ lastSeq: { ...store.lastSeq, [payload.chat_id]: payload.seq } });
    }
  });
}

export const useStore = create<Store>((set, get) => ({
  screen: "loading",
  serverUrl: isLocalServer(localStorage.getItem(LS_SERVER) || "")
    ? ""
    : localStorage.getItem(LS_SERVER) || "",
  username: localStorage.getItem(LS_USER) || "",
  loginBusy: false,
  loginError: null,
  rememberLogin: localStorage.getItem("xbot.remember") !== "0",
  loginHint: null,
  bootstrapAvailable: false,
  sessions: [],
  activeChatId: "",
  activeChannel: "web",
  chat: emptyChat("", "web"),
  models: [],
  selectedModel: null,
  settingsOpen: false,
  contentWidth: readContentWidth(),
  draft: "",
  attachments: [],
  toast: null,
  lastSeq: readSeq(),
  appVersion: "",
  updateHost: localStorage.getItem(LS_UPDATE_HOST) || DEFAULT_UPDATE_HOST,
  updateInfo: null,
  updateChecking: false,
  updateProgress: 0,
  updateReadyPath: null,
  updateOpen: false,
  updateError: null,

  async bootstrap() {
    if (bootStarted) return;
    bootStarted = true;
    await initBridge();
    const saved = localStorage.getItem(LS_SERVER) || "";
    const remember = localStorage.getItem("xbot.remember") !== "0";
    api.appVersion().then((version) => set({ appVersion: version })).catch(() => undefined);
    // Remembered login: only auto-resume a NON-local saved server with a valid
    // session cookie. This is what lets a second launch skip the login page
    // without ever falling back to localhost.
    if (remember && saved && !isLocalServer(saved)) {
      try {
        await api.configureServer(saved);
        if (await api.hasSession()) {
          const tree = await api.tryResume();
          const sessions = treeToSessions(tree);
          const user = localStorage.getItem(LS_USER) || "";
          setCacheScope(saved, user);
          writeCache("tree", "", sessions);
          set({ screen: "shell", serverUrl: saved, username: user, sessions });
          const target =
            sessions.find((node) => node.chat_id === localStorage.getItem(LS_CHAT)) ??
            sessions.find((node) => !node.parent_chat_id) ??
            sessions[0];
          if (target) await get().selectSession(target);
          startRefreshTimer();
          void get().checkUpdate(false);
          return;
        }
      } catch {
        // cookie expired / server restarted -> show login
      }
    }
    if (isLocalServer(saved)) localStorage.removeItem(LS_SERVER);
    set({
      screen: "login",
      serverUrl: isLocalServer(saved) ? "" : saved,
      username: localStorage.getItem(LS_USER) || "",
    });
  },

  async login(serverUrl, username, password, remember = true) {
    set({ loginBusy: true, loginError: null, rememberLogin: remember });
    try {
      await api.configureServer(serverUrl);
      await api.login(username, password);
      localStorage.setItem(LS_SERVER, serverUrl.trim());
      localStorage.setItem(LS_USER, username.trim());
      localStorage.setItem("xbot.remember", remember ? "1" : "0");
      setCacheScope(serverUrl, username);
      set({ serverUrl: serverUrl.trim(), username: username.trim(), screen: "shell" });
      await get().refreshSessions(false);
      const sessions = get().sessions;
      const target =
        sessions.find((node) => node.chat_id === localStorage.getItem(LS_CHAT)) ??
        sessions.find((node) => !node.parent_chat_id) ??
        sessions[0];
      if (target) await get().selectSession(target);
      startRefreshTimer();
      void get().checkUpdate(false);
    } catch (error) {
      set({ loginError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loginBusy: false });
    }
  },

  async register(serverUrl, username, password, remember = true) {
    set({ loginBusy: true, loginError: null, rememberLogin: remember });
    try {
      await api.configureServer(serverUrl);
      await api.register(username, password);
      localStorage.setItem(LS_SERVER, serverUrl.trim());
      localStorage.setItem(LS_USER, username.trim());
      localStorage.setItem("xbot.remember", remember ? "1" : "0");
      setCacheScope(serverUrl, username);
      set({ serverUrl: serverUrl.trim(), username: username.trim(), screen: "shell" });
      await get().refreshSessions(false);
      const sessions = get().sessions;
      const target =
        sessions.find((node) => !node.parent_chat_id) ?? sessions[0];
      if (target) await get().selectSession(target);
      startRefreshTimer();
      void get().checkUpdate(false);
    } catch (error) {
      set({ loginError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loginBusy: false });
    }
  },

  async detectServer(serverUrl) {
    set({ loginBusy: true, loginError: null, loginHint: null });
    try {
      await api.configureServer(serverUrl);
      const config = await api.authConfig();
      set({
        bootstrapAvailable: config.bootstrap,
        loginHint: config.bootstrap
          ? "这是首次部署：可以创建第一个管理员账号。"
          : config.invite_only
            ? "服务器只允许已有账号登录。"
            : "服务器允许注册新账号。",
      });
    } catch (error) {
      set({ loginError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loginBusy: false });
    }
  },

  async logout() {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    await api.stopSse().catch(() => undefined);
    sseQueue = [];
    activeStream = null;
    lastStreamAt = 0;
    await clearCache();
    localStorage.removeItem(LS_SERVER);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_CHAT);
    if (refreshTimer != null) window.clearInterval(refreshTimer);
    refreshTimer = null;
    set({
      screen: "login",
      sessions: [],
      chat: emptyChat("", "web"),
      activeChatId: "",
      attachments: [],
      draft: "",
    });
  },

  async refreshSessions(showError = true) {
    try {
      // First paint after a webview reload: show the last known sidebar while
      // the network request is in flight.
      if (!get().sessions.length) {
        const cached = await readCache<SessionNode[]>("tree", "");
        if (cached && !get().sessions.length) set({ sessions: cached.value });
      }
      const tree = await api.sessionTree();
      const sessions = treeToSessions(tree);
      writeCache("tree", "", sessions);
      const active = sessions.find((node) => node.chat_id === get().activeChatId);
      set((state) => ({
        sessions,
        chat: active
          ? { ...state.chat, sessionRunning: active.running }
          : state.chat,
      }));
    } catch (error) {
      if (!get().sessions.length) {
        const cached = await readCache<SessionNode[]>("tree", "");
        if (cached) set({ sessions: cached.value });
      }
      if (showError) set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async selectSession(node) {
    if (!node || (node.chat_id === get().activeChatId && get().activeChannel === node.channel)) return;
    // Take ownership of the switch BEFORE the first await. Any slower switch
    // that was already in flight will see a newer epoch and bail out instead
    // of overwriting this selection.
    const epoch = ++sessionEpoch;
    const chatId = node.chat_id;
    const channel = node.channel || "web";
    await api.stopSse().catch(() => undefined);
    if (epoch !== sessionEpoch) return;
    sseQueue = [];
    activeStream = null;
    lastStreamAt = 0;
    // Give reloadHistory/loadModels time to bring the new stream up before the
    // watchdog may restart anything.
    lastRestartAt = Date.now();
    localStorage.setItem(LS_CHAT, chatId);
    set({
      activeChatId: chatId,
      activeChannel: channel,
      chat: emptyChat(chatId, channel, node.label),
      models: [],
      selectedModel: null,
      attachments: [],
      draft: "",
    });
    // Paint picker + context from cache immediately; history and the live
    // status/models requests continue in the background.
    void hydrateCached(chatId);
    await get().reloadHistory(true);
  },

  async reloadHistory(replaces = true) {
    const chatId = get().activeChatId;
    const channel = get().activeChannel;
    const epoch = sessionEpoch;
    if (!chatId) return;
    try {
      const response = await api.history(chatId, channel, 40, 0);
      // The user may have switched sessions while this request was in flight.
      // Applying it would paint the previous session's turns into the one on
      // screen and start a stream for the chat we already left.
      if (epoch !== sessionEpoch || get().activeChatId !== chatId || get().activeChannel !== channel) {
        return;
      }
      const lastSeq = Number(response.last_seq) || 0;
      persistSeq(chatId, lastSeq);
      set((state) => ({
        lastSeq: { ...state.lastSeq, [chatId]: lastSeq },
        chat: replaces
          ? withHistory(state.chat, response, true)
          : mergeLatestHistory(state.chat, response),
      }));
      // Pagination is keyed by raw message id, so the newest page can start in
      // the middle of the latest turn (a long agent run writes many assistant
      // rows). Walk back until every loaded turn has its user message, or we
      // run out of history.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const current = get().chat;
        if (!needsOlderHistory(current) || !current.hasMore || !current.oldestId) break;
        const before = current.oldestId;
        const older = await api.history(chatId, channel, 40, before);
        if (epoch !== sessionEpoch || get().activeChatId !== chatId || get().activeChannel !== channel) {
          return;
        }
        set((state) => ({ chat: prependHistory(state.chat, older) }));
        if (get().chat.oldestId === before) break;
      }
      // Status and models are independent: run them together so the context
      // meter and the model picker land in the same frame instead of the
      // picker waiting for the status round-trip.
      await Promise.all([get().refreshStatus(), get().loadModels()]);
      if (epoch !== sessionEpoch || get().activeChatId !== chatId || get().activeChannel !== channel) {
        return;
      }
      const streaming =
        activeStream?.chatId === chatId && activeStream?.channel === channel;
      if (!streaming) {
        await api.startSse(chatId, channel, Math.max(0, lastSeq - 1), epoch);
        if (epoch !== sessionEpoch || get().activeChatId !== chatId || get().activeChannel !== channel) {
          return;
        }
        activeStream = { chatId, channel };
        lastStreamAt = Date.now();
      }
      // The status event can race the history load; a running (or just
      // started) stream means the UI must not stay on "重连中".
      set((state) => ({ chat: withConnected(state.chat, true) }));
    } catch (error) {
      if (epoch !== sessionEpoch || get().activeChatId !== chatId) return;
      set({ chat: withError(get().chat, error instanceof Error ? error.message : String(error)) });
    }
  },

  async loadMore() {
    const { chat, activeChatId, activeChannel } = get();
    if (!chat.hasMore || chat.loadingMore || !chat.oldestId) return;
    const epoch = sessionEpoch;
    set({ chat: { ...chat, loadingMore: true } });
    try {
      // Server pagination is keyed by raw message id, which can split a turn:
      // a page may start with the assistant shell of a turn whose user message
      // sits just below the window. Keep pulling until the oldest loaded turn
      // has its user message, otherwise the user bubbles silently go missing.
      let merged = chat;
      let before = chat.oldestId;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response: HistoryResponse = await api.history(
          activeChatId,
          activeChannel,
          40,
          before,
        );
        if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
        merged = prependHistory(merged, response);
        // Stop only when every loaded turn has its user message — checking just
        // the oldest one left long current turns (whose user message is a few
        // pages back) without a bubble.
        if (!needsOlderHistory(merged)) break;
        if (!response.has_more) break;
        if (!response.oldest_id || response.oldest_id === before) break;
        before = response.oldest_id;
      }
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      set({ chat: merged });
    } catch (error) {
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      set({
        chat: {
          ...get().chat,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },

  async send() {
    const { draft, attachments, activeChatId, activeChannel, chat } = get();
    const text = draft.trim();
    if ((!text && !attachments.length) || !activeChatId) return;
    const epoch = sessionEpoch;
    set({ draft: "" });
    try {
      const result = (await api.sendMessage({
        content: text,
        chat_id: activeChatId,
        channel: activeChannel,
        upload_keys: attachments.map((item) => item.uploadKey),
        file_names: attachments.map((item) => item.name),
        file_sizes: attachments.map((item) => item.size),
        file_mimes: attachments.map((item) => item.mime),
        id: crypto.randomUUID().replace(/-/g, ""),
      })) as { turn_id?: number; queued?: boolean };
      // The message went to the session it was composed for. If the user has
      // since switched away, leave the current session's UI untouched.
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      set({
        chat: sendAccepted(
          get().chat,
          text || "（附件）",
          Number(result?.turn_id) || 0,
          !!result?.queued,
        ),
        attachments: [],
      });
    } catch (error) {
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      set({
        chat: withError(get().chat, error instanceof Error ? error.message : String(error)),
        draft: text,
      });
    }
  },

  async cancel() {
    try {
      await api.cancel(get().activeChatId, get().activeChannel);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  setDraft(value) {
    set({ draft: value });
  },

  setRememberLogin(value) {
    set({ rememberLogin: value });
    localStorage.setItem("xbot.remember", value ? "1" : "0");
  },

  async addAttachment() {
    try {
      const path = await api.pickFile();
      if (!path) return;
      const uploaded = await api.uploadFile(path);
      const name = uploaded.name || path.split(/[\\/]/).pop() || "file";
      set((state) => ({
        attachments: [
          ...state.attachments,
          {
            path,
            uploadKey: uploaded.upload_key,
            name,
            size: uploaded.size || 0,
            mime: uploaded.mime || "application/octet-stream",
          },
        ],
      }));
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  removeAttachment(path) {
    set((state) => ({ attachments: state.attachments.filter((item) => item.path !== path) }));
  },

  async answerAskUser(answers) {
    const prompt = get().chat.askUser;
    if (!prompt) return;
    const chatId = get().activeChatId;
    const channel = get().activeChannel;
    set({ chat: dismissAskUser(get().chat) });
    try {
      await api.respondAskUser(chatId, channel, answers, false);
    } catch (error) {
      if (get().activeChatId !== chatId) return;
      set({
        chat: { ...get().chat, askUser: prompt, error: error instanceof Error ? error.message : String(error) },
      });
    }
  },

  dismissAskUser() {
    set({ chat: dismissAskUser(get().chat) });
  },

  async cancelQueued(msgId) {
    try {
      await api.cancelQueued(get().activeChatId, get().activeChannel, msgId);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async rewindTurn(turnId, mode) {
    const { chat } = get();
    const chatId = chat.chatId;
    const channel = chat.channel;
    const turn = chat.turns.find((item) => item.turnId === turnId);
    if (!turn) return;
    if (!turn.userHistoryId) {
      set({ toast: "这条消息还没有写入历史，暂时不能回退" });
      return;
    }
    const epoch = sessionEpoch;
    try {
      // The server truncates at (and including) this user message and hands its
      // content back as `draft`, so "edit" can put it into the composer.
      const result = await api.rewind(chatId, channel, turn.userHistoryId);
      if (epoch !== sessionEpoch || get().activeChatId !== chatId) return;
      if (mode === "edit") {
        set({ draft: result?.draft ?? turn.userText });
      }
      await get().reloadHistory(true);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async selectModel(entry) {
    const { activeChatId, activeChannel } = get();
    set({ selectedModel: entry });
    try {
      await api.rpc("select_model", {
        chat_id: activeChatId,
        channel: activeChannel,
        sub_id: entry.sub_id,
        model: entry.model,
      });
      // Keep the cached per-session selection in sync so the next switch to
      // this session paints the right model before the RPC returns.
      writeCache("session-model", activeChatId, {
        subscription_id: entry.sub_id,
        model: entry.model,
      });
      await get().refreshStatus();
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async refreshStatus() {
    const { activeChatId, activeChannel } = get();
    if (!activeChatId) return;
    const epoch = sessionEpoch;
    try {
      // Paint the last known cwd / context immediately, then reconcile.
      const cached = await readCache<{
        cwd?: string;
        token_usage?: {
          available: boolean;
          prompt_tokens: number;
          max_context_tokens: number;
          usage_percent: number | null;
          context_usage_percent: number;
          model: string;
        } | null;
      }>("status", activeChatId);
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      if (cached) {
        set((state) => ({
          chat: withSessionStatus(
            state.chat,
            cached.value.cwd ?? "",
            cached.value.token_usage ?? null,
          ),
        }));
      }
      const status = (await api.sessionStatus(activeChatId, activeChannel)) as {
        token_usage?: {
          available: boolean;
          prompt_tokens: number;
          max_context_tokens: number;
          usage_percent: number | null;
          context_usage_percent: number;
          model: string;
        } | null;
        cwd?: string;
      };
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      writeCache("status", activeChatId, status ?? {});
      set((state) => ({
        chat: withSessionStatus(
          state.chat,
          status?.cwd ?? "",
          status?.token_usage ?? null,
        ),
      }));
    } catch {
      // auxiliary
    }
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  setContentWidth(value) {
    const width = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    set({ contentWidth: width });
    try {
      localStorage.setItem(LS_CONTENT_WIDTH, String(width));
    } catch {
      // storage disabled — keep the in-memory value
    }
  },

  setToast(toast) {
    if (toast) logEvent("ui", toast);
    set({ toast });
  },

  async newSession(label, workDir) {
    try {
      const created = (await api.createChat(label)) as { chat_id?: string };
      const chatId = created?.chat_id || "";
      if (workDir && chatId) {
        await api.rpc("set_cwd", {
          channel: "web",
          chat_id: chatId,
          dir: workDir,
          force: true,
        });
      }
      dropCache("tree");
      await get().refreshSessions(false);
      const node = get().sessions.find((item) => item.chat_id === chatId);
      if (node) await get().selectSession(node);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async renameSession(label) {
    const { activeChatId, activeChannel } = get();
    if (!activeChatId) return;
    try {
      await api.renameChat(activeChatId, activeChannel, label);
      dropCache("tree");
      await get().refreshSessions(false);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteSession() {
    const { activeChatId, activeChannel } = get();
    if (!activeChatId) return;
    try {
      await api.deleteChat(activeChatId, activeChannel);
      // Invalidate any in-flight switch/reload for the session being deleted.
      sessionEpoch += 1;
      await api.stopSse().catch(() => undefined);
      activeStream = null;
      lastStreamAt = 0;
      dropCache("tree");
      set({ activeChatId: "", chat: emptyChat("", "web") });
      await get().refreshSessions(false);
      const next = get().sessions.find((node) => !node.parent_chat_id) ?? get().sessions[0];
      if (next) await get().selectSession(next);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async forkSession(label) {
    const { activeChatId, activeChannel } = get();
    if (!activeChatId) return;
    try {
      const fork = (await api.forkChat(activeChatId, activeChannel, label)) as {
        chat_id?: string;
      };
      dropCache("tree");
      await get().refreshSessions(false);
      const node = get().sessions.find((item) => item.chat_id === fork?.chat_id);
      if (node) await get().selectSession(node);
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  async checkUpdate(manual = false) {
    if (get().updateChecking) return;
    set({ updateChecking: true, updateError: null });
    try {
      const host = get().updateHost.trim().replace(/\/$/, "");
      const result = await api.checkUpdate(host ? `${host}/latest.json` : undefined);
      set({
        appVersion: result.current,
        updateInfo: result.available,
        updateOpen: !!result.available && manual,
      });
      if (!result.available && manual) {
        set({ toast: `已是最新版本（${result.current}）` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ updateError: message });
      if (manual) set({ toast: `检查更新失败：${message}` });
    } finally {
      set({ updateChecking: false });
    }
  },

  async downloadUpdate() {
    const info = get().updateInfo;
    if (!info) return;
    set({ updateProgress: 0, updateError: null });
    try {
      const host = get().updateHost.trim().replace(/\/$/, "");
      let urlOverride: string | undefined;
      if (host && host !== DEFAULT_UPDATE_HOST) {
        const filename = info.url.split("/").pop() || `xbot-desktop-tauri-${info.version}-win-x64.exe`;
        urlOverride = `${host}/${filename}`;
      }
      const path = await api.downloadUpdate(info, urlOverride);
      set({ updateReadyPath: path, updateProgress: 100 });
    } catch (error) {
      set({ updateError: error instanceof Error ? error.message : String(error) });
    }
  },

  async applyUpdate() {
    const path = get().updateReadyPath;
    if (!path) return;
    try {
      await api.applyUpdate(path);
    } catch (error) {
      set({ updateError: error instanceof Error ? error.message : String(error) });
    }
  },

  setUpdateOpen(open) {
    set({ updateOpen: open });
  },

  setUpdateHost(host) {
    set({ updateHost: host });
    localStorage.setItem(LS_UPDATE_HOST, host);
  },

  async addPastedFile(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const dataBase64 = btoa(binary);
      const name = file.name || "pasted-image.png";
      const uploaded = await api.uploadBytes(name, file.type || "application/octet-stream", dataBase64);
      set((state) => ({
        attachments: [
          ...state.attachments,
          {
            path: `paste:${crypto.randomUUID()}:${name}`,
            uploadKey: uploaded.upload_key,
            name: uploaded.name || name,
            size: uploaded.size || bytes.length,
            mime: uploaded.mime || file.type || "application/octet-stream",
          },
        ],
      }));
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : String(error) });
    }
  },

  // internal helper used by reload/selection
  async loadModels() {
    const { activeChatId, activeChannel } = get();
    if (!activeChatId) return;
    const epoch = sessionEpoch;
    try {
      // Model catalog changes rarely (5 min TTL); the per-session selection is
      // stable too (10 min). Paint both from cache first so switching sessions
      // shows the picker instantly, then revalidate only what expired.
      const [catalogEntry, selectionEntry] = await Promise.all([
        readCache<ModelEntry[]>("models", ""),
        readCache<{ subscription_id?: string; model?: string }>("session-model", activeChatId),
      ]);
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      const cachedModels = catalogEntry?.value ?? get().models;
      if (catalogEntry || selectionEntry) {
        set({
          models: cachedModels,
          selectedModel: pickModel(cachedModels, selectionEntry?.value ?? null),
        });
      }

      const needCatalog = !isFresh(catalogEntry, 5 * 60_000);
      const needSelection = !isFresh(selectionEntry, 10 * 60_000);
      if (!needCatalog && !needSelection) return;

      const models = needCatalog
        ? ((await api.rpc<ModelEntry[]>("list_all_model_entries")) ?? [])
        : cachedModels;
      const current = needSelection
        ? await api.rpc<{ subscription_id?: string; model?: string }>(
            "get_session_subscription",
            { chat_id: activeChatId, channel: activeChannel },
          )
        : (selectionEntry?.value ?? null);
      if (epoch !== sessionEpoch || get().activeChatId !== activeChatId) return;
      if (needCatalog) writeCache("models", "", models);
      if (needSelection) writeCache("session-model", activeChatId, current ?? null);
      set({ models, selectedModel: pickModel(models, current) });
    } catch {
      // picker is auxiliary
    }
  },
}));

let streamTimer: number | null = null;
let lastRestartAt = 0;

/**
 * Paint the model picker and context meter from cache the moment a session is
 * selected, before history/status round-trips. Without this the picker only
 * appeared after `refreshStatus` returned, so context looked like it rendered
 * first.
 */
async function hydrateCached(chatId: string): Promise<void> {
  const [catalog, selection, status] = await Promise.all([
    readCache<ModelEntry[]>("models", ""),
    readCache<{ subscription_id?: string; model?: string }>("session-model", chatId),
    readCache<{
      cwd?: string;
      token_usage?: {
        available: boolean;
        prompt_tokens: number;
        max_context_tokens: number;
        usage_percent: number | null;
        context_usage_percent: number;
        model: string;
      } | null;
    }>("status", chatId),
  ]);
  const state = useStore.getState();
  if (state.activeChatId !== chatId) return;
  if (catalog) {
    useStore.setState({
      models: catalog.value,
      selectedModel: pickModel(catalog.value, selection?.value ?? null),
    });
  }
  if (status) {
    useStore.setState({
      chat: withSessionStatus(state.chat, status.value.cwd ?? "", status.value.token_usage ?? null),
    });
  }
}

/**
 * Keep the live stream truthful. Two failure modes are invisible otherwise:
 *  - the UI is stuck on "重连中" although the Rust task already died;
 *  - the UI still says "已连接" on a half-open connection (no heartbeat).
 * Restarts are throttled so a genuinely unreachable server is not hammered.
 */
function ensureStreamAlive() {
  const state = useStore.getState();
  if (state.screen !== "shell" || !state.chat.chatId) return;
  const now = Date.now();
  const chat = state.chat;
  const stale = chat.connected && lastStreamAt > 0 && now - lastStreamAt > 45_000;
  if (chat.connected && !stale) return;
  if (chat.connected) {
    useStore.setState({ chat: withConnected(chat, false) });
  }
  if (now - lastRestartAt < 8_000) return;
  lastRestartAt = now;
  const seq = state.lastSeq[chat.chatId] ?? 0;
  activeStream = { chatId: chat.chatId, channel: chat.channel };
  void api
    .startSse(chat.chatId, chat.channel, Math.max(0, seq - 1), sessionEpoch)
    .then(() => {
      lastStreamAt = Date.now();
    })
    .catch(() => undefined);
}

function startRefreshTimer() {
  if (refreshTimer != null) return;
  refreshTimer = window.setInterval(() => {
    if (getScreen() === "shell") void useStore.getState().refreshSessions(false);
  }, 10000);
  if (streamTimer == null) {
    streamTimer = window.setInterval(ensureStreamAlive, 5000);
  }
}

function getScreen(): Screen {
  return useStore.getState().screen;
}
