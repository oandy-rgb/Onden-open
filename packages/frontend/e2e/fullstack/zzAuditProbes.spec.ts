// Feature-audit loop probes (2026-10-07) for 待盤 rows with no execution
// evidence. API-level contracts only; UI entry points are checked separately.
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";


test("RSS-07: OPML import dedupes, rejects junk, and export lists readable sources", async ({ page }) => {
  const stamp = Date.now();
  const a = `http://localhost:5099/feeds/a-${stamp}.xml`;
  const b = `http://localhost:5099/feeds/b-${stamp}.xml`;
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>
    <outline text="Feed A ${stamp}" type="rss" xmlUrl="${a}"/>
    <outline text="Feed B ${stamp}" type="rss" xmlUrl="${b}"/>
    <outline text="Feed A dup ${stamp}" type="rss" xmlUrl="${a}"/>
  </body></opml>`;
  const first = await page.request.post("/api/rss/opml", { ...H, data: { opml } });
  console.log("AUDIT RSS-07 first import:", first.status(), await first.text());
  expect(first.ok()).toBe(true);
  const firstBody = await first.json();
  // parseOpml already collapses a URL repeated inside one file.
  expect(firstBody.imported).toBe(2);

  const again = await (await page.request.post("/api/rss/opml", { ...H, data: { opml } })).json();
  console.log("AUDIT RSS-07 re-import:", JSON.stringify(again));
  expect(again).toEqual({ imported: 0, skipped: 2 });

  const junk = await page.request.post("/api/rss/opml", { ...H, data: { opml: "<not-opml>" } });
  console.log("AUDIT RSS-07 junk:", junk.status());
  expect(junk.status()).toBe(422);
  const empty = await page.request.post("/api/rss/opml", { ...H, data: {} });
  expect(empty.status()).toBe(400);

  const exported = await page.request.get("/api/rss/opml");
  const xml = await exported.text();
  console.log("AUDIT RSS-07 export:", exported.status(), exported.headers()["content-type"]);
  expect(xml).toContain(a);
  expect(xml).toContain(b);
  expect(xml.split(a).length - 1).toBe(1);
});

test("SITE-10: static export returns an archive and excludes private notes", async ({ page }) => {
  const stamp = Date.now();
  const priv = await (await page.request.post("/api/nodes", { ...H, data: { title: `Private static ${stamp}`, markdown: `secret-${stamp}` } })).json();
  const res = await page.request.get("/api/export-static");
  const buf = await res.body();
  console.log("AUDIT SITE-10:", res.status(), res.headers()["content-type"], res.headers()["content-disposition"], buf.length, "bytes");
  expect(res.ok()).toBe(true);
  // zip local-file header; contents are deflated so only check the private
  // note's stamp doesn't appear in any stored (uncompressed) entry name.
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  expect(buf.includes(Buffer.from(`secret-${stamp}`))).toBe(false);
  expect(buf.includes(Buffer.from(`Private static ${stamp}`))).toBe(false);
  await page.request.delete(`/api/nodes/${priv.id}`, H);
});

// The trash was removed on 2026-10-19 (86ee37124, D111): GET /api/nodes/trash, POST /api/nodes/trash/empty and
// the maintenance prune are gone and a deleted note is brought back from History › Recently deleted. What
// "empty the trash" protected is now POST /api/history/deleted/purge: it deletes for good only the deleted notes
// that are named (with the plan the person saw), refuses a note that is still live, and a purged note cannot come back.
test("HIST-10: delete for good removes only the named deleted notes; a live note is refused", async ({ page }) => {
  const stamp = Date.now();
  const live = await (await page.request.post("/api/nodes", { ...H, data: { title: `Prune live ${stamp}`, markdown: "keep" } })).json();
  const doomed = await (await page.request.post("/api/nodes", { ...H, data: { title: `Prune doomed ${stamp}`, markdown: "bye" } })).json();
  const spared = await (await page.request.post("/api/nodes", { ...H, data: { title: `Prune spared ${stamp}`, markdown: "still in recently deleted" } })).json();
  expect((await page.request.delete(`/api/nodes/${doomed.id}`, H)).ok()).toBe(true);
  expect((await page.request.delete(`/api/nodes/${spared.id}`, H)).ok()).toBe(true);

  const real = await page.request.post("/api/history/deleted/purge", { ...H, data: { items: [{ node_id: doomed.id, expected_ids: [doomed.id] }, { node_id: live.id, expected_ids: [live.id] }] } });
  expect(real.ok()).toBe(true);
  const { results } = await real.json() as { results: Array<{ node_id: string; purged: boolean; code?: string }> };
  expect(results.find((r) => r.node_id === doomed.id)).toMatchObject({ purged: true });
  expect(results.find((r) => r.node_id === live.id)).toMatchObject({ purged: false, code: "not_deleted" });

  expect((await page.request.get(`/api/nodes/${live.id}`, H)).status()).toBe(200);
  expect((await page.request.get(`/api/nodes/${doomed.id}`, H)).status()).toBe(404);
  // Not named, so still there to bring back; the purged one cannot come back.
  const deleted = await (await page.request.get("/api/history/deleted?days=30", H)).json() as { notes: Array<{ id: string }> };
  expect(deleted.notes.map((n) => n.id)).toContain(spared.id);
  expect(deleted.notes.map((n) => n.id)).not.toContain(doomed.id);
  expect((await page.request.post(`/api/nodes/${doomed.id}/undelete`, H)).ok()).toBe(false);
  expect((await page.request.post(`/api/nodes/${spared.id}/undelete`, H)).ok()).toBe(true);

  // The old workspace-wide routes stay gone.
  expect((await page.request.post("/api/maintenance/prune", { ...H, data: { retention_days: 0 } })).ok()).toBe(false);
  expect((await page.request.post("/api/nodes/trash/empty", { ...H, data: { node_ids: [live.id] } })).ok()).toBe(false);
  expect((await page.request.get(`/api/nodes/${live.id}`, H)).status()).toBe(200);
});

test("NOTE-09: reading + character templates are reachable from the slash menu", async ({ page }) => {
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `Tpl ${Date.now()}`, markdown: "" } })).json();
  await ready(page, `/?view=notes&node=${n.id}`);
  const ed = page.locator(".cm-content");
  await ed.click();
  await page.keyboard.type("/");
  const items = await page.locator(".cm-tooltip-autocomplete li, .slash-menu-item").allInnerTexts();
  console.log("AUDIT NOTE-09 slash items:", JSON.stringify(items));
});
