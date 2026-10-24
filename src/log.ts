import { invoke } from "@tauri-apps/api/core";

/**
 * Client-side log sink. Everything lands in `%TEMP%\xbot-desktop.log`
 * (written by the Rust side), so a failure in the UI is never invisible.
 * Logging must never throw or block the caller.
 */
export function logEvent(scope: string, message: string, detail?: unknown): void {
  let text = "";
  if (detail !== undefined) {
    try {
      text = typeof detail === "string" ? detail : JSON.stringify(detail);
    } catch {
      text = String(detail);
    }
  }
  void invoke("append_log", { scope, message, detail: text }).catch(() => undefined);
}

export function logError(scope: string, error: unknown, context?: string): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  logEvent(scope, message, [context, stack].filter(Boolean).join("\n"));
}
