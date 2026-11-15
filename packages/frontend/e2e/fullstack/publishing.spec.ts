import { test, expect, type Page } from "@playwright/test";
import { ready, requireAdmin, openInfoFunctions, openPublishRow, defaultSpaceId, createPublishingSpace, H, publishRequest } from "./helpers";

// Behaviour-driven journeys over WEBSITE PUBLISHING — a motivation-priority
// surface, hardened here around the D9 opt-in privacy guarantee (private nodes
// must NEVER reach the public site). Fully exercisable on the isolated stack:
// with no GitHub creds the Pages push NOOPs and the site serves at /site/.
// Per-test stamp keeps it idempotent against the shared onden_test DB.

async function siteNodes(page: Page): Promise<Array<{ id: string; slug: string }>> {
  const s = await (await page.request.get("/api/site")).json();
  return s.payload?.nodes ?? s.nodes ?? [];
}

// The site shows the last published snapshot (snapshot model B,
// docs/architecture/site-render-model.md): a note in a space that publishes is
// in the next snapshot unless it is kept off, and it reaches readers at the
// owner's next Publish. Taking a note down is immediate. Publishing needs the
// preview's hash (publishRequest previews first), as the studio does.
async function publishSite(page: Page) {
  const res = await publishRequest(page.request, {});
  requireAdmin(res.status() !== 403, "publish needs admin; reset the stack");
  expect(res.status()).toBe(201);
}

// 1 — A note in a space that publishes is on the site unless kept off: the info panel's 「網站」 row says where it
//     stands, it goes public at the next Publish, 「不發布」 takes it down at once and 「放回網站」 returns it.
test("a note in a publishing space is on the site until it is kept off", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `Toggle ${stamp}`, markdown: "body" } })).json();
  await ready(page, `/?view=notes&node=${node.id}`);

  await openInfoFunctions(page);
  const { row, unpublish, putBack } = await openPublishRow(page);
  await expect(unpublish).toBeVisible();                                        // on the site by default, no step to take
  expect((await siteNodes(page)).some((n) => n.id === node.id)).toBe(false);   // but readers get it at the next publish
  const siteState = async () => (await (await page.request.get(`/api/site/status/${node.id}`)).json()).state;
  expect(await siteState()).toBe("not_on_site");                                // what the publish row's status line says
  await publishSite(page);
  await expect.poll(async () => (await siteNodes(page)).some((n) => n.id === node.id)).toBe(true); // now served
  expect(await siteState()).toBe("current");

  await unpublish.click();
  await expect(putBack).toBeVisible();                                          // 「放回網站」 replaces 「不發布」
  await expect.poll(async () => (await siteNodes(page)).some((n) => n.id === node.id)).toBe(false); // kept off immediately
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).attrs?._published).toBe("false");
  await putBack.click();
  await expect(row.locator("[data-action='unpublish']")).toBeVisible();         // back among the notes the site takes
});

// We assert against the SERVED HTML (page.request.get) — the authoritative
// published output a user/crawler receives before any JS runs — rather than the
// hydrated DOM (the published pages are plain server-rendered HTML; the only
// script is the header search).

// 2 — SECURITY: a private node's content must NOT leak in the served /site HTML.
test("a private node does not leak at /site/[slug]", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const secret = `TOPSECRET${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Secret ${stamp}`, markdown: `# Secret\n\n${secret} do not leak` } })).json();
  // never toggled public → absent from the D9 serve-time allowlist…
  expect((await siteNodes(page)).some((n) => n.id === node.id)).toBe(false);
  // …and its body never appears in the served page HTML.
  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).not.toContain(secret);
});

