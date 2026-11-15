// Feature-audit deepening (2026-10-08): NAV-04 — run every command-palette
// action from a note context and record what visibly happens (navigation,
// download, toast, nothing), disabled rows with their reason, plus search
// while the search request fails and while offline.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("NAV-04: every palette action, disabled reasons, search failure/offline", async ({ page, context }) => {
  test.setTimeout(420_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
  const mkNote = async () => {
    const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Pal ${stamp}-${Math.random().toString(36).slice(2, 6)}`, markdown: "# H1\n\none\n\n# H2\n\ntwo\n\n- [ ] item a\n- [ ] item b" } })).json()).id as string;
    await page.request.post("/api/nodes", { ...H, data: { title: `PalKid ${stamp}`, markdown: "kid", parent_id: id } });
    return id;
  };
  const open = async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").waitFor({ timeout: 5000 }); await page.waitForTimeout(300); };
  await ready(page, `/?view=notes&node=${await mkNote()}&lens=editor`);
  await page.waitForTimeout(1200);
  await open();
  const rows = await page.locator(".palette-item, [role=option]").evaluateAll((els) => els.map((e) => ({ label: (e.querySelector(".palette-label, .palette-item-label") as HTMLElement | null)?.innerText ?? (e as HTMLElement).innerText.split("\n")[0], disabled: e.getAttribute("aria-disabled") === "true" || e.classList.contains("disabled") || (e as HTMLButtonElement).disabled, hint: (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 80) })));
  out.rows = rows.length;
  const results: Record<string, unknown> = {};
  const skip = /Download all notes|Export workspace/; // large downloads; covered by DATA rows
  for (const r of rows) {
    const label = r.label.trim();
    if (!label || results[label] || skip.test(label)) continue;
    if (r.disabled) { results[label] = { disabled: true, hint: r.hint }; continue; }
    await ready(page, `/?view=notes&node=${await mkNote()}&lens=editor`); await page.waitForTimeout(800);
    await open();
    await page.locator(".palette-input-wrap input").fill(label);
    await page.waitForTimeout(400);
    const before = page.url();
    const nToast = await page.locator(".toast").count();
    const dl = page.waitForEvent("download", { timeout: 2500 }).catch(() => null);
    const popup = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
    await page.locator(".palette-item, [role=option]").filter({ hasText: label }).first().click({ timeout: 4000 }).catch((e) => { results[label] = { clickErr: String(e).slice(0, 60) }; });
    if (results[label]) continue;
    await page.waitForTimeout(1500);
    const d = await dl; const pp = await popup; if (pp) await pp.close().catch(() => {});
    results[label] = {
      paletteClosed: !(await page.locator(".palette-input-wrap input").isVisible().catch(() => false)),
      urlChanged: page.url() !== before ? page.url().replace(BASE, "").slice(0, 40) : false,
      download: d ? d.suggestedFilename() : null, popup: !!pp,
      newToasts: (await page.locator(".toast").allInnerTexts()).slice(nToast).map((t) => t.replace(/\s+/g, " ").slice(0, 70)),
      dialog: await page.locator("[role=dialog]").filter({ visible: true }).count(),
    };
  }
  out.actions = results;
  out.pageErrors = errs;
  // Search failure and offline.
  await ready(page, "/?view=notes"); await page.waitForTimeout(800);
  await page.route("**/api/search**", (r) => r.fulfill({ status: 503, body: "{}" }));
  await open(); await page.locator(".palette-input-wrap input").fill(`Pal ${stamp}`); await page.waitForTimeout(1500);
  out.searchFail = (await page.locator(".palette-backdrop, .palette").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  await page.unroute("**/api/search**");
  await page.keyboard.press("Escape");
  await context.setOffline(true); await page.waitForTimeout(800);
  await open(); await page.locator(".palette-input-wrap input").fill(`Pal ${stamp}`); await page.waitForTimeout(1500);
  out.searchOffline = (await page.locator(".palette-backdrop, .palette").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  await context.setOffline(false);
  console.log("NAV04 " + JSON.stringify(out, null, 2));
});
