import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, createPublishingSpace, publishSite, BASE, FEED_ORIGIN, H } from "./helpers";

// RSS module (modules/rss), end to end through the real stack — articles are
// STAGING rows, not nodes, until saved: subscribe → the outbox fetch effect
// lands items in rss_staging → the reader opens an article (sanitized html
// path) → a text selection becomes an EXCERPT in a chosen note (quote, source
// line with the original link, anchored as a paragraph; the article itself is NOT saved) → the
// same passage again is recognised instead of written twice → next.
// Plus: the phone reading immersion — with an article open the app chrome
// (topbar + bottom nav) and the list-layer chrome (panel header + subscribe
// row) leave the screen; the actions row becomes a fixed bottom toolbar.
//
// THE FEED: the stack's OWN published site. Publishing is opt-in per node
// (`_published` attr) and /site/feed.xml is public — so the spec publishes
// two stamped probe notes and subscribes to the site's feed, which is the
// real dogfood loop (an Onden reading an Onden). A per-stamp query param
// keeps each test's subscription a distinct source (the backend keys sources
// on the exact URL string; the feed ignores the param). (The old trick —
// uploading feed XML via /api/media — died when media reads grew a
// read-policy gate: the backend's feed fetch carries no session. A host-side
// fixture server dies on host firewalls. The published site is in-network,
// unauthenticated, and exercises real surface.)
//
// Desktop sidebar surface → chromium only (like inboxReview.spec.ts).


/** Publish two stamped probe notes — they become the site feed's items.
 *  The body's summary is what the feed carries as the description
 *  (siteFeed.feedSummary), i.e. the article body the reader renders. */
async function publishProbeNotes(page: Page, stamp: number): Promise<void> {
  // The default space does not publish: the probe notes go in a space whose switch is on (on the site at the next publish).
  const space_id = await createPublishingSpace(page.request);
  for (const n of [1, 2]) {
    const node = await (await page.request.post("/api/nodes", {
      ...H, data: {
        space_id,
        title: `E2E article ${n} (${stamp})`,
        markdown: `Highlightable sentence ${n} of run ${stamp}.\n\nSecond paragraph.`,
      },
    })).json() as { id: string };
  }
  // Marking only opts a note in; the feed serves the last published snapshot.
  await publishSite(page.request);
}

function feedUrlFor(stamp: number): string {
  // In-network via the stack's nginx; the ?run param makes each test's
  // subscription a distinct source without changing what the feed serves.
  return `${FEED_ORIGIN}/site/feed.xml?run=${stamp}`;
}

type ItemRow = { id: string; title: string; seen: boolean; saved_node_id: string | null };

async function pollItems(page: Page, titleMark: string, want: number): Promise<ItemRow[]> {
  let items: ItemRow[] = [];
  await expect.poll(async () => {
    const r = await page.request.get("/api/rss/items?limit=100");
    if (!r.ok()) return 0;
    items = ((await r.json()) as { items: ItemRow[] }).items.filter((it) => it.title.includes(titleMark));
    return items.length;
  }, { timeout: 30_000 }).toBeGreaterThanOrEqual(want);
  return items;
}

/** Publish + subscribe + first fetch via API (the UI path is covered in the
 *  main loop). */
async function seedSubscription(page: Page, stamp: number): Promise<{ sourceId: string; items: ItemRow[] }> {
  await publishProbeNotes(page, stamp);
  const sub = await page.request.post("/api/rss/subscribe", { ...H, data: { url: feedUrlFor(stamp) } });
  expect(sub.ok(), `subscribe → ${sub.status()}`).toBeTruthy();
  const { id } = (await sub.json()) as { id: string };
  await page.request.post(`/api/rss/sources/${id}/refresh`, { ...H, data: {} });
  const items = await pollItems(page, `(${stamp})`, 2);
  return { sourceId: id, items };
}

