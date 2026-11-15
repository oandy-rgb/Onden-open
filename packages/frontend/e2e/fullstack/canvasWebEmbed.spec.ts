// ⑦ web embed card: a note whose body is a single bare URL renders on the
// board as an embedded page (domain bar + sandboxed iframe + open-in-new-tab)
// instead of a one-line link; ordinary notes keep the markdown preview.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


async function makeNode(page: Page, title: string, markdown: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json();
}

test("board: bare-URL note renders as a web embed card", async ({ page }) => {
  const stamp = Date.now();
  const web = await makeNode(page, `Web ${stamp}`, "https://example.com/some/article");
  const plain = await makeNode(page, `Plain ${stamp}`, "ordinary **markdown** body");
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `EmbedBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: web.id, x: 80, y: 80, width: 320, height: 260 },
      { nodeId: plain.id, x: 520, y: 80, width: 240 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2, { timeout: 30_000 });

  const embed = page.locator(".card-node-webembed");
  await expect(embed).toHaveCount(1);
  await expect(embed.locator(".card-node-webembed-bar")).toContainText("example.com");
  // A page from an arbitrary site loads only when asked (#624: only known
  // video hosts embed on their own); until then the card shows the address.
  await expect(embed.locator("iframe")).toHaveCount(0);
  await expect(embed.locator(".card-node-webembed-url")).toHaveText("https://example.com/some/article");
  await embed.getByRole("button", { name: "Load preview" }).click();
  await expect(embed.locator("iframe")).toHaveAttribute("src", "https://example.com/some/article");
  await expect(embed.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  const open = embed.locator("a");
  await expect(open).toHaveAttribute("href", "https://example.com/some/article");
  await expect(open).toHaveAttribute("target", "_blank");

  // the ordinary note still gets the markdown preview, not an embed
  await expect(page.locator('.react-flow__node:has-text("ordinary")').locator(".card-md-preview")).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/web-embed.png" });
});
