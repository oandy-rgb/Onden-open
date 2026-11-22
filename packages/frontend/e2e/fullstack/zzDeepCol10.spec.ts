// Feature-audit deepening (2026-10-07): COL-10 — onden-query / onden-base
// embeds: real rendering in the editor's Preview, malformed specs, collection
// (space) permissions for a second human, and paging a long result list.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). The rules: nodeQuery.ts (the spec is strict — a
// string where an array goes, a limit outside 1..200, an unknown operator or a body that is not an object is a 400; a sort by anything else is
// a sort by that attribute, never SQL; a reserved key in `where` is not a filter; an answer is a Page {rows, total, next}, 50 rows by default),
// OndenQueryBlock.tsx (「N matches · showing M」 says the whole count, D66; a line that is not a spec says so instead of listing everything,
// GAP-267), BaseRenderer.tsx, full-feature-audit.md COL-10 and GAP-162 / GAP-266 / GAP-267, and the read policy (a hidden note is in no
// answer for someone who may not read it). The workspace is shared, so every list is cut down to this run's stamp.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, switchNoteView, BASE, H } from "./helpers";
import { contextsClosedAfterEach } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";
/** Members of the long tag: more than the 50 of a default page (nodeQuery.ts), as few as that allows. */
const LONG = 54;
const PAGE = 50;

