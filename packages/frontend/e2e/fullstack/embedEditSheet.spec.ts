// Tapping a rendered `![[Note#^id]]` block embed opens an editor for the
// SOURCE block (components/EmbedEditSheet) — a bottom sheet on a phone —
// instead of turning the embed back into `![[…]]` text. Edit, close: the embed
// shows the new text and the source note holds it (the sheet's text carries no id).
// A `![[Note/words]]` part embed is read-only (lib/embedDom never passes it to onEdit), so this protects the
// anchored block form.
import { test, expect, devices } from "@playwright/test";
import { ready, H } from "./helpers";

test.use({ ...devices["Pixel 5"] });


test("phone: tap an embed -> sheet -> edit -> close -> embed and source note have the new text", async ({ page }) => {
  const stamp = Date.now();
  const sourceTitle = `Embed source ${stamp}`;
  const sourceBody = `Before.\n\n- first item\n  - child one\n  - child two\n\nAfter.`;
  const source = await (await page.request.post("/api/nodes", { ...H, data: { title: sourceTitle, markdown: sourceBody } })).json() as { id: string };
  const host = await (await page.request.post("/api/nodes", { ...H, data: { title: `Embed host ${stamp}`, markdown: "Top line.\n\nBottom line." } })).json() as { id: string };
  // A paragraph is a block only once it has an anchor (段落錨點, 2026-11-07): a hand-typed `^id` names nothing. Anchor
  // the list item the way pasting a copied paragraph link does, and embed it by that anchor's id.
  const anchor = await page.request.post(`/api/nodes/${source.id}/block-links`, { ...H, data: { source_note_id: host.id, at: sourceBody.indexOf("first item"), seen_text: "first item" } });
  expect(anchor.status(), "anchor the list item").toBe(201);
  const { anchor_id: anchorId } = await anchor.json() as { anchor_id: string };
  await page.request.patch(`/api/nodes/${host.id}`, { ...H, data: { markdown: `Top line.\n\n![[${sourceTitle}#^${anchorId}]]\n\nBottom line.`, base_markdown: "Top line.\n\nBottom line." } });

  await ready(page, `/?view=notes&node=${host.id}`);
  const embed = page.locator(".cm-embed .md-transclusion-body");
  await expect(embed).toContainText("child two", { timeout: 20_000 });

  // A tap on the top, then the bottom line of the embed: the sheet opens each
  // time and the embed's `![[…]]` text never appears.
  const lines = embed.locator("li");
  // The sheet's own Back: the phone note's top bar has a Back button too.
  for (const line of [lines.first(), lines.last()]) {
    await line.tap();
    await expect(page.getByRole("dialog", { name: `Edit: ${sourceTitle}` })).toBeVisible();
    await expect(page.locator(".cm-content")).not.toContainText("![[");
    await page.getByRole("dialog", { name: /^Edit: / }).getByRole("button", { name: "Back" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  await embed.tap();
  const text = page.getByLabel("Source text");
  await expect(text).toHaveValue("- first item\n  - child one\n  - child two");
  await text.fill("- first item, edited\n  - child one\n  - child two\n  - child three");
  await page.getByRole("dialog", { name: /^Edit: / }).getByRole("button", { name: "Back" }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(embed).toContainText("child three", { timeout: 20_000 });
  await expect(embed).toContainText("first item, edited");
  await expect(page.locator(".cm-content")).not.toContainText("![[");

  await expect.poll(async () => ((await (await page.request.get(`/api/nodes/${source.id}`)).json()) as { markdown: string }).markdown, { timeout: 20_000 })
    .toBe(`Before.\n\n- first item, edited\n  - child one\n  - child two\n  - child three\n\nAfter.`);
});
