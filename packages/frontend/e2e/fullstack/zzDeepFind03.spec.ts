// Feature-audit deepening (2026-10-07): FIND-03 — wikilink / alias / heading
// anchor / part link resolution in preview, on the published site, after the
// target is renamed, and creating a missing target from a link.
// Rewritten 2026-11-18 for the current model: a part of a note is linked as `[[筆記/段落開頭]]` with a binding made by
// POST /api/nodes/:id/block-links (docs/architecture/block-nodes.md, 批 3: no `^id` in the text), and a note reaches the site
// by the space it is in (「發布到網站」), not by a per-note switch.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, publishSite, createPublishingSpace, switchNoteView, BASE, H } from "./helpers";

test("FIND-03: link forms across preview, publish, rename and missing target", async ({ page }) => {
  test.setTimeout(150_000);
  const s = Date.now();
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join("\n\n");
  const space_id = await createPublishingSpace(page.request);
  const targetMd = `top\n\n${filler}\n\n## Deep Section\n\ndeep text ${s}\n\nblock line ${s}`;
  const target = await (await page.request.post("/api/nodes", { ...H, data: { space_id, title: `Tgt${s}`, markdown: targetMd } })).json();
  const src = await (await page.request.post("/api/nodes", { ...H, data: { space_id, title: `Src${s}`, markdown: "placeholder" } })).json();
  // The part link as the editor makes it: anchor the paragraph and bind the link text (routes/blockLinks.ts).
  const made = await page.request.post(`/api/nodes/${target.id}/block-links`, { ...H, data: { source_note_id: src.id, at: targetMd.indexOf(`block line ${s}`), seen_text: `block line ${s}` } });
  expect(made.status(), await made.text()).toBe(201);
  const partLinkText = (await made.json()).link as string;
  expect(partLinkText, "the link reads 「筆記/段落開頭」, the start cut short (services/blockLinks.ts, blockLinkText)").toMatch(new RegExp(`^Tgt${s}/block line `));
  const patched = await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown:
    `plain [[Tgt${s}]]\n\nalias [[Tgt${s}|Nice Name]]\n\nheading [[Tgt${s}#Deep Section]]\n\nblock [[${partLinkText}]]\n\nmissing [[Ghost${s}]]` } });
  expect(patched.ok(), await patched.text()).toBe(true);

  // Preview: each link form shows its words (a part link reads 「筆記 › 段落開頭」, @onden/markdown blockLink.ts blockLinkWords) and opens
  // the target; the heading and the part scroll into view (the spec's header; MarkdownRenderer: a part link puts the caret on the part).
  const forms = [
    { label: "plain", words: `Tgt${s}`, inView: null },
    { label: "alias", words: "Nice Name", inView: null },
    // The heading link shows the target as written; there is no written rule for its words.
    // That it scrolls to the heading is the FINDING test below.
    { label: "heading", words: `Tgt${s}#Deep Section`, inView: null }, // pinned: today's behaviour, no written rule
    // That it scrolls to the part is the second FINDING test below.
    { label: "part", words: new RegExp(`^Tgt${s} › block line `), inView: null },
  ] as const;
  for (const form of forms) {
    await ready(page, `/?view=notes&node=${src.id}`);
    await switchNoteView(page, "preview");
    const link = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: form.words }).first();
    await expect(link, `${form.label} link is drawn`).toBeVisible();
    await expect(link).toHaveClass(/known/);
    await link.click();
    await expect(page, `${form.label} link opens the target`).toHaveURL(new RegExp(target.id));
    if (form.inView) await expect(page.locator(".cm-line, .obsidian-preview p").filter({ hasText: form.inView }).first(), `${form.label} link scrolls its place into view`).toBeInViewport();
  }

  // Missing target: it reads as a link to nothing (no `known`), clicking creates exactly one note, and the link resolves afterwards.
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  const ghost = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: `Ghost${s}` }).first();
  await expect(ghost).not.toHaveClass(/known/); // MarkdownRenderer.tsx: `known` only when the link resolves
  await ghost.click();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Ghost${s}`, { timeout: 15_000 });
  const titled = async (title: string) => ((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ title: string }>).filter((n) => n.title === title).length;
  await expect.poll(() => titled(`Ghost${s}`)).toBe(1);
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  await expect(page.locator(".obsidian-preview .wikilink-token").filter({ hasText: `Ghost${s}` }).first(), "the link resolves once the note exists").toHaveClass(/known/);

  // Publish: the public HTML links point at the target page, the heading anchor survives (with the prefix the sanitizer puts before ids,
  // markdown/src/sanitizeSchema.ts DOM_ID_PREFIX), an alias keeps its words (a part link on the site is the FINDING test below), and a link to a note that is not on the site reads the site's placeholder word, 「（未公開）」 on a zh-TW site (docs/architecture/site-render-model.md).
  await publishSite(page.request);
  const anon = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const srcSlug = (await (await page.request.get(`/api/nodes/${src.id}`, H)).json()).slug;
  const tgtSlug = (await (await page.request.get(`/api/nodes/${target.id}`, H)).json()).slug;
  const html = await (await anon.get(`/site/${srcSlug}`)).text();
  const anchors = [...html.matchAll(/<a class="published-inline-link" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], text: m[2] }));
  expect(anchors.find((a) => a.text === `Tgt${s}`), "plain link").toMatchObject({ href: `/site/${tgtSlug}` });
  expect(anchors.find((a) => a.text === "Nice Name"), "an alias keeps its words and points at the target").toMatchObject({ href: `/site/${tgtSlug}` });
  expect(anchors.find((a) => a.text === `Tgt${s}#Deep Section`), "the heading anchor survives").toMatchObject({ href: `/site/${tgtSlug}#user-content-deep-section` });
  expect(html, "the link to a note that is not on the site is hidden").not.toContain(`Ghost${s}`);
  expect(html).toContain("（未公開）");
  expect(anchors.some((a) => a.href.toLowerCase().includes("ghost")), "and is no link").toBe(false);
  await anon.dispose();

  // Rename the target: a part link names its part by an anchor, so the note's name is only a hint and it still opens the note
  // (docs/architecture/proposals/block-anchors-2026-11-01.md: 位址裡的筆記名稱只是提示，認的是 id).
  // A link by title does NOT follow a rename: the text is not rewritten and the old title reads as a link to nothing
  // (docs/research/full-feature-audit.md GAP-147, open; no decision says what a title link should do).
  await ready(page, `/?view=notes&node=${target.id}`);
  await expect(page.locator(".backlink-card:not(.backlink-card--unlinked)").filter({ hasText: `Src${s}` }).filter({ visible: true }), "before the rename the source is a mention of the target").toHaveCount(1);
  const renamed = await page.request.patch(`/api/nodes/${target.id}`, { ...H, data: { title: `Renamed${s}` } });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  const srcBody = (await (await page.request.get(`/api/nodes/${src.id}`, H)).json()).markdown as string;
  expect(srcBody, "links by title are not rewritten").toContain(`plain [[Tgt${s}]]`); // pinned: today's behaviour, no written rule (GAP-147)
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  const plain = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: new RegExp(`^Tgt${s}$`) }).first();
  await expect(plain).not.toHaveClass(/known/); // pinned: today's behaviour, no written rule (GAP-147)
  const part = page.locator(".obsidian-preview .wikilink-token").filter({ hasText: /› block line / }).first();
  await expect(part, "the part link shows the new name").toContainText(`Renamed${s} › block line `);
  await expect(part).toHaveClass(/known/);
  await part.click();
  await expect(page, "and still opens the renamed note").toHaveURL(new RegExp(target.id));
  await ready(page, `/?view=notes&node=${target.id}`);
  // The mention cards under the target (FIND-04's rule: a link makes the source a mention of its target): the source listed the
  // target while its title links resolved, and no longer does after the rename. A part link alone makes no mention at all
  // (wikilinkEdges.ts reads no part link), so nothing is left.
  await expect(page.locator(".obsidian-title-input"), "the renamed note is what is open").toHaveValue(`Renamed${s}`);
  const mentions = () => page.locator(".backlink-card:not(.backlink-card--unlinked)").filter({ hasText: `Src${s}` }).filter({ visible: true });
  await expect(mentions(), "no mention is left once the title links no longer resolve").toHaveCount(0); // pinned: today's behaviour, no written rule (GAP-147; a part link makes no mention)
});

