/**
 * Mermaid SVG sanitization (klanker#163 U08). Mermaid runs with
 * securityLevel "strict" — but defense in depth: the rendered SVG is
 * scrubbed before it ever touches innerHTML. Strip anything that can
 * execute: script/foreignObject elements, on* event handlers,
 * javascript:/data: hrefs, and mermaid `click` callbacks.
 */
export function sanitizeSvg(svg: string): string {
  if (!svg) return "";
  let out = svg;
  // Whole-element removals (non-greedy, nested-safe enough for mermaid output).
  out = out.replace(/<script\b[\s\S]*?(<\/script\s*>|\/\s*>)/gi, "");
  out = out.replace(/<foreignObject\b[\s\S]*?(<\/foreignObject\s*>|\/\s*>)/gi, "");
  out = out.replace(/<iframe\b[\s\S]*?(<\/iframe\s*>|\/\s*>)/gi, "");
  out = out.replace(/<object\b[\s\S]*?(<\/object\s*>|\/\s*>)/gi, "");
  out = out.replace(/<embed\b[^>]*\/?>/gi, "");
  // Event handler attributes: onload=, onclick=, … (quoted + unquoted).
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Dangerous URLs in href/xlink:href.
  out = out.replace(/(xlink:)?href\s*=\s*"\s*(javascript|data|vbscript):[^"]*"/gi, 'href=""');
  out = out.replace(/(xlink:)?href\s*=\s*'\s*(javascript|data|vbscript):[^']*'/gi, "href=''");
  return out;
}

/** True when the diagram source tries to smuggle active content that
 *  strict-mode mermaid or the SVG scrubber must neutralize — used by
 *  tests to prove the payload actually reached the pipeline. */
export function looksMalicious(source: string): boolean {
  return /<script|javascript:|onclick|onerror|onload|click\s+\w+\s+call|<a\s+[^>]*href\s*=\s*["']?\s*javascript/i.test(
    source
  );
}
