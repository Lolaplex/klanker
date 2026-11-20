import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Mobile dashboard flows against a stubbed relay (klanker#56). Every /v1/*
 * + /health call is answered by a page.route fixture so the suite runs the
 * real built UI with zero backend — the same contract agents-relay serves.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function stubRelay(page: Page, opts: { pending?: unknown[] } = {}) {
  const pending = opts.pending ?? [];
  const fulfill = async (route: Route, body: unknown, status = 200) =>
    route.fulfill(json(body, status));

  await page.route("**/health", (route) =>
    fulfill(route, { ok: true, version: "9.9.9" })
  );
  await page.route("**/v1/auth/status", (route) =>
    fulfill(route, { enabled: false, authenticated: true, user: "e2e" })
  );
  await page.route("**/v1/remotes**", (route) =>
    route.request().method() === "GET" ? fulfill(route, { remotes: [] }) : fulfill(route, { ok: true })
  );
  await page.route("**/v1/workspaces", (route) =>
    route.request().method() === "GET"
      ? fulfill(route, { workspaces: [{ id: "default", label: "default" }] })
      : fulfill(route, { workspace: { id: "default" } })
  );
  await page.route("**/v1/personas**", (route) =>
    fulfill(route, { personas: [{ id: "default", name: "default" }] })
  );
  await page.route("**/v1/workspaces/*/personas/*/sessions", (route) =>
    fulfill(route, { sessions: [] })
  );
  await page.route("**/v1/workspaces/*/personas/*/sessions/*", (route) =>
    fulfill(route, { events: [] })
  );
  await page.route("**/v1/approvals**", (route) => {
    if (route.request().method() === "POST") return fulfill(route, { ok: true });
    return fulfill(route, { approvals: pending });
  });
  await page.route("**/v1/traces**", (route) => fulfill(route, { sessions: [] }));
  await page.route("**/v1/jobs**", (route) => fulfill(route, { jobs: [] }));
  await page.route("**/v1/klanker/**", (route) => fulfill(route, { ok: true }));
  await page.route("**/v1/runs/stream**", (route) =>
    route.fulfill({ status: 404, body: "no such running turn" })
  );
  await page.route("**/v1/chat/stop", (route) => fulfill(route, { ok: true }));
  await page.route("**/v1/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `data: {"type":"start","run":"r1"}\n\n` +
        `data: {"type":"delta","text":"hello "}\n\n` +
        `data: {"type":"delta","text":"from relay"}\n\n` +
        `data: {"type":"trailer","session":"ses_e2e","returncode":0}\n\n`,
    })
  );
}

test.beforeEach(async ({ page }) => {
  await stubRelay(page);
});

test("app shell renders + chat send/receive streams reply", async ({ page }) => {
  await page.goto("/");
  const input = page.getByPlaceholder(/Message .+\.\.\./);
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.tap();
  await input.pressSequentially("ping", { delay: 80 });
  await expect(input).toHaveValue("ping");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("ping", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("hello from relay")).toBeVisible({ timeout: 10_000 });
});

test("sidebar opens over chat on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder(/Message .+\.\.\./)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open navigation" }).tap();
  // KlankerList renders workspaces + personas in the drawer
  await expect(page.getByText("default").first()).toBeVisible({ timeout: 5_000 });
});

test("settings panel opens and cancels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder(/Message .+\.\.\./)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Settings", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Cancel" }).tap();
  await expect(page.getByRole("button", { name: "Save" })).toBeHidden();
});

test("pending approval renders Allow/Deny and resolves", async ({ page }) => {
  await stubRelay(page, {
    pending: [{ id: "ap1", summary: "run `rm -rf /tmp/x`", tool: "terminal" }],
  });
  await page.goto("/");
  await expect(page.getByText("Approval")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("run `rm -rf /tmp/x`")).toBeVisible();
  const posted = page.waitForRequest("**/v1/approvals/ap1");
  await page.getByRole("button", { name: "Allow" }).tap();
  await posted;
});
