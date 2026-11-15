// ⑨ Onboarding acceptance — the Obsidian-basics teaching sequence
// (youtu.be/9oh9hGE9LsY) walked end to end against the real stack, each beat
// asserted. This is the "can a new user do the things the tutorial teaches?"
// checklist, driven like a person ([[verify-like-a-user]]). Beats covered:
//   1. create a note (quick capture)
//   2. write markdown + read it back in Preview
//   3. link to a note that doesn't exist yet → clicking the link CREATES it
//   4. the new note shows the backlink
//   5. tag a note (the "＋" in the grey line under the title — a #word in the body
//      is text, not a tag: T10)
//   6. find it again by search (command palette)
//   7. open today's daily note
//   8. quick-switch to a note by title (command palette)
//
// Rerun-safe on the persistent e2e DB: every fixture title carries a stamp.
import { test, expect } from "@playwright/test";
import { ready, openQuickCapture, switchNoteView, titleTagAdd, H, saveQuickCapture } from "./helpers";


test("a new user can walk the Obsidian-basics sequence", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const linkTarget = `Linked Topic ${stamp}`;

  await ready(page, "/?view=notes");
  await page.waitForTimeout(600);

  // 1. create a note via quick capture
  const noteTitle = `Basics Note ${stamp}`;
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(noteTitle);
  await saveQuickCapture(page); // stays open for the next thought; closed after "Saved to …"
  await page.waitForTimeout(600);

  let boot = await (await page.request.get("/api/bootstrap", H)).json();
  const note = boot.nodes.find((n: { title: string }) => n.title === noteTitle);
  expect(note, "the captured note exists server-side").toBeTruthy();

  // 2. write markdown by TYPING and read it back in Preview (heading, bold,
  //    an inline #word, which stays text). The wikilink is added in step 3 via the API — the editor's
  //    `[[` autocomplete intercepts typed brackets, which is a different beat.
  await page.goto(`/?view=notes&node=${note.id}`, { waitUntil: "load" });
  const editor = page.locator(".cm-content");
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(`# ${noteTitle}\n\nA **bold** idea about study flow #studyflow\n`);
  // Autosave debounce is 1500ms (draftActions.ts) — wait for the server copy,
  // not a fixed sleep, so the later API PATCH doesn't race an unsent draft.
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${note.id}`, H)).json()).markdown,
    { timeout: 10_000 }).toContain("study flow");

  await switchNoteView(page, "preview");
  const preview = page.locator(".obsidian-preview");
  await expect(preview.locator("h1")).toContainText(noteTitle);
  await expect(preview.locator("strong")).toHaveText("bold");

  // 3. a link to a note that doesn't exist yet → clicking it CREATES the note.
  //    Write the link straight into the body (clean [[ ]]), then reopen.
  await page.request.patch(`/api/nodes/${note.id}`, {
    ...H, data: { markdown: `# ${noteTitle}\n\nA **bold** idea about [[${linkTarget}]] #studyflow\n` },
  });
  boot = await (await page.request.get("/api/bootstrap", H)).json();
  expect(boot.nodes.some((n: { title: string }) => n.title === linkTarget),
    "the link target must NOT exist before the click").toBe(false);

  await page.goto(`/?view=notes&node=${note.id}`, { waitUntil: "load" });
  await page.locator(".cm-content").waitFor({ timeout: 20_000 });
  await switchNoteView(page, "preview");
  const wikilink = page.locator(".obsidian-preview .wikilink-token", { hasText: linkTarget });
  await expect(wikilink).toBeVisible({ timeout: 10_000 });
  await wikilink.click();

  // the editor now shows the freshly-created target note (its title bar names
  // it — the view may stay in Preview, so assert the title, not .cm-content)
  await expect(page.locator(".obsidian-title-input")).toHaveValue(linkTarget, { timeout: 15_000 });
  await expect.poll(async () => {
    const b = await (await page.request.get("/api/bootstrap", H)).json();
    return b.nodes.some((n: { title: string }) => n.title === linkTarget);
  }, { timeout: 15_000 }).toBe(true);

  boot = await (await page.request.get("/api/bootstrap", H)).json();
  const created = boot.nodes.find((n: { title: string }) => n.title === linkTarget);
  expect(created, "clicking the unresolved link created a note titled by the link").toBeTruthy();

  // 4. backlink — the new note shows the source as a backlink. The source was
  //    saved (step 3) BEFORE the target existed, so the edge only materializes
  //    because creating the target reverse-wires incoming wikilinks
  //    (relinkTarget). This closes the gap obsidianBasics first
  //    recorded.
  await expect.poll(async () => {
    const edges = await (await page.request.get("/api/bootstrap", H)).json();
    return (edges.edges as Array<{ source_node_id: string; target_node_id: string }>)
      .some((e) => e.source_node_id === note.id && e.target_node_id === created.id);
  }, { timeout: 15_000 }).toBe(true);

  // 5. tag the note with the "＋" in the grey line under the title. The body's
  //    #studyflow is text, not a tag (T10): before tagging, the note carries
  //    no tag of that name; after, the tag is a stored membership.
  const tagName = `studyflow${stamp}`;
  await page.goto(`/?view=notes&node=${note.id}`, { waitUntil: "load" });
  await page.locator(".cm-content, .obsidian-preview").first().waitFor({ timeout: 20_000 });
  // The one tag row under the title (the sidebar has no tag adder).
  const tagRow = page.locator(".note-document .title-tag-row");
  // A capture lands in the inbox, so the note carries the inbox's tag only.
  await expect(tagRow.locator(".prop-tag--applied", { hasText: tagName })).toHaveCount(0);
  await (await titleTagAdd(page)).click();
  await tagRow.getByRole("combobox", { name: "Add a tag" }).fill(tagName);
  await tagRow.getByRole("combobox", { name: "Add a tag" }).press("Enter");
  await expect(tagRow.locator(".prop-tag--applied", { hasText: `#${tagName}` })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    const b = await (await page.request.get("/api/bootstrap", H)).json();
    const tag = (b.tags as Array<{ id: string; name: string }>).find((t) => t.name === tagName);
    const n = (b.nodes as Array<{ id: string; label_tag_ids?: string[] }>).find((x) => x.id === note.id);
    return !!tag && !!n?.label_tag_ids?.includes(tag.id);
  }, { timeout: 15_000 }).toBe(true);

  // 6. find the source note again by search (command palette)
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-input-wrap input")).toBeFocused();
  await page.locator(".palette-input-wrap input").fill(noteTitle);
  const hit = page.locator(".palette-item", { hasText: noteTitle }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await hit.click();
  // the global view may be in Preview from step 3 — switch to Edit to read CM
  await switchNoteView(page, "edit");
  await expect(page.locator(".cm-content")).toContainText("idea about", { timeout: 15_000 });

  // 7. open today's daily note (the Today button)
  await page.keyboard.press("ControlOrMeta+Shift+D"); // the topbar Today button is gone (daily-notes module)
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  await expect.poll(async () => {
    const b = await (await page.request.get("/api/bootstrap", H)).json();
    return b.nodes.some((n: { title?: string; slug?: string }) => n.title === today || n.slug === today);
  }, { timeout: 15_000 }).toBe(true);

  // 8. quick-switch back to the source note by title
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(noteTitle);
  await page.locator(".palette-item", { hasText: noteTitle }).first().click();
  await expect(page.locator(".cm-content")).toContainText(noteTitle, { timeout: 15_000 });
});
