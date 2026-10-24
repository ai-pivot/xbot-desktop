import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { dropCache, isFresh, readCache, readMemory, setCacheScope, writeCache } from "./index";

beforeEach(() => {
  setCacheScope("", "");
  dropCache("models");
  dropCache("tree");
  dropCache("status");
});

describe("client cache", () => {
  it("reads back a value written for the same account", async () => {
    setCacheScope("https://a.example", "alice");
    writeCache("models", "", ["gpt"]);
    const entry = await readCache<string[]>("models", "");
    expect(entry?.value).toEqual(["gpt"]);
  });

  it("does not leak values across accounts", async () => {
    setCacheScope("https://a.example", "alice");
    writeCache("models", "", ["alice-only"]);
    setCacheScope("https://a.example", "bob");
    expect(await readCache("models", "")).toBeNull();
  });

  it("drops only the requested kind", async () => {
    setCacheScope("https://a.example", "alice");
    writeCache("tree", "", [{ chat_id: "c1" }]);
    writeCache("status", "c1", { cwd: "/tmp" });
    dropCache("tree");
    expect(await readCache("tree", "")).toBeNull();
    expect((await readCache<{ cwd: string }>("status", "c1"))?.value.cwd).toBe("/tmp");
  });

  it("reports freshness against a ttl", () => {
    writeCache("models", "", ["x"]);
    expect(isFresh(readMemory("models"), 60_000)).toBe(true);
    expect(isFresh({ value: [], storedAt: Date.now() - 120_000 }, 60_000)).toBe(false);
    expect(isFresh(null, 60_000)).toBe(false);
  });
});
