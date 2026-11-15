// Feature-audit deepening (2026-10-08): REV-05 phone pass — the same card types on a 390 px phone, plus how a
// [[wikilink]] renders inside a card (desktop) — fresh cards, since
// "Again" leaves graded cards due only minutes later.
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

test("REV-05c: phone readability and wikilink markup", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r05c${stamp}`, fields: [] } })).json();
  const mk = async (title: string, markdown: string, parent?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  await mk(`R05 Target ${stamp}`, "Target body.");
  const deck = await mk(`R05c Deck ${stamp}`, "deck");
  const wide = "| " + Array.from({ length: 12 }, (_, i) => `column ${i}`).join(" | ") + " |\n|" + " --- |".repeat(12) + "\n| " + Array.from({ length: 12 }, (_, i) => `value-${i}-longer-text`).join(" | ") + " |";
  const rich = ["# Rich card", "", wide, "", "```js", `const longLine = "${"x".repeat(220)}";`, "```", "", "$$\\int_0^1 x^2\\,dx + \\sum_{k=1}^{100} k^2 = \\frac{338350}{1}$$", "", `See [[R05 Target ${stamp}]].`].join("\n");
  const ids = [await mk(`R05 1 rich ${stamp}`, rich, deck), await mk(`R05 2 text+ink ${stamp}`, "Text with handwriting below.", deck)];
  await req.put(`/api/nodes/${ids[1]}/attributes/ink_data`, { ...H, data: { value: INK, value_type: "text" } });
  for (const id of ids) await Promise.all([req.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, id)]);
  const openDeck = async (p: Page) => {
    await ready(p, `/?view=notes&node=${deck}`);
    await p.keyboard.press("Control+k");
    await p.locator(".palette-input-wrap input").fill(">Review cards");
    await p.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
    await p.locator(".review-panel").waitFor({ timeout: 10_000 });
    await p.waitForTimeout(1500);
  };
  // Desktop: wikilink markup only (no grading).
  await openDeck(page);
  await page.locator(".review-reveal").click();
  await page.waitForTimeout(1000);
  out.wikilinkMarkup = await page.locator(".review-card-body").first().evaluate((el) => {
    const hit = Array.from(el.querySelectorAll("*")).find((e) => e.children.length === 0 && /R05 Target/.test(e.textContent ?? ""));
    return hit ? (hit.parentElement?.outerHTML ?? "").slice(0, 300) : "(not found)";
  });
  const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  try {
    await openDeck(pp);
    const sizes = async () => pp.evaluate(() => Array.from(document.querySelectorAll(".review-reveal, .review-grade, .review-open-note")).filter((b) => (b as HTMLElement).offsetParent).map((b) => { const r = b.getBoundingClientRect(); return `${(b.textContent ?? "").trim().slice(0, 10)}:${Math.round(r.width)}x${Math.round(r.height)}`; }));
    out.phoneTitle = await pp.locator(".review-card-title").innerText().catch(() => "(none)");
    out.phoneButtonsBefore = await sizes();
    await pp.locator(".review-reveal").click();
    await pp.waitForTimeout(1500);
    out.phoneButtonsRevealed = await sizes();
    out.phoneRich = await describe(pp);
    out.phoneInner = await pp.locator(".review-card-body").first().evaluate((el) => Array.from(el.querySelectorAll("table, pre, .katex-display")).map((e) => { const s = e as HTMLElement; const cs = getComputedStyle(s); return `${e.tagName.toLowerCase()}${e.className ? "." + String(e.className).split(" ")[0] : ""} ${s.scrollWidth}/${s.clientWidth} ox=${cs.overflowX} parentOx=${getComputedStyle(s.parentElement!).overflowX}`; }));
    out.phoneFont = await pp.locator(".review-card-body").first().evaluate((el) => getComputedStyle(el).fontSize);
    await pp.screenshot({ path: "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick7/rev05c-phone.png", fullPage: false });
    await pp.locator(".review-grade--3").click();
    await pp.waitForTimeout(1200);
    await pp.locator(".review-reveal").click();
    await pp.waitForTimeout(1200);
    out.phoneTextInk = await describe(pp);
  } catch (e) { out.phoneErr = String(e).split("\n")[0].slice(0, 160); }
  await phone.close();
  console.log("REV05C " + JSON.stringify(out, null, 2));
});
