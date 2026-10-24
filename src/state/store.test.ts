import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryResponse, SessionNode } from "../types";

// The store touches localStorage at module scope; install a stub before the
// module graph is evaluated.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
    clear: () => mem.clear(),
    key: (index: number) => [...mem.keys()][index] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
});

const historyMock = vi.fn();
const sessionTreeMock = vi.fn();
const startSseMock = vi.fn();
const stopSseMock = vi.fn();
const rewindMock = vi.fn();

vi.mock("../api", () => ({
  api: {
    history: (...args: unknown[]) => historyMock(...args),
    sessionTree: (...args: unknown[]) => sessionTreeMock(...args),
    startSse: (...args: unknown[]) => startSseMock(...args),
    stopSse: (...args: unknown[]) => stopSseMock(...args),
    rewind: (...args: unknown[]) => rewindMock(...args),
    sessionStatus: vi.fn(async () => null),
    rpc: vi.fn(async () => []),
    configureServer: vi.fn(async () => undefined),
  },
  onSse: vi.fn(async () => () => undefined),
  onSseHeartbeat: vi.fn(async () => () => undefined),
  onSseSeq: vi.fn(async () => () => undefined),
  onSseStatus: vi.fn(async () => () => undefined),
  onUpdateProgress: vi.fn(async () => () => undefined),
}));

import { emptyChat } from "../chat/reducer";
import { useStore } from "./store";

function node(chatId: string): SessionNode {
  return {
    chat_id: chatId,
    channel: "web",
    label: chatId,
    work_dir: "",
    last_active: "",
    preview: "",
    running: false,
    type: "",
    role: "",
    instance: "",
    parent_chat_id: "",
    children: [],
    depth: 0,
  };
}

function historyFor(turns: number[]): HistoryResponse {
  return {
    messages: turns.map((turnId) => ({
      id: turnId,
      history_id: turnId,
      role: "user",
      content: `question ${turnId}`,
      reasoning_content: "",
      turn_id: turnId,
      iterations: [],
      timestamp: "",
    })),
    processing: false,
    active_progress: null,
    last_seq: 42,
    has_more: false,
    oldest_id: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  historyMock.mockReset();
  sessionTreeMock.mockReset();
  startSseMock.mockReset();
  stopSseMock.mockReset();
  stopSseMock.mockResolvedValue(undefined);
  startSseMock.mockResolvedValue(undefined);
  useStore.setState({
    screen: "shell",
    sessions: [node("A"), node("B"), node("C")],
    activeChatId: "A",
    activeChannel: "web",
    chat: emptyChat("A", "web"),
  });
});

