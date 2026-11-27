import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { WorkbenchRail } from "./components/workbench/WorkbenchRail.tsx";
import {
  deleteApprovalAllowlistPattern,
  deleteMemoryFile,
  deleteSkill,
  getBgLogs,
  getDoctorReport,
  getSessionGit,
  getUsageStats,
  grepWorkbenchFiles,
  killBgSession,
  listApprovalAllowlist,
  listBgSessions,
  listMemoryFiles,
  listSkills,
  listWorkbenchFiles,
  readMemoryFile,
  readSkill,
  readWorkbenchFile,
  writeMemoryFile,
  writeSkill,
} from "./services/workbenchApi.ts";
import type { KlankerInstance } from "./types/klanker.ts";

// U12 oracle (klanker#167): right-rail workbench over the U14 routes —
// Changes/@pierre diff, Files browse/read/grep, Traces+doctor, BG logs/kill,
// memory+skills editors, approval allowlist, detail slot. Wire shapes must
// match the backend exactly.

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return jsonRes(out ?? { ok: true });
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

async function renderInDom(el: React.ReactElement): Promise<{ html: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function deepText(node: Element | null): string {
  if (!node) return "";
  let out = node.textContent || "";
  for (const el of Array.from(node.querySelectorAll("*"))) {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) out += String.fromCharCode(10) + (sr.textContent || "");
  }
  return out;
}

const flush = async (ms = 30) => act(async () => new Promise((res) => setTimeout(res, ms)));

describe("U14 workbench wire contracts", () => {
  it("uses exact methods, paths, query params and bodies for every rail endpoint", async () => {
    const fx = stubFetch((url) => {
      if (url.includes("/git")) return { ok: true, is_git: false, branch: "", repo: "", worktree: "", dirty_files: [], wip_unpushed: false, diff: "", diff_truncated: false };
      if (url.includes("/files/grep")) return { ok: true, path: "src", matches: [], truncated: false };
      if (url.includes("/files/read")) return { ok: true, path: "a.ts", offset: 1, limit: 2000, line_count: 1, truncated: false, content: "x", encoding: "utf-8" };
      if (url.includes("/files")) return { ok: true, path: "src", entries: [] };
      if (url.includes("/stats")) return { ok: true, workspace: "alpha", stats: {} };
      if (url.includes("/doctor")) return { ok: true, checks: [], failed: 0, warned: 0 };
      if (url.includes("/logs")) return { ok: true, id: "bg1", status: "running", logs: "" };
      if (url.includes("/kill")) return { ok: true, session: { id: "bg1", status: "killed" } };
      if (url.endsWith("/v1/klanker/bg?workspace=alpha")) return { ok: true, sessions: [] };
      if (url.includes("/memory/file")) return { ok: true, path: "n.md", content: "memory", bytes: 6, files: [] };
      if (url.includes("/memory")) return { ok: true, files: [] };
      if (url.includes("/skills/")) return { ok: true, name: "review", content: "# s", bytes: 3, skill: "review" };
      if (url.includes("/skills")) return { ok: true, skills: [] };
      if (url.includes("/approvals/allowlist")) return { ok: true, patterns: ["git status"], workspace: "alpha", removed: "git status" };
      return { ok: true };
    });
    try {
      await getSessionGit(inst, "alpha", "ses_1", "src/a.ts");
      await listWorkbenchFiles(inst, "alpha", "src");
      await readWorkbenchFile(inst, "alpha", "src/a.ts", 10, 50);
      await grepWorkbenchFiles(inst, "alpha", "needle", "src", "*.ts");
      await getUsageStats(inst, "alpha", "ses_1", 14);
      await getDoctorReport(inst);
      await listBgSessions(inst, "alpha");
      await getBgLogs(inst, "bg1", 80);
      await killBgSession(inst, "bg1");
      await listMemoryFiles(inst, "alpha", "note");
      await readMemoryFile(inst, "alpha", "n.md");
      await writeMemoryFile(inst, "alpha", "n.md", "memory");
      await deleteMemoryFile(inst, "alpha", "n.md");
      await listSkills(inst, "alpha");
      await readSkill(inst, "alpha", "review");
      await writeSkill(inst, "alpha", "review", "# s");
      await deleteSkill(inst, "alpha", "review");
      await listApprovalAllowlist(inst, "alpha");
      await deleteApprovalAllowlistPattern(inst, "alpha", "git status");
      const u = fx.calls.map((c) => c.url.replace("http://127.0.0.1:8787", ""));
      assert.equal(u[0], "/v1/klanker/sessions/ses_1/git?workspace=alpha&file=src%2Fa.ts");
      assert.equal(u[1], "/v1/klanker/files?workspace=alpha&path=src");
      assert.equal(u[2], "/v1/klanker/files/read?workspace=alpha&path=src%2Fa.ts&offset=10&limit=50");
      assert.equal(u[3], "/v1/klanker/files/grep?workspace=alpha&q=needle&path=src&glob=*.ts");
      assert.equal(u[4], "/v1/klanker/stats?workspace=alpha&session=ses_1&days=14");
      assert.equal(u[5], "/v1/klanker/doctor");
      assert.equal(u[6], "/v1/klanker/bg?workspace=alpha");
      assert.equal(u[7], "/v1/klanker/bg/bg1/logs?lines=80");
      assert.equal(fx.calls[8].init?.method, "POST");
      assert.equal(u[8], "/v1/klanker/bg/bg1/kill");
      assert.equal(u[9], "/v1/klanker/memory?workspace=alpha&q=note");
      assert.equal(u[10], "/v1/klanker/memory/file?workspace=alpha&path=n.md");
      assert.equal(fx.calls[11].init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(fx.calls[11].init?.body)), { workspace: "alpha", path: "n.md", content: "memory" });
      assert.equal(fx.calls[12].init?.method, "DELETE");
      assert.equal(u[12], "/v1/klanker/memory/file?workspace=alpha&path=n.md");
      assert.equal(u[13], "/v1/klanker/skills?workspace=alpha");
      assert.equal(u[14], "/v1/klanker/skills/review?workspace=alpha");
      assert.equal(fx.calls[15].init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(fx.calls[15].init?.body)), { workspace: "alpha", content: "# s" });
      assert.equal(fx.calls[16].init?.method, "DELETE");
      assert.equal(u[16], "/v1/klanker/skills/review?workspace=alpha");
      assert.equal(u[17], "/v1/approvals/allowlist?workspace=alpha");
      assert.equal(fx.calls[18].init?.method, "DELETE");
      assert.equal(u[18], "/v1/approvals/allowlist?workspace=alpha&pattern=git+status");
      assert.ok(!fx.calls.some((c) => c.url.includes("undefined")), "no undefined query/path segment");
    } finally {
      fx.restore();
    }
  });
});