async function setUp(page: Page) {
  const stamp = Date.now();
  const tagName = `c10q${stamp}`;
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: tagName, fields: [{ name: "stage", type: "text" }] } })).json();
  // Default space so the second human reads them (except QSecret, hidden below).
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, markdown = `${title} body`, extra: Record<string, unknown> = {}) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, space_id: shared, ...extra } })).json()).id as string;
  // A member is made with its tag and field in ONE request (POST /api/nodes takes `tag_ids` and `attributes`, GAP-125).
  const member = (title: string, stage?: string) => mk(title, undefined, { tag_ids: [tag.id], ...(stage ? { attributes: [{ key: "stage", value: stage, value_type: "text" }] } : {}) });
  await member(`QA ${stamp}`, "doing");
  await member(`QB ${stamp}`, "done");
  await member(`QC ${stamp}`, "doing");
  // A member only the owner may read: it sits in a space of its own.
  const secret = await member(`QSecret ${stamp}`, "doing");
  await hideFromOthers(page.request, secret);
  // A second tag with more members than a page holds, for the paging checks, made now, four requests at a time: while a page of the app is
  // open a burst of creates stalls the single-connection PGlite stack, and on a workspace as big as the late specs leave it every stall is
  // seconds long, so the fewer sequential round trips the better.
  const longName = `c10p${stamp}`;
  const longTag = await (await page.request.post("/api/tags/import", { ...H, data: { name: longName, fields: [] } })).json();
  for (let i = 0; i < LONG; i += 4) {
    await Promise.all(Array.from({ length: Math.min(4, LONG - i) }, (_, k) => mk(`QLong${String(i + k).padStart(2, "0")} ${stamp}`, undefined, { tag_ids: [longTag.id] })));
  }
  const longHost = await mk(`LongHost ${stamp}`, fence("onden-query", `tags: ${longName}`));

  const q = async (body: unknown) => {
    const r = await page.request.post("/api/query", { ...H, data: body });
    const text = await r.text();
    return { status: r.status(), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const titles = (j: { rows?: Array<{ title: string }> } | null) => (j?.rows ?? []).map((r) => r.title).filter((t) => t.includes(String(stamp)));
  const hostMd = [
    "# Embeds",
    fence("onden-query", `tags: ${tagName}`),
    fence("onden-query", `tags: ${tagName}, nothing${stamp}\nwhere:\n  stage: doing\nsort: -title`),
    fence("onden-base", `filters:\n  and:\n    - file.hasTag("${tagName}")\nviews:\n  - type: table\n    name: T${stamp}`),
    fence("onden-base", "views: [this is: not: yaml"),
    fence("onden-query", "this is not a spec at all"),
  ].join("\n\n");
  const host = await mk(`EmbedHost ${stamp}`, hostMd);
  const openPreview = async (p: Page, note = host) => {
    await ready(p, `/?view=notes&node=${note}`);
    await switchNoteView(p, "preview");
    await expect(p.locator(".obsidian-preview")).toBeVisible({ timeout: 15_000 });
    await expect(p.locator(".onden-query-block .onden-query-meta").first()).toBeVisible({ timeout: 15_000 }); // the blocks have asked and been answered
  };
  const preview = (p: Page) => p.locator(".obsidian-preview");
  const queryBlock = (p: Page, n: number) => preview(p).locator(".onden-query-block").nth(n);
  // A block asks again when the page re-renders (it re-runs on its source and on the language), so read its rows until they settle.
  const links = async (p: Page, n: number) => (await queryBlock(p, n).locator(".onden-query-result-link").allInnerTexts());
  const baseTitles = (p: Page) => preview(p).locator(".bases-table tbody .bases-table-title").allInnerTexts();
  return { stamp, tagName, longName, longHost, tag, secret, host, mk, member, q, titles, openPreview, preview, queryBlock, links, baseTitles };
}

test.describe("COL-10: query and base embeds", () => {
  test.setTimeout(300_000);

  test("API spec, rendering, malformed specs, permissions, paging, phone", async ({ page, browser }) => {
    const { stamp, tagName, longName, longHost, q, titles, openPreview, preview, queryBlock, links, baseTitles } = await setUp(page);
    const mine = (r: { json: { rows?: Array<{ title: string }> } | null }) => titles(r.json);
    const four = [`QA ${stamp}`, `QB ${stamp}`, `QC ${stamp}`, `QSecret ${stamp}`];

    // ── API surface (nodeQuery.ts) ───────────────────────────────────────────
    // `tags` is an array of names: the owner reads every member, hidden or not.
    let r = await q({ tags: [tagName] });
    expect(r.status).toBe(200);
    expect(mine(r).sort()).toEqual(four);
    // A string where the array goes is refused (nodeQuerySchema: `tags: z.array`), not read as one name.
    r = await q({ tags: tagName });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad_request");
    // where + sort: a bare string is equality sugar, 「-」 sorts descending; `ne` is an operator clause.
    r = await q({ tags: [tagName], where: { stage: "doing" }, sort: "-title" });
    expect(r.status).toBe(200);
    expect(mine(r)).toEqual([`QSecret ${stamp}`, `QC ${stamp}`, `QA ${stamp}`]);
    r = await q({ tags: [tagName], where: { stage: { op: "ne", value: "doing" } } });
    expect(mine(r)).toEqual([`QB ${stamp}`]);
    // Refused as a 400: a limit outside 1..200 (the header comment of nodeQuery.ts says 「capped at 200」, the schema refuses — COL-10 in
    // full-feature-audit.md lists 400), an operator the compiler does not know, a negative offset, a body that is not an object, a number
    // where a value goes.
    for (const [what, body] of Object.entries({
      limit0: { limit: 0 }, limit500: { limit: 500 }, badOp: { where: { stage: { op: "like", value: "x" } } },
      offsetNeg: { offset: -1 }, notJson: "not json", whereNumber: { where: { stage: 3 } },
    })) {
      const res = typeof body === "string"
        ? await page.request.post("/api/query", { headers: H.headers, data: body })
        : await page.request.post("/api/query", { ...H, data: body });
      expect(res.status(), what).toBe(400);
    }
    // A sort by something that is not a column is a sort by that attribute (parameterised, never SQL): answered, nothing dropped.
    r = await q({ tags: [tagName], sort: "title; DROP TABLE content_nodes" });
    expect(r.status).toBe(200);
    expect(mine(r).sort()).toEqual(four);
    expect(mine(await q({ tags: [tagName] })).sort()).toEqual(four); // the table is still there
    // A reserved (system) key in `where` is not a filter (nodeQuery.ts: 「!isSystemAttr(key)) // reserved」): the answer is the tag's members.
    r = await q({ tags: [tagName], where: { _status: "draft" } });
    expect(r.status).toBe(200);
    expect(mine(r).sort()).toEqual(four);

    // ── Real rendering in the editor Preview ────────────────────────────────
    await openPreview(page);
    // Every fence is drawn as what it is: three query blocks, two Bases views, no raw code (GAP-162, fixed 2026-10-09).
    await expect(preview(page).locator(".onden-query-block")).toHaveCount(3);
    await expect(preview(page).locator(".bases-table")).toHaveCount(1);
    await expect(preview(page).locator("pre code")).toHaveCount(0);
    // A single tag name works (GAP-266, fixed 2026-10-09: `tags` is always sent as an array) and the owner's block lists the four.
    await expect(queryBlock(page, 0).locator(".onden-query-meta")).toHaveText("4 matches");
    await expect.poll(async () => (await links(page, 0)).sort()).toEqual(four);
    // The second block: two tags (one unknown), where + sort -title.
    await expect(queryBlock(page, 1).locator(".onden-query-meta")).toHaveText("3 matches");
    await expect.poll(() => links(page, 1)).toEqual([`QSecret ${stamp}`, `QC ${stamp}`, `QA ${stamp}`]);
    // A line that is not a spec says so and lists nothing (GAP-267: 「無任何可辨識鍵時顯示『不是有效的查詢』而非執行空查詢」).
    await expect(queryBlock(page, 2).locator(".onden-query-error")).toHaveText("Can't read this query line: this is not a spec at all");
    await expect(queryBlock(page, 2).locator(".onden-query-result-link")).toHaveCount(0);
    // The Bases view lists the same four; a base spec that is not YAML says 「No views defined.」 instead of showing code.
    await expect.poll(async () => (await baseTitles(page)).sort()).toEqual(four);
    await expect(preview(page).getByText("No views defined.")).toBeVisible();
    // The embeds carry no copy button of a code block (MarkdownRenderer: 「只驗沒有複製鈕」).
    await expect(preview(page).locator(".onden-query-block, .bases-table-wrap").getByRole("button", { name: /copy/i })).toHaveCount(0);

    // Clicking a query result navigates to that note (COL-10: 「點結果開啟該筆記」).
    const firstLink = preview(page).locator(".onden-query-result-link").first();
    const target = await firstLink.innerText();
    await firstLink.click();
    await expect(page).toHaveURL(/node=/);
    await expect(page.locator(".obsidian-title-input, [aria-label='Note title']").first()).toHaveValue(target);

    // ── Second human (editor): the restricted member is hidden in the API and in the embeds ─
    const human = await newContext(browser, { baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C10 ${stamp}`, email: `c10-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
    const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `C10 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
    await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
    const theirQ = await (await human.request.post("/api/query", { ...H, data: { tags: [tagName] } })).json();
    const readable = [`QA ${stamp}`, `QB ${stamp}`, `QC ${stamp}`];
    expect(titles(theirQ).sort()).toEqual(readable);
    expect(mine(await q({ tags: [tagName] })).some((t) => t.includes("QSecret"))).toBe(true); // and the owner does see it
    const hp = await human.newPage();
    await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
    await openPreview(hp);
    await expect(queryBlock(hp, 0).locator(".onden-query-meta")).toHaveText("3 matches"); // the three they may read: QSecret is in no answer for them
    await expect.poll(async () => (await links(hp, 0)).sort()).toEqual(readable);
    await expect(queryBlock(hp, 1).locator(".onden-query-meta")).toHaveText("2 matches");
    await expect.poll(() => links(hp, 1)).toEqual([`QC ${stamp}`, `QA ${stamp}`]);
    await expect.poll(async () => (await baseTitles(hp)).sort()).toEqual(readable);
    expect(await preview(hp).innerText()).not.toContain(`QSecret ${stamp}`);
    await human.close();

    // ── Long list: more members than a page, default page = 50, paging via the offset the answer names ────
    const p1 = await q({ tags: [longName], sort: "title" });
    expect(p1.json.rows).toHaveLength(PAGE); // nodeQuery.ts: `limit ?? 50`
    expect(p1.json.total).toBe(LONG);
    expect(p1.json.next).toBe(PAGE);
    const p2 = await q({ tags: [longName], sort: "title", offset: p1.json.next });
    expect(p2.json.rows).toHaveLength(LONG - PAGE);
    expect(p2.json.total).toBe(LONG);
    expect(p2.json.next).toBeNull();
    const all = [...titles(p1.json), ...titles(p2.json)];
    expect(all).toHaveLength(LONG);
    expect(new Set(all).size).toBe(LONG); // no title on two pages, none missing
    // The block says the whole count, not the page's length (OndenQueryBlock.tsx, D66) and shows the first page.
    await openPreview(page, longHost);
    await expect(queryBlock(page, 0).locator(".onden-query-meta")).toHaveText(`${LONG} matches · showing ${PAGE}`);
    await expect(queryBlock(page, 0).locator(".onden-query-result-link")).toHaveCount(PAGE);

    // ── Phone viewport: nothing makes the page wider (COL-10: 390px 無橫向溢出) ───────
    await page.setViewportSize({ width: 390, height: 844 });
    await openPreview(page, longHost);
    await expect(queryBlock(page, 0).locator(".onden-query-meta")).toHaveText(`${LONG} matches · showing ${PAGE}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await expect(preview(page).locator("pre code")).toHaveCount(0);
  });

  // FINDING: full-feature-audit.md GAP-267 (「未修；顯示總數或『顯示前 50 筆』並提供下一頁」; scan-2026-11-14/07 M8: 「顯示『120 matches · showing 50』但沒有『更多』」).
  // The total is said now (D66), the rest of the list is the other half: a block that shows 50 of 54 gives a way to the other 4. What the app
  // does instead: no control at all (the probe's loadMoreControl was 0); the rest can be reached only by opening the tag.
  test("FINDING: a query block that shows 50 of 54 offers the rest", async ({ page }) => {
    test.fail();
    const { longHost, openPreview, queryBlock } = await setUp(page);
    await openPreview(page, longHost);
    await expect(queryBlock(page, 0).locator(".onden-query-meta")).toHaveText(`${LONG} matches · showing ${PAGE}`);
    await expect(queryBlock(page, 0).getByRole("button", { name: /more|next/i })).toHaveCount(1);
  });
});
