/**
 * Chat export helpers — serialize a chat's messages to Markdown or JSON and
 * trigger a browser download. Pure string builders are kept separate from the
 * DOM download path so the formats stay unit-testable under node --test.
 */
import type { ChatMessage } from "./types/klanker";

export interface ExportDoc {
  /** Instance/agent display name, e.g. "klanker". */
  agent: string;
  /** Assistant speaker name shown on bubbles. */
  speaker: string;
  /** Session label/id the chat is bound to (may be "new"). */
  session: string;
  messages: ChatMessage[];
}

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  user: "User",
  klanker: "Assistant",
  system: "System",
  tool: "Tool",
};

function roleLabel(m: ChatMessage, speaker: string): string {
  return m.role === "klanker" ? speaker || "Assistant" : ROLE_LABEL[m.role] || m.role;
}

function stamp(m: ChatMessage): string {
  const t = new Date(m.timestamp);
  const when = Number.isNaN(t.getTime()) ? m.timestamp : t.toLocaleString();
  return m.elapsed_ms ? `${when} · ${m.elapsed_ms}ms` : when;
}

export function chatToMarkdown(doc: ExportDoc): string {
  const out = [
    `# ${doc.agent} chat`,
    "",
    `- Session: ${doc.session || "new"}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
  ];
  for (const m of doc.messages) {
    out.push(`## ${roleLabel(m, doc.speaker)} — ${stamp(m)}`, "");
    if (m.attachments?.length) {
      out.push(`Attachments: ${m.attachments.join(", ")}`, "");
    }
    out.push(m.content || "_(empty)_", "");
  }
  return out.join("\n");
}

export function chatToJson(doc: ExportDoc): string {
  return JSON.stringify(
    {
      agent: doc.agent,
      speaker: doc.speaker,
      session: doc.session || null,
      exported_at: new Date().toISOString(),
      messages: doc.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        elapsed_ms: m.elapsed_ms ?? null,
        attachments: m.attachments ?? [],
      })),
    },
    null,
    2
  );
}

/** Filesystem-safe download stem: lowercase, dashes, bounded length. */
export function exportStem(session: string): string {
  const base = (session || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${(base || "chat").slice(0, 40)}-${ts}`;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