describe("workbench rail shell", () => {
  it("renders all six areas and the empty-session changes state", async () => {
    const fx = stubFetch(() => ({ ok: true }));
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "", onClose: () => {}, notify: () => {} }));
    try {
      const html = r.html();
      for (const label of ["Changes", "Files", "Traces", "Terminal", "Memory", "Detail"]) {
        assert.ok(html.includes(label) || html.includes(label.replace("&", "&amp;")), `${label} tab missing`);
      }
      assert.ok(html.includes("open a session to inspect its git worktree"), "empty session guidance missing");
      assert.ok(html.includes("workbench-rail"), "rail test id missing");
    } finally {
      r.unmount();
      fx.restore();
    }
  });

  it("App mounts the rail and Ctrl/Cmd+J toggles it", () => {
    const src = readFileSync("src/App.tsx", "utf-8");
    assert.ok(src.includes("WorkbenchRail"), "rail not mounted in App");
    assert.ok(src.includes('key === "j"'), "Ctrl/Cmd+J binding missing");
    assert.ok(!src.includes("WorkspacePane"), "old store drawer still mounted");
  });
});

describe("changes and detail slot", () => {
  it("renders dirty files, opens the selected file diff in Detail via @pierre/diffs", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const fx = stubFetch((url) => {
      if (url.includes("file=")) return { ok: true, is_git: true, branch: "feat/x", repo: "repo", worktree: "wt", dirty_files: [], wip_unpushed: false, diff: patch, diff_truncated: false };
      return { ok: true, is_git: true, branch: "feat/x", repo: "repo", worktree: "wt", dirty_files: [{ status: "M", path: "src/a.ts" }], wip_unpushed: true, diff: patch, diff_truncated: false };
    });
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "ses_1", onClose: () => {}, notify: () => {} }));
    try {
      await flush(60);
      assert.ok(r.html().includes("feat/x"), "branch missing");
      assert.ok(r.html().includes("src/a.ts"), "dirty file row missing");
      assert.ok(r.html().includes("wip unpushed"), "wip badge missing");
      const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("src/a.ts")) as HTMLButtonElement;
      assert.ok(row, "dirty row button missing");
      await act(async () => row.click());
      await flush(350);
      const html = r.html();
      assert.ok(html.includes("workbench-diff"), "detail diff renderer missing");
      assert.ok(deepText(document.body as unknown as Element).includes("new"), "diff content missing");
    } finally {
      r.unmount();
      fx.restore();
    }
  });
});

