import React from "react";
import Markdown from "react-markdown";
import { assistantMarkdownComponents, assistantMarkdownOptions } from "../assistantMarkdown";
import { codeFenceText } from "../chatUi";
import { CopyButton } from "./CopyButton";

function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return nodeText(props.children);
  }
  return "";
}

function fenceLanguage(node: React.ReactNode): string {
  if (Array.isArray(node)) {
    for (const child of node) {
      const lang = fenceLanguage(child);
      if (lang) return lang;
    }
    return "";
  }
  if (!React.isValidElement(node)) return "";
  const className = (node.props as { className?: string }).className || "";
  return /language-([\w+-]+)/.exec(className)?.[1] ?? "";
}

function CodeFence({ children }: { children?: React.ReactNode }) {
  const text = codeFenceText(nodeText(children));
  const lang = fenceLanguage(children);
  return (
    <div className="my-2 overflow-hidden rounded border border-[#262626] bg-black">
      <div className="flex items-center justify-between gap-2 border-b border-[#262626] pl-3">
        <span className="truncate text-[10px] uppercase tracking-wider text-[#737373]">{lang || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="klanker-md select-text min-w-0 break-words">
      {/* Raw HTML is escaped by react-markdown. Do not add rehype-raw. */}
      <Markdown
        {...assistantMarkdownOptions()}
        components={{
          ...assistantMarkdownComponents(),
          pre: CodeFence,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
