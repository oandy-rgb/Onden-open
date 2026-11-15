import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createAgent, ready, openQuickCapture, BASE, saveQuickCapture } from "./helpers";

// Realtime track, end to end through nginx (which must NOT buffer the SSE
// stream — this suite is the regression net for that): two browser contexts on
// the SAME account; what one does, the other sees WITHOUT a manual refresh.
//
// 1 — the money test: A creates a note through the real UI; B's UI reflects it
//     (sidebar search results derive from B's in-memory store, fed by the
//     blind tick → /api/sync?since pull). No reload anywhere.
// 2 — instant effects: an agent's publishSite request (an outbox
//     pending_approval row) surfaces as a held card in B's ALREADY-OPEN inbox
//     (effects tick → approvals refetch), and approving it completes the
//     publish promptly (immediate drain, no reconciler-tick wait).
//
// Rerun-safe: every fixture title carries a per-test stamp.
const STATE = process.env.E2E_STORAGE || "/tmp/pw-auth.json";

async function twoSessions(browser: import("@playwright/test").Browser): Promise<{
  ctxA: BrowserContext; pageA: Page; ctxB: BrowserContext; pageB: Page;
}> {
  const ctxA = await browser.newContext({ baseURL: BASE, storageState: STATE });
  const ctxB = await browser.newContext({ baseURL: BASE, storageState: STATE });
  return { ctxA, pageA: await ctxA.newPage(), ctxB, pageB: await ctxB.newPage() };
}

test("a note created in context A appears in context B without a refresh", async ({ browser }) => {
  const { ctxA, pageA, ctxB, pageB } = await twoSessions(browser);
  try {
    const stamp = Date.now();
    const title = `LiveSync ${stamp}`;

    // B is just sitting there, watching its inbox: a capture lands there
    // (modules/capture), and the list derives from B's client-side store. (The
    // sidebar search asks the server once per query since 7ae4e4e0, so it is
    // no live view.)
    await ready(pageB);
    await pageB.locator('.sidebar-tab:has-text("Inbox")').click();
    const inboxB = pageB.getByRole("region", { name: "Inbox", exact: true });
    await expect(inboxB).toBeVisible();
    const hit = inboxB.getByText(title, { exact: true });
    await expect(hit).toHaveCount(0);

    // A creates the note through the real UI (quick capture).
    await ready(pageA);
    await openQuickCapture(pageA);
    await pageA.locator(".quick-capture-textarea").fill(title);
    await saveQuickCapture(pageA); // stays open for the next thought; closed after "Saved to …"

    // B sees it — no reload, no navigation; the SSE tick pulled the delta in.
    // Generous timeout: tick coalescing (~250ms) + sync round-trip, with slack.
    await expect(hit).toBeVisible({ timeout: 20_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("a held agent effect surfaces in an open inbox and runs promptly on approve", async ({ browser }) => {
  const { ctxA, pageA, ctxB, pageB } = await twoSessions(browser);
  try {
    const stamp = Date.now();
    // The agent first: adding it to 共用 changes that space's members, and an
    // open app answers with its membership check (.membership-gate) — not
    // what this test watches for.
    const { headers: agentHeaders } = await createAgent(pageA.request, `E2E LiveAgent ${stamp}`);

    // B opens the Inbox FIRST and leaves it open — the held card must arrive
    // via the effects tick, not via a navigation-triggered reload.
    await ready(pageB);
    await pageB.locator('.sidebar-tab:has-text("Inbox")').click();
    // The inbox has loaded (its region is there) — everything that arrives
    // after this is the SSE/effects tick.
    await expect(pageB.getByRole("region", { name: "Inbox", exact: true })).toBeVisible();

    // The agent proposes a tag pack → an outbox row is HELD as
    // pending_approval; nothing installs yet. (A site deploy was the held
    // request here; no token carries publishSite since 2026-10-22.)
    const name = `LiveHeld${stamp}`;
    const held = await pageA.request.post("/api/mcp/tools/proposeTagPack", {
      headers: agentHeaders, data: { args: { name, fields: [{ name: "rating", type: "number" }] } },
    });
    expect(held.ok(), await held.text()).toBeTruthy();
    expect(((await held.json()).result as { status: string }).status).toBe("pending_approval");

    // The card appears in B's already-open inbox WITHOUT any refresh.
    const card = pageB.locator(".inbox-review-item-held", { hasText: `Install tag pack #${name}` });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Approve → the toast flips immediately and the effect actually performs
    // promptly (immediate post-approval drain, not a reconciler-tick wait):
    // the pack's tag exists fast.
    await card.locator(".inbox-review-approve").click();
    await expect(pageB.getByText("Approved — running now")).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => {
      const tags = await (await pageB.request.get("/api/tags")).json();
      return ((tags.tags ?? tags) as Array<{ name: string }>).some((t) => t.name === name);
    }, { timeout: 10_000 }).toBe(true);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
