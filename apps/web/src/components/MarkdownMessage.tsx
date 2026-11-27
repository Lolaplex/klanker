import React, { Suspense } from "react";
import Markdown from "react-markdown";
import type { Options } from "react-markdown";
import { assistantMarkdownComponents, assistantMarkdownOptions } from "../assistantMarkdown";
import { codeFenceText } from "../chatUi";
import { CopyButton } from "./CopyButton";
import { MermaidBlock } from "./MermaidBlock";
import { OpenUiRawFallback } from "./genui/OpenUiRawFallback";
import type { OpenUiActionContext } from "./genui/actionDispatcher";

const OpenUiBlock = React.lazy(() => import("./genui/OpenUiBlock"));

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

function CodeFence({ children, genui }: { children?: React.ReactNode; genui?: MarkdownGenUiContext }) {
  const text = codeFenceText(nodeText(children));
  const lang = fenceLanguage(children);
  if (lang === "mermaid") {
    return <MermaidBlock source={text} />;
  }
  if (lang === "openui") {
    if (!genui) return <OpenUiRawFallback source={text} reason="unbound action context" />;
    return (
      <Suspense fallback={<div className="my-2 rounded-md border border-subtle bg-surface p-4 text-[11px] text-ink-muted">loading genui…</div>}>
        <OpenUiBlock source={text} streaming={genui.streaming} actionContext={genui.actionContext} />
      </Suspense>
    );
  }
  return (
    <div className="my-2 overflow-hidden rounded-md border border-strong bg-main">
      <div className="flex items-center justify-between gap-2 border-b border-strong pl-3">
        <span className="truncate text-[10px] uppercase tracking-wider text-ink-muted">{lang || "code"}</span>
        <CopyButton text={text} label="Copy code" borderless className="mr-1" />
      </div>
      <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}

export type MarkdownGenUiContext = {
  streaming?: boolean;
  actionContext: OpenUiActionContext;
};

// Static Markdown config hoisted to module scope: identical for every bubble,
// so per-chunk renders no longer rebuild plugins/closures. `pre` is assigned
// per render because GenUI carries a per-session action context.
const MD_BASE: Omit<Options, "components"> = assistantMarkdownOptions();
const MD_COMPONENTS = assistantMarkdownComponents();

export const MarkdownMessage = React.memo(function MarkdownMessage({
  text,
  genui,
}: {
  text: string;
  genui?: MarkdownGenUiContext;
}) {
  const props: Options = {
    ...MD_BASE,
    components: {
      ...MD_COMPONENTS,
      pre: (preProps) => <CodeFence {...preProps} genui={genui} />,
    },
  };
  return (
    <div className="klanker-md select-text min-w-0 break-words">
      {/* Raw HTML is escaped by react-markdown. Do not add rehype-raw. */}
      <Markdown {...props}>{text}</Markdown>
    </div>
  );
});
