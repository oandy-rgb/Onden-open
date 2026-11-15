// UX-02 follow-up (2026-10-08): which visible text actually scales with the
// "Base font size" setting (14 → 22 px) on the notes view.
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";

test("UX-02b: font size scaling coverage", async ({ page }) => {
  test.setTimeout(120_000);
  const sample = () => page.evaluate(() => {
    const pick: Record<string, string> = { sidebarTitle: ".sb-item-title", topbarBtn: ".app-topbar button", editor: ".cm-content", noteTitle: ".obsidian-title-input", inspector: ".ov-prop-label", tagChip: ".sb-tag-chip, [class*=tag-chip]", toolbar: ".tiptap-toolbar-right summary" };
    const r: Record<string, string> = {};
    for (const [k, s] of Object.entries(pick)) { const el = document.querySelector(s); r[k] = el ? getComputedStyle(el).fontSize : "n/a"; }
    const all = Array.from(document.querySelectorAll("body *")).filter((e) => (e as HTMLElement).offsetParent && (e as HTMLElement).innerText?.trim() && e.children.length === 0);
    r.__leafTextCount = String(all.length);
    (window as unknown as { __sizes: string[] }).__sizes = all.map((e) => getComputedStyle(e).fontSize);
    return r;
  });
  await ready(page, "/?view=notes"); await page.evaluate(() => localStorage.setItem("theme.font_size", "14")); await page.reload(); await page.waitForTimeout(2500);
  const a = await sample(); const sa = await page.evaluate(() => (window as unknown as { __sizes: string[] }).__sizes);
  await page.evaluate(() => localStorage.setItem("theme.font_size", "22")); await page.reload(); await page.waitForTimeout(2500);
  const b = await sample(); const sb = await page.evaluate(() => (window as unknown as { __sizes: string[] }).__sizes);
  await page.evaluate(() => localStorage.removeItem("theme.font_size"));
  const n = Math.min(sa.length, sb.length); let grew = 0; for (let i = 0; i < n; i++) if (parseFloat(sb[i]) > parseFloat(sa[i])) grew++;
  console.log("UX02B " + JSON.stringify({ at14: a, at22: b, leafTextCompared: n, grew }, null, 2));
});
