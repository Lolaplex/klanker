import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { assistantMarkdownComponents, assistantMarkdownOptions } from "./assistantMarkdown.ts";

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