// 2.5 — SECURITY (Bases trust boundary): an `onden-base` query block in a
//       PUBLISHED note must not surface a PRIVATE note's content. Bases run
//       client-side over the published payload, which is read-policy/publish
//       filtered, so the private note is never in the set the base can match.
test("a published base query cannot leak a private note", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const secret = `SECRETLEAK${stamp}`;
  const tag = `leaktag${stamp}`;
  // Private note carrying the tag the base will query + a secret marker.
  await (await page.request.post("/api/nodes", { ...H, data: {
    space_id: await defaultSpaceId(page.request),
    title: `Private ${stamp}`, markdown: `# Private\n\n${secret} — #${tag}`,
  } })).json();
  // Public note whose body embeds a base that lists everything with that tag.
  const baseBlock = "```onden-base\n"
    + "views:\n  - type: list\n    name: Leak\n    filters:\n      and:\n"
    + `        - 'file.hasTag("${tag}")'\n`
    + "```";
  const pub = await (await page.request.post("/api/nodes", { ...H, data: {
    space_id: await defaultSpaceId(page.request),
    title: `Hub ${stamp}`, markdown: `# Hub ${stamp}\n\n${baseBlock}`,
  } })).json();
  await page.request.put(`/api/nodes/${pub.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page);

  // The private note never reaches the served page — not its marker, not its title.
  const html = await (await page.request.get(`/site/${pub.slug}`)).text();
  expect(html).not.toContain(secret);
  expect(html).not.toContain(`Private ${stamp}`);
});

// 3 — A published node renders its markdown into the served /site HTML.
test("a published page renders its markdown", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const marker = `HELLOPUB${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `Public ${stamp}`, markdown: `# Heading ${stamp}\n\n${marker} is visible.` } })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page);

  const res = await page.request.get(`/site/${node.slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain(marker);            // body rendered into the page
  expect(html).toContain(`Heading ${stamp}`); // markdown heading → HTML
});

// 3.5 — A ```mermaid block in a published note stays readable code. Diagrams are
//       drawn in the browser and the published pages ship no script but the
//       search, so the fence is shown as code (not an empty box).
test("a published note keeps a mermaid fence as readable code", async ({ page }) => {
  const stamp = Date.now();
  const md = `# Diagram ${stamp}\n\n\`\`\`mermaid\ngraph TD; A${stamp}-->B${stamp};\n\`\`\`\n`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `Diagram ${stamp}`, markdown: md } })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishSite(page);

  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain("language-mermaid");
  expect(html).toContain(`graph TD; A${stamp}--&gt;B${stamp};`); // the source, escaped
  expect(html).not.toContain('class="md-mermaid"');
  await page.goto(`/site/${node.slug}`, { waitUntil: "load" });
  await expect(page.locator("pre", { hasText: `A${stamp}-->B${stamp}` })).toBeVisible();
});

// 4 — POST /api/publish succeeds on a stack with no GitHub configured.
test("publish build succeeds without GitHub configured", { tag: "@critical" }, async ({ page }) => {
  const res = await publishRequest(page.request, {});
  requireAdmin(res.status() !== 403, "publish needs admin; reset the stack");
  expect(res.status()).toBe(201);
  const j = await res.json();
  expect(j.url).toBe("/site/");      // local artifact ref (no GitHub push)
  expect(j.snapshot?.id).toBeTruthy();
});

// 4.5 — D9 confidence: the studio's Publish button first shows exactly which
//       notes will be public; confirming runs the real publish.
test("publish shows the what's-public list before running", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const pub = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await createPublishingSpace(page.request), title: `WhatPub ${stamp}`, markdown: "public body" } })).json();
  await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `PrivNote ${stamp}`, markdown: "private body" } })).json();
  await page.request.put(`/api/nodes/${pub.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  // Owner probe — the same gate POST /api/publish enforces.
  const probe = await page.request.patch("/api/workspace/config", { ...H, data: { config: {} } });
  requireAdmin(probe.status() !== 403, "publish needs the owner; reset the stack");

  await ready(page, "/?view=website");
  await page.locator(".pub-publish-button").click();
  const dialog = page.locator(".publish-preview-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".publish-preview-list li", { hasText: `WhatPub ${stamp}` })).toBeVisible();
  await expect(dialog.locator(".publish-preview-list li", { hasText: `PrivNote ${stamp}` })).toHaveCount(0);

  await dialog.locator(".publish-preview-confirm").click();
  await expect(dialog).toHaveCount(0);
  // The confirm actually published: the served set contains the public note.
  await expect.poll(async () => (await siteNodes(page)).some((n) => n.id === pub.id), { timeout: 15_000 }).toBe(true);
});

// 5 — Export returns a non-empty zip of the workspace. The workspace archive
//     is GET /api/export/markdown.zip (GET /api/export was dropped in 4ba86e9f).
test("export returns a workspace zip", { tag: "@critical" }, async ({ page }) => {
  const res = await page.request.get("/api/export/markdown.zip");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("zip");
  expect((await res.body()).length).toBeGreaterThan(0);
});
