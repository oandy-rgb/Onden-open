import { test, expect, type Page } from "@playwright/test";
import { ready, openSettingsFromAvatar, renderSettled, defaultSpaceId, seedLayout, publishSite, H } from "./helpers";

// STATE GALLERY — self-verification screenshots (NOT assertions). One PNG for
// every major UI state so the owner can review the whole surface at once. The
// emphasis (per the brief): dark mode, EN↔中文 (zh-TW) switch, and each
// node-type / lens / place surface. PNGs land in /tmp/pw-output/shots (mirrored
// to the host by fullstack/run.sh). See memory frontend-self-verify.
//
// Mechanisms (verified by code-read — file:line cited in the agent report):
//   • THEME  — localStorage["theme"] = "dark" | "light". applyPersistedSettings()
//     (main.tsx:10) runs at boot and replays theme.dark's set() which writes
//     document.documentElement[data-theme] (settings/registry.tsx:663-668). So
//     seeding localStorage BEFORE load + reloading applies the theme with no
//     first-paint flash.
//   • LOCALE — localStorage["onden.locale"] = "en" | "zh-TW" | "system". i18n.ts
//     resolves the active locale from this key at module init (i18n.ts:23,34-46);
//     language.app.get/set read/write it (registry.tsx:526). Seed + load.
//   • Both are seeded via page.addInitScript, which Playwright runs before any
//     page script (i.e. before main.tsx), on every navigation in the context.
//     Each test() gets a FRESH context, so per-test addInitScript never stacks.
//
// Node-type surfaces (OverviewEditor polymorphism, registry.tsx:150-152,607-657):
//   • markdown    — a plain node (.cm-content)
//   • pdf_url     — PdfNodeView (.pdf-node-bar / .pdf-node-content)
//   • ink_data    — InkNodeView handwriting (.ink-note)
//   • canvas      — a canvas node opens as its board (.react-flow__node)
//   • class_tag   — opening the tag node shows its schema (.schema-lens-title)
//
// Lenses (?lens=, useUrlLocation.ts:39): editor | canvas | table | timeline.
// Places (?view=, useUrlLocation.ts:33): tasks | graph | tags.

const SHOTS = "/tmp/pw-output/shots";

