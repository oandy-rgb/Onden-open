// ⑩ custom appearance — owner CSS on the published site (Notion can't do
// this). (1) The site's design carries its CSS through publish into the SSR'd
// <style>, scoped to `.site-scope` (an `@scope` block), with the </style> escape neutralised (the
// pages themselves are in sitePages.spec.ts); (2) the single-note HTML export
// carries the workspace's custom CSS. (The old Website-studio Design tab that
// also exposed the textarea is gone; the home studio's site CSS is covered by
// siteStudioHome.spec.ts.)
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { ready, defaultSpaceId, markPublished, publishSite, requireAdmin, siteDesign, H } from "./helpers";


test("custom CSS flows design → publish → served <style>, scoped and escape-proof", async ({ page }) => {
  const stamp = Date.now();
  const mark = `cc-${stamp}`;
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `CssProbe ${stamp}`, markdown: `# CssProbe\n\nbody ${stamp}` },
  })).json();
  await markPublished(page.request, node.id);

  // An owner CSS string carrying a unique marker AND an injection attempt.
  const css = `/* ${mark} */ .s-article__title{color:rgb(7,8,9)} a{}</style><script>window.__pwned=1</script>`;
  const saved = await page.request.patch("/api/workspace/config", { ...H, data: { chrome: siteDesign({ css }) } });
  requireAdmin(saved.status() !== 403, "config needs the owner; run on a fresh stack");
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await publishSite(page.request);

  // 1) the served design carries the CSS
  const site = await (await page.request.get("/api/site", H)).json();
  expect(site.payload.presentation.design.css).toContain(mark);

  // 2) the SSR'd page injects it into a <style> inside the site scope — and the
  //    </style> closer was neutralised, so the smuggled <script> never becomes a real tag.
  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain(mark);
  expect(html).toContain(".s-article__title{color:rgb(7,8,9)}");
  expect(html).toMatch(/@scope \(\.site-scope\) \{\s*:scope \{[^}]*cc-/s);
  expect(html).not.toContain("</style><script>window.__pwned");
});

test("single-note HTML export: themed, self-contained, carries custom CSS", async ({ page }) => {
  const stamp = Date.now();
  const mark = `ex-${stamp}`;
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `ExportProbe ${stamp}`, markdown: `# ExportProbe\n\nbody ${stamp} **bold**` },
  })).json();
  await page.request.patch("/api/workspace/config", { ...H, data: { config: { custom_css: `/* ${mark} */ h1{color:teal}`, accent: "#0a7d6b" } } });

  const res = await page.request.get(`/api/nodes/${node.id}/export.html`, H);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain(".html");
  const html = await res.text();
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain(`body ${stamp} <strong>bold</strong>`); // rendered note body
  expect(html).toContain("<style>");           // self-contained (inline CSS)
  expect(html).toContain(mark);                  // owner custom CSS rode along
  expect(html).not.toContain('class="site-nav"'); // no site chrome
});

test("palette 'Export this note as HTML' downloads a file", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `DlProbe ${stamp}`, markdown: "# DlProbe\n\nbody" },
  })).json();
  await ready(page, `/?view=notes&node=${node.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });

  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">export note as html");
  await page.locator(".palette-item", { hasText: "Export this note as HTML" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});

test("HTML preview renders the current draft without saving it", async ({ page }) => {
  const stamp = Date.now();
  const saved = `Saved body ${stamp}`;
  const draft = `Draft body ${stamp}`;
  const created = await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `PreviewProbe ${stamp}`, markdown: saved },
  });
  expect(created.status()).toBe(201);
  const node = await created.json();
  try {
    const preview = await page.request.post(`/api/nodes/${node.id}/export-preview`, {
      ...H, data: { title: `Draft title ${stamp}`, markdown: `# ${draft}` },
    });
    expect(preview.status()).toBe(200);
    const { html } = await preview.json();
    expect(html).toContain(draft);
    expect(html).toContain(`Draft title ${stamp}`);
    expect(html).not.toContain(saved);
    const persisted = await (await page.request.get(`/api/nodes/${node.id}`, H)).json();
    expect(persisted.markdown).toBe(saved);
    expect(persisted.title).toBe(`PreviewProbe ${stamp}`);
  } finally {
    await page.request.delete(`/api/nodes/${node.id}`, H);
  }
});

test("320px note menu exports HTML inside the viewport", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 500 });
  const stamp = Date.now();
  const body = `Mobile export ${stamp}`;
  const created = await page.request.post("/api/nodes", {
    ...H, data: { space_id: await defaultSpaceId(page.request), title: `MobileExportProbe ${stamp}`, markdown: body },
  });
  expect(created.status()).toBe(201);
  const node = await created.json();
  try {
    await ready(page, `/?view=notes&node=${node.id}`);
    await page.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: "More actions" });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    // 320px is a phone: ⋯ is a bottom sheet whose Export tile opens the choices.
    await menu.getByRole("menuitem", { name: "Export", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await menu.getByRole("group", { name: "Export as" }).getByRole("menuitem", { name: "HTML" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    expect(await readFile(await download.path(), "utf8")).toContain(body);
    await page.screenshot({ path: "/tmp/pw-output/shots/note-html-export-320.png" });
  } finally {
    await page.request.delete(`/api/nodes/${node.id}`, H);
  }
});