test("rss loop: subscribe → fetch lands in staging → read → highlight becomes an excerpt in a note → same passage is recognised → next", async ({ page }) => {
  const stamp = Date.now();
  const feedUrl = feedUrlFor(stamp);

  await ready(page, "/?view=notes");
  await publishProbeNotes(page, stamp);
  // The note the quote goes into.
  const target = await (await page.request.post("/api/nodes", {
    headers: H.headers,
    data: { space_id: await defaultSpaceId(page.request), title: `Quote target ${stamp}`, markdown: "My notes." },
  })).json() as { id: string };

  // 1. Open the reader from the command palette ("Go to Reading"). The ⌘K
  // listener attaches in a mount effect — poll the keypress until it opens.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator(".palette-input-wrap input")).toBeFocused();
  await page.locator(".palette-input-wrap input").fill(">rss reader");
  await page.locator(".palette-item", { hasText: "Go to Reading" }).click();
  const reader = page.locator(".rss-reader");
  await expect(reader).toBeVisible();

  // 2. Subscribe through the panel — the input is FOLDED inside the 來源 sheet
  //    (management UI never sits on the reading path).
  await expect(reader.locator(".rss-subscribe-input")).toHaveCount(0);
  await reader.locator(".rss-sources-open").click();
  await page.locator(".rss-subscribe-input").fill(feedUrl);
  await page.locator(".rss-subscribe-btn").click();
  // The source's title is the published SITE's feed title (whatever the
  // workspace calls itself) — resolve it via the API instead of guessing.
  let sourceId = "";
  await expect.poll(async () => {
    const r = await (await page.request.get("/api/rss/sources")).json() as { sources: Array<{ id: string; url: string | null }> };
    sourceId = r.sources.find((s0) => s0.url === feedUrl)?.id ?? "";
    return sourceId;
  }, { timeout: 20_000 }).toBeTruthy();
  // A successful subscribe closes the sheet; the feed is a tag in the row above the list.
  await expect(reader.locator(`.ui-filter-chip[data-value="${sourceId}"]`)).toBeVisible({ timeout: 20_000 });

  // 3. The first fetch rides the outbox; nudge it with a manual refresh and
  //    wait for both articles (rerun-safe: stamped titles). Items are
  //    STAGING rows — unseen, unsaved, and NOT nodes.
  await reader.locator(".rss-sources-open").click();
  await page.locator(`.rss-source-row[data-source-id="${sourceId}"] .rss-source-refresh`).click();
  await page.keyboard.press("Escape");
  const items = await pollItems(page, `(${stamp})`, 2);
  // Staging rows, not nodes: nothing is saved until the human says so. (The
  // stamped TITLES do exist as nodes — they're the published ORIGIN notes the
  // feed was built from — so "not a node" is pinned via saved_node_id.)
  expect(items.every((it) => !it.seen && it.saved_node_id === null)).toBeTruthy();

  // 4. Open the first item in the reader (new articles are counted in
  //    Reading; they no longer sit in the sidebar's review queue).
  await page.locator(".rss-item", { hasText: `(${stamp})` }).first().click();
  await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rss-article-body")).toContainText("Highlightable sentence");
  const openTitle = (await page.locator(".rss-article-title").textContent()) ?? "";

  // 5. A highlight becomes an EXCERPT in a chosen note (@onden/markdown
  //    excerpt.ts): the quote and its source line with the original link,
  //    anchored as a paragraph so it can be embedded and found again. The article is not saved.
  const selectFirstParagraph = () => page.evaluate(() => {
    const el = document.querySelector(".rss-article-body p");
    if (!el) throw new Error("article paragraph missing");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await selectFirstParagraph();
  const bar = page.getByRole("toolbar", { name: "Selected text" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Another note…" }).click();
  const sheet = page.getByRole("dialog", { name: "Put it in…" });
  await sheet.locator("input").fill(`Quote target ${stamp}`);
  await sheet.getByRole("option", { name: `Quote target ${stamp}` }).click();
  // Since the paragraph anchors (commit 724dd9e7, 2026-11-07) the quote carries no `^id` in its text: its identity is
  // the anchor the server gives the block the moment it is written (anchorExcerpts, 211fa69f).
  await expect.poll(async () => {
    const n = await (await page.request.get(`/api/nodes/${target.id}`)).json() as { markdown: string };
    return n.markdown;
  }, { timeout: 10_000 }).toMatch(new RegExp(`^My notes\\.\\n\\n> Highlightable sentence \\d of run ${stamp}\\.\\n>\\n> — \\[[^\\]]+\\]\\([^)]+#:~:text=[^)]+\\)[^\\n]*\\n?$`));
  const written = (await (await page.request.get(`/api/nodes/${target.id}`)).json() as { markdown: string }).markdown;
  expect(written).not.toMatch(/^> \^/m);
  // The excerpt can still be pointed back at: an anchor that starts at the quote and is confirmed (a citation of it, an embed, the
  // reader's 「already in this note」 all resolve through it).
  const quoteAt = written.indexOf("> Highlightable");
  await expect.poll(async () => {
    const { note_anchors = [] } = await (await page.request.get("/api/bootstrap")).json() as { note_anchors?: Array<{ note_id: string; from: number; status: string }> };
    return note_anchors.filter((a) => a.note_id === target.id && a.from === quoteAt).map((a) => a.status);
  }, { timeout: 10_000 }).toEqual(["valid"]);
  const afterQuote = (await pollItems(page, `(${stamp})`, 2)).find((it) => it.title === openTitle);
  expect(afterQuote?.saved_node_id ?? null).toBeNull();

  // 6. The same passage again: putting it in asks where it already is
  //    instead of writing a second copy.
  await selectFirstParagraph();
  await bar.getByRole("button", { name: /^Put in “Quote target/ }).click();
  await expect(bar.getByText(`Already in “Quote target ${stamp}”`)).toBeVisible({ timeout: 10_000 });
  const once = (await (await page.request.get(`/api/nodes/${target.id}`)).json() as { markdown: string }).markdown;
  expect(once.split("Highlightable sentence").length - 1).toBe(1);

  // 7. Advance: on desktop "next" waits at the end of the article (the Skip
  //    verb lives on the phone toolbar).
  await page.locator(".rss-article-nav .rss-next-btn:not(.rss-prev-btn)").click();
  await expect(page.locator(".rss-article-title")).not.toHaveText(openTitle, { timeout: 10_000 });
  // The article LEFT becomes seen (the one now open is not, yet); the mark is
  // written in the background.
  await expect.poll(async () => (await pollItems(page, `(${stamp})`, 2)).find((it) => it.title === openTitle)?.seen, { timeout: 10_000 }).toBe(true);
  // Quoting kept nothing: no article was saved whole.
  expect((await pollItems(page, `(${stamp})`, 2)).every((it) => !it.saved_node_id)).toBeTruthy();
});

test("home start shows the skim line when unseen articles are waiting", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");
  await seedSubscription(page, stamp);

  // A home node so the HomeStart strip has a stage (reviewLoop.spec.ts shape).
  const home = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `RSS home ${stamp}`, markdown: "## home" },
  })).json();
  await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } });

  await ready(page, `/?view=notes&node=${home.id}`);
  const line = page.locator(".home-start-rss");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toContainText(/to skim/);
  await line.locator("button").first().click();
  await expect(page.locator(".rss-reader")).toBeVisible();
});

