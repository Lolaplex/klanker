import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { assistantMarkdownComponents, assistantMarkdownOptions } from "./assistantMarkdown.ts";
import { sanitizeSvg, looksMalicious } from "./mermaidSafe.ts";

function render(markdown: string): string {
  return renderToStaticMarkup(
    React.createElement(Markdown, {
      ...assistantMarkdownOptions(),
      components: assistantMarkdownComponents(),
      children: markdown,
    })
  );
}

describe("assistant markdown", () => {
  it("renders emphasis and keeps raw HTML as text", () => {
    const html = render("Hello **world**\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    assert.match(html, /<strong>world<\/strong>/);
    assert.equal(/<script\b/i.test(html), false);
    assert.equal(/<img\b/i.test(html), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("does not emit javascript links", () => {
    const html = render("[x](javascript:alert(1)) and [y](https://example.com/a)");
    assert.equal(/javascript:/i.test(html), false);
    assert.match(html, /href="https:\/\/example.com\/a"/);
  });

  it("does not load an image from a script URL", () => {
    const html = render("![pic](javascript:alert(1))");
    assert.equal(/<img\b/i.test(html), false);
    assert.equal(/javascript:/i.test(html), false);
  });
});

describe("markdown math + code highlighting pipeline", () => {
  it("renders inline math through rehype-katex", () => {
    const html = render("energy is $E = mc^2$ end");
    assert.ok(html.includes("katex"), `katex class missing: ${html.slice(0, 200)}`);
  });

  it("renders display math without executing script payloads inside it", () => {
    const html = render("$$x^2$$\n\n<script>alert(1)</script>");
    assert.ok(html.includes("katex"), "katex missing for display math");
    assert.equal(/<script\b/i.test(html), false);
  });

  it("highlights fenced code with prism tokens", () => {
    const html = render("```js\nconst x = 1\n```");
    assert.ok(html.includes("language-js") || html.includes("token"), `prism classes missing: ${html.slice(0, 300)}`);
  });
});

describe("mermaid svg sanitization", () => {
  it("strips script elements", () => {
    const dirty = '<svg><script>alert(1)</script><g/></svg>';
    const clean = sanitizeSvg(dirty);
    assert.equal(/<script/i.test(clean), false);
    assert.ok(clean.includes("<g/>"), "benign content must survive");
  });

  it("strips foreignObject and iframes", () => {
    const dirty = '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject><rect/></svg>';
    const clean = sanitizeSvg(dirty);
    assert.equal(/foreignObject/i.test(clean), false);
    assert.equal(/<script/i.test(clean), false);
    assert.ok(clean.includes("<rect/>"));
  });

  it("strips event handler attributes", () => {
    const dirty = '<svg onload="alert(1)"><rect onclick=alert(1) width="3"/></svg>';
    const clean = sanitizeSvg(dirty);
    assert.equal(/onload|onclick/i.test(clean), false);
  });

  it("neutralizes javascript: and data: hrefs", () => {
    const dirty = '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a><a href="data:text/html,x">y</a></svg>';
    const clean = sanitizeSvg(dirty);
    assert.equal(/javascript:/i.test(clean), false);
    assert.equal(/data:text\/html/i.test(clean), false);
  });

  it("detects malicious mermaid click payloads in source", () => {
    assert.ok(looksMalicious("graph TD\n  click A call alert(1)"));
    assert.ok(looksMalicious('graph TD\n  A["<script>alert(1)</script>"]'));
    assert.ok(!looksMalicious("graph TD\n  A-->B"));
  });

  it("mermaid fence source never reaches the DOM as html in ssr output", () => {
    // The SSR shell only renders the lazy-loading placeholder — the
    // diagram source must not be innerHTML'ed anywhere.
    const html = render("```mermaid\ngraph TD\n  click A call alert(1)\n```");
    assert.equal(/<script\b/i.test(html), false);
    assert.equal(/onclick/i.test(html), false);
  });
});
