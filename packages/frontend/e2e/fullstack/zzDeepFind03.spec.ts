// Feature-audit deepening (2026-10-07): FIND-03 — wikilink / alias / heading
// anchor / block id resolution in preview, on the published site, after the
// target is renamed, and creating a missing target from a link.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, publishSite, switchNoteView, BASE, H } from "./helpers";


test("FIND-03: link forms across preview, publish, rename and missing target", async ({ page }) => {
  test.setTimeout(150_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join("\n\n");
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `Tgt${s}`, markdown: `top\n\n${filler}\n\n## Deep Section\n\ndeep text ${s}\n\nblock line ${s}` } })).json();
  const src = await (await page.request.post("/api/nodes", { ...H, data: { title: `Src${s}`, markdown:
    `plain [[Tgt${s}]]\n\nalias [[Tgt${s}|Nice Name]]\n\nheading [[Tgt${s}#Deep Section]]\n\nblock [[Tgt${s}/block line ${s}]]\n\nmissing [[Ghost${s}]]` } })).json();

  // Preview: each link form opens the target; heading/block scroll into view.
  for (const [label, text] of [["plain", `Tgt${s}`], ["alias", "Nice Name"], ["heading", "Deep Section"], ["block", `block line ${s}`]] as const) {
    await ready(page, `/?view=notes&node=${src.id}`);
    await switchNoteView(page, "preview");
    const link = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: text }).first();
    const visibleText = await link.innerText().catch(() => "(no link)");
    await link.click().catch(() => {});
    await page.waitForTimeout(1500);
    const onTarget = page.url().includes(target.id);
    const deepVisible = await page.locator(".cm-line, .obsidian-preview *", { hasText: label === "block" ? `block line ${s}` : `deep text ${s}` }).first().isVisible().catch(() => false);
    out[`preview.${label}`] = `shown=${JSON.stringify(visibleText)} opensTarget=${onTarget} anchorInView=${label === "plain" || label === "alias" ? "n/a" : deepVisible}`;
  }

  // Missing target: clicking creates it and links resolve afterwards.
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  const ghost = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: `Ghost${s}` }).first();
  out.missingClass = (await ghost.getAttribute("class")) ?? "";
  await ghost.click();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Ghost${s}`, { timeout: 15_000 });
  const ghosts = ((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ title: string }>).filter((n) => n.title === `Ghost${s}`).length;
  out.missingCreated = `copies=${ghosts}`;

  // Publish both: the public HTML links point at the target page; the anchor survives.
  for (const id of [target.id, src.id]) await page.request.put(`/api/nodes/${id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page.request); // snapshot model B: opt-in alone does not reach the site
  const anon = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const srcSlug = (await (await page.request.get(`/api/nodes/${src.id}`, H)).json()).slug;
  const tgtSlug = (await (await page.request.get(`/api/nodes/${target.id}`, H)).json()).slug;
  const html = await (await anon.get(`/site/${srcSlug}`)).text();
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h.includes(tgtSlug) || h.toLowerCase().includes("ghost"));
  out.publishedHrefs = JSON.stringify(hrefs.slice(0, 6));
  out.publishedAliasText = String(html.includes("Nice Name"));
  out.ghostOnSite = String(html.includes(`Ghost${s}`) && /href="[^"]*ghost/i.test(html));

  // Rename the target: do existing links follow?
  await page.request.patch(`/api/nodes/${target.id}`, { ...H, data: { title: `Renamed${s}` } });
  await page.waitForTimeout(1500);
  const srcBody = (await (await page.request.get(`/api/nodes/${src.id}`, H)).json()).markdown as string;
  out.afterRenameBody = JSON.stringify(srcBody.split("\n").filter(Boolean).slice(0, 4));
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  const plain = page.locator(".obsidian-preview .wikilink-token").first();
  out.afterRenameLink = `class=${await plain.getAttribute("class")} text=${JSON.stringify(await plain.innerText())}`;
  await plain.click(); await page.waitForTimeout(1500);
  out.afterRenameOpens = String(page.url().includes(target.id));
  const backlinks = await (await page.request.get(`/api/nodes/${target.id}/backlinks`, H)).text().catch(() => "");
  out.backlinksAfterRename = String(backlinks.includes(src.id));
  await anon.dispose();
  console.log(`AUDIT FIND-03 ${JSON.stringify(out)}`);
});
