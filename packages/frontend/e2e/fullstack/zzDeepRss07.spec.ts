// Feature-audit deepening (2026-10-07): RSS-07 — OPML through the UI (since
// 2026-10-12 under 「設定」 on the RSS card in the module library, since
// 2026-10-17 in Settings › Modules):
// real file chooser, mixed/partial content, junk file, download and re-import,
// desktop and phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openModuleCard, ready, BASE, H } from "./helpers";


async function openRssSettings(page: Page) {
  const imported = await page.request.patch("/api/workspace/modules", {
    headers: H.headers, data: { module: "rss", imported: true },
  });
  expect(imported.ok(), "importing RSS (needs the owner)").toBe(true);
  await ready(page, "/?view=tags");
  const card = await openModuleCard(page, "rss", { settings: true });
  await expect(card.getByText("Import subscriptions (.opml)")).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`RSS-07 @${viewport.width}px: import via file chooser, export download, re-import`, async ({ browser, page: base }) => {
    test.setTimeout(120_000);
    const phone = viewport.width < 600;
    const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport, baseURL: BASE, acceptDownloads: true });
    const page = await ctx.newPage();
    const stamp = Date.now();
    const a = `http://localhost:5099/feeds/ui-a-${stamp}.xml`, b = `http://localhost:5099/feeds/ui-b-${stamp}.xml`;
    const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>
      <outline text="UI A ${stamp}" xmlUrl="${a}"/><outline text="UI B ${stamp}" xmlUrl="${b}"/>
      <outline text="Broken ${stamp}" xmlUrl="not a url ${stamp}"/></body></opml>`;
    const out: Record<string, string> = {};
    out.viewport = phone ? "phone" : "desktop";
    const opened = await openRssSettings(page).then(() => true).catch((e) => { out.open = String(e).slice(0, 120); return false; });
    await page.screenshot({ path: `/tmp/pw-output/rss07-${viewport.width}.png`, fullPage: true });
    if (!opened) { console.log(`AUDIT RSS-07 ${viewport.width}px ${JSON.stringify(out)}`); await ctx.close(); return; }

    const importFile = async (name: string, content: string) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByText("Import subscriptions (.opml)").click();
      await (await chooser).setFiles({ name, mimeType: "text/xml", buffer: Buffer.from(content) });
      await expect(page.getByText("Importing…")).toHaveCount(0, { timeout: 15_000 });
      const hints = await page.locator(".settings-hint").allInnerTexts();
      return hints.filter((h) => /Imported \d+ feed|subscri|feeds found|failed|error|OPML|422|400/i.test(h) && !/Subscriptions live as ordinary/.test(h)).join(" | ") || "(no result line)";
    };
    out.firstImport = await importFile("subs.opml", opml);
    out.junk = await importFile("junk.opml", "<html>not opml</html>");

    const dl = page.waitForEvent("download");
    await page.getByText("Export subscriptions (.opml)").click();
    const download = await dl;
    const file = await download.path();
    const xml = file ? readFileSync(file, "utf8") : "";
    out.export = `name=${download.suggestedFilename()} hasA=${xml.includes(a)} hasB=${xml.includes(b)} hasBroken=${xml.includes("not a url")} bytes=${xml.length}`;
    out.reimport = await importFile("roundtrip.opml", xml);
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    out.layout = `docWidth=${docWidth}`;
    console.log(`AUDIT RSS-07 ${viewport.width}px ${JSON.stringify(out)}`);
    await ctx.close();
  });
}
