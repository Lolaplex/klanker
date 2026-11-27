import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ApprovalReview } from "./components/ApprovalReview.tsx";
import type { PendingApproval } from "./types/klanker.ts";

// U09 oracle (klanker#164): diff preview renders path + truncated hint,
// command preview renders argv/cwd/risk badge, Allow always dispatches
// remember:true, legacy rows fall back to summary||tool.

async function renderInDom(el: React.ReactElement): Promise<{ html: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return {
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** @pierre/diffs renders into shadow DOM — innerHTML never sees the
 *  lines. Collect visible text incl. every shadow root. */
function deepText(node: Element | null): string {
  if (!node) return "";
  let out = node.textContent || "";
  for (const el of Array.from(node.querySelectorAll("*"))) {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) out += "\n" + (sr.textContent || "");
  }
  return out;
}

const base: PendingApproval = {
  id: "ap1",
  tool: "mcp.terminal.write",
  summary: "write file",
};

describe("ApprovalReview diff preview", () => {
  it("renders the file path header and the unified diff", async () => {
    const unified = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      "-const x = 1",
      "+const x = 2",
      " export {}",
    ].join("\n");
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: { ...base, preview: { kind: "diff", path: "src/app.ts", unified, truncated: true } },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 300));
    });
    try {
      const html = r.html();
      assert.ok(html.includes("src/app.ts"), "file path header missing");
      assert.ok(html.includes("truncated"), "truncated hint missing");
      const text = deepText(document.body as unknown as Element);
      assert.ok(text.includes("const x = 2"), `diff content missing in shadow text: ${text.slice(0, 200)}`);
      assert.ok(text.includes("const x = 1"), "removed line missing");
      assert.ok(!html.includes("<script"), "no script injection");
    } finally {
      r.unmount();
    }
  });

  it("renders from old_text/new_text when unified is absent", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: {
          ...base,
          preview: { kind: "diff", path: "a.txt", old_text: "before\n", new_text: "after\n" },
        },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 300));
    });
    try {
      const html = r.html();
      assert.ok(html.includes("a.txt"), "path missing");
      assert.ok(deepText(document.body as unknown as Element).includes("after"), "new text missing");
    } finally {
      r.unmount();
    }
  });
});

describe("ApprovalReview command preview", () => {
  it("renders expanded argv, cwd and a color-coded risk badge", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: {
          ...base,
          tool: "mcp.terminal.run",
          preview: { kind: "command", argv: ["git", "push", "origin", "main"], cwd: "/repo", risk: "high" },
        },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    try {
      const html = r.html();
      assert.ok(html.includes("git"), "argv missing");
      assert.ok(html.includes("push"), "argv tail missing");
      assert.ok(html.includes("cwd"), "cwd line missing");
      assert.ok(html.includes("/repo"), "cwd value missing");
      assert.ok(html.includes("high"), "risk badge missing");
      assert.ok(html.includes("text-red-500"), "high risk must be red-coded");
    } finally {
      r.unmount();
    }
  });

  it("medium risk renders amber", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: { ...base, preview: { kind: "command", argv: ["ls"], risk: "medium" } },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    try {
      assert.ok(r.html().includes("text-amber-500"), "medium risk must be amber-coded");
    } finally {
      r.unmount();
    }
  });
});

describe("ApprovalReview actions", () => {
  const clickByLabel = async (label: string) => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => (b.textContent || "").trim() === label) as HTMLButtonElement | undefined;
    assert.ok(btn, `button "${label}" missing`);
    await act(async () => {
      btn.click();
    });
  };

  it("Allow always dispatches (true, remember:true)", async () => {
    const calls: [boolean, boolean | undefined][] = [];
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: { ...base, preview: { kind: "command", argv: ["ls"], risk: "low" } },
        deciding: false,
        decideError: null,
        onDecide: (allow: boolean, remember?: boolean) => calls.push([allow, remember]),
      })
    );
    try {
      await clickByLabel("Allow always");
      assert.deepEqual(calls, [[true, true]], "remember flag must ride the wire payload");
    } finally {
      r.unmount();
    }
  });

  it("Allow once dispatches (true) without remember; Deny dispatches false", async () => {
    const calls: [boolean, boolean | undefined][] = [];
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: base,
        deciding: false,
        decideError: null,
        onDecide: (allow: boolean, remember?: boolean) => calls.push([allow, remember]),
      })
    );
    try {
      await clickByLabel("Allow once");
      await clickByLabel("Deny");
      assert.deepEqual(calls, [[true, undefined], [false, undefined]]);
    } finally {
      r.unmount();
    }
  });
});

describe("ApprovalReview legacy fallback", () => {
  it("falls back to summary when preview is absent", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: { ...base, summary: "run npm install" },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    try {
      assert.ok(r.html().includes("run npm install"), "summary fallback missing");
    } finally {
      r.unmount();
    }
  });

  it("falls back to tool name when summary is empty", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: { ...base, summary: "" },
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    try {
      assert.ok(r.html().includes("mcp.terminal.write"), "tool fallback missing");
    } finally {
      r.unmount();
    }
  });

  it("renders all three action labels", async () => {
    const r = await renderInDom(
      React.createElement(ApprovalReview, {
        pending: base,
        deciding: false,
        decideError: null,
        onDecide: () => {},
      })
    );
    try {
      const html = r.html();
      assert.ok(html.includes("Deny"), "Deny missing");
      assert.ok(html.includes("Allow once"), "Allow once missing");
      assert.ok(html.includes("Allow always"), "Allow always missing");
    } finally {
      r.unmount();
    }
  });
});
