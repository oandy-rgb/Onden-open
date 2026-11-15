import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// Long-running / stability (#11). Sustained interaction in one session must not
// throw uncaught errors, leak the DOM unboundedly, or wedge the UI. Single
// engine (chromium) — this is about endurance over time, not engine coverage.
const ITERATIONS = 30;

test.describe("long-running stability", () => {
  test("sustained interaction: no JS errors, DOM stays bounded, UI stays live", async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // History left the lens strip (7795c3e) and so did Table (#486); churn
    // Content ⇄ Canvas on a parent note instead, which still mounts/unmounts a
    // whole lens pane. The whiteboard is a view tab the note has (added from
    // the tab row's ＋, docs/architecture/canvas-as-view.md) — having children
    // no longer earns one — so give it that tab; the board lays out the child.
    const parent = await (await page.request.post("/api/nodes", { ...H, data: { title: `soak parent ${Date.now()}`, markdown: "p" } })).json();
    await page.request.post("/api/nodes", { ...H, data: { title: `soak child ${Date.now()}`, markdown: "c", parent_id: parent.id } });
    const view = await page.request.post(`/api/nodes/${parent.id}/views`, { ...H, data: { name: "Canvas", layout: "canvas", visible_fields: [] } });
    expect(view.ok(), await view.text()).toBeTruthy();
    await ready(page, `/?view=notes&node=${parent.id}`);
    // Every page load runs the cold-start membership check (.membership-gate
    // over the workspace until it answers); churn starts once it has.
    const gate = page.locator(".membership-gate");
    await expect(gate).toHaveCount(0, { timeout: 45_000 });
    const domStart = await page.evaluate(() => document.querySelectorAll("*").length);

    for (let i = 0; i < ITERATIONS; i++) {
      // toggle the per-node lens (content ⇄ canvas) — the highest-churn UI
      // action
      // DELIBERATE waitForTimeout (×3): these are interaction PACING, not
      // condition waits — the soak's purpose is sustained human-speed churn,
      // so there is no app condition to await between the beats.
      await page.locator('.view-tabs [role=tab]:has-text("Canvas")').click({ timeout: 5_000 });
      await page.waitForTimeout(80);
      await page.locator('.view-tabs [role=tab]:has-text("Content")').click({ timeout: 5_000 });
      await page.waitForTimeout(80);
      // periodically create + open a node (new editor mounts/unmounts — a common
      // place for listener/observer leaks)
      if (i % 6 === 0) {
        const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `soak ${i} ${Date.now()}`, markdown: "s" } })).json();
        await page.goto(`/?view=notes&node=${n.id}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(120);
        await page.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "domcontentloaded" });
        // A cold boot of the whole app (as ready() allows for), not a click.
        await page.locator('.view-tabs [role=tab]:has-text("Canvas")').waitFor({ timeout: 45_000 });
        await expect(gate).toHaveCount(0, { timeout: 45_000 });
      }
    }

    const domEnd = await page.evaluate(() => document.querySelectorAll("*").length);

    // No uncaught exceptions over the whole run.
    expect(errors, `JS errors during soak: ${errors.join(" | ")}`).toEqual([]);
    // DOM may grow (more nodes exist) but must not balloon — a runaway count is
    // the signature of mount/unmount leaks. Generous bound to avoid flakiness.
    expect(domEnd, `DOM ballooned ${domStart}→${domEnd}`).toBeLessThan(domStart * 4 + 3000);

    // The UI is still live: a fresh interaction still drives the URL.
    await page.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "load" });
    await page.locator('.view-tabs [role=tab]:has-text("Canvas")').click();
    await expect(page).toHaveURL(/lens=canvas/);
  });
});