// FINDING: a `[[Note#Heading]]` link followed from the preview opens the note at its top. What it does instead: components/OverviewPreview.tsx
// hands only (label, nodeId, blockId) to onOpenWikilink and drops the heading that MarkdownRenderer.tsx forwards "so the caller can
// scroll-to-anchor"; docs/research/full-feature-audit.md FIND-03 recorded the heading scrolled into view (2026-10-07).
test("FINDING: a heading link in the preview scrolls the heading into view", async ({ page }) => {
  test.fail();
  const s = Date.now();
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join("\n\n");
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `HTgt${s}`, markdown: `top\n\n${filler}\n\n## Deep Section\n\ndeep text ${s}` } })).json();
  const src = await (await page.request.post("/api/nodes", { ...H, data: { title: `HSrc${s}`, markdown: `heading [[HTgt${s}#Deep Section]]` } })).json();
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  await page.locator(".obsidian-preview .wikilink-token").first().click();
  await expect(page).toHaveURL(new RegExp(target.id));
  await expect(page.getByRole("heading", { name: "Deep Section" })).toBeInViewport();
});

// FINDING: a part link `[[筆記/段落開頭]]` followed from the preview opens the note at its top. What it does instead: the click only hands the
// part's place to the editor's caret (MarkdownRenderer.tsx: `?at=`, "opening it puts the caret there"), and a note shown as preview has no
// caret, so the paragraph stays 3000 px below the fold; the same handoff in the editor works (zzDeepFind04 caret handoff).
test("FINDING: a part link in the preview scrolls the part into view", async ({ page }) => {
  test.fail();
  const s = Date.now();
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join("\n\n");
  const md = `top\n\n${filler}\n\nthe far part ${s}`;
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `PTgt${s}`, markdown: md } })).json();
  const src = await (await page.request.post("/api/nodes", { ...H, data: { title: `PSrc${s}`, markdown: "placeholder" } })).json();
  const made = await page.request.post(`/api/nodes/${target.id}/block-links`, { ...H, data: { source_note_id: src.id, at: md.indexOf("the far part"), seen_text: `the far part ${s}` } });
  expect(made.status(), await made.text()).toBe(201);
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `part [[${(await made.json()).link}]]` } });
  await ready(page, `/?view=notes&node=${src.id}`);
  await switchNoteView(page, "preview");
  await page.locator(".obsidian-preview .wikilink-token").first().click();
  await expect(page).toHaveURL(new RegExp(target.id));
  await expect(page.getByText(`the far part ${s}`).first()).toBeInViewport();
});

