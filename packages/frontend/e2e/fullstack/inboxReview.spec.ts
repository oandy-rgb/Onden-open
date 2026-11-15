import { test, expect } from "@playwright/test";
import { createAgent, ready, requireAdmin, openNoteDecisions } from "./helpers";

// D7 governance review, end to end through the real UI. An AGENT (bearer token)
// makes a change → it appears in the Inbox pane's review section → the human
// approves (keeps) or rejects (inverse-undo). Desktop sidebar surface, so this
// runs on chromium only (the config keeps non-UI specs off the other engines).

async function agentHeaders(page: import("@playwright/test").Page, name: string) {
  // An AI role that edits directly (「直接編輯」): its changes land and come to the inbox for review; a new agent would only suggest (2026-10-30).
  const agent = await createAgent(page.request, name, { reviewRule: "apply" });
  return { actorId: agent.id, headers: agent.headers };
}

test.describe("inbox governance review (D7)", () => {
  test("an agent change appears in the review queue and Approve clears it", async ({ page }) => {
    const stamp = Date.now();
    const agentH = await agentHeaders(page, `E2E Agent ${stamp}`);
    requireAdmin(!!agentH, "actor creation needs admin; skipped");
    // An agent change must go through the MCP tool surface — a bearer token is
    // an MCP credential and is 403'd on /api/nodes (index.ts token_scope gate).
    const created = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `agent note ${stamp}`, markdown: "x" } } });
    expect(created.ok()).toBeTruthy();

    await ready(page);
    await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
    const row = await openNoteDecisions(page, `agent note ${stamp}`);
    const item = page.locator(".inbox-review-item").first();
    await item.locator(".inbox-review-approve").click();
    await expect(page.locator(".inbox-review-item")).toHaveCount(0); // approved → decided
    await page.locator('.sidebar-tab:has-text("Inbox")').click();
    await expect(row).toHaveCount(0); // left 「等你決定」
  });

  test("Reject inverse-undoes the agent change (node soft-deleted)", async ({ page }) => {
    const stamp = Date.now();
    const agentH = await agentHeaders(page, `E2E Agent2 ${stamp}`);
    requireAdmin(!!agentH, "actor creation needs admin; skipped");
    // Agent change via the MCP tool surface (bearer is 403'd on /api/nodes).
    const createRes = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `reject me ${stamp}`, markdown: "x" } } });
    expect(createRes.ok()).toBeTruthy();
    const node = (await createRes.json()).result as { id: string };

    await ready(page);
    await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
    await openNoteDecisions(page, `reject me ${stamp}`);
    await page.locator(".inbox-review-item").first().locator(".inbox-review-reject").click();
    await expect(page.locator(".inbox-review-item")).toHaveCount(0); // rejected → decided

    // inverse-undo: the agent's NODE_CREATED is reverted, so the node is gone.
    await expect.poll(async () => {
      const r = await page.request.get("/api/bootstrap");
      const b = r.ok() ? await r.json() : {};
      return (b.nodes ?? []).some((n: { id: string }) => n.id === node.id);
    }, { timeout: 10_000 }).toBeFalsy();
  });
});