// A tiny single-page PDF as a data: URL — borrowed verbatim from pdfInk.spec.ts.
const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
trailer<</Root 1 0 R/Size 4>>
startxref
9
%%EOF`,
).toString("base64");

// A minimal single-page InkDocument that the handwriting host accepts (NOT the
// multi-page PDF envelope, which would be routed elsewhere — see
// OverviewEditor.tsx:201-210). Shape mirrors fetchInkDoc in inkNote.spec.ts.
const INK_DOC = JSON.stringify({
  version: 1,
  strokes: [
    { id: "s1", points: [[100, 80], [220, 110], [340, 90]] },
    { id: "s2", points: [[120, 180], [260, 200], [380, 170]] },
  ],
  erased: {},
  page: { width: 1000 },
});


type SeedAttr = { value: string; value_type?: string };
async function setAttr(page: Page, nodeId: string, key: string, attr: SeedAttr) {
  await page.request.put(`/api/nodes/${nodeId}/attributes/${key}`, {
    ...H,
    data: { value: attr.value, value_type: attr.value_type ?? "text" },
  });
}
async function makeNode(page: Page, title: string, markdown = "", parent_id?: string) {
  const data: Record<string, unknown> = { title, markdown };
  if (parent_id) data.parent_id = parent_id;
  else data.space_id = await defaultSpaceId(page.request); // the default space publishes; a personal one does not
  return (await (await page.request.post("/api/nodes", { ...H, data })).json()) as { id: string; slug: string };
}

// Seed every node-type fixture ONCE and return their ids. Idempotent enough for
// the shared onden_test DB: each title carries a fixed gallery stamp so reruns
// reuse-or-recreate without colliding on lookups (we only ever reference by id).
async function seedFixtures(page: Page) {
  const stamp = Date.now();

  // Markdown node with a body + tags + a backlink + a class-tag schema value, so
  // the editor, inline-metadata strip, inspector backlinks AND featured fields
  // all have something to render.
  const md = await makeNode(
    page,
    `Gallery note ${stamp}`,
    "# Gallery note\n\nA markdown node with real content so the editor, inline metadata, and the inspector backlinks widget have something to show.\n\nTagged #gallery and #idea.",
  );
  await makeNode(page, `Gallery linker ${stamp}`, `Points at [[Gallery note ${stamp}]] to populate backlinks.`);

  // Featured-fields: give the markdown node a class tag with a schema + a value.
  const ct = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `GalleryProject${stamp}` } })).json();
  const classTagId = ct.leaf_id as string;
  await page.request.patch(`/api/tags/${classTagId}/schema`, { ...H, data: { fields: [
    { name: "status", label: "Status", type: "select", options: ["todo", "doing", "done"] },
    { name: "due", label: "Due", type: "date" },
  ] } });
  await page.request.put(`/api/nodes/${md.id}/tags/${classTagId}`, { ...H, data: {} });
  await setAttr(page, md.id, "status", { value: "doing" });

  // A subtree parent (for the table + canvas lenses, both subtree-gated).
  const parent = await makeNode(page, `Gallery parent ${stamp}`, "the subtree root");
  await makeNode(page, `Gallery child A ${stamp}`, "child a body", parent.id);
  await makeNode(page, `Gallery child B ${stamp}`, "child b body", parent.id);

  // PDF node.
  const pdf = await makeNode(page, `Gallery PDF ${stamp}`, "");
  await setAttr(page, pdf.id, "pdf_url", { value: `data:application/pdf;base64,${TINY_PDF}` });

  // Handwriting (ink) node.
  const ink = await makeNode(page, `Gallery ink ${stamp}`, "");
  await setAttr(page, ink.id, "ink_data", { value: INK_DOC });

  // A canvas board node with one card on it (opens as a board in the editor).
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Gallery board ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: [{ nodeId: md.id, x: 80, y: 80, width: 240 }], edges: [] } } });

  // A published node so the site route renders.
  const published = await makeNode(page, `Gallery published ${stamp}`, `# Published page ${stamp}\n\nThis is the public face served at /site.`);
  await setAttr(page, published.id, "_published", { value: "true", value_type: "bool" });
  await publishSite(page.request); // snapshot model B: serve only what was published

  return {
    mdId: md.id, classTagId, parentId: parent.id,
    pdfId: pdf.id, inkId: ink.id, canvasId: canvas.id,
    publishedSlug: published.slug,
  };
}

// Seed localStorage BEFORE the app boots: theme + locale are both read at module
// init / boot, so this is the deterministic way to fix them for a context.
// addInitScript re-runs on EVERY navigation in the context (before page scripts),
// so the dismissed-flag is re-applied on each load — pass dismissWelcome=false
// when you specifically WANT the first-run banner to appear.
async function seedEnv(
  page: Page,
  theme: "light" | "dark",
  locale: "en" | "zh-TW",
  dismissWelcome = true,
) {
  await page.addInitScript(
    ({ theme, locale, dismissWelcome }) => {
      try {
        localStorage.setItem("theme", theme);
        localStorage.setItem("onden.locale", locale);
        // Keep the one-time welcome banner out of the app-shell shots, unless the
        // caller wants it (the welcome-banner gallery shot).
        if (dismissWelcome) localStorage.setItem("onden.welcomeDismissed", "1");
        else localStorage.removeItem("onden.welcomeDismissed");
      } catch { /* private mode */ }
    },
    { theme, locale, dismissWelcome },
  );
}

// Take a self-verification shot, never failing the whole test if one state is
// momentarily unreachable — partial galleries are better than none. Waits for a
// stable anchor (best-effort), settles fonts/frames, then captures.
async function shot(page: Page, name: string, anchor: string | null, fullPage = false) {
  try {
    if (anchor) {
      await page.locator(anchor).first().waitFor({ state: "visible", timeout: 20_000 });
    }
    await page.waitForTimeout(400); // fonts / theme transition settle
    await renderSettled(page).catch(() => {});
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
  } catch (err) {
    // Anchor never showed — capture whatever is on screen + flag it, but don't
    // abort the rest of the gallery.
    console.warn(`[stateGallery] ${name}: anchor "${anchor}" not found — capturing anyway`, err);
    await page.screenshot({ path: `${SHOTS}/${name}-FALLBACK.png`, fullPage }).catch(() => {});
  }
}

