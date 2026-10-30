import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { api } from "../api";
import { normalizeMarkdown } from "../utils/markdown";

export function Markdown({ content }: { content: string }) {
  if (!content?.trim()) return null;
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v9 no longer passes `inline`. Fenced code arrives as
          // <pre><code class="language-x">, so let `pre` own code blocks and let
          // `code` render only true inline spans.
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as any)?.props ?? {};
            const text = String(props.children ?? "").replace(/\n$/, "");
            const language = /language-([\w-]+)/.exec(props.className || "")?.[1] || "";
            return <CodeBlock language={language} code={text} />;
          },
          code: ({ children }: any) => <code className="inline-code">{children}</code>,
          a: ({ href, children }: any) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void api.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language || "code"}</span>
        <button
          type="button"
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: "14px 16px",
          background: "transparent",
          fontSize: 12.5,
          lineHeight: 1.65,
        }}
        codeTagProps={{
          style: {
            fontFamily: "Cascadia Code, Consolas, monospace",
            background: "transparent",
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
