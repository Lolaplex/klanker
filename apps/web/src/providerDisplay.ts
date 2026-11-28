import type { ProviderRow } from "./types/klanker";

const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  "openrouter.local": "OpenRouter",
  openai: "OpenAI",
  "openai.default": "OpenAI",
  "openai.local": "OpenAI",
  anthropic: "Anthropic",
  "anthropic.local": "Anthropic",
  gemini: "Gemini",
  google: "Gemini",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  lmstudio: "LM Studio",
  "lmstudio.local": "LM Studio",
  ollama: "Ollama",
  "ollama.local": "Ollama",
  "acp.devin": "Devin",
  "acp.claude": "Claude Code",
  "acp.codex": "Codex",
};

function stripProviderSlug(raw: string): string {
  return raw.trim().replace(/^acp\./i, "").replace(/\.(local|default)$/i, "");
}

/** Human provider label for settings cards, badges and picker rows. */
export function providerDisplayName(provider: string | Pick<ProviderRow, "name" | "label" | "kind">): string {
  const label = typeof provider === "object" ? provider.label?.trim() : "";
  if (label) return label;
  const raw = typeof provider === "string" ? provider.trim() : provider.name.trim();
  if (!raw) return "Provider";
  const direct = PROVIDER_NAMES[raw.toLowerCase()];
  if (direct) return direct;
  const stripped = stripProviderSlug(raw);
  return PROVIDER_NAMES[stripped.toLowerCase()] || stripped || raw;
}

/** Split OpenRouter-style vendor prefixes out of the primary model label.
 *  The raw id remains the caller's tooltip/filter key — this helper only
 *  shapes the visual projection. */
export function modelDisplayName(model: string, provider = ""): { primary: string; vendor?: string } {
  const raw = model.trim();
  if (!raw) return { primary: provider ? providerDisplayName(provider) : "Auto" };
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    return { primary: raw.slice(slash + 1), vendor: raw.slice(0, slash) };
  }
  return { primary: raw };
}
