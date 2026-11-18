// Feature-audit deepening (2026-10-07): COL-03 — saved-view table: real cell
// edits per field type, rejected/failed writes keep the draft, retry without
// duplicate rows (cell + quick-add row, incl. lost response), offline, phone.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). What changed since 2026-10-07 and is
// followed here: the table stores a cell by the column's schema type, not by what was typed (TableLayout.tsx); a number that is not
// one is refused in the table and never sent; a write the server answers 5xx is queued, not rejected (writeErrors.ts classifyWriteFailure,
// SyncStatus); the quick-add row creates a tagged note with ONE request (GAP-125, fixed 2026-10-10).
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, clearRecoveryCopies, BASE, H } from "./helpers";
import { contextsClosedAfterEach, clickableSize } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const QUEUED_5XX = "Still trying — your changes are safe on this device. The server answered with an error."; // components/SyncStatus.tsx

async function setUp(page: Page) {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C03T${stamp}`, fields: [
    { name: "status", type: "select", options: ["todo", "doing", "done"] },
    { name: "score", type: "number" },
    { name: "due", type: "date" },
    { name: "done", type: "boolean" },
    { name: "memo", type: "text" },
  ] } })).json();
  const ids: Record<string, string> = {};
  for (const t of ["Alpha", "Beta"]) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    ids[t] = n.id;
  }
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "T", layout: "table", visible_fields: ["title", "status", "score", "due", "done", "memo"] } })).json();
  const attr = async (id: string, k: string) => ((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).find((a) => a.key === k);
  const execRows = async () => ((await (await page.request.get(`/api/tags/${tag.id}/views/${view.id}/exec`)).json()).rows as { id: string; title: string }[]);
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts.push(`${r.url().split("/attributes/")[1]}=${JSON.parse(r.postData() ?? "{}").value}`); });

  const open = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-table")).toBeVisible();
  };
  const COL = { status: 1, score: 2, due: 3, done: 4, memo: 5 } as const;
  const cell = (p: Page, title: string, f: keyof typeof COL) =>
    p.locator(".cv-table tbody tr", { hasText: `${title} ${stamp}` }).locator("td").nth(COL[f]);
  const editCell = async (p: Page, title: string, f: keyof typeof COL, v: string, how: "Enter" | "blur") => {
    await cell(p, title, f).locator("button").click();
    const input = p.locator(".cv-table-cell-input");
    await input.fill(v);
    if (how === "Enter") await input.press("Enter"); else await p.locator(".view-tabs").click();
  };
  const nodesTitled = async (t: string) => {
    const b = await (await page.request.get("/api/bootstrap?bodies=none")).json();
    return ((b.nodes ?? []) as { title: string; deleted_at?: string | null }[]).filter((n) => n.title === t && !n.deleted_at).length;
  };
  return { stamp, tag, ids, view, attr, execRows, puts, open, cell, editCell, nodesTitled };
}

test.describe("COL-03: saved-view table", () => {
  test.setTimeout(260_000);

  test("cell edits per field type, failure keeps draft, retry no duplicate rows, offline, quick add, phone", async ({ page, browser }) => {
    const { stamp, tag, ids, view, attr, execRows, puts, open, cell, editCell, nodesTitled } = await setUp(page);
    await open(page);

    // Real edits through each field type. The column's schema field decides the stored type and a cell is saved once per commit
    // (TableLayout.tsx: 「Enter and blur only send once」; full-feature-audit.md COL-03).
    puts.length = 0;
    await editCell(page, "Alpha", "score", "42", "Enter");
    await expect.poll(async () => (await attr(ids.Alpha, "score"))?.value).toBe("42");
    expect((await attr(ids.Alpha, "score"))?.value_type).toBe("number");
    await expect(cell(page, "Alpha", "score")).toHaveText("42");
    expect(puts).toEqual(["score=42"]);
    puts.length = 0;
    await editCell(page, "Alpha", "memo", "hello", "blur");
    await expect.poll(async () => (await attr(ids.Alpha, "memo"))?.value).toBe("hello");
    expect(puts).toEqual(["memo=hello"]);
    await editCell(page, "Alpha", "status", "doing", "Enter");
    await expect.poll(async () => (await attr(ids.Alpha, "status"))?.value).toBe("doing");
    await editCell(page, "Alpha", "due", "2026-10-31", "Enter");
    await expect.poll(async () => (await attr(ids.Alpha, "due"))?.value).toBe("2026-10-31");
    expect((await attr(ids.Alpha, "due"))?.value_type).toBe("date");
    await editCell(page, "Alpha", "done", "true", "Enter");
    await expect.poll(async () => (await attr(ids.Alpha, "done"))?.value).toBe("true");
    expect((await attr(ids.Alpha, "done"))?.value_type).toBe("bool"); // markdown storageType("boolean")
    // A text field holding digits stays text: the schema field decides, the old guess from what was typed applies only to a key with
    // no field (TableLayout.tsx commit). The probe expected number — it was written before that rule.
    await editCell(page, "Beta", "memo", "123", "Enter");
    await expect.poll(async () => (await attr(ids.Beta, "memo"))?.value).toBe("123");
    expect((await attr(ids.Beta, "memo"))?.value_type).toBe("text");
    // pinned: today's behaviour, no written rule — the table offers one plain text input for every field type (select, date, boolean too).
    await cell(page, "Alpha", "status").locator("button").click();
    expect(await page.locator(".cv-table-cell-input").evaluate((el) => `${el.tagName} ${(el as HTMLInputElement).type}`)).toBe("INPUT text"); // pinned: today's behaviour, no written rule
    await page.locator(".cv-table-cell-input").press("Escape");
    await expect(page.locator(".cv-table-cell-input")).toHaveCount(0);

    // Rejected write (422): the error is said beside the table, the draft stays in the input, the server is unchanged
    // (TableLayout.tsx 「A refused value stays in the box with the error beside the table」; full-feature-audit.md COL-03/COL-05).
    await editCell(page, "Alpha", "status", "bogus", "Enter");
    await expect(page.locator(".cv-table-cell-error")).toHaveText('"status" must be one of: todo, doing, done');
    await expect(page.locator(".cv-table-cell-input")).toHaveValue("bogus");
    expect((await attr(ids.Alpha, "status"))?.value).toBe("doing");
    // Escape drops the draft: the cell shows the server's value again, and the refused text lives only in the recovery card
    // (FailedWriteRecovery keeps what a refusal could not save).
    await page.locator(".cv-table-cell-input").press("Escape");
    await expect(page.locator(".cv-table-cell-input")).toHaveCount(0);
    await expect(cell(page, "Alpha", "status")).toHaveText("doing");
    await expect(page.locator(".failed-write-recovery .fwr-content")).toHaveText("bogus");
    await expect(page.locator(".cv-table").getByText("bogus")).toHaveCount(0);
    // A number that is not one is refused in the table, said beside it, never sent, and the draft stays (TableLayout.tsx commit).
    puts.length = 0;
    await editCell(page, "Alpha", "score", "abc", "Enter");
    await expect(page.locator(".cv-table-cell-error")).toHaveText("Enter a number, like 1200 or 12.5.");
    await expect(page.locator(".cv-table-cell-input")).toHaveValue("abc");
    expect(puts).toEqual([]);
    expect((await attr(ids.Alpha, "score"))?.value).toBe("42");
    await page.locator(".cv-table-cell-input").press("Escape");
    // Only the server's refusal left a recovery card behind (the number was never sent). It would cover the view chips below, so clear it.
    expect(await clearRecoveryCopies(page)).toBe(1);

    // 503: the write is queued (writeErrors.ts classifyWriteFailure: any 5xx is retryable), said once by the sync status, the edit box
    // closes without an error, and the server has nothing yet. Then the person types it again: one value, one row per note.
    await page.route("**/api/nodes/*/attributes/*", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
    await editCell(page, "Beta", "score", "7", "Enter");
    await expect(page.getByText(QUEUED_5XX)).toHaveCount(1);
    await expect(page.locator(".cv-table-cell-input")).toHaveCount(0);
    await expect(page.locator(".cv-table-cell-error")).toHaveCount(0);
    expect((await attr(ids.Beta, "score"))?.value).toBeUndefined();
    await page.unroute("**/api/nodes/*/attributes/*");
    await editCell(page, "Beta", "score", "7", "Enter");
    await expect.poll(async () => (await attr(ids.Beta, "score"))?.value).toBe("7");
    await expect(cell(page, "Beta", "score")).toHaveText("7");
    // Landed: nothing is left waiting (a synced change says nothing), and still one row per note, on screen and in the view's answer.
    await expect(page.getByText(QUEUED_5XX)).toHaveCount(0);
    await expect(page.locator(".cv-table tbody tr[data-cv-row]")).toHaveCount(2);
    expect((await execRows()).map((r) => r.title).sort()).toEqual([`Alpha ${stamp}`, `Beta ${stamp}`]);

    // Offline cell edit: queued, the box closes without an error, and when the connection returns the value lands and shows
    // (viewWriter/propertyWriter queue; AGENTS.md 「待同步不能顯示已同步」).
    await page.context().setOffline(true);
    await editCell(page, "Beta", "memo", "offline-edit", "Enter");
    await expect(page.locator(".cv-table-cell-input")).toHaveCount(0);
    await expect(page.locator(".cv-table-cell-error")).toHaveCount(0);
    expect((await attr(ids.Beta, "memo"))?.value).toBe("123"); // the API call is the page's own request context, which stays online: the server has not been told
    await page.context().setOffline(false);
    await expect.poll(async () => (await attr(ids.Beta, "memo"))?.value, { timeout: 30_000 }).toBe("offline-edit");
    await expect(cell(page, "Beta", "memo")).toHaveText("offline-edit");
    expect((await attr(ids.Beta, "score"))?.value).toBe("7");

    // Quick-add row: normal, then with the tag endpoint failing, then a lost POST response.
    const qa = page.locator(".cv-quickadd-input");
    await qa.fill(`Gamma ${stamp}`); await qa.press("Enter");
    await expect(cell(page, "Gamma", "status")).toBeVisible();
    await expect(page.locator(".cv-table tbody tr[data-cv-row]")).toHaveCount(3);
    await expect(qa).toHaveValue("");
    // GAP-125 (fixed 2026-10-10): the note and its tag are ONE request, so a failing tag endpoint cannot leave an untagged orphan or a
    // refused add; the probe's model (tag apply fails, the title is kept) is from before.
    await page.route(`**/api/nodes/*/tags/${tag.id}`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
    await qa.fill(`Delta ${stamp}`); await qa.press("Enter");
    await expect(cell(page, "Delta", "status")).toBeVisible();
    await expect(page.locator(".cv-quickadd-error")).toHaveCount(0);
    await expect(qa).toHaveValue("");
    await page.unroute(`**/api/nodes/*/tags/${tag.id}`);
    await qa.press("Enter"); // nothing typed: nothing is made
    expect(await nodesTitled(`Delta ${stamp}`)).toBe(1);
    expect((await execRows()).filter((r) => r.title === `Delta ${stamp}`)).toHaveLength(1);

    await page.route("**/api/nodes", async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      await r.fetch().catch(() => null); // the server commits (if the page already gave up waiting there is nothing left to answer)
      await r.abort("connectionreset").catch(() => {}); // the client never sees the response
    });
    await qa.fill(`Epsilon ${stamp}`); await qa.press("Enter");
    // The server has the note exactly once, the title is not kept for a second try, and a later Enter makes nothing new (GAP-125:
    // 「回應遺失不會建出第二筆」, a retry reuses the same id).
    await expect.poll(() => nodesTitled(`Epsilon ${stamp}`)).toBe(1);
    await expect(qa).toHaveValue("");
    await page.unroute("**/api/nodes"); // a retry of the same create may still be inside the handler: it ignores what is left to answer
    await qa.press("Enter");
    await expect(cell(page, "Epsilon", "status")).toBeVisible();
    expect(await nodesTitled(`Epsilon ${stamp}`)).toBe(1);
    expect((await execRows()).filter((r) => r.title === `Epsilon ${stamp}`)).toHaveLength(1);

    // Phone viewport: the page itself does not get wider; the table scrolls inside its own container (full-feature-audit.md COL-03: 390px
    // 表格容器內橫向捲動、頁面無溢出); a cell can be edited by touch.
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true });
    const pp = await phone.newPage();
    await open(pp);
    expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const wrap = await pp.locator(".cv-table-wrap").evaluate((w) => ({ client: w.clientWidth, scroll: w.scrollWidth, overflowX: getComputedStyle(w).overflowX }));
    expect(wrap.client).toBeLessThanOrEqual(390);
    expect(wrap.scroll).toBeGreaterThan(wrap.client);
    expect(["auto", "scroll"]).toContain(wrap.overflowX);
    const gamma = cell(pp, "Gamma", "memo").locator("button");
    await gamma.scrollIntoViewIfNeeded();
    await gamma.tap();
    await pp.locator(".cv-table-cell-input").fill("phone");
    await pp.locator(".cv-table-cell-input").press("Enter");
    const gammaId = (await execRows()).find((r) => r.title === `Gamma ${stamp}`)!.id;
    await expect.poll(async () => (await attr(gammaId, "memo"))?.value).toBe("phone");
    await phone.close();
    void view;
  });

  // FINDING: layout-audit R7 / `--ac-tap` (44px) — a table cell is a button a finger must hit on a phone. What the app does instead:
  // the cell button's height is 20px (the probe measured cellBtnH 20) and nothing widens its target.
  test("FINDING: a table cell is a 44px target on a phone", async ({ page, browser }) => {
    test.fail();
    const { open, cell } = await setUp(page);
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true });
    const pp = await phone.newPage();
    await open(pp);
    const target = cell(pp, "Alpha", "memo").locator("button");
    expect((await clickableSize(target)).h).toBeGreaterThanOrEqual(44);
    await phone.close();
  });

  // FINDING: GAP-126 in full-feature-audit.md (「未修；表格在佇列待送時保留樂觀值並標示待同步，寫入落地後重查」): while a cell write
  // waits in the queue the cell keeps what the person typed. What the app does instead: the table re-reads the server and shows the
  // old value (「—」) although the sync status says the change is safe on this device. (Same for an offline edit: next test.)
  test("FINDING: a cell write that waits (503) keeps showing what was typed", async ({ page }) => {
    test.fail();
    const { open, cell, editCell } = await setUp(page);
    await open(page);
    await page.route("**/api/nodes/*/attributes/*", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
    await editCell(page, "Beta", "score", "7", "Enter");
    await expect(page.getByText(QUEUED_5XX)).toHaveCount(1);
    await expect(cell(page, "Beta", "score")).toHaveText("7", { timeout: 3_000 });
  });

  test("FINDING: a cell write that waits (offline) keeps showing what was typed", async ({ page }) => {
    test.fail();
    const { open, cell, editCell } = await setUp(page);
    await open(page);
    await page.context().setOffline(true);
    await editCell(page, "Beta", "memo", "offline-edit", "Enter");
    await expect(page.locator(".cv-table-cell-input")).toHaveCount(0);
    await expect(cell(page, "Beta", "memo")).toHaveText("offline-edit", { timeout: 3_000 });
  });
});
