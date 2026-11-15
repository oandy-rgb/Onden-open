import { test, expect } from "@playwright/test";
import { ready, createAgent } from "./helpers";

// D7 approve-BEFORE-apply, end to end through the real UI. An agent proposes a
// tag pack via the MCP tool → NOTHING is installed; a held card appears in the
// Inbox ("Waiting for your approval") → the human approves (it installs,
// attributed to the agent) or rejects (it never installs). The agent has no
// publish tool: publishing is only the owner's own button. The risk-tier
// counterpart to inboxReview.spec.ts's apply-then-review flow.

/** Whether a root tag of this name exists (installed packs land at the root). */
async function tagInstalled(page: import("@playwright/test").Page, name: string): Promise<boolean> {
  const r = await page.request.get("/api/tags");
  const b = r.ok() ? await r.json() : [];
  const list: { name?: string; title?: string }[] = Array.isArray(b) ? b : b.tags ?? [];
  return list.some((t) => (t.name ?? t.title) === name);
}

test.describe("approve-before-apply gate (D7)", { tag: "@critical" }, () => {
  test("the agent has no publish tool; a tag pack proposal is HELD and reject means it never installs", async ({ page }) => {
    const stamp = Date.now();
    // createAgent fails loudly if the owner cannot make an agent (no silent skip).
    const agent = await createAgent(page.request, `E2E PackAgent ${stamp}`);

    const publish = await page.request.post("/api/mcp/tools/publishSite", { headers: agent.headers, data: { args: {} } });
    expect(publish.status()).toBe(404);

    const name = `e2epack${stamp}`;
    const res = await page.request.post("/api/mcp/tools/proposeTagPack", { headers: agent.headers, data: { args: { name, fields: [{ name: "due", type: "date" }] } } });
    expect(res.ok()).toBeTruthy();
    expect(((await res.json()).result as { status: string }).status).toBe("pending_approval");

    await ready(page);
    await page.locator('.sidebar-tab:has-text("Inbox")').click();
    const held = page.locator(".inbox-review-item-held", { hasText: `#${name}` });
    await expect(held).toBeVisible();
    await expect(held).toContainText("Hasn’t run yet");
    await page.screenshot({ path: "/tmp/pw-output/shots/approval-held-card.png" });

    await held.locator(".inbox-review-reject").click();
    await expect(held).toHaveCount(0); // decided → left the queue

    // It never ran. DELIBERATE waitForTimeout: this is a NEGATIVE assertion
    // against a background runner — there is no condition to await ("the
    // wrong thing didn't happen"); the sleep is the observation window.
    await page.waitForTimeout(2000); // give a would-be (wrong) run time to land
    expect(await tagInstalled(page, name)).toBe(false);
  });

  test("approve installs the pack", async ({ page }) => {
    const stamp = Date.now();
    const agent = await createAgent(page.request, `E2E PackAgent2 ${stamp}`);

    const name = `e2epackok${stamp}`;
    expect((await page.request.post("/api/mcp/tools/proposeTagPack", { headers: agent.headers, data: { args: { name } } })).ok()).toBeTruthy();

    await ready(page);
    await page.locator('.sidebar-tab:has-text("Inbox")').click();
    const held = page.locator(".inbox-review-item-held", { hasText: `#${name}` });
    await expect(held).toBeVisible();
    await held.locator(".inbox-review-approve").click();
    await expect(held).toHaveCount(0);

    await expect.poll(() => tagInstalled(page, name), { timeout: 15_000 }).toBe(true);
  });
});
