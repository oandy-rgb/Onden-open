// Journey [offline-organize] — the "tidy up the day's captures while the
// train's in a tunnel" workflow. Seed a few notes online, lose signal, then
// ORGANIZE them offline: set an inline attribute on each (the durable,
// real-UI offline path — a body edit derives node_attributes server-side via
// the queued PATCH), and rename one. On reconnect every change must converge
// and the queue must drain to zero.
//
// Scope note: explicit tag-junction application (PUT /api/nodes/:id/tags/:id)
// is NOT an offline-durable UI path today — the inspector's tag toggles call
// the raw `api()` (no queue), so they throw offline. Asserting tag application
// here would assert a non-feature. The offline-durable organize surface is the
// body edit (inline `key:: value` attributes + frontmatter), which is exactly
// what this exercises. (See offlineCommuteCapture.spec.ts for the same honest
// framing around offline task creation.)
//
// Offline simulation + server-truth reads follow syncStatus.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { ready, H, expectNoPending, expectOffline, expectOnline, expectPending } from "./helpers";
import type { BrowserContext } from "@playwright/test";


async function bootstrap(page: Page) {
  return (await page.request.get("/api/bootstrap")).json();
}

async function fetchAttr(page: Page, nodeId: string, key: string): Promise<string | null> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return null;
  const attrs = (await res.json()) as Array<{ key: string; value: string }>;
  return attrs.find((a) => a.key === key)?.value ?? null;
}

async function goOffline(page: Page, context: BrowserContext) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}

async function goOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnline(page);
}

test("offline organize: set inline attributes on several notes, all converge on reconnect", async ({ page, context }) => {
  const stamp = Date.now();
  // Seed two notes ONLINE — the things we'll organize offline.
  const a = await (await page.request.post("/api/nodes", { ...H, data: { title: `Organize A ${stamp}`, markdown: "# A\n\nbody a" } })).json();
  const b = await (await page.request.post("/api/nodes", { ...H, data: { title: `Organize B ${stamp}`, markdown: "# B\n\nbody b" } })).json();

  await ready(page, `/?view=notes&node=${a.id}`);
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await expectOnline(page);
  await expectNoPending(page);

  // ── Go offline, then organize ─────────────────────────────────────────────
  await goOffline(page, context);

  // Note A: append an inline attribute (priority) + a rename.
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(`\n\npriority:: high${stamp}`);
  await page.locator(".obsidian-title-input").fill(`Organize A renamed ${stamp}`);
  // Click into the body so the title autosave commits.
  await page.locator(".cm-content").click();
  await expectPending(page, { timeout: 10_000 });

  // Note B: switch to it WHILE OFFLINE via the app's own client-side router
  // (history pushState + popstate) — a full page.goto offline would hit the
  // SSR/auth shell, but an in-app node switch stays on the live SPA. Set a
  // different inline attribute.
  await page.evaluate((nodeId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("node", nodeId);
    window.history.pushState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, b.id);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Organize B ${stamp}`, { timeout: 10_000 });
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(`\n\nstatus:: review${stamp}`);
  await expectPending(page, { timeout: 10_000 });

  // ── Reconnect → every offline organize-edit drains ───────────────────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  // ── Server truth: attributes derived from the offline body edits + rename ─
  await expect.poll(() => fetchAttr(page, a.id, "priority"), { timeout: 15_000 }).toBe(`high${stamp}`);
  await expect.poll(() => fetchAttr(page, b.id, "status"), { timeout: 15_000 }).toBe(`review${stamp}`);

  const final = await bootstrap(page);
  const renamedA = final.nodes.find((n: { id: string }) => n.id === a.id);
  expect(renamedA?.title).toBe(`Organize A renamed ${stamp}`);

  // Queue fully drained — the bare dot, no pending count.
  await expectNoPending(page);
});
