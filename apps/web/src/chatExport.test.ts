import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatToJson, chatToMarkdown, exportStem } from "./chatExport.ts";
import type { ChatMessage } from "./types/klanker.ts";

const msgs: ChatMessage[] = [
  { id: "m1", role: "user", content: "hi **there**", timestamp: "2026-01-02T03:04:05Z", attachments: ["a.png"] },
  { id: "m2", role: "klanker", content: "hello\n\n- item", timestamp: "2026-01-02T03:04:07Z", elapsed_ms: 2100 },
];

const doc = { agent: "klanker-1", speaker: "Klank", session: "ses_abc", messages: msgs };

describe("chatToMarkdown", () => {
  it("emits a header, session line, roles and attachments", () => {
    const md = chatToMarkdown(doc);
    assert.match(md, /^# klanker-1 chat\n/);
    assert.match(md, /- Session: ses_abc/);
    assert.match(md, /## User — /);
    assert.match(md, /## Klank — .*2100ms/);
    assert.match(md, /Attachments: a\.png/);
    assert.match(md, /hi \*\*there\*\*/);
  });
});

describe("chatToJson", () => {
  it("round-trips messages with normalized fields", () => {
    const parsed = JSON.parse(chatToJson(doc));
    assert.equal(parsed.agent, "klanker-1");
    assert.equal(parsed.session, "ses_abc");
    assert.equal(parsed.messages.length, 2);
    assert.deepEqual(parsed.messages[0].attachments, ["a.png"]);
    assert.equal(parsed.messages[1].elapsed_ms, 2100);
    assert.equal(parsed.messages[0].elapsed_ms, null);
  });
});

describe("exportStem", () => {
  it("slugifies and bounds the filename stem", () => {
    const s = exportStem("Ses_ABC Def!");
    assert.match(s, /^ses-abc-def-\d{8}-\d{4}$/);
    assert.ok(exportStem("").startsWith("chat-"));
    assert.ok(exportStem("x".repeat(200)).length <= 60);
  });
});
