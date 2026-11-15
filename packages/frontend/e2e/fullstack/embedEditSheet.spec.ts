// Tapping a rendered `![[Note/words]]` part embed opens an editor for the
// SOURCE block (components/EmbedEditSheet) — a bottom sheet on a phone —
// instead of turning the embed back into `![[…]]` text. Edit, close: the embed
// shows the new text and the source note holds it (the text carries no id).
import { test, expect, devices } from "@playwright/test";
import { ready, H } from "./helpers";

test.use({ ...devices["Pixel 5"] });


test("phone: tap an embed -> sheet -> edit -> close -> embed and source note have the new text", async ({ page }) => {
  const stamp = Date.now();
  const sourceTitle = `Embed source ${stamp}`;
  const source = await (await page.request.post("/api/nodes", {
    ...H, data: { title: sourceTitle, markdown: `Before.\n\n- first item\n  - child one\n  - child two\n\nAfter.` },
  })).json() as { id: string };
  const host = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Embed host ${stamp}`, markdown: `Top line.\n\n![[${sourceTitle}/first item]]\n\nBottom line.` },
  })).json() as { id: string };

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
    .toBe("Before.\n\n- first item, edited\n  - child one\n  - child two\n  - child three\n\nAfter.");
});
