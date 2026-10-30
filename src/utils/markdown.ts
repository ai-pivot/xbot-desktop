/**
 * Markdown quirks that come from the model's output, normalised before the
 * renderer sees them.
 *
 * GFM extended autolinks are greedy: `**https://x/y**（说明）` (no space before
 * the Chinese text) swallows the closing `**` and `（说明` into the link, so the
 * opening `**` stays literal and the bold never closes. Rewriting the pattern
 * as an explicit markdown link keeps the emphasis delimiters intact, and the
 * `<...>` destination form tolerates parentheses inside the URL.
 */
export function normalizeMarkdown(raw: string): string {
  if (!raw) return raw;
  return raw.replace(/\*\*(https?:\/\/[^\s*<>]+?)\*\*/g, "**[$1](<$1>)**");
}
