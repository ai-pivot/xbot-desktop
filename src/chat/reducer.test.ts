import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyStreamEvents,
  emptyChat,
  sendAccepted,
  withHistory,
} from "./reducer";
import type { HistoryResponse, SseEnvelope } from "../types";

function history(messages: HistoryResponse["messages"]): HistoryResponse {
  return {
    messages,
    processing: false,
    active_progress: null,
    last_seq: 42,
    has_more: true,
    oldest_id: 1,
  };
}

describe("chat reducer", () => {
  it("builds turns and iterations from history", () => {
    const state = withHistory(
      emptyChat("c1", "web"),
      history([
        { id: 1, history_id: 1, role: "user", content: "hi", reasoning_content: "", turn_id: 10, iterations: [], timestamp: "" },
        {
          id: 2, history_id: 2, role: "assistant", content: "world", reasoning_content: "", turn_id: 10,
          iterations: [{ iteration: 1, content: "body", reasoning: "think", tools: [], elapsed_wall: 0, tokens: 0, ttft_ms: 0, tokens_per_sec: 0 }],
          timestamp: "",
        },
      ]),
    );
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].userText).toBe("hi");
    expect(state.turns[0].userHistoryId).toBe(1);
    expect(state.turns[0].finalText).toBe("world");
    expect(state.turns[0].iterations[0].content).toBe("body");
  });

  it("appends stream deltas and replaces with checkpoints", () => {
    let state = emptyChat("c1", "web");
    state = applyEvent(state, { type: "progress_structured", progress: { turn_id: 5, iteration: 1, stream_delta: "Hel" } as never });
    state = applyEvent(state, { type: "stream_content", progress: { turn_id: 5, iteration: 1, stream_delta: "lo" } as never });
    state = applyEvent(state, { type: "stream_content", progress: { turn_id: 5, iteration: 1, stream_content: "Hello" } as never });
    expect(state.turns[0].iterations[0].content).toBe("Hello");
    expect(state.busy).toBe(true);
    expect(state.liveTurnId).toBe(5);
  });

  it("keeps content when the turn ends", () => {
    let state = emptyChat("c1", "web");
    state = applyEvent(state, { type: "progress_structured", progress: { turn_id: 5, iteration: 1, stream_content: "partial" } as never });
    state = applyEvent(state, {
      type: "progress_structured",
      progress: { turn_id: 5, iteration: 1, phase: "done", content: "partial" } as never,
    });
    expect(state.turns[0].iterations[0].content).toBe("partial");
    expect(state.turns[0].finalText).toBe("partial");
    expect(state.busy).toBe(false);
  });

  it("renders command replies as standalone turns", () => {
    const state = applyEvent(emptyChat("c1", "web"), { type: "text", turn_id: 0, content: "cmd" });
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].finalText).toBe("cmd");
  });

  it("parses ask_user questions encoded as a JSON string", () => {
    const state = applyEvent(emptyChat("c1", "web"), {
      type: "ask_user",
      content: JSON.stringify({ request_id: "r1", questions: JSON.stringify([{ question: "pick", options: ["a", "b"] }]) }),
    });
    expect(state.askUser?.requestId).toBe("r1");
    expect(state.askUser?.questions[0].question).toBe("pick");
  });

  it("marks earlier iterations done when the next one starts", () => {
    // Regression: empty intermediate iterations stayed "running" forever, so
    // every one of them rendered its own 思考中 block.
    let state = emptyChat("c1", "web");
    state = applyEvent(state, {
      type: "progress_structured",
      progress: { turn_id: 5, iteration: 1, phase: "running", content: "" } as never,
    });
    state = applyEvent(state, {
      type: "progress_structured",
      progress: { turn_id: 5, iteration: 2, stream_content: "next" } as never,
    });
    const turn = state.turns[0];
    expect(turn.iterations.find((iteration) => iteration.index === 1)?.done).toBe(true);
    expect(turn.iterations.find((iteration) => iteration.index === 2)?.done).toBe(false);
  });

  it("tracks queue snapshots and optimistic sends", () => {
    let state = applyEvent(emptyChat("c1", "web"), {
      type: "queue_state",
      queue_state: { items: [{ msg_id: "m1", turn_id: 0, content: "x", preview: "x" }] },
    });
    expect(state.queue).toHaveLength(1);
    state = sendAccepted(state, "hello", 7, false);
    expect(state.turns[0].userText).toBe("hello");
    expect(state.busy).toBe(true);
  });

  it("never applies an SSE batch from another session's stream", () => {
    const chatB = emptyChat("B", "web");
    const fromA: SseEnvelope[] = [
      {
        stream_chat_id: "A",
        stream_channel: "web",
        message: {
          type: "progress_structured",
          progress: { turn_id: 9, iteration: 3, stream_content: "A 的迭代" } as never,
        },
      },
      {
        stream_chat_id: "A",
        stream_channel: "web",
        message: { type: "session", session: { chat_id: "A", action: "busy" } },
      },
    ];
    // Identical reference: a foreign batch must not even cause a re-render.
    expect(applyStreamEvents(chatB, fromA)).toBe(chatB);
  });

  it("applies only the current session's events out of a mixed batch", () => {
    const chatB = emptyChat("B", "web");
    const mixed: SseEnvelope[] = [
      {
        stream_chat_id: "A",
        stream_channel: "web",
        message: {
          type: "progress_structured",
          progress: { turn_id: 9, iteration: 3, stream_content: "A 的迭代" } as never,
        },
      },
      {
        stream_chat_id: "B",
        stream_channel: "web",
        message: {
          type: "progress_structured",
          progress: { turn_id: 4, iteration: 1, stream_content: "B 的内容" } as never,
        },
      },
    ];
    const next = applyStreamEvents(chatB, mixed);
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0].turnId).toBe(4);
    expect(next.turns[0].iterations[0].content).toBe("B 的内容");
  });
});
