/**
 * Two-tier client cache: an in-process Map for instant reads plus IndexedDB
 * for surviving restarts. Keys are namespaced by server + user so data can
 * never leak between accounts; a schema bump invalidates everything written by
 * an older client.
 *
 * Only read-mostly data belongs here (model lists, settings, session tree,
 * session status). Live session state (SSE, ask_user, queue) must always come
 * from the server.
 */

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

const DB_NAME = "xbot-cache";
const STORE = "entries";
const SCHEMA = 1;
const MAX_ENTRIES = 300;
const SCOPE_KEY = "xbot.cacheScope";

const memory = new Map<string, CacheEntry<unknown>>();
let scope = readScope();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function readScope(): string {
  try {
    return localStorage.getItem(SCOPE_KEY) || "";
  } catch {
    return "";
  }
}

function keyOf(kind: string, id = ""): string {
  return `${scope}|${kind}|${id}`;
}

function normalizeServer(server: string): string {
  return (server || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Point the cache at one account. A different account wipes everything. */
export function setCacheScope(server: string, user: string): void {
  const next = `${normalizeServer(server)}|${(user || "").trim().toLowerCase()}`;
  if (next === scope) return;
  scope = next;
  try {
    if (next) localStorage.setItem(SCOPE_KEY, next);
    else localStorage.removeItem(SCOPE_KEY);
  } catch {
    // storage disabled — memory-only mode
  }
  void clearCache();
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("storedAt", "storedAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export function readMemory<T>(kind: string, id = ""): CacheEntry<T> | null {
  const entry = memory.get(keyOf(kind, id));
  if (!entry) return null;
  return { value: entry.value as T, storedAt: entry.storedAt };
}

export async function readCache<T>(kind: string, id = ""): Promise<CacheEntry<T> | null> {
  const cached = readMemory<T>(kind, id);
  if (cached) return cached;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(keyOf(kind, id));
      request.onsuccess = () => {
        const row = request.result as
          | { value: T; storedAt: number; schema: number }
          | undefined;
        if (!row || row.schema !== SCHEMA) {
          resolve(null);
          return;
        }
        const entry = { value: row.value, storedAt: row.storedAt };
        memory.set(keyOf(kind, id), entry as CacheEntry<unknown>);
        resolve(entry);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function writeCache<T>(kind: string, id: string, value: T): void {
  const storedAt = Date.now();
  memory.set(keyOf(kind, id), { value, storedAt } as CacheEntry<unknown>);
  void persist(keyOf(kind, id), value, storedAt);
}

async function persist(key: string, value: unknown, storedAt: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ key, value, storedAt, schema: SCHEMA });
    tx.oncomplete = () => void prune(db);
  } catch {
    // quota / closed db — memory copy still works
  }
}

async function prune(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const count = store.count();
    count.onsuccess = () => {
      const extra = (count.result || 0) - MAX_ENTRIES;
      if (extra <= 0) return;
      let removed = 0;
      const cursor = store.index("storedAt").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || removed >= extra) return;
        current.delete();
        removed += 1;
        current.continue();
      };
    };
  } catch {
    // best effort
  }
}

/** Drop one entry, or every entry of a kind when `id` is omitted. */
export function dropCache(kind: string, id?: string): void {
  if (id !== undefined) {
    const key = keyOf(kind, id);
    memory.delete(key);
    void deleteKeys([key]);
    return;
  }
  const prefix = keyOf(kind, "");
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  void deleteKeysByPrefix(prefix);
}

async function deleteKeys(keys: string[]): Promise<void> {
  const db = await openDb();
  if (!db || !keys.length) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const key of keys) store.delete(key);
  } catch {
    // ignore
  }
}

async function deleteKeysByPrefix(prefix: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
  } catch {
    // ignore
  }
}

export async function clearCache(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function isFresh(entry: CacheEntry<unknown> | null, ttlMs: number): boolean {
  return !!entry && Date.now() - entry.storedAt < ttlMs;
}
