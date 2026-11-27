/**
 * `<think>...</think>` extraction (klanker#163 U08). Reasoning models
 * stream their chain-of-thought wrapped in think tags ahead of the
 * answer. While streaming the closing tag may not have arrived yet —
 * an unclosed trailing `<think>` still counts as thinking content.
 */
export interface ThinkingSplit {
  /** Concatenated thinking content, null when no think block exists. */
  thinking: string | null;
  /** The visible answer body with all think blocks removed. */
  body: string;
  /** True while a trailing think block is still open (streaming). */
  thinkingOpen: boolean;
}

export function splitThinking(text: string): ThinkingSplit {
  if (!text || !text.includes("<think")) {
    return { thinking: null, body: text, thinkingOpen: false };
  }
  const thinks: string[] = [];
  let body = "";
  let rest = text;
  let openTail = false;

  for (;;) {
    const start = rest.indexOf("<think>");
    if (start === -1) {
      body += rest;
      break;
    }
    body += rest.slice(0, start);
    const after = rest.slice(start + "<think>".length);
    const end = after.indexOf("</think>");
    if (end === -1) {
      thinks.push(after);
      openTail = true;
      rest = "";
      break;
    }
    thinks.push(after.slice(0, end));
    rest = after.slice(end + "</think>".length);
  }

  const thinking = thinks.length ? thinks.join("\n").trim() || null : null;
  return { thinking, body: body.trim(), thinkingOpen: openTail };
}
