// Feature-audit deepening (2026-10-08): REV-05 follow-up — the first pass hung
// on "Show answer" for a card with an empty body. Reproduce in isolation: an
// empty card, an ink card whose stroke lacks toolId (older ink), and a normal
// card, each in its own deck; detect a frozen page via a guarded evaluate.
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";

const OLD_INK = JSON.stringify({ version: 1, page: { width: 800 }, erased: {}, strokes: [{ id: "s0", points: [[10, 10], [200, 120]], color: "#000", size: 3 }] });

test("REV-05d: reveal an empty card / old ink card", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r05d${stamp}`, fields: [] } })).json();
  const mk = async (title: string, markdown: string, parent?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  const cases: Array<[string, string, string | null]> = [["normal", "Plain body", null], ["empty", "", null], ["oldInk", "", OLD_INK], ["blankSpaces", "   \n  ", null]];
  for (const [k, md, ink] of cases) {
    const deck = await mk(`R05d ${k} deck ${stamp}`, "deck");
    const card = await mk(`R05d ${k} ${stamp}`, md, deck);
    if (ink) await req.put(`/api/nodes/${card}/attributes/ink_data`, { ...H, data: { value: ink, value_type: "text" } });
    await Promise.all([req.put(`/api/nodes/${card}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, card)]);
    const p: Page = await page.context().newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    try {
      await ready(p, `/?view=notes&node=${deck}`);
      await p.keyboard.press("Control+k");
      await p.locator(".palette-input-wrap input").fill(">Review cards");
      await p.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
      await p.locator(".review-reveal").waitFor({ timeout: 10_000 });
      const t0 = Date.now();
      const clicked = await p.locator(".review-reveal").click({ timeout: 8000 }).then(() => "ok").catch((e) => String(e).split("\n")[0].slice(0, 120));
      const alive = await Promise.race([p.evaluate(() => 1).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 6000))]);
      out[k] = { clicked, ms: Date.now() - t0, alive, body: alive ? (await p.locator(".review-card-body").innerText({ timeout: 3000 }).catch(() => "(none)")).slice(0, 80) : "(page frozen)", errors: errors.slice(0, 3) };
    } catch (e) { out[k] = { err: String(e).split("\n")[0].slice(0, 160), errors: errors.slice(0, 3) }; }
    await p.close({ runBeforeUnload: false }).catch(() => {});
  }
  console.log("REV05D " + JSON.stringify(out, null, 2));
});
