import { safeHttpUrl } from "./safety";

export type OpenUiActionEvent = {
  type: string;
  params?: Record<string, unknown>;
  humanFriendlyMessage?: string;
  formState?: Record<string, unknown>;
  formName?: string;
};

export type OpenUiActionContext = {
  session?: string;
  workspace?: string;
  persona?: string;
  sendPrompt: (text: string) => void;
  openUrl?: (url: string) => void;
};

export type OpenUiActionResult =
  | { kind: "prompt"; payload: { text: string; session: string; workspace: string; persona: string } }
  | { kind: "url"; url: string }
  | { kind: "detail" }
  | { kind: "rejected"; reason: string };

function scalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function promptText(event: OpenUiActionEvent): string {
  const p = event.params || {};
  const base =
    (event.humanFriendlyMessage || "").trim() ||
    scalar(p.message ?? p.prompt ?? p.text ?? p.label).trim();
  const state = event.formState || {};
  const rows = Object.entries(state)
    .filter(([k]) => k && !k.startsWith("$"))
    .map(([k, v]) => `- ${k}: ${scalar(v)}`);
  if (!rows.length) return base;
  const form = event.formName ? `Form \`${event.formName}\` answers` : "Form answers";
  return `${base || "Submitted form"}\n\n${form}:\n${rows.join("\n")}`.trim();
}

/**
 * Whitelisted GenUI action bridge. No custom action is ever evaluated — the
 * only effects are a prompt turn, a verified http(s) navigation, or a local
 * detail-view CustomEvent.
 */
export function dispatchOpenUiAction(event: OpenUiActionEvent, ctx: OpenUiActionContext): OpenUiActionResult {
  const type = String(event.type || "");
  const session = ctx.session || "";
  const workspace = ctx.workspace || "";
  const persona = ctx.persona || "";

  if (type === "continue_conversation" || type === "form_submit" || type === "prompt_submit") {
    const text = promptText(event);
    if (!text) return { kind: "rejected", reason: "empty prompt action" };
    ctx.sendPrompt(text);
    return { kind: "prompt", payload: { text, session, workspace, persona } };
  }

  if (type === "open_url") {
    const url = safeHttpUrl(event.params?.url);
    if (!url) return { kind: "rejected", reason: "url must be absolute http(s)" };
    const open = ctx.openUrl || ((u: string) => window.open(u, "_blank", "noopener,noreferrer"));
    open(url);
    return { kind: "url", url };
  }

  if (type === "open_detail") {
    window.dispatchEvent(
      new CustomEvent("klanker:open-detail", {
        detail: {
          params: event.params || {},
          session,
          workspace,
          persona,
        },
      })
    );
    return { kind: "detail" };
  }

  return { kind: "rejected", reason: `unsupported action: ${type || "unknown"}` };
}