describe("files tab", () => {
  it("lists entries, opens file contents in Detail and exposes grep", async () => {
    const fx = stubFetch((url) => {
      if (url.includes("/files/read")) return { ok: true, path: "src/a.ts", content: "const answer = 42;", line_count: 1, truncated: false };
      return { ok: true, path: ".", entries: [{ name: "src", type: "dir", size: 0 }, { name: "a.ts", type: "file", size: 20 }] };
    });
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "", onClose: () => {}, notify: () => {} }));
    try {
      const filesTab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Files") as HTMLElement;
      await act(async () => filesTab.click());
      await flush(60);
      assert.ok(r.html().includes("a.ts"), "file row missing");
      assert.ok(r.html().includes("grep"), "grep affordance missing");
      const file = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("a.ts")) as HTMLButtonElement;
      await act(async () => file.click());
      await flush(60);
      assert.ok(r.html().includes("const answer = 42"), "detail file content missing");
    } finally {
      r.unmount();
      fx.restore();
    }
  });
});

describe("data and memory tab", () => {
  it("loads memory, skills and allowlist; memory rows open the editor", async () => {
    const fx = stubFetch((url) => {
      if (url.includes("/memory/file")) return { ok: true, path: "notes/a.md", content: "remember this" };
      if (url.includes("/memory")) return { ok: true, files: [{ path: "notes/a.md", bytes: 13 }] };
      if (url.includes("/skills")) return { ok: true, skills: [{ name: "review", files: 1, bytes: 30 }] };
      if (url.includes("/approvals/allowlist")) return { ok: true, patterns: ["git status"], workspace: "alpha" };
      return { ok: true };
    });
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "", onClose: () => {}, notify: () => {} }));
    try {
      const dataTab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Memory") as HTMLElement;
      await act(async () => dataTab.click());
      await flush(60);
      const html = r.html();
      assert.ok(html.includes("notes/a.md"), "memory row missing");
      assert.ok(html.includes("review"), "skill row missing");
      assert.ok(html.includes("git status"), "allowlist row missing");
      assert.ok(html.includes("new memory") && html.includes("new skill"), "create affordances missing");
      const row = [...document.querySelectorAll("button")].find((b) => b.textContent === "notes/a.md") as HTMLButtonElement;
      await act(async () => row.click());
      await flush(60);
      assert.ok((document.querySelector('textarea[aria-label="Edit memory"]') as HTMLTextAreaElement)?.value.includes("remember this"), "memory editor did not load content");
    } finally {
      r.unmount();
      fx.restore();
    }
  });
});

describe("monochrome and primitive reuse", () => {
  it("workbench files use semantic surfaces and reuse ui/Tabs + @pierre/diffs", () => {
    const dir = "src/components/workbench";
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(`${dir}/${f}`, "utf-8");
      assert.ok(!/bg-\[#[01][0-9a-fA-F]{5}\]/.test(src), `${f} hardcoded surface hex`);
      assert.ok(!/(blue|purple)-[0-9]/.test(src), `${f} introduces blue/purple accents`);
    }
    const rail = readFileSync(`${dir}/WorkbenchRail.tsx`, "utf-8");
    assert.ok(rail.includes('from "../ui/Tabs"'), "ui/Tabs not reused");
    assert.ok(rail.includes("@pierre/diffs/react"), "@pierre/diffs not reused for detail diffs");
  });
});
