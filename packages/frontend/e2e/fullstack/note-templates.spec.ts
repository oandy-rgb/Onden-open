import { test, expect, type Page } from "@playwright/test";
import { ready, pollBootstrap, H } from "./helpers";

// Journey [note-templates]: insert a note template (daily / meeting) "from the
// menu" → the template content appears.
//
// Onden ships note templates (NOTE_TEMPLATES in lib/noteTemplates) on TWO real
// menu surfaces, and this suite drives both the way a person would:
//
//   1. The editor SLASH menu (`/`). Typing `/daily` surfaces a
//      "Template text: Daily note" item; selecting it STAMPS the scaffold body
//      (## Agenda / ## Notes / ## Log) into the current note in place of the
//      slash trigger. Same for `/meeting` → Attendees / Decisions / Action
//      items. This is the primary, fully-deterministic path: we stamp into a
//      freshly-minted scratch node so there is no shared-DB title collision and
//      no autosave dependency for the assertion.
//
//   2. The ⌘K command PALETTE ("New from template: …"). This MINTS a whole new
//      node from the template and opens it in the editor — a different code
//      path (useNodeCreation.createFromTemplate) worth covering once.
//
// Robustness notes (per virtSidebar / lazyBody lessons): we never scroll-hunt.
// The slash query is narrowed to a fragment unique to ONE template item so the
// first (auto-highlighted) result is the one we want, and we assert on the
// STATIC scaffold headings (not the {date}/{datetime} placeholders) so the
// suite can't flake on the clock or the local timezone.
const SHOTS = "/tmp/pw-output/shots";

// Mint an empty scratch note via the API and land in its editor. The stamped
// title keeps it unique in the shared onden_test DB so the editor opens exactly
// this node (deep-link by id, not by a fragile search).
async function openScratch(page: Page, label: string): Promise<{ id: string }> {
  const node = await (
    await page.request.post("/api/nodes", { ...H, data: { title: `${label} ${Date.now()}`, markdown: "" } })
  ).json();
  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".cm-content")).toBeVisible(); // editor mounted
  return node;
}

// Open the editor slash menu on an empty line and pick the single template item
// whose title contains `query` (e.g. "daily" → "Template text: Daily note"). The
// slash trigger only fires at the start of a line and its grammar is `[\w ]*`
// (no punctuation), so we query a bare word fragment, never "Template text:".
async function stampTemplateViaSlash(page: Page, query: string, expectTitle: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.type(`/${query}`);
  const item = page.locator(".slash-menu-title", { hasText: expectTitle });
  await expect(item).toBeVisible(); // the slash menu surfaced the template item
  // It ranks first for this fragment, so it is auto-highlighted → Enter
  // applies it (mirrors dailyDriver's wikilink select-on-Enter convention).
  await page.keyboard.press("Enter");
  await expect(page.locator(".slash-menu-title")).toHaveCount(0); // menu closed
}

// 1 — Daily template from the slash menu stamps the journal scaffold.
test("slash menu inserts the Daily note template scaffold", { tag: "@critical" }, async ({ page }) => {
  await openScratch(page, "Daily scratch");

  await stampTemplateViaSlash(page, "daily", "Template text: Daily note");

  // The felt result: the daily journal scaffold now lives in the editor. Assert
  // on the static section headings (placeholder-free, timezone-independent).
  const body = await page.locator(".cm-content").innerText();
  expect(body).toContain("## Agenda");
  expect(body).toContain("## Notes");
  expect(body).toContain("## Log");
  await page.screenshot({ path: `${SHOTS}/note-templates-daily.png`, fullPage: false });
});

// 2 — Meeting template from the slash menu stamps the meeting scaffold.
test("slash menu inserts the Meeting notes template scaffold", { tag: "@critical" }, async ({ page }) => {
  await openScratch(page, "Meeting scratch");

  await stampTemplateViaSlash(page, "meeting", "Template text: Meeting notes");

  const body = await page.locator(".cm-content").innerText();
  expect(body).toContain("**Attendees:**");
  expect(body).toContain("## Agenda");
  expect(body).toContain("## Decisions");
  expect(body).toContain("## Action items");
  await page.screenshot({ path: `${SHOTS}/note-templates-meeting.png`, fullPage: false });
});

// 3 — The stamped scaffold persists server-side (it isn't just a transient
// editor decoration). Drive the slash menu, then poll the server until the
// debounced autosave has written the scaffold into a body version of THIS node.
test("a stamped template persists through autosave", async ({ page }) => {
  const node = await openScratch(page, "Persist scratch");

  await stampTemplateViaSlash(page, "daily", "Template text: Daily note");
  // Nudge a save: focus the editor and type a trailing char so the change is
  // committed even if the stamp alone hasn't tripped the autosave debounce yet.
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");

  // Server truth: a version of this node carries the scaffold heading.
  await pollBootstrap(
    page,
    (b) => b.nodes.find((n: { id: string }) => n.id === node.id),
    { message: "node should exist in bootstrap" },
  );
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/nodes/${node.id}/versions`);
      if (!res.ok()) return false;
      const list = (await res.json()) as Array<{ markdown?: string }>;
      return list.some((v) => (v.markdown || "").includes("## Agenda"));
    }, { timeout: 15_000, message: "stamped scaffold should reach a saved version" })
    .toBeTruthy();
});

// 4 — The command palette "New from template" surface MINTS a whole new node
// from the meeting template and opens it in the editor (a distinct code path
// from the in-editor slash stamp).
test("command palette 'New from template' mints + opens a templated note", async ({ page }) => {
  await ready(page, "/?view=notes");

  // ⌘K is a window-level shortcut; the listener attaches in a mount effect that
  // can land after the shell paints, so poll the keypress until it opens.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // Command mode (`>`) lists actions; filter to the meeting template action.
  await page.locator(".palette-input-wrap input").fill(">template: Meeting");
  const action = page.locator(".palette-item", { hasText: "New from template: Meeting notes" });
  await expect(action).toBeVisible(); // the Templates group surfaced the action
  await action.click();

  await expect(page.locator(".palette-modal")).toHaveCount(0); // palette closed
  // The minted node opened in the editor with the meeting title pattern + body.
  await expect(page.locator(".obsidian-title-input")).toHaveValue(/^Meeting — /);
  await expect.poll(async () => (await page.locator(".cm-content").innerText()))
    .toContain("## Action items");
});
