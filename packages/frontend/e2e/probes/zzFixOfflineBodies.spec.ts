// Offline copy check (large workspace, slim mode): after boot the app downloads
// missing bodies in the background; offline, a note this browser never opened
// still opens with its text, and an offline cold start paints slim and opens it too.
import { test } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("offline bodies for never-opened notes", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `OffBody ${s}`, markdown: `offline body ${s}` } })).json();
  const batches: number[] = []; let last = Date.now();
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/bodies")) { batches.push((JSON.parse(r.postData() ?? "{}").ids ?? []).length); last = Date.now(); } });
  try {
    await ready(page, "/?view=notes");
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000 && (batches.length === 0 || Date.now() - last < 6000)) await page.waitForTimeout(1000);
    out.download = { batches: batches.length, ids: batches.reduce((a, b) => a + b, 0), seconds: Math.round((last - t0) / 1000) };
    await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.evaluate((id) => { history.pushState(null, "", `/?view=notes&node=${id}`); window.dispatchEvent(new PopStateEvent("popstate")); }, note.id);
    await page.waitForTimeout(3000);
    out.offlineOpen = { editor: await page.locator(".cm-content").first().innerText().catch(() => null), notDownloaded: await page.locator(".lazy-offline-pane").count() };
    // Offline cold start of the same note.
    await page.close();
    const p2 = await context.newPage();
    await p2.goto(`${BASE}/?view=notes&node=${note.id}`).catch(() => {});
    await p2.waitForTimeout(8000);
    out.offlineColdStart = { editor: await p2.locator(".cm-content").first().innerText().catch(() => null), lock: await p2.getByText("Unable to check your sign-in status").count(), gate: await p2.getByText("Checking your workspace").count() };
  } finally {
    await context.setOffline(false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("OFFBODIES " + JSON.stringify(out, null, 2));
  }
});