// ── 1. locale × theme matrix on the home/editor (the owner's core ask) ────────
// One test per (locale, theme) so a fresh context applies the env cleanly and a
// failure in one cell doesn't lose the others.
for (const locale of ["en", "zh-TW"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`gallery: ${locale} / ${theme} — home + editor + inspector`, async ({ page }) => {
      await seedEnv(page, theme, locale);
      const f = await seedFixtures(page);

      // Editor on the rich markdown node, inspector open (the default).
      await ready(page, `/?view=notes&node=${f.mdId}`);
      await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
      await shot(page, `gallery-${locale}-${theme}-editor`, ".cm-content");

      // The inspector rail with backlinks (a second node links the target).
      await shot(page, `gallery-${locale}-${theme}-inspector`, ".overview-activity");

      // Tasks place — exercises chrome translation + theming on a non-editor surface.
      await ready(page, `/?view=tasks`);
      await shot(page, `gallery-${locale}-${theme}-tasks`, ".tasks-mode");
    });
  }
}

// ── 2. Lenses (light / en) — editor / canvas / table / history ───────────────
test("gallery: lenses (light/en)", async ({ page }) => {
  await seedEnv(page, "light", "en");
  const f = await seedFixtures(page);

  // Editor lens.
  await ready(page, `/?view=notes&node=${f.mdId}&lens=editor`);
  await shot(page, "gallery-lens-editor", ".cm-content");

  // Canvas lens — on the subtree parent (canvas is subtree-gated). The lens
  // shows the board or an empty-state hint; both are valid gallery content.
  await ready(page, `/?view=notes&node=${f.parentId}&lens=canvas`);
  await shot(page, "gallery-lens-canvas", ".react-flow, .canvas-empty-state");

  // Sub-notes — a parent's children as rows, the 「Sub-notes」 section of its
  // content page (the Table lens was removed in #486).
  await ready(page, `/?view=notes&node=${f.parentId}`);
  await shot(page, "gallery-note-subnotes", ".note-relations-children");

  // History — the workspace page (a note's own history is the time slider dialog).
  await ready(page, `/?view=timeline`);
  await shot(page, "gallery-lens-history", ".node-lens-pane");
});

// ── 3. Node-type surfaces (light / en) ───────────────────────────────────────
test("gallery: node-type surfaces (light/en)", async ({ page }) => {
  await seedEnv(page, "light", "en");
  const f = await seedFixtures(page);

  // Markdown.
  await ready(page, `/?view=notes&node=${f.mdId}`);
  await shot(page, "gallery-type-markdown", ".cm-content");

  // PDF.
  await ready(page, `/?view=notes&node=${f.pdfId}`);
  await shot(page, "gallery-type-pdf", ".pdf-node-bar, .pdf-node-content");

  // Handwriting / ink.
  await ready(page, `/?view=notes&node=${f.inkId}`);
  await shot(page, "gallery-type-ink", ".ink-note");

  // Canvas board (a canvas node opens as its board).
  await ready(page, `/?view=notes&node=${f.canvasId}`);
  await shot(page, "gallery-type-canvas-board", ".react-flow__node, .canvas-empty-hint");

  // Class-tag schema page.
  await ready(page, `/?view=notes&node=${f.classTagId}`);
  await shot(page, "gallery-type-schema", ".schema-lens-title, .schema-lens-instances");
});

// ── 4. Places (light / en) — tasks / graph / tags ────────────────────────────
test("gallery: places (light/en)", async ({ page }) => {
  await seedEnv(page, "light", "en");
  await seedFixtures(page);

  await ready(page, `/?view=tasks`);
  await shot(page, "gallery-place-tasks", ".tasks-mode");

  await ready(page, `/?view=graph`);
  await shot(page, "gallery-place-graph", ".all-cards-graph-wrap");

  await ready(page, `/?view=tags`);
  await shot(page, "gallery-place-tags", ".node-lens-tags");
});

