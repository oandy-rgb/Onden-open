import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// REGRESSION [undelete-slug-conflict] — restoring a trashed node whose slug was
// re-taken by a newer live node used to 500 (the deleted_at→NULL flip re-entered
// the partial-unique slug index → 23505 unhandled), stranding the node in trash.
// The fix re-slugs the restored row inside retryOnSlugConflict, so undelete
// returns 200 and the node comes back (with a fresh, non-colliding slug).


test("undelete of a node whose slug was re-taken succeeds (no 500)", async ({ page }) => {
  await ready(page);
  const title = `Slugclash ${Date.now()}`;

  // 1) Create 'Foo', capturing its id + slug.
  const a = await page.request.post("/api/nodes", { ...H, data: { title, markdown: "first" } });
  expect(a.ok()).toBeTruthy();
  const first = await a.json();

  // 2) Trash it.
  const del = await page.request.delete(`/api/nodes/${first.id}`, H);
  expect(del.ok()).toBeTruthy();

  // 3) Create another note with the SAME title → it legitimately reuses the slug.
  const b = await page.request.post("/api/nodes", { ...H, data: { title, markdown: "second" } });
  expect(b.ok()).toBeTruthy();
  const second = await b.json();
  expect(second.slug).toBe(first.slug); // the freed slug got reused

  // 4) Undelete the trashed original — must NOT 500; it comes back re-slugged.
  const un = await page.request.post(`/api/nodes/${first.id}/undelete`, H);
  expect(un.status()).toBe(200);

  // Both nodes are now live with distinct slugs.
  const boot = await (await page.request.get("/api/bootstrap?bodies=none", H)).json();
  const live = (boot.nodes as Array<{ id: string; slug: string }>).filter(
    (n) => n.id === first.id || n.id === second.id,
  );
  expect(live).toHaveLength(2);
  expect(new Set(live.map((n) => n.slug)).size).toBe(2); // distinct slugs, no clash
});
