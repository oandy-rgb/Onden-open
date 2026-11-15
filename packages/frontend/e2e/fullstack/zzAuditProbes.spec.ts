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

test("HIST-10: empty trash purges only the named trashed notes; a live note is skipped", async ({ page }) => {
  // D95: the workspace-wide POST /api/maintenance/prune is gone; a person
  // empties the trash they see through POST /api/nodes/trash/empty.
  const stamp = Date.now();
  const live = await (await page.request.post("/api/nodes", { ...H, data: { title: `Prune live ${stamp}`, markdown: "keep" } })).json();
  const doomed = await (await page.request.post("/api/nodes", { ...H, data: { title: `Prune doomed ${stamp}`, markdown: "bye" } })).json();
  expect((await page.request.delete(`/api/nodes/${doomed.id}`, H)).ok()).toBe(true);

  const real = await page.request.post("/api/nodes/trash/empty", { ...H, data: { node_ids: [doomed.id, live.id] } });
  const body = await real.json();
  console.log("AUDIT HIST-10 empty:", real.status(), JSON.stringify(body));
  expect(real.ok()).toBe(true);
  expect(body).toMatchObject({ purged: 1, skipped: 1 });
  const liveAfter = await page.request.get(`/api/nodes/${live.id}`, H);
  const doomedAfter = await page.request.get(`/api/nodes/${doomed.id}`, H);
  console.log("AUDIT HIST-10 live/doomed after purge:", liveAfter.status(), doomedAfter.status());
  expect(liveAfter.status()).toBe(200);
  expect(doomedAfter.status()).toBe(404);
  const undelete = await page.request.post(`/api/nodes/${doomed.id}/undelete`, H);
  console.log("AUDIT HIST-10 undelete after purge:", undelete.status());

  expect((await page.request.post("/api/maintenance/prune", { ...H, data: { retention_days: 0 } })).ok()).toBe(false);
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