// FINDING: a part link `[[筆記/段落開頭]]` to a published note reads 「Note › start」 and opens that page on the site
// (packages/markdown/src/servedPartLink.ts: "the served page it opens and the words it shows"; htmlUtils.ts partLink).
// What the site does instead: it reads the placeholder 「（未公開）」 with no link, because modules/website/publishing/redaction.ts runs first and takes
// `Note/start` (wikilinkTarget) for a note title that no note has.
test("FINDING: a part link to a published note is a link on the site", async ({ page }) => {
  test.fail();
  const s = Date.now();
  const space_id = await createPublishingSpace(page.request);
  const md = `top\n\nthe site part ${s}`;
  const target = await (await page.request.post("/api/nodes", { ...H, data: { space_id, title: `STgt${s}`, markdown: md } })).json();
  const src = await (await page.request.post("/api/nodes", { ...H, data: { space_id, title: `SSrc${s}`, markdown: "placeholder" } })).json();
  const made = await page.request.post(`/api/nodes/${target.id}/block-links`, { ...H, data: { source_note_id: src.id, at: md.indexOf("the site part"), seen_text: `the site part ${s}` } });
  expect(made.status(), await made.text()).toBe(201);
  await page.request.patch(`/api/nodes/${src.id}`, { ...H, data: { markdown: `part [[${(await made.json()).link}]]` } });
  await publishSite(page.request);
  const anon = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const slugOf = async (id: string) => (await (await page.request.get(`/api/nodes/${id}`, H)).json()).slug as string;
  const html = await (await anon.get(`/site/${await slugOf(src.id)}`)).text();
  const anchors = [...html.matchAll(/<a class="published-inline-link" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], text: m[2] }));
  await anon.dispose();
  expect(anchors.find((a) => a.text.startsWith(`STgt${s} › the site part`))).toMatchObject({ href: `/site/${await slugOf(target.id)}` });
});