// ── 5. Settings (Appearance + Your Data), welcome banner, mobile nav ─────────
test("gallery: settings + welcome banner (light/en)", async ({ page }) => {
  await seedEnv(page, "light", "en");
  await seedFixtures(page);
  await ready(page, "/?view=notes");

  // Open Settings via the topbar gear (title="Settings" — a hardcoded prop, not
  // translated; AppTopbar.tsx:152).
  await openSettingsFromAvatar(page);
  await expect(page.locator(".settings-modal")).toBeVisible({ timeout: 10_000 });

  // Appearance tab (where Dark mode + density live). The nav items are buttons
  // labelled by the (translated) tab label — in en the literal text matches.
  await page.locator(".settings-nav-item", { hasText: "Appearance" }).click();
  await shot(page, "gallery-settings-appearance", ".settings-content");

  // Your Data tab (export / backup / on-disk storage).
  await page.locator(".settings-nav-item", { hasText: "Data and backup" }).click();
  await shot(page, "gallery-settings-your-data", ".settings-content");

  // Close the modal.
  await page.locator(".settings-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
});

// First-run welcome banner — its own test so the addInitScript that seeds env
// can leave onden.welcomeDismissed UNSET (it re-runs on every navigation, so it
// can't be undone mid-test). The banner gates on that flag
// (welcomeBanner.spec.ts:15-18) and mounts on a clean state.
test("gallery: welcome banner (light/en)", async ({ page }) => {
  // seedFixtures adds notes, and a workspace with notes hides the welcome.
  test.skip(true, "the welcome only shows in an empty workspace; see welcomeBanner.spec.ts");
  await seedEnv(page, "light", "en", /* dismissWelcome */ false);
  await seedFixtures(page);
  await ready(page, "/?view=notes");
  await shot(page, "gallery-welcome-banner", ".welcome-banner");
});

// ── 6. Mobile viewport — bottom nav + More sheet ─────────────────────────────
test.describe("gallery: mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("gallery: mobile nav + more sheet (light/en)", async ({ page }) => {
    await seedEnv(page, "light", "en");
    await seedFixtures(page);
    await ready(page, "/?view=notes");

    // The bottom nav shows under 900px (MobileNav.css:5).
    await shot(page, "gallery-mobile-nav", ".mobile-bottom-nav");

    // Open the More sheet (the 4th bar button, aria-label "More"; MobileNav.tsx:117-126).
    await page.locator('.mobile-bottom-nav button[aria-label="More"]').click();
    await shot(page, "gallery-mobile-more-sheet", ".mobile-more-sheet");
  });
});

// ── 7. Dark-mode lenses (a few key surfaces in dark/en) ───────────────────────
test("gallery: lenses + types (dark/en)", async ({ page }) => {
  await seedEnv(page, "dark", "en");
  const f = await seedFixtures(page);

  await ready(page, `/?view=notes&node=${f.parentId}`);
  await shot(page, "gallery-dark-note-subnotes", ".note-relations-children");

  await ready(page, `/?view=timeline`);
  await shot(page, "gallery-dark-lens-history", ".node-lens-pane");

  await ready(page, `/?view=notes&node=${f.canvasId}`);
  await shot(page, "gallery-dark-type-canvas-board", ".react-flow__node, .canvas-empty-hint");

  await ready(page, `/?view=graph`);
  await shot(page, "gallery-dark-place-graph", ".all-cards-graph-wrap");
});

// ── 8. Published site (light) — the public face ──────────────────────────────
test("gallery: published site (light)", async ({ page }) => {
  await seedEnv(page, "light", "en");
  const f = await seedFixtures(page);

  // The site is static SSR HTML — navigate directly to the published node's slug
  // (publishing.spec.ts:65-67). Root anchor is .site-scope (sitePages.spec.ts).
  await page.goto(`/site/${f.publishedSlug}`, { waitUntil: "load" });
  await shot(page, "gallery-site-published", ".site-scope", /* fullPage */ true);

  // The site home page.
  await page.goto(`/site/`, { waitUntil: "load" });
  await shot(page, "gallery-site-index", ".site-scope", /* fullPage */ true);
});