// ── Phone reading immersion ──────────────────────────────────────────────────
// With an article open the reading layer owns the screen: app topbar + bottom
// nav + the reader's list-layer chrome all leave; the actions row becomes a
// fixed bottom toolbar with Skip as the one primary verb; back restores it all.
test.describe("mobile reading immersion", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("article view = content + one bottom toolbar; back restores the chrome", async ({ page }, testInfo) => {
    const stamp = Date.now();
    await ready(page, "/?view=notes");
    await seedSubscription(page, stamp);

    await ready(page, "/?view=rss");
    const reader = page.locator(".rss-reader");
    await expect(reader).toBeVisible();

    // Open this run's article (single-pane drill). The reader remembers where
    // you were per view, per ACCOUNT, and reopening the view resumes there on
    // any device (readingPosition.ts) — so it may come back on an earlier
    // run's open article, a moment after the list loads. Go back to the list
    // (the chrome is there), then open ours; retry if the resume lands late.
    const back = page.locator(".rss-article-back");
    const ours = page.locator(".rss-item", { hasText: `(${stamp})` }).first();
    await expect(async () => {
      if (await back.isVisible()) await back.click();
      await expect(page.locator(".mobile-bottom-nav")).toBeVisible({ timeout: 2_000 });
      await ours.click({ timeout: 2_000 });
      await expect(page.locator(".rss-article-title")).toContainText(`(${stamp})`, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });

    // The chrome is gone: app topbar, bottom nav, panel header, subscribe UI.
    await expect(page.locator(".app-topbar")).toBeHidden();
    await expect(page.locator(".mobile-bottom-nav")).toBeHidden();
    await expect(reader.locator(".panel-header.compact")).toBeHidden();

    // No bottom toolbar, and nothing beside the title: keeping the whole
    // article (存成筆記 + ▾) is the secondary action at the end, on 寫點什麼's row.
    await expect(page.locator(".rss-article-head .rss-save-ctl")).toHaveCount(0);

    // Scroll past the end → the continuation affordance (next unseen).
    await page.locator(".rss-article-end").scrollIntoViewIfNeeded();
    await expect(page.locator(".rss-next-btn")).toBeVisible();
    const row = page.locator(".rss-article-end .rss-end-actions");
    const write = row.getByRole("button", { name: /Write something|寫點什麼/ });
    const save = row.locator(".rss-act-save");
    await expect(write).toBeVisible();
    await expect(save).toBeVisible();
    // One row at phone width: same top, same height.
    const [w, s] = [await write.boundingBox(), await save.boundingBox()];
    expect(Math.abs(w!.y - s!.y)).toBeLessThan(2);
    expect(Math.abs(w!.height - s!.height)).toBeLessThan(2);

    await page.screenshot({ path: testInfo.outputPath("mobile-reading.png") });

    // Back restores the full chrome.
    await page.locator(".rss-article-back").click();
    await expect(page.locator(".app-topbar")).toBeVisible();
    await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
  });
});
