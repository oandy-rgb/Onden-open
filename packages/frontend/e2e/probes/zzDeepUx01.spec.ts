// Feature-audit deepening (2026-10-09, tick 20): UX-01 — visual matrix.
// Every main view at 1280 / 390 / 320 px: horizontal overflow, elements cut off
// at the right edge, page errors. A very long note (long CJK title, an
// unbroken 2 000-char token, a wide table, a long code line). A slow first load
// (bootstrap delayed) and a failed first load (bootstrap 500) on a cold page.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";

const VIEWS = ["notes", "tasks", "timeline", "graph", "tags", "website", "review", "rss", "history", "trash", "settings"];

async function measure(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const cut = new Set<string>();
    for (const e of Array.from(document.querySelectorAll("body *"))) {
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed" && r.left >= vw) continue;
      if (r.right > vw + 2 || r.left < -2) {
        // Ignore content inside its own horizontal scroller.
        let p: HTMLElement | null = e.parentElement; let scrolled = false;
        while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll" || o === "hidden" || o === "clip") && p.getBoundingClientRect().right <= vw + 2) { scrolled = true; break; } p = p.parentElement; }
        if (!scrolled) cut.add(`${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(" ")[0]}`.slice(0, 50));
      }
    }
    return { docScroll: document.documentElement.scrollWidth, vw, cut: [...cut].slice(0, 6), textLen: document.body.innerText.length };
  });
}

test("UX-01 visual matrix", async ({ page, browser }) => {
  test.setTimeout(900_000);
  const out: Record<string, unknown> = {};
  const req = page.request; const s = Date.now();
  const longTitle = `長標題測試 ${"這是一個非常長的筆記標題用來檢查換行與截斷".repeat(6)} ${s}`;
  const token = "x".repeat(2000);
  const body = `# ${longTitle}\n\n${token}\n\nhttps://example.com/${"a".repeat(400)}\n\n| ${Array.from({ length: 14 }, (_, i) => `column ${i}`).join(" | ")} |\n|${" --- |".repeat(14)}\n| ${Array.from({ length: 14 }, () => "cell value").join(" | ")} |\n\n\`\`\`\n${"const veryLongIdentifierName = 1; ".repeat(30)}\n\`\`\`\n`;
  const note = (await (await req.post("/api/nodes", { ...H, data: { title: longTitle, markdown: body } })).json()) as { id: string };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  try {
    for (const [w, h] of [[1280, 800], [390, 780], [320, 640]]) {
      await page.setViewportSize({ width: w, height: h });
      const row: Record<string, unknown> = {};
      for (const v of VIEWS) {
        await ready(page, `/?view=${v}`);
        await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const landed = new URL(page.url()).searchParams.get("view");
        const m = await measure(page);
        row[v] = { landed, ...m };
        if (m.docScroll > w + 2 || m.cut.length) await page.screenshot({ path: test.info().outputPath(`${w}-${v}.png`) });
      }
      await ready(page, `/?view=notes&node=${note.id}`);
      await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      row.longNote = await measure(page);
      await page.screenshot({ path: test.info().outputPath(`${w}-longnote.png`) });
      out[String(w)] = row;
    }
    // Slow and failed first load, cold context (no local cache).
    for (const [w, h] of [[1280, 800], [390, 780]]) {
      for (const mode of ["slow", "fail"] as const) {
        const ctx = await browser.newContext({ baseURL: BASE, storageState: test.info().project.use.storageState as string, viewport: { width: w, height: h } });
        const p = await ctx.newPage();
        await p.route("**/api/bootstrap*", async (r) => { if (mode === "slow") { await new Promise((x) => setTimeout(x, 6000)); await r.continue(); } else await r.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"boom\"}" }); });
        await p.goto(`${BASE}/?view=notes`).catch(() => {});
        await p.waitForTimeout(2500);
        const early = { text: (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200), ...(await measure(p)) };
        await p.screenshot({ path: test.info().outputPath(`${w}-${mode}-early.png`) });
        await p.waitForTimeout(mode === "slow" ? 8000 : 6000);
        const late = { text: (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200), ...(await measure(p)), buttons: await p.locator("button").filter({ visible: true }).allInnerTexts().then((b) => b.slice(0, 8)) };
        await p.screenshot({ path: test.info().outputPath(`${w}-${mode}-late.png`) });
        out[`${mode}${w}`] = { early, late };
        await ctx.close();
      }
    }
    out.pageErrors = [...new Set(errors)].slice(0, 8);
  } finally {
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("UX01 " + JSON.stringify(out, null, 1));
  }
});
