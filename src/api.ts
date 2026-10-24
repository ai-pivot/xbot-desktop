import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  FsEntry,
  HistoryResponse,
  RewindResult,
  SseEnvelope,
  SseSeqPayload,
  SseStatusPayload,
  UpdateCheck,
  UpdateInfo,
  WsMessage,
} from "./types";

export type {
  SseEnvelope,
  SseSeqPayload,
  SseStatusPayload,
} from "./types";

export const api = {
  configureServer: (url: string) => invoke<void>("configure_server", { url }),
  authConfig: () => invoke<{ invite_only: boolean; bootstrap: boolean }>("auth_config"),
  login: (username: string, password: string) =>
    invoke<unknown>("login", { username, password }),
  register: (username: string, password: string) =>
    invoke<unknown>("register", { username, password }),
  logout: () => invoke<void>("logout"),
  hasSession: () => invoke<boolean>("has_session"),
  tryResume: () => invoke<unknown>("try_resume"),
  sessionTree: () => invoke<unknown>("session_tree"),
  createChat: (label: string) => invoke<unknown>("create_chat", { label }),
  renameChat: (chatId: string, channel: string, label: string) =>
    invoke<unknown>("rename_chat", { chatId, channel, label }),
  deleteChat: (chatId: string, channel: string) =>
    invoke<unknown>("delete_chat", { chatId, channel }),
  forkChat: (sourceChatId: string, sourceChannel: string, label: string) =>
    invoke<unknown>("fork_chat", { sourceChatId, sourceChannel, label }),
  history: (chatId: string, channel: string, limit = 40, beforeId = 0) =>
    invoke<HistoryResponse>("history", { chatId, channel, limit, beforeId }),
  rewind: (chatId: string, channel: string, historyId: number) =>
    invoke<RewindResult>("rewind_history", { chatId, channel, historyId }),
  sendMessage: (request: unknown) => invoke<unknown>("send_message", { request }),
  cancel: (chatId: string, channel: string) => invoke<unknown>("cancel", { chatId, channel }),
  cancelQueued: (chatId: string, channel: string, msgId: string) =>
    invoke<unknown>("cancel_queued", { chatId, channel, msgId }),
  respondAskUser: (chatId: string, channel: string, answers: unknown, cancelled: boolean) =>
    invoke<unknown>("respond_ask_user", { chatId, channel, answers, cancelled }),
  sessionStatus: (chatId: string, channel: string) =>
    invoke<unknown>("session_status", { chatId, channel }),
  rpc: <T>(method: string, params?: unknown) =>
    invoke<T>("rpc", { method, params: params ?? {} }),
  uploadFile: (path: string) =>
    invoke<{ upload_key: string; name: string; size: number; mime: string }>("upload_file", {
      path,
    }),
  uploadBytes: (name: string, mime: string, dataBase64: string) =>
    invoke<{ upload_key: string; name: string; size: number; mime: string }>("upload_bytes", {
      name,
      mime,
      dataBase64,
    }),
  pickFile: () => invoke<string | null>("pick_file"),
  listDir: async (path: string, showHidden = false) => {
    const result = await invoke<{ entries?: FsEntry[] }>("fs_list", { path, showHidden });
    return result?.entries ?? [];
  },
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  openLog: () => invoke<string>("open_log"),
  startSse: (chatId: string, channel: string, lastSeq: number, epoch: number) =>
    invoke<void>("start_sse", { chatId, channel, lastSeq, epoch }),
  stopSse: () => invoke<void>("stop_sse"),
  appVersion: () => invoke<string>("app_version"),
  checkUpdate: (manifestUrl?: string) =>
    invoke<UpdateCheck>("check_update", { manifestUrl: manifestUrl ?? null }),
  downloadUpdate: (info: UpdateInfo, urlOverride?: string) =>
    invoke<string>("download_update", { info, urlOverride: urlOverride ?? null }),
  applyUpdate: (path: string) => invoke<void>("apply_update", { path }),
};

export function onSse(callback: (envelope: SseEnvelope) => void): Promise<UnlistenFn> {
  return listen<SseEnvelope>("xbot-sse", (event) => callback(event.payload));
}

export function onSseStatus(callback: (status: SseStatusPayload) => void): Promise<UnlistenFn> {
  return listen<SseStatusPayload>("xbot-sse-status", (event) => callback(event.payload));
}

export function onSseSeq(callback: (payload: SseSeqPayload) => void): Promise<UnlistenFn> {
  return listen<SseSeqPayload>("xbot-sse-seq", (event) => callback(event.payload));
}

export interface SseHeartbeatPayload {
  chat_id: string;
  channel: string;
}

export function onSseHeartbeat(
  callback: (payload: SseHeartbeatPayload) => void,
): Promise<UnlistenFn> {
  return listen<SseHeartbeatPayload>("xbot-sse-heartbeat", (event) => callback(event.payload));
}


export function onUpdateProgress(
  callback: (progress: { downloaded: number; total: number; percent: number }) => void,
) {
  return listen<{ downloaded: number; total: number; percent: number }>(
    "xbot-update-progress",
    (event) => callback(event.payload),
  );
}
