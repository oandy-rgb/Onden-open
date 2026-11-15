import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, renderSettled, defaultSpaceId, H } from "./helpers";

// NOT a regression spec — a guided user-journey tour that walks the app like a
// person and screenshots every surface for a human design review. Run ad hoc;
// not part of the committed suite.
const S = "/tmp/pw-output/shots";
const shot = async (page: Page, name: string) => {
  await renderSettled(page); // fonts + frames flushed — replaces fixed pre-shot sleeps
  await page.screenshot({ path: `${S}/tour-${name}.png`, fullPage: false });
};

const daysFromNow = (n: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test("user journey tour", async ({ page }) => {
  test.skip(!process.env.TOUR, "ad-hoc design-review tour — run with TOUR=1 against a FRESH stack (the seeded data is not cleaned up)");
  test.setTimeout(240_000);
  // ── Seed a small, realistic workspace via API (fast), then WALK it via UI.
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: "Reading",
      color: "#7a2e33",
      fields: [
        { key: "status", type: "select", label: "Status", options: ["queued", "reading", "done"], default: "queued" },
        { key: "rating", type: "number", label: "Rating" },
      ],
    },
  })).json();

  const mk = async (title: string, markdown: string, parent_id?: string) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title, markdown, parent_id } })).json());

  const project = await mk("Reading list", "# Reading list\n\nBooks and papers I'm working through.");
  const b1 = await mk("How Buildings Learn", "Stewart Brand on how buildings adapt over time. Links to [[Pattern Language]].", project.id);
  const b2 = await mk("Pattern Language", "Christopher Alexander. The original pattern catalog.", project.id);
  await mk("Thinking in Systems", "Donella Meadows primer on systems thinking.", project.id);
  await page.request.put(`/api/nodes/${b1.id}/tags/${tag.id}`, { ...H });
  await page.request.put(`/api/nodes/${b2.id}/tags/${tag.id}`, { ...H });

  await page.request.post(`/api/nodes/${project.id}/tasks`, { ...H, data: { title: "Finish chapter 3", due_date: daysFromNow(0) } });
  await page.request.post(`/api/nodes/${project.id}/tasks`, { ...H, data: { title: "Weekly review of notes", due_date: daysFromNow(0), recur: "1w" } });
  await page.request.post(`/api/nodes/${project.id}/tasks`, { ...H, data: { title: "Return library book", due_date: daysFromNow(-2) } });

  // 1 — Landing (today's note): open-or-create redirects to ?node= and mounts the editor.
  await ready(page, "/");
  await expect(page).toHaveURL(/node=/, { timeout: 20_000 });
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await shot(page, "01-landing");

  // 2 — Open a note via the command palette like a user (⌘K → type → Enter).
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette-input-wrap input").waitFor({ timeout: 10_000 }); // palette open
  await page.keyboard.type("How Buildings");
  await page.locator(".palette-item", { hasText: "How Buildings" }).first().waitFor({ timeout: 10_000 }); // result painted
  await page.keyboard.press("Enter");
  // Landed on the note: its title is in the editor surface.
  await expect(page.locator(".obsidian-title-input").first()).toHaveValue(/How Buildings/, { timeout: 15_000 });
  await shot(page, "02-note-editor");

  // 3 — The note's views now live beside it: outgoing links and the local
  //     graph in the Info pane (already in the shot above), the full version
  //     history behind "All versions".
  await page.getByRole("button", { name: "All versions" }).click();
  // History opens over the editor, without leaving the note.
  await expect(page.locator(".nh")).toBeVisible();
  await shot(page, "04-history-dialog");
  await page.keyboard.press("Escape");

  // 4 — The parent's sub-notes: the 「Sub-notes」 section of its content page
  //     (the Table lens was removed in #486).
  await page.locator("aside").getByText("Reading list").first().click();
  await expect(page.locator(".obsidian-title-input").first()).toHaveValue(/Reading list/, { timeout: 15_000 });
  const subNotes = page.getByRole("region", { name: /Sub-notes/ });
  await subNotes.scrollIntoViewIfNeeded();
  await expect(subNotes.getByRole("button", { name: /Sub-notes/ })).toBeVisible(); // the foldable heading
  await shot(page, "05-sub-notes");

  // 5 — The tag node (schema lens: fields / access / automation), opened from
  //     the sidebar tree (TagsMode retired — the tag IS a node).
  await ready(page, "/?view=notes");
  // Tags are listed once, under TAGS; a chip opens the tag's page.
  const tagRow = page.locator(".sidebar-tag-chip", { hasText: "#Reading" }).first();
  await expect(tagRow).toBeVisible(); // tag panel rendered
  await shot(page, "06-sidebar-tag-panel");
  await tagRow.click();
  await expect(page.locator(".schema-lens-title")).toBeVisible(); // schema lens, not the editor
  await shot(page, "07-schema-lens");

  // 6 — Tasks agenda (three tasks were seeded above — wait for rows, not time).
  await ready(page, "/?view=tasks");
  await expect(page.locator(".task-row").first()).toBeVisible();
  await shot(page, "08-tasks-agenda");

  // 8 — Inbox with BOTH card kinds (agent edit + held request). The held
  //     request is a tag pack proposal: no token carries publishSite since
  //     2026-10-22 (services/agentTools/templates.ts).
  const AH = { headers: (await createAgent(page.request, `Tour Agent ${Date.now()}`)).headers };
  const created = await page.request.post("/api/mcp/tools/createNode", { ...AH, data: { args: { title: "Agent draft: summary of systems thinking", markdown: "drafted by the agent" } } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const held = await page.request.post("/api/mcp/tools/proposeTagPack", { ...AH, data: { args: { name: `TourPack${Date.now()}`, fields: [{ name: "rating", type: "number" }] } } });
  expect(held.ok(), await held.text()).toBeTruthy();
  await ready(page, "/");
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  // Both card kinds must be on screen before the shot: the held card
  // and the agent edit's review card.
  await expect(page.locator(".inbox-review-item-held").first()).toBeVisible();
  await expect(page.locator(".inbox-review-approve").first()).toBeVisible();
  await shot(page, "10-inbox-governance");
});
