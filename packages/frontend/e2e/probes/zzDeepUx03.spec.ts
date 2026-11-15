// Feature-audit deepening (2026-10-08): UX-03 — keyboard and assistive tech:
// controls without an accessible name, Tab order with a visible focus ring,
// focus trap + focus return for palette / quick capture / More actions /
// Share, toasts announced via a live region, and a mouse-free capture → find
// → open → type flow.
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("UX-03: names, focus ring, traps, return, live region, keyboard flow", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const note = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Kbd3 ${stamp}`, markdown: "body" } })).json()).id as string;
  await ready(page, `/?view=notes&node=${note}&lens=editor`); await page.waitForTimeout(1500);
  // 1) Unnamed controls on the main notes view.
  out.unnamed = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("button, a[href], [role=button], input, select, textarea, [role=checkbox], [role=tab], [role=menuitem]")) as HTMLElement[];
    const vis = els.filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden");
    const nameOf = (e: HTMLElement) => {
      const al = e.getAttribute("aria-label"); if (al?.trim()) return al;
      const lb = e.getAttribute("aria-labelledby"); if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim(); if (t) return t; }
      if ((e as HTMLInputElement).labels?.length) return Array.from((e as HTMLInputElement).labels!).map((l) => l.textContent).join(" ").trim();
      const txt = (e.innerText ?? "").trim(); if (txt) return txt;
      const ttl = e.getAttribute("title"); if (ttl?.trim()) return ttl;
      const ph = e.getAttribute("placeholder"); if (ph?.trim()) return ph;
      const img = e.querySelector("img[alt]"); if (img?.getAttribute("alt")) return img.getAttribute("alt")!;
      return "";
    };
    const missing = vis.filter((e) => !nameOf(e));
    return { visibleControls: vis.length, unnamed: missing.length, sample: missing.slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${(e.className || "").toString().split(" ")[0]}`) };
  });
  // 2) Tab through 40 stops: does each show a focus indicator?
  await page.locator(".app-topbar").click({ position: { x: 3, y: 3 } }).catch(() => {});
  const stops: Array<{ el: string; ring: boolean }> = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; if (!a || a === document.body) return { el: "body", ring: false }; const cs = getComputedStyle(a); const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none"); return { el: `${a.tagName.toLowerCase()}.${(a.className || "").toString().split(" ")[0]}`, ring: !!ring }; }));
  }
  out.tabStops = { total: stops.length, noRing: stops.filter((s) => !s.ring).length, noRingSample: [...new Set(stops.filter((s) => !s.ring).map((s) => s.el))].slice(0, 8), bodyStops: stops.filter((s) => s.el === "body").length };
  // 3) Traps and focus return.
  const trap = async (name: string, open: (p: Page) => Promise<void>, container: string) => {
    await page.locator(".cm-content").first().click(); await page.waitForTimeout(200);
    const before = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className?.toString().slice(0, 30) ?? "");
    await open(page); await page.waitForTimeout(500);
    const opened = await page.locator(container).first().isVisible().catch(() => false);
    let escaped = 0;
    for (let i = 0; i < 15; i++) { await page.keyboard.press("Tab"); if (!(await page.evaluate((sel) => !!document.activeElement?.closest(sel), container))) escaped++; }
    const dialogSemantics = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement | null; const d = c?.closest("[role=dialog], dialog, [role=menu]") ?? c?.querySelector("[role=dialog], dialog"); return d ? `${d.tagName.toLowerCase()} role=${d.getAttribute("role")} modal=${d.getAttribute("aria-modal") ?? (d.tagName === "DIALOG" ? "native" : null)}` : "none"; }, container);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    const closedByEscape = !(await page.locator(container).first().isVisible().catch(() => false));
    const after = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className?.toString().slice(0, 30) ?? "");
    if (!closedByEscape) { await page.locator(container).first().getByRole("button", { name: /Close|Cancel/ }).first().click({ timeout: 3000 }).catch(async () => { await page.mouse.click(5, 795); }); await page.waitForTimeout(400); }
    return { opened, dialogSemantics, tabsEscapingTrap: escaped, closedByEscape, focusBefore: before, focusAfter: after };
  };
  out.trapPalette = await trap("palette", async (p) => { await p.keyboard.press("Control+k"); }, ".palette-backdrop, .palette");
  out.trapCapture = await trap("capture", async (p) => { await p.keyboard.press("Control+Shift+N"); }, ".quick-capture-sheet");
  out.trapMoreActions = await trap("more", async (p) => { const b = p.getByRole("button", { name: "More actions" }).filter({ visible: true }).first(); await b.focus(); await p.keyboard.press("Enter"); }, "[role=menu][aria-label='More actions']");
  out.trapShare = await trap("share", async (p) => { const b = p.getByRole("button", { name: /^Share/ }).filter({ visible: true }).first(); await b.focus(); await p.keyboard.press("Enter"); }, "[role=dialog]");
  // 4) Toast live region.
  await page.route(`**/api/nodes/${note}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.locator(".cm-content").first().click(); await page.keyboard.type(" x"); await page.keyboard.press("Control+s"); await page.waitForTimeout(1500);
  out.toastLive = await page.evaluate(() => { const t = document.querySelector(".toast"); if (!t) return null; const region = t.closest("[aria-live], [role=status], [role=alert]") as HTMLElement | null; return { role: t.getAttribute("role"), ownLive: t.getAttribute("aria-live"), regionRole: region?.getAttribute("role") ?? null, regionLive: region?.getAttribute("aria-live") ?? null }; });
  await page.unroute(`**/api/nodes/${note}`);
  // 5) Mouse-free flow: capture → find → open → type.
  await ready(page, "/?view=notes"); await page.waitForTimeout(1200);
  await page.keyboard.press("Control+Shift+N"); await page.waitForTimeout(400);
  await page.keyboard.type(`KbdOnly ${stamp}`); await page.keyboard.press("Control+Enter"); await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k"); await page.waitForTimeout(300); await page.keyboard.type(`KbdOnly ${stamp}`); await page.waitForTimeout(1200);
  await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
  const focusAfterOpen = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}.${(a.className || "").toString().split(" ")[0]}` : "none"; });
  await page.keyboard.type(" typed-by-keyboard"); await page.waitForTimeout(2500);
  const nodes = ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title.startsWith(`KbdOnly ${stamp}`));
  const md = nodes[0] ? ((await (await page.request.get(`/api/nodes/${nodes[0].id}`)).json()).markdown as string) : "";
  out.keyboardFlow = { created: nodes.length, focusAfterOpen, typedLanded: md.includes("typed-by-keyboard"), title: await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null) };
  console.log("UX03 " + JSON.stringify(out, null, 2));
});
