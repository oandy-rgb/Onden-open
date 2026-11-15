// Feature-audit deepening (2026-10-08): REV-05 (second pass) — what a review card shows for
// each content type (rich Markdown with table/code/math/callout/mermaid/
// wikilink, an uploaded image, a missing image, ink only, text + ink, an
// embed), following a wikilink and "Open" then coming back, and the same
// cards on a 390 px phone (overflow, button sizes).
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const INK = JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[100, 100], [300, 220], [500, 120], [700, 320]], color: "#1e66f5", size: 8, toolId: "pen" }], erased: {}, page: { width: 1000 } });

async function describe(p: Page) {
  return p.locator(".review-card-body").first().evaluate((el) => ({
    text: (el as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 140),
    tables: el.querySelectorAll("table").length,
    katex: el.querySelectorAll(".katex").length,
    callout: el.querySelectorAll("[class*='callout']").length,
    svg: el.querySelectorAll("svg").length,
    mermaidRaw: /graph TD|flowchart/.test((el as HTMLElement).innerText),
    pre: el.querySelectorAll("pre").length,
    imgs: Array.from(el.querySelectorAll("img")).map((i) => ({ src: (i.getAttribute("src") ?? "").slice(0, 50), ok: i.complete && i.naturalWidth > 0, alt: i.alt })),
    inkThumb: el.querySelectorAll(".review-ink-thumb").length,
    links: Array.from(el.querySelectorAll("a")).map((a) => `${(a.textContent ?? "").slice(0, 30)}→${(a.getAttribute("href") ?? "").slice(0, 40)}`).slice(0, 4),
    overflowX: el.scrollWidth > el.clientWidth + 2,
    widths: `${el.scrollWidth}/${el.clientWidth}`,
    pageOverflow: document.documentElement.scrollWidth > innerWidth + 2,
  }));
}