describe("session isolation", () => {
  it("discards the previous session's in-flight history after a switch", async () => {
    const pendingA = deferred<HistoryResponse>();
    historyMock.mockImplementation((chatId: string) => {
      if (chatId === "A") return pendingA.promise;
      return Promise.resolve(historyFor([1]));
    });

    // A reload for the session that is active right now...
    const reloadA = useStore.getState().reloadHistory(true);
    // ...and the user switches away before it returns.
    await useStore.getState().selectSession(node("B"));

    pendingA.resolve(historyFor([7, 8]));
    await reloadA;

    const state = useStore.getState();
    expect(state.activeChatId).toBe("B");
    expect(state.chat.chatId).toBe("B");
    expect(state.chat.turns.map((turn) => turn.turnId)).toEqual([1]);
    // Critically: the stale response must not start an SSE stream for A.
    expect(startSseMock.mock.calls.filter((call) => call[0] === "A")).toHaveLength(0);
  });

  it("lets only the newest switch mutate state when switches overlap", async () => {
    const pendingStop = deferred<void>();
    stopSseMock.mockReturnValueOnce(pendingStop.promise);
    historyMock.mockImplementation((chatId: string) => Promise.resolve(historyFor([1])));

    const switchToB = useStore.getState().selectSession(node("B"));
    // The user changes their mind while B's switch is still tearing down.
    await useStore.getState().selectSession(node("C"));
    pendingStop.resolve();
    await switchToB;

    expect(useStore.getState().activeChatId).toBe("C");
    expect(useStore.getState().chat.chatId).toBe("C");
  });

  it("does not restart a live stream when the same session reloads history", async () => {
    historyMock.mockImplementation(() => Promise.resolve(historyFor([1])));
    await useStore.getState().selectSession(node("B"));
    expect(startSseMock).toHaveBeenCalledTimes(1);

    // resync_required / manual refresh reloads history without dropping the
    // stream: restarting it emits "connecting" and flashes "重连中".
    await useStore.getState().reloadHistory(true);
    expect(startSseMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().chat.connected).toBe(true);
  });

  it("keeps loading older pages until the oldest turn has its user message", async () => {
    useStore.setState({
      activeChatId: "B",
      activeChannel: "web",
      chat: {
        ...emptyChat("B", "web"),
        hasMore: true,
        oldestId: 100,
        turns: [
          {
            turnId: 5,
            userText: "new question",
            iterations: [],
            finalText: "",
            cancelled: false,
          },
        ],
      },
    });
    // The first older page starts on an assistant row whose user message is
    // below the window — exactly what the server does when a page boundary
    // splits a turn.
    historyMock
      .mockResolvedValueOnce({
        messages: [
          {
            id: 95,
            history_id: 95,
            role: "assistant",
            content: "answer 4",
            reasoning_content: "",
            turn_id: 4,
            iterations: [],
            timestamp: "",
          },
        ],
        processing: false,
        active_progress: null,
        last_seq: 42,
        has_more: true,
        oldest_id: 90,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 88,
            history_id: 88,
            role: "user",
            content: "old question",
            reasoning_content: "",
            turn_id: 4,
            iterations: [],
            timestamp: "",
          },
        ],
        processing: false,
        active_progress: null,
        last_seq: 42,
        has_more: true,
        oldest_id: 80,
      });

    await useStore.getState().loadMore();

    expect(historyMock).toHaveBeenCalledTimes(2);
    const oldest = useStore.getState().chat.turns[0];
    expect(oldest.turnId).toBe(4);
    expect(oldest.userText).toBe("old question");
  });

  it("fills the user message of the newest turn when it spans more than one page", async () => {
    // A long agent run: the newest page starts mid-turn (assistant iterations,
    // no user row), so the initial load must walk back to find the user message.
    historyMock
      .mockResolvedValueOnce({
        messages: [
          {
            id: 200,
            history_id: 200,
            role: "assistant",
            content: "",
            reasoning_content: "",
            turn_id: 9,
            iterations: [
              {
                iteration: 1,
                content: "step",
                reasoning: "",
                tools: [],
                elapsed_wall: 0,
                tokens: 0,
                ttft_ms: 0,
                tokens_per_sec: 0,
              },
            ],
            timestamp: "",
          },
        ],
        processing: false,
        active_progress: null,
        last_seq: 42,
        has_more: true,
        oldest_id: 150,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 140,
            history_id: 140,
            role: "user",
            content: "long task",
            reasoning_content: "",
            turn_id: 9,
            iterations: [],
            timestamp: "",
          },
        ],
        processing: false,
        active_progress: null,
        last_seq: 42,
        has_more: true,
        oldest_id: 100,
      });

    useStore.setState({
      activeChatId: "B",
      activeChannel: "web",
      chat: emptyChat("B", "web"),
    });
    await useStore.getState().reloadHistory(true);

    expect(historyMock).toHaveBeenCalledTimes(2);
    const turn = useStore.getState().chat.turns[0];
    expect(turn.turnId).toBe(9);
    expect(turn.userText).toBe("long task");
  });

  it("rewinds a user message and restores it as the draft on edit", async () => {
    historyMock.mockImplementation(() => Promise.resolve(historyFor([])));
    rewindMock.mockResolvedValue({ draft: "old question", target_history_id: 11 });
    useStore.setState({
      activeChatId: "B",
      activeChannel: "web",
      chat: {
        ...emptyChat("B", "web"),
        turns: [
          {
            turnId: 3,
            userText: "old question",
            userHistoryId: 11,
            iterations: [],
            finalText: "",
            cancelled: false,
          },
        ],
      },
    });

    await useStore.getState().rewindTurn(3, "edit");

    expect(rewindMock).toHaveBeenCalledWith("B", "web", 11);
    expect(useStore.getState().draft).toBe("old question");
  });

  it("does not touch the composer when rewinding in delete mode", async () => {
    historyMock.mockImplementation(() => Promise.resolve(historyFor([])));
    rewindMock.mockResolvedValue({ draft: "gone", target_history_id: 12 });
    useStore.setState({
      activeChatId: "B",
      activeChannel: "web",
      draft: "",
      chat: {
        ...emptyChat("B", "web"),
        turns: [
          {
            turnId: 4,
            userText: "gone",
            userHistoryId: 12,
            iterations: [],
            finalText: "",
            cancelled: false,
          },
        ],
      },
    });

    await useStore.getState().rewindTurn(4, "delete");

    expect(rewindMock).toHaveBeenCalledWith("B", "web", 12);
    expect(useStore.getState().draft).toBe("");
  });
});
