// Feature-audit deepening (2026-10-08): UX-02 — appearance settings at their
// extremes (dark, 22 px, compact, reduce motion) survive reload and apply;
// the first paint is not a white flash in dark mode; every main page at 1280
// and 390 px has no horizontal overflow at 22 px; text contrast in dark; and
// "system" follows the OS colour scheme.
import { test, type Page } from "@playwright/test";
import { ready, BASE } from "../fullstack/helpers";

const VIEWS = ["notes", "tasks", "review", "rss", "tags", "website", "graph", "timeline"];

const lum = (rgb: string) => { const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number); const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };

test("UX-02: appearance extremes, first paint, overflow, contrast, system", async ({ browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const mkCtx = (w: number, h: number, scheme: "light" | "dark" = "light") => browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: w, height: h }, colorScheme: scheme });
  const set = (p: Page, kv: Record<string, string>) => p.evaluate((o) => { for (const [k, v] of Object.entries(o)) localStorage.setItem(k, v); }, kv);
  const ctx = await mkCtx(1280, 800);
  const p = await ctx.newPage();
  await ready(p, "/?view=notes");
  await set(p, { theme: "dark", "theme.font_size": "22", "theme.density": "compact", "theme.reduce_motion": "true" });
  // First paint after reload: sample the background as early as possible.
  await p.addInitScript(() => { const s = () => { (window as unknown as { __firstBg?: string }).__firstBg ??= getComputedStyle(document.documentElement).backgroundColor + " / body " + (document.body ? getComputedStyle(document.body).backgroundColor : "none"); }; document.addEventListener("DOMContentLoaded", s, { once: true }); });
  await p.reload(); await p.waitForTimeout(2500);
  out.applied = await p.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), fontVar: getComputedStyle(document.documentElement).getPropertyValue("--onden-ui-font-size-base").trim(), density: document.documentElement.getAttribute("data-density"), reduceMotion: document.documentElement.getAttribute("data-reduce-motion"), firstBg: (window as unknown as { __firstBg?: string }).__firstBg, bodyBg: getComputedStyle(document.body).backgroundColor, sidebarFont: getComputedStyle(document.querySelector(".sb-item-title") ?? document.body).fontSize }));
  out.contrast = await p.evaluate(() => {
    const pick = (sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; if (!el) return null; let bgEl: HTMLElement | null = el; let bg = "rgba(0, 0, 0, 0)"; while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; } return { fg: getComputedStyle(el).color, bg }; };
    return { sidebar: pick(".sb-item-title"), topbar: pick(".app-topbar button"), muted: pick(".sb-bar-btn") };
  });
  for (const [k, v] of Object.entries(out.contrast as Record<string, { fg: string; bg: string } | null>)) if (v) (out.contrast as Record<string, unknown>)[k] = { ...v, ratio: ratio(v.fg, v.bg) };
  // Reduce motion: any running CSS animation/transition longer than 0.05s?
  out.motion = await p.evaluate(() => { const els = Array.from(document.querySelectorAll("*")).slice(0, 3000) as HTMLElement[]; const long = els.filter((e) => { const cs = getComputedStyle(e); const d = (s: string) => s.split(",").map((x) => parseFloat(x) * (x.includes("ms") ? 0.001 : 1)); return Math.max(...d(cs.transitionDuration), ...d(cs.animationDuration)) > 0.05; }); return { elementsWithMotion: long.length, sample: long.slice(0, 3).map((e) => e.className.toString().slice(0, 30)) }; });
  const overflow: Record<string, number> = {};
  for (const v of VIEWS) { await ready(p, `/?view=${v}`); await p.waitForTimeout(1200); const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > 1281) overflow[`1280:${v}`] = sw; }
  await ctx.close();
  const ph = await mkCtx(390, 844);
  const pp = await ph.newPage();
  await ready(pp, "/?view=notes");
  await set(pp, { theme: "dark", "theme.font_size": "22", "theme.density": "compact" });
  for (const v of VIEWS) { await ready(pp, `/?view=${v}`); await pp.waitForTimeout(1200); const sw = await pp.evaluate(() => document.documentElement.scrollWidth); if (sw > 391) overflow[`390:${v}`] = sw; }
  await pp.evaluate(() => { for (const k of ["theme", "theme.font_size", "theme.density", "theme.reduce_motion"]) localStorage.removeItem(k); });
  await ph.close();
  out.overflowAt22px = overflow;
  // System follows OS.
  const sys = await mkCtx(1280, 800, "dark");
  const sp = await sys.newPage();
  await ready(sp, "/?view=notes");
  await sp.evaluate(() => localStorage.setItem("theme", "system")); await sp.reload(); await sp.waitForTimeout(2000);
  out.systemDark = await sp.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await sp.evaluate(() => localStorage.removeItem("theme"));
  await sys.close();
  console.log("UX02 " + JSON.stringify(out, null, 2));
});