test("REV-05: content types, media, wikilink/open-and-return, phone", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r05t${stamp}`, fields: [] } })).json();
  const mk = async (title: string, markdown: string, parent?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  const target = await mk(`R05 Target ${stamp}`, "Target body text that an embed should show.");
  const deck = await mk(`R05 Deck ${stamp}`, "deck");
  const up = await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `r05-${stamp}.png`, mimeType: "image/png", buffer: PNG } } });
  const url = ((await up.json().catch(() => ({}))) as { url?: string }).url ?? "";
  const wide = "| " + Array.from({ length: 12 }, (_, i) => `column ${i}`).join(" | ") + " |\n|" + " --- |".repeat(12) + "\n| " + Array.from({ length: 12 }, (_, i) => `value-${i}-longer-text`).join(" | ") + " |";
  const rich = [`# Rich card`, "", "**Bold** and *italic* with a list:", "", "- one", "- two", "", wide, "", "```js", `const longLine = "${"x".repeat(220)}";`, "```", "", "$$\\int_0^1 x^2\\,dx = \\tfrac13$$", "", "> [!note] Remember", "> Callout body", "", "```mermaid", "graph TD; A-->B;", "```", "", `See [[R05 Target ${stamp}]] and [site](https://example.com).`].join("\n");
  const ids = {
    rich: await mk(`R05 1 rich ${stamp}`, rich, deck),
    image: await mk(`R05 2 image ${stamp}`, `Image card\n\n![pic](${url})`, deck),
    missing: await mk(`R05 3 missing ${stamp}`, `Missing image card\n\n![gone](/api/media/missing-${stamp}.png)`, deck),
    ink: await mk(`R05 4 ink ${stamp}`, "", deck),
    textInk: await mk(`R05 5 text+ink ${stamp}`, "Text with handwriting below.", deck),
    embed: await mk(`R05 6 embed ${stamp}`, `Embed card\n\n![[R05 Target ${stamp}]]`, deck),
  };
  for (const id of [ids.ink, ids.textInk]) await req.put(`/api/nodes/${id}/attributes/ink_data`, { ...H, data: { value: INK, value_type: "text" } });
  for (const id of Object.values(ids)) await Promise.all([req.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, id)]);
  out.upload = up.status();

  const openDeck = async (p: Page) => {
    await ready(p, `/?view=notes&node=${deck}`);
    await p.keyboard.press("Control+k");
    await p.locator(".palette-input-wrap input").fill(">Review cards");
    await p.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
    await p.locator(".review-panel").waitFor({ timeout: 10_000 });
    await p.waitForTimeout(1500);
  };
  const head = async (p: Page) => ({ title: (await p.locator(".review-card-title").innerText().catch(() => "(none)")).replace(` ${stamp}`, ""), left: await p.locator(".review-count").innerText().catch(() => "") });

  try {
    await openDeck(page);
    out.start = await head(page);
    for (let i = 0; i < 6; i++) {
      const h = await head(page);
      if (h.title === "(none)") break;
      const key = h.title.replace(/^R05 \d /, "");
      if (key === "image") {
        // "Open" the note (offered while the answer is still hidden), then browser Back.
        await page.locator(".review-open-note").click();
        await page.waitForTimeout(2000);
        out.openNote = { url: page.url().replace(BASE, "").slice(0, 70), panelVisible: await page.locator(".review-panel").isVisible().catch(() => false), editor: await page.locator(".cm-content").first().isVisible().catch(() => false) };
        await page.goBack();
        await page.waitForTimeout(2500);
        out.openNoteBack = { url: page.url().replace(BASE, "").slice(0, 70), panelVisible: await page.locator(".review-panel").isVisible().catch(() => false), ...(await head(page)) };
        if (!(await page.locator(".review-panel").isVisible().catch(() => false))) { await openDeck(page); out.reopenedDeck = await head(page); }
        if (!(await page.locator(".review-card-body").isVisible().catch(() => false))) { await page.locator(".review-reveal").click().catch(() => {}); await page.waitForTimeout(800); }
      }
      if (!(await page.locator(".review-card-body").isVisible().catch(() => false))) { await page.locator(".review-reveal").click(); await page.waitForTimeout(1500); }
      out[`card_${key}`] = await describe(page);
      if (key === "rich") {
        // Follow the wikilink from inside the card, then come back.
        const link = page.locator(".review-card-body a", { hasText: `R05 Target` }).first();
        const before = page.url();
        if (await link.count()) {
          await link.click();
          await page.waitForTimeout(1500);
          out.wikilink = { navigated: page.url() !== before, url: page.url().replace(BASE, "").slice(0, 70), panelVisible: await page.locator(".review-panel").isVisible().catch(() => false) };
          if (page.url() !== before) { await page.goBack(); await page.waitForTimeout(2000); out.wikilinkBack = { panelVisible: await page.locator(".review-panel").isVisible().catch(() => false), ...(await head(page)), revealed: await page.locator(".review-card-body").isVisible().catch(() => false) }; }
          if (!(await page.locator(".review-panel").isVisible().catch(() => false))) await openDeck(page);
          if (!(await page.locator(".review-card-body").isVisible().catch(() => false))) { await page.locator(".review-reveal").click().catch(() => {}); await page.waitForTimeout(800); }
        } else out.wikilink = "no link element";
      }
      await page.locator(".review-grade--1").click();  // "Again" keeps the card due for the phone pass
      await page.waitForTimeout(1200);
    }
    out.end = await head(page);
    out.endText = (await page.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);

    // Phone pass.
    const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    try {
      await openDeck(pp);
      out.phoneStart = await head(pp);
      const sizes = async () => pp.evaluate(() => Array.from(document.querySelectorAll(".review-reveal, .review-grade, .review-open-note")).filter((b) => (b as HTMLElement).offsetParent).map((b) => { const r = b.getBoundingClientRect(); return `${(b.textContent ?? "").trim().slice(0, 10)}:${Math.round(r.width)}x${Math.round(r.height)}`; }));
      out.phoneButtonsBefore = await sizes();
      for (let i = 0; i < 6; i++) {
        const h = await head(pp);
        if (h.title === "(none)") break;
        await pp.locator(".review-reveal").click();
        await pp.waitForTimeout(1200);
        const key = h.title.replace(/^R05 \d /, "");
        if (["rich", "textInk", "text+ink", "embed"].includes(key) || i === 0) out[`phone_${key}`] = await describe(pp);
        if (i === 0) out.phoneButtonsRevealed = await sizes();
        await pp.locator(".review-grade--3").click();
        await pp.waitForTimeout(1000);
      }
    } catch (e) { out.phoneErr = String(e).split("\n")[0].slice(0, 160); }
    await phone.close();
  } finally {
    console.log("REV05 " + JSON.stringify(out, null, 2));
  }
});
