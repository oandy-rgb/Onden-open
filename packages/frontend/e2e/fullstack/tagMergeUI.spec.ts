// P2 merge UI: the schema lens's "Merge into another tag" flow — open the
// panel → pick a target → plain-language blast radius → confirm → source
// dissolves into target. (Backend: /merge-preview + /merge.)
import { test, expect } from "@playwright/test";
import { ready, tagMenuAction, H } from "./helpers";


test("merge flow: pick target \u2192 preview numbers \u2192 confirm \u2192 membership moved", async ({ page }) => {
  const stamp = Date.now();
  const src = await (await page.request.post("/api/tags/import", { ...H, data: { name: `uiSrc${stamp}`, fields: [{ name: "only_src", type: "text" }] } })).json();
  const tgt = await (await page.request.post("/api/tags/import", { ...H, data: { name: `uiTgt${stamp}`, fields: [] } })).json();
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `ui merge note ${stamp}`, markdown: "x" } })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${src.id}`, { ...H, data: {} });

  await ready(page, `/?view=notes&node=${src.id}`);
  await tagMenuAction(page, /^Merge into…$/);

  const panel = page.getByRole("region", { name: "Merge into another tag" });
  await expect(panel).toBeVisible();
  await panel.locator(".schema-lens-merge-select").selectOption(tgt.id);

  // The preview spells out the blast radius in plain language, in a confirm dialog
  // (tagPage/MergePanel: a Modal alertdialog since the confirms became dialogs).
  const confirm = page.getByRole("alertdialog", { name: `Merge #uiSrc${stamp} into` });
  await expect(confirm).toContainText(`Merging #uiSrc${stamp} into #uiTgt${stamp}`);
  await expect(confirm).toContainText(`1 note will also get #uiTgt${stamp}`);
  await expect(confirm).toContainText("only_src");
  await page.screenshot({ path: "/tmp/pw-output/tag-merge-ui.png" });

  await confirm.locator(".schema-lens-merge-go").click();
  await expect.poll(async () => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const n = boot.nodes.find((x: { id: string }) => x.id === note.id);
    return (n?.class_tag_ids ?? []).includes(tgt.id) && !boot.tags.some((tg: { id: string }) => tg.id === src.id);
  }, { timeout: 15_000 }).toBe(true);
});
