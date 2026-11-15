import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// Self-verification screenshots — NOT assertions. Drives the wired stack to the
// states I need to SEE (topbar inspector toggle off/on, inspector open with a
// focused node), and writes PNGs to /tmp/pw-output/shots (mirrored to the host
// at /tmp/pw-host-out/shots by fullstack/run.sh's bind mount) so I can Read them
// and judge the result myself. See memory frontend-self-verify.
const SHOTS = "/tmp/pw-output/shots";

test("capture inspector + topbar states", async ({ page }) => {
  // Seven cold loads, each behind the cold-start membership check (the workspace is inert under it).
  test.setTimeout(150_000);
  const open = async (url: string) => {
    await ready(page, url);
    await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  };
  // A focused node with a body, plus a second node linking to it so the
  // inspector's backlinks widget has something to render.
  const target = await page.request.post("/api/nodes", {
    ...H,
    data: { title: "Self-verify target", markdown: "# Self-verify target\n\nA node with a body so the editor + inspector have real content to show.\n\nTagged #self-verify and #idea so the inline metadata strip renders." },
  });
  const t = await target.json();
  await page.request.post("/api/nodes", {
    ...H,
    data: { title: "Linker", markdown: `Points at [[Self-verify target]] to populate backlinks.` },
  });
  // A note that names the target as plain text without linking it — exercises
  // the Unlinked mentions section (doc 09 #3).
  await page.request.post("/api/nodes", {
    ...H,
    data: { title: "Mentioner", markdown: `Was thinking about the Self-verify target idea but never linked it.` },
  });

  // 1) Node focused, inspector OPEN (the new default) — supporting rail visible.
  await open(`/?view=notes&node=${t.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.locator(".overview-activity")).toBeVisible(); // the inspector rail (expanded pane class)
  await page.screenshot({ path: `${SHOTS}/01-node-inspector-open.png`, fullPage: false });

  // 2) Hide it via the PanelRight toggle in the note header (beside ⋯) — the rail
  //    retracts and the editor reclaims the width. aria-pressed carries the state.
  const toggle = page.locator(".notes-inspector-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false"); // retracted
  await page.screenshot({ path: `${SHOTS}/02-node-inspector-hidden.png`, fullPage: false });

  // 2b) Re-open via the Cmd/Ctrl+. keyboard shortcut (handler accepts ctrlKey).
  await page.locator("body").click();
  await page.keyboard.press("Control+Period");
  await expect(toggle).toHaveAttribute("aria-pressed", "true"); // re-opened
  await page.screenshot({ path: `${SHOTS}/02b-cmd-dot-reopened.png`, fullPage: false });

  // 3) #25 capture-first startup: opening with NO ?node= should land on today's
  //    day-note (open-or-create), not the first arbitrary knowledge note.
  await page.goto(`/?view=notes`, { waitUntil: "load" });
  // The landing pick waits for the cold-start membership check (useLandingNote).
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await expect(page).toHaveURL(/node=/, { timeout: 20_000 }); // open-or-create landed
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-startup-today-note.png`, fullPage: false });

  // 4) doc 09 — the inspector is lens-stable: the SAME NodeInspector renders against the focused note on its
  //    whiteboard tab too. Since 2026-10-30 the board starts with it folded (useWorkspacePanes: the whiteboard
  //    tab's own choice, not the stored one), and the same toggle opens it at the right of the board.
  await open(`/?view=notes&node=${t.id}&lens=canvas`);
  await expect(page.locator(".react-flow").first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator(".overview-activity")).toBeVisible(); // inspector present in this lens
  await page.screenshot({ path: `${SHOTS}/04-canvas-inspector.png`, fullPage: false });

  // Tasks and History are full pages: no note list and no inspector beside them (useWorkspacePanes fullPage;
  // decisions-ui 「整頁的畫面…沒有資訊欄」). The shots show the page using the whole width.
  await open(`/?view=tasks&node=${t.id}`);
  await expect(page.locator(".overview-activity")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/05-tasks-inspector.png`, fullPage: false });

  // (the tags lens is gone — TagsMode retired; tags open as nodes in notes)

  await open(`/?view=timeline&node=${t.id}`);
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toBeVisible();
  await expect(page.locator(".overview-activity")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/07-timeline-inspector.png`, fullPage: false });

  // 8) doc 09 #4 — pinned "featured fields". Give the target a class tag with a
  //    schema (Status select + Due date) and a value, then confirm the fields
  //    render as editable cells under the title on the node itself.
  const ct = await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: "Project" } })).json();
  const tagId = ct.leaf_id as string;
  await page.request.patch(`/api/tags/${tagId}/schema`, { ...H, data: { fields: [
    { name: "status", label: "Status", type: "select", options: ["todo", "doing", "done"] },
    { name: "due", label: "Due", type: "date" },
  ] } });
  await page.request.put(`/api/nodes/${t.id}/tags/${tagId}`, { ...H, data: {} });
  await page.request.put(`/api/nodes/${t.id}/attributes/status`, { ...H, data: { value: "doing", value_type: "text" } });
  await open(`/?view=notes&node=${t.id}`);
  await expect(page.getByText("Status").first()).toBeVisible(); // featured field cell rendered
  await page.screenshot({ path: `${SHOTS}/08-featured-fields.png`, fullPage: false });

  // 9) doc 01 P3 — open the class_tag ITSELF as a node: the center renders its
  //    SCHEMA (the fields), not a markdown editor. A class_tag is a node you open.
  await open(`/?view=notes&node=${tagId}`);
  await expect(page.locator(".schema-lens-title")).toBeVisible(); // schema lens, not the editor
  await page.screenshot({ path: `${SHOTS}/09-schema-lens.png`, fullPage: false });
});
