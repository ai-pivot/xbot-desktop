import { describe, expect, it } from "vitest";
import { normalizeMarkdown } from "./markdown";

describe("normalizeMarkdown", () => {
  it("rewrites a bold bare URL into a bold markdown link", () => {
    // GFM autolinks swallow the closing ** when Chinese text follows without a
    // space, which left the opening ** literal in the UI.
    expect(normalizeMarkdown("PR 已开: **https://github.com/a/b/pull/62**（4 文件）")).toBe(
      "PR 已开: **[https://github.com/a/b/pull/62](<https://github.com/a/b/pull/62>)**（4 文件）",
    );
  });

  it("keeps URLs with parentheses intact", () => {
    expect(normalizeMarkdown("**https://example.com/a_(b)** 后面")).toBe(
      "**[https://example.com/a_(b)](<https://example.com/a_(b)>)** 后面",
    );
  });

  it("leaves normal emphasis and bare links alone", () => {
    const text = "普通 **粗体** 和 https://example.com 裸链接";
    expect(normalizeMarkdown(text)).toBe(text);
  });

  it("handles empty input", () => {
    expect(normalizeMarkdown("")).toBe("");
  });
});
