// Feature-audit deepening (2026-10-07): COL-02 — saved-view config: multi-column
// sort, compound filters, partial PATCH keeps other settings, UI builder,
// offline edit and rejected PATCH, phone viewport.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). The expected row orders are
// computed from the rules, not copied from a run: collectionViewQuery.ts (typed sorts, a missing value last, `n.id ASC` as the
// last key of a sorted view, title then id when no sort is set) and services/filter (filters compose with AND).
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";
import { contextsClosedAfterEach, clickableSize } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

type Seed = { t: string; status: string; score: number | null; id: string };
type Sort = { field: string; dir: "asc" | "desc" };

/** Rows of the seed in the order a sort list gives them: each key in turn, a missing value last, then the id (the view's last key). */
const orderBy = (rows: Seed[], keys: Array<(r: Seed) => number | string | null>, dirs: Array<"asc" | "desc">) =>
  rows.slice().sort((a, b) => {
    for (const [i, key] of keys.entries()) {
      const [x, y] = [key(a), key(b)];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return dirs[i] === "desc" ? -c : c;
    }
    return a.id < b.id ? -1 : 1;
  }).map((r) => r.t).join("");

async function setUp(page: Page) {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C02T${stamp}`, fields: [
    { name: "status", type: "select", options: ["todo", "doing", "done"] },
    { name: "score", type: "number" },
  ] } })).json();
  const seed: Seed[] = [];
  for (const [t, status, score] of [["A", "todo", 3], ["B", "todo", 10], ["C", "doing", 7], ["D", "done", 1], ["E", "todo", null], ["F", "doing", 7]] as const) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    await page.request.put(`/api/nodes/${n.id}/attributes/status`, { ...H, data: { value: status, value_type: "text" } });
    if (score !== null) await page.request.put(`/api/nodes/${n.id}/attributes/score`, { ...H, data: { value: String(score), value_type: "number" } });
    seed.push({ t, status, score, id: n.id });
  }
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "V1", layout: "table", visible_fields: ["title", "status", "score"] } })).json();
  const vPath = `/api/tags/${tag.id}/views/${view.id}`;
  const exec = async () => ((await (await page.request.get(`${vPath}/exec`)).json()).rows as { title: string }[]).map((r) => r.title[0]).join("");
  const getView = async () => ((await (await page.request.get(`/api/tags/${tag.id}/views`)).json()).views as Record<string, unknown>[]).find((v) => v.id === view.id)!;
  const patch = async (data: unknown) => (await page.request.patch(vPath, { ...H, data })).status();
  return { stamp, tag, seed, view, vPath, exec, getView, patch };
}

// The builder is an item of the view's 「View options」 menu (CollectionView), not a toolbar button of its own.
const openBuilder = async (p: Page, tagId: string) => {
  await ready(p, `/?view=notes&node=${tagId}`);
  await openSavedViewTab(p);
  await expect(p.locator(".cv-table")).toBeVisible();
  await p.getByRole("button", { name: "View options", exact: true }).click();
  await p.getByRole("menuitem", { name: "Filter, sort and group this view", exact: true }).click();
  await expect(p.locator(".cv-builder")).toBeVisible();
};
const tableOrder = async (p: Page) => (await p.locator(".cv-table tbody tr .cv-table-title").allInnerTexts()).map((t) => t[0]).join("");
const sortGroup = (p: Page) => p.locator(".cv-builder-group").nth(1);
const filterGroup = (p: Page) => p.locator(".cv-builder-group").nth(0);
const uiSorts = async (p: Page): Promise<Sort[]> => {
  const rows = sortGroup(p).locator(".cv-builder-row");
  return Promise.all((await rows.all()).map(async (r) => ({ field: await r.locator("select").first().inputValue(), dir: (await r.locator("select").nth(1).inputValue()) as "asc" | "desc" })));
};

test.describe("COL-02: saved-view config", () => {
  test.setTimeout(180_000);

  test("API: multi-sort, compound filter, partial PATCH, rejections; UI builder; offline; phone", async ({ page, browser }) => {
    const { stamp, seed, tag, view, exec, getView, patch } = await setUp(page);
    const by = (keys: Array<(r: Seed) => number | string | null>, dirs: Array<"asc" | "desc">, keep: (r: Seed) => boolean = () => true) =>
      orderBy(seed.filter(keep), keys, dirs);
    const status = (r: Seed) => r.status;
    const score = (r: Seed) => r.score; // typed numeric: 10 sorts after 3 only as text; the rule says number columns sort by value
    const title = (r: Seed) => r.t;

    // API: multi-sort status asc, score desc (score is typed numeric: 10 before 3, a missing score last; select sorts by its text).
    expect(await patch({ sorts: [{ field: "status", dir: "asc" }, { field: "score", dir: "desc" }] })).toBe(200);
    expect(await exec()).toBe(by([status, score], ["asc", "desc"]));
    expect(by([status, score], ["asc", "desc"]).slice(2)).toBe(["D", "B", "A", "E"].join("")); // the rule worked out by hand: done, then todo 10 / 3 / none
    expect(await patch({ sorts: [{ field: "score", dir: "desc" }, { field: "title", dir: "desc" }] })).toBe(200);
    expect(await exec()).toBe("BFCADE"); // 10, then 7 with the title tie-break descending (F before C), 3, 1, no score last
    // Compound filter (AND): status ne done AND score nempty AND title contains the stamp.
    expect(await patch({ filters: [{ field: "status", op: "ne", value: "done" }, { field: "score", op: "nempty" }, { field: "title", op: "contains", value: String(stamp) }] })).toBe(200);
    expect(await exec()).toBe("BFCA"); // not D (done), not E (no score); the sorts of the previous PATCH stay
    expect(await patch({ filters: [{ field: "score", op: "gt", value: "5" }, { field: "status", op: "eq", value: "doing" }] })).toBe(200);
    expect(await exec()).toBe("FC");
    // Partial PATCH must not reset other keys (tagViews.ts viewPatchSchema: defaults belong only to creation; COL-02 in full-feature-audit.md).
    expect(await patch({ layout: "kanban" })).toBe(200);
    expect(await patch({ pin_order: 3 })).toBe(200);
    const kept = await getView();
    expect(kept.layout).toBe("kanban");
    expect(kept.sorts).toEqual([{ field: "score", dir: "desc" }, { field: "title", dir: "desc" }]);
    expect(kept.filters).toEqual([{ field: "score", op: "gt", value: "5" }, { field: "status", op: "eq", value: "doing" }]);
    expect(kept.visible_fields).toEqual(["title", "status", "score"]);
    expect(kept.pin_order).toBe(3);
    // Rejections: an op, layout or sort direction the server does not know is a 400 (zod enums in tagViews.ts).
    expect(await patch({ filters: [{ field: "status", op: "regex", value: "x" }] })).toBe(400);
    expect(await patch({ layout: "pivot" })).toBe(400);
    expect(await patch({ sorts: [{ field: "title", dir: "sideways" }] })).toBe(400);
    // A sort by a field nobody has: accepted, and it sorts by that attribute (missing → last), so the rows stay and nothing breaks
    // (nodeQuery.ts: 「any other field sorts by that node_attribute value (missing → last)」).
    expect(await patch({ sorts: [{ field: "no_such_field", dir: "asc" }] })).toBe(200);
    expect((await exec()).split("").sort().join("")).toBe("CF");
    expect((await getView()).layout).toBe("kanban"); // none of the refused PATCHes changed the layout
    // Reset for the UI part.
    expect(await patch({ layout: "table", filters: [], sorts: [] })).toBe(200);

    // ── UI builder ──────────────────────────────────────────────────────
    await openBuilder(page, tag.id);
    // No sort set: by title, then id (collectionViewQuery.ts, UNSORTED_ORDER_N).
    await expect.poll(() => tableOrder(page)).toBe(by([title], ["asc"]));
    await sortGroup(page).getByRole("button", { name: "Add sort" }).click();
    await sortGroup(page).locator(".cv-builder-row").nth(0).locator("select").first().selectOption("status");
    await sortGroup(page).getByRole("button", { name: "Add sort" }).click();
    await sortGroup(page).locator(".cv-builder-row").nth(1).locator("select").first().selectOption("score");
    await sortGroup(page).locator(".cv-builder-row").nth(1).locator("select").nth(1).selectOption("desc");
    await expect.poll(async () => (await getView()).sorts, { timeout: 10_000 }).toEqual([{ field: "status", dir: "asc" }, { field: "score", dir: "desc" }]);
    await expect.poll(() => tableOrder(page)).toBe(by([status, score], ["asc", "desc"]));

    // Compound filter via UI: status is not done + score is not empty.
    await filterGroup(page).getByRole("button", { name: "Add filter" }).click();
    const f0 = filterGroup(page).locator(".cv-builder-row").nth(0);
    await f0.locator("select").first().selectOption("status");
    await f0.locator("select").nth(1).selectOption("ne");
    await f0.locator("input").fill("done");
    await filterGroup(page).getByRole("button", { name: "Add filter" }).click();
    const f1 = filterGroup(page).locator(".cv-builder-row").nth(1);
    await f1.locator("select").first().selectOption("score");
    await f1.locator("select").nth(1).selectOption("nempty");
    await expect.poll(async () => (await getView()).filters, { timeout: 10_000 }).toMatchObject([{ field: "status", op: "ne", value: "done" }, { field: "score", op: "nempty" }]);
    await expect.poll(() => tableOrder(page)).toBe(by([status, score], ["asc", "desc"], (r) => r.status !== "done" && r.score !== null));

    // Remove a filter and then a sort inside the 400 ms debounce: both changes must land, none may be lost (GAP-123, fixed 2026-10-10:
    // the builder sends every change of one debounce window together). Whether the two clicks share one window is a matter of timing,
    // so the check is the end state — on the server, in the builder, after a reload — not the number of PATCH requests.
    await f1.locator(".cv-builder-del").click();
    await sortGroup(page).locator(".cv-builder-row").nth(1).locator(".cv-builder-del").click();
    await expect.poll(async () => { const v = await getView(); return [(v.filters as unknown[]).length, (v.sorts as unknown[]).length]; }, { timeout: 10_000 }).toEqual([1, 1]);
    expect(await filterGroup(page).locator(".cv-builder-row").count()).toBe(1);
    expect(await sortGroup(page).locator(".cv-builder-row").count()).toBe(1);
    expect((await getView()).sorts).toEqual([{ field: "status", dir: "asc" }]);
    expect((await getView()).filters).toMatchObject([{ field: "status", op: "ne", value: "done" }]);
    await page.reload();
    await openBuilder(page, tag.id);
    expect(await filterGroup(page).locator(".cv-builder-row").count()).toBe(1);
    expect(await sortGroup(page).locator(".cv-builder-row").count()).toBe(1);

    // Rejected PATCH (503): the server is unchanged while it answers 503, and once the network is back the server and the builder agree.
    const before503 = JSON.stringify(await getView());
    const viewUrl = `**/api/tags/${tag.id}/views/${view.id}`;
    await page.route(viewUrl, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
    const refused = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/views/${view.id}`) && r.status() === 503);
    await sortGroup(page).getByRole("button", { name: "Add sort" }).click();
    await refused;
    expect(JSON.stringify(await getView())).toBe(before503);
    await page.unroute(viewUrl);
    await sortGroup(page).locator(".cv-builder-row").first().locator("select").nth(1).selectOption("desc");
    // After the retry the server's first sort is the one the person just changed (viewWriter.ts: a change is replayed in order per view; the
    // whole `sorts` list is sent each time, so a later change completes an earlier one), and the builder shows what the server holds.
    const changed = { field: "status", dir: "desc" };
    await expect.poll(async () => ((await getView()).sorts as Sort[])[0], { timeout: 20_000 }).toEqual(changed);
    await expect.poll(async () => (await uiSorts(page))[0], { timeout: 20_000 }).toEqual(changed);
    await expect(page.locator(".cv-builder-status")).toHaveText("");

    // Offline edit: the change is saved on this device (a queued save is never called saved: queuedWriteMessage) and replayed when the
    // connection returns.
    const nowSorts = (await getView()).sorts as Sort[];
    await expect.poll(async () => (await uiSorts(page)).length).toBe(nowSorts.length);
    await page.context().setOffline(true);
    await sortGroup(page).locator(".cv-builder-row").last().locator(".cv-builder-del").click();
    await expect(page.locator(".cv-builder-status")).toHaveText("Saved on this device — it will sync when the server is reachable.");
    expect(await sortGroup(page).locator(".cv-builder-row").count()).toBe(nowSorts.length - 1);
    expect((await getView()).sorts).toEqual(nowSorts); // not on the server yet (the API call goes through the page's own request context, which is not offline)
    await page.context().setOffline(false);
    const afterOffline = nowSorts.slice(0, -1);
    await expect.poll(async () => (await getView()).sorts, { timeout: 30_000 }).toEqual(afterOffline);
    expect(await sortGroup(page).locator(".cv-builder-row").count()).toBe(afterOffline.length);
    await expect(page.locator(".cv-builder-status")).toHaveText(""); // synced: nothing left to say
    await page.reload();
    await openBuilder(page, tag.id);
    expect(await sortGroup(page).locator(".cv-builder-row").count()).toBe(afterOffline.length);

    // Phone viewport: the builder and the table stay inside the screen, and nothing makes the page wider (COL-02 in full-feature-audit.md: 390px 無溢出).
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
    const pp = await phone.newPage();
    await openBuilder(pp, tag.id);
    expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const selector of [".view-tabs", ".cv-builder", ".cv-table-wrap"]) {
      const box = await pp.locator(selector).first().boundingBox();
      expect(box!.x, selector).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, selector).toBeLessThanOrEqual(390 + 1);
    }
    // layout-audit R7 / `--ac-tap`: a button a finger must hit is 44px on a phone.
    expect((await clickableSize(sortGroup(pp).getByRole("button", { name: "Add sort" }))).h).toBeGreaterThanOrEqual(44);
    await phone.close();
  });

  // FINDING: a view-settings change that the server answers 503 is queued (viewWriter.ts: 「accepted by the server or durably queued
  // (offline / transient failure) and replayed」; GAP-124 「503／離線會持久排隊並重播」) and so must be told like the offline one:
  // 「Saved on this device — it will sync when the server is reachable.」 and the new row stays in the builder. What the app does
  // instead: the builder re-reads the server's unchanged view right after the queued save, so the row that was just added is gone
  // again and the 「saved on this device」 line is cleared with it; the person sees neither the change nor any word about it.
  test("FINDING: a 503 on a view setting shows 'saved on this device' and keeps the added sort row", async ({ page }) => {
    test.fail();
    const { tag, view } = await setUp(page);
    await openBuilder(page, tag.id);
    const viewUrl = `**/api/tags/${tag.id}/views/${view.id}`;
    await page.route(viewUrl, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
    let refused503 = 0;
    page.on("response", (r) => { if (r.request().method() === "PATCH" && r.url().endsWith(`/views/${view.id}`) && r.status() === 503) refused503++; });
    await sortGroup(page).getByRole("button", { name: "Add sort" }).click();
    // The builder re-reads the view right after the queued save; how long that takes depends on how busy the server is, so wait for the
    // queue's own retry (the second 503, a couple of seconds later): the re-read was sent before it, and the server answers in order.
    await expect.poll(() => refused503, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".cv-builder-status")).not.toHaveText("Saving…"); // the write has been dealt with: queued, not still in flight
    await expect(sortGroup(page).locator(".cv-builder-row")).toHaveCount(1);
    await expect(page.locator(".cv-builder-status")).toHaveText("Saved on this device — it will sync when the server is reachable.");
  });
});
