import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandRows, groupRows, parseFreeId, pickerRows, picksEqual } from "./providerPicker.ts";

const providers = [
  { name: "lmstudio.local", kind: "openai_compat", model: "qwen", models: ["qwen", "deepseek-r1"] },
  { name: "acp.devin", kind: "acp-agent", models: ["opus", "sonnet"], source: "file", command: "devin acp" },
  { name: "echo", kind: "echo", source: "env" },
  { name: "openrouter", kind: "openai_compat", model: "auto" },
];

describe("expandRows", () => {
  it("expands one row per model, provider default for model-less rows", () => {
    const rows = expandRows(providers);
    assert.equal(rows.length, 6); // 2 + 2 + 1 (echo) + 1 (openrouter)
    assert.deepEqual(
      rows.filter((r) => r.provider === "lmstudio.local").map((r) => r.model),
      ["qwen", "deepseek-r1"]
    );
    const echo = rows.find((r) => r.provider === "echo");
    assert.equal(echo?.isDefault, true);
    assert.equal(echo?.model, "");
    const orr = rows.find((r) => r.provider === "openrouter");
    assert.equal(orr?.label, "openrouter · auto");
  });
});

describe("pickerRows", () => {
  it("favorites first, tail deduped", () => {
    const { favorites, rows } = pickerRows(providers, [
      { provider: "acp.devin", model: "sonnet" },
    ]);
    assert.equal(favorites.length, 1);
    assert.equal(favorites[0].model, "sonnet");
    assert.equal(
      rows.some((r) => r.provider === "acp.devin" && r.model === "sonnet"),
      false
    );
  });

  it("favorite for an unknown provider still renders", () => {
    const { favorites } = pickerRows(providers, [
      { provider: "acp.offline", model: "gone" },
    ]);
    assert.equal(favorites[0].label, "gone");
  });

  it("filter matches provider, model, and provider:model", () => {
    assert.equal(pickerRows(providers, [], "devin").rows.length, 2);
    assert.equal(pickerRows(providers, [], "opus").rows.length, 1);
    assert.equal(pickerRows(providers, [], "acp.devin:sonnet").rows.length, 1);
    assert.equal(pickerRows(providers, [], "zzz").rows.length, 0);
  });
});

describe("groupRows", () => {
  it("groups by provider preserving order", () => {
    const groups = groupRows(expandRows(providers));
    assert.deepEqual(
      groups.map((g) => g.provider),
      ["lmstudio.local", "acp.devin", "echo", "openrouter"]
    );
    assert.equal(groups[1].rows.length, 2);
  });
});

describe("parseFreeId", () => {
  it("provider:model splits on the first colon", () => {
    assert.deepEqual(parseFreeId("acp.devin:opus", providers), {
      provider: "acp.devin",
      model: "opus",
    });
    assert.deepEqual(parseFreeId("acp.devin:", providers), {
      provider: "acp.devin",
      model: "",
    });
  });

  it("bare provider name = provider default", () => {
    assert.deepEqual(parseFreeId("echo", providers), { provider: "echo", model: "" });
  });

  it("bare model id resolves its single owner", () => {
    assert.deepEqual(parseFreeId("deepseek-r1", providers), {
      provider: "lmstudio.local",
      model: "deepseek-r1",
    });
  });

  it("unambiguous-free ids fall back to the current provider or empty", () => {
    assert.deepEqual(parseFreeId("custom-id", providers, "echo"), {
      provider: "echo",
      model: "custom-id",
    });
    assert.deepEqual(parseFreeId("custom-id", providers), { provider: "", model: "custom-id" });
  });

  it("empty input returns null", () => {
    assert.equal(parseFreeId("   ", providers), null);
  });
});

describe("picksEqual", () => {
  it("compares provider+model loosely", () => {
    assert.equal(picksEqual({ provider: "a", model: "" }, { provider: "a" }), true);
    assert.equal(picksEqual(null, { provider: "", model: "" }), true);
    assert.equal(picksEqual({ provider: "a", model: "m" }, { provider: "a", model: "n" }), false);
  });
});
