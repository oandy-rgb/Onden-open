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
    const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport, baseURL: BASE, acceptDownloads: true });
    const page = await ctx.newPage();
    const stamp = Date.now();
    const a = `http://localhost:5099/feeds/ui-a-${stamp}.xml`, b = `http://localhost:5099/feeds/ui-b-${stamp}.xml`;
    const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>
      <outline text="UI A ${stamp}" xmlUrl="${a}"/><outline text="UI B ${stamp}" xmlUrl="${b}"/>
      <outline text="Broken ${stamp}" xmlUrl="not a url ${stamp}"/></body></opml>`;
    await openRssSettings(page);

    // The one line the import leaves behind (modules/rss/RssOpmlWidget.tsx): what was imported, what was skipped, or why nothing was.
    const result = page.locator(".settings-hint").filter({ hasText: /^(Imported|That file)/ });
    const importFile = async (name: string, content: string) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByText("Import subscriptions (.opml)").click();
      await (await chooser).setFiles({ name, mimeType: "text/xml", buffer: Buffer.from(content) });
      await expect(page.getByText("Importing…")).toHaveCount(0, { timeout: 15_000 });
      await expect(result).toHaveCount(1);
      return (await result.innerText()).trim();
    };
    const sourcesWith = async (url: string) => (((await (await page.request.get("/api/rss/sources", H)).json()).sources ?? []) as Array<{ url: string }>).filter((s) => s.url === url).length;
    // A file with two feeds and one entry that is no address: the two are imported, the broken entry makes no subscription
    // (modules/rss/subscriptions.ts importOpml: parseOpml drops it; a new feed is checked by its first fetch).
    expect(await importFile("subs.opml", opml)).toBe("Imported 2 feeds. First articles arrive in Reading › RSS shortly.");
    expect(await sourcesWith(a)).toBe(1);
    expect(await sourcesWith(b)).toBe(1);
    // A file that is not OPML says so (lib/serverSentences.ts: "no feeds found in the OPML").
    expect(await importFile("junk.opml", "<html>not opml</html>")).toBe("That file has no subscriptions in it.");

    // Export downloads the readable subscriptions as onden-subscriptions.opml: both imported feeds, not the broken entry.
    const dl = page.waitForEvent("download");
    await page.getByText("Export subscriptions (.opml)").click();
    const download = await dl;
    expect(download.suggestedFilename()).toBe("onden-subscriptions.opml");
    const xml = readFileSync((await download.path())!, "utf8");
    expect(xml).toContain(a);
    expect(xml).toContain(b);
    expect(xml, "the broken entry was never a subscription").not.toContain("not a url");
    // Re-importing the export: every entry is either imported or skipped as already subscribed (the workspace holds other feeds too, so the
    // totals are compared with the file), and our two feeds are not subscribed twice.
    const entries = new Set(xml.match(/xmlUrl="[^"]*"/g) ?? []).size; // one subscription per distinct address (parseOpml folds repeats)
    const reimport = await importFile("roundtrip.opml", xml);
    const m = /^Imported (\d+) feeds?(?:, skipped (\d+) already subscribed)?\./.exec(reimport);
    expect(m, reimport).not.toBeNull();
    expect(Number(m![1]) + Number(m![2] ?? 0), "every distinct address of the file is accounted for").toBe(entries);
    expect(Number(m![2] ?? 0), "at least our two feeds were skipped").toBeGreaterThanOrEqual(2);
    expect(await sourcesWith(a), "not subscribed twice").toBe(1);
    expect(await sourcesWith(b), "not subscribed twice").toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll").toBeLessThanOrEqual(viewport.width);
    await ctx.close();
  });
}
