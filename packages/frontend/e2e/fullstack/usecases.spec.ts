import { test, expect } from "@playwright/test";
import { H } from "./helpers";

// Real note-taking jobs-to-be-done (from the note-use-cases research) exercised
// end to end against the wired stack. Focus = the sticky daily-driver loop
// (capture → task → daily note → link) + the linking/retrieval payoff, since
// those are what real users actually do (vs the aspirational graph).

const mk = async (page: import("@playwright/test").Page, title: string, markdown = "") => {
  const r = await page.request.post("/api/nodes", { ...H, data: { title, markdown } });
  expect(r.status()).toBe(201);
  return r.json();
};
const bootstrap = async (page: import("@playwright/test").Page) => {
  const r = await page.request.get("/api/bootstrap");
  expect(r.ok()).toBeTruthy();
  return r.json();
};

test.describe("note use-cases", () => {
  // #3 meeting notes — the top professional use: a note that [[links]] a project
  // and carries action items. Verifies the link resolves to an edge + tasks land.
  test("meeting note: wikilink to a project + action items", async ({ page }) => {
    const stamp = Date.now();
    const apollo = await mk(page, `Project Apollo ${stamp}`);
    const standup = await mk(page, `Standup ${stamp}`, `Notes\n\n[[Project Apollo ${stamp}]]\n`);
    await page.request.post(`/api/nodes/${standup.id}/tasks`, { ...H, data: { title: "send recap" } });
    await page.request.post(`/api/nodes/${standup.id}/tasks`, { ...H, data: { title: "book room" } });

    const b = await bootstrap(page);
    const edge = (b.edges ?? []).find((e: { source_node_id?: string; target_node_id?: string }) => e.source_node_id === standup.id && e.target_node_id === apollo.id);
    expect(edge, "wikilink edge standup → apollo").toBeTruthy();
    const tasks = (b.tasks ?? []).filter((t: { node_id?: string; status?: string }) => t.node_id === standup.id);
    expect(tasks.length).toBe(2);
    expect(tasks.every((t: { status?: string }) => t.status === "todo")).toBeTruthy();
  });

  // #6 linking: backlinks track the TEXT — adding then removing [[B]] from A's
  // body must create then delete the edge (syncWikilinkEdges on every rewrite).
  test("wikilink bidirectionality + edit re-sync", async ({ page }) => {
    const stamp = Date.now();
    const b1 = await mk(page, `Target ${stamp}`);
    const a = await mk(page, `Source ${stamp}`, "no link yet");
    // add the link
    await page.request.patch(`/api/nodes/${a.id}`, { ...H, data: { markdown: `now links [[Target ${stamp}]]` } });
    await expect.poll(async () => {
      const b = await bootstrap(page);
      return (b.edges ?? []).some((e: { source_node_id?: string; target_node_id?: string }) => e.source_node_id === a.id && e.target_node_id === b1.id);
    }).toBeTruthy();
    // remove the link
    await page.request.patch(`/api/nodes/${a.id}`, { ...H, data: { markdown: "link removed" } });
    await expect.poll(async () => {
      const b = await bootstrap(page);
      return (b.edges ?? []).some((e: { source_node_id?: string; target_node_id?: string }) => e.source_node_id === a.id && e.target_node_id === b1.id);
    }).toBeFalsy();
  });

  // #10 version recovery — the durable-record promise that underpins keeping
  // notes at all: edit, then restore an earlier version.
  test("version history: edit then restore reverts the body", async ({ page }) => {
    const node = await mk(page, `Versioned ${Date.now()}`, "v0 original");
    await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { markdown: "v1 edited" } });
    const versions = await (await page.request.get(`/api/nodes/${node.id}/versions`)).json();
    const v0 = versions.find((v: { markdown?: string }) => (v.markdown || "").includes("v0 original"));
    expect(v0, "the original is retained as a version").toBeTruthy();
    const restore = await page.request.post(`/api/nodes/${node.id}/versions/${v0.id}/restore`, { ...H, data: {} });
    expect(restore.status()).toBe(200);
    await expect.poll(async () => {
      const list = await (await page.request.get(`/api/nodes/${node.id}/versions`)).json();
      // newest version (the restore) should carry the reverted body
      return (list[0]?.markdown || "").includes("v0 original");
    }).toBeTruthy();
  });

  // #4 daily-note catch-all via the Today button (the sticky chronological dump).
  test("Today opens the daily note and an edit there persists", async ({ page }) => {
    await page.goto("/?view=notes", { waitUntil: "load" });
    await page.keyboard.press("ControlOrMeta+Shift+D"); // the topbar Today button is gone (daily-notes module)
    await expect(page, "a daily node is focused").toHaveURL(/node=/);
    const url = page.url();
    const nodeId = new URL(url).searchParams.get("node")!;
    const editor = page.locator(".cm-content").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("End");
    const stamp = `dump-${Date.now()}`;
    await page.keyboard.type(`\n${stamp}`);
    const save = page.locator('button:has-text("Save")').first();
    if (await save.isEnabled().catch(() => false)) await save.click();
    await expect.poll(async () => {
      const list = await (await page.request.get(`/api/nodes/${nodeId}/versions`)).json();
      return Array.isArray(list) && list.some((v: { markdown?: string }) => (v.markdown || "").includes(stamp));
    }, { timeout: 12_000 }).toBeTruthy();
  });
});
