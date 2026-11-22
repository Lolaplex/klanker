import React from "react";
import type { Components, Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeUrl, visibleImageSrc } from "./chatUi.ts";

let cachedOptions: Pick<Options, "remarkPlugins" | "urlTransform"> | null = null;

export function assistantMarkdownOptions(): Pick<Options, "remarkPlugins" | "urlTransform"> {
  // One allocation per app, not per render: the objects are static.
  cachedOptions ??= {
    remarkPlugins: [remarkGfm],
    urlTransform: (url) => safeUrl(url),
  };
  return cachedOptions;
}

let cachedComponents: Components | null = null;

export function assistantMarkdownComponents(): Components {
  cachedComponents ??= {
    a(props) {
      const url = safeUrl(typeof props.href === "string" ? props.href : "");
      if (!url) return React.createElement("span", null, props.children);
      return React.createElement(
        "a",
        { href: url, title: props.title, target: "_blank", rel: "noreferrer noopener" },
        props.children
      );
    },
    img(props) {
      const url = visibleImageSrc(typeof props.src === "string" ? props.src : "");
      if (!url) return React.createElement("span", null, props.alt || "image");
      return React.createElement("img", {
        src: url,
        alt: props.alt || "",
        title: props.title,
        className: "max-w-full",
      });
    },
  };
  return cachedComponents;
}
