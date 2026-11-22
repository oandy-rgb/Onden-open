// Feature-audit deepening (2026-10-07): NOTE-09 — all four templates from the
// palette and the slash menu, default tags, no carry-over, and failure paths.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

const TEMPLATES = [
  { label: "Daily note", heading: "## Agenda", tag: "daily", title: /^\d{4}-\d{2}-\d{2}$/ },
  { label: "Meeting notes", heading: "## Action items", tag: "meeting", title: /^Meeting — / },
  { label: "Reading notes", heading: "## Key ideas", tag: "reading", title: /^Reading — / },
  { label: "Character sheet", heading: "## Inventory", tag: "character", title: /^Character — / },
];

async function openPalette(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
const selectedId = (page: Page) => new URL(page.url()).searchParams.get("node");

// The "Daily note" template does not mint a note: it opens today's note, and stamps its scaffold only when that note is
// empty (useNodeCreation.createTemplateNote — a day that already has words is opened as it is). Other specs write into
// today's note (usecases.spec.ts types a line there), so this one first puts it in the state it asserts about.
async function blankTodaysNote(page: Page) {
  const today = await page.evaluate(() => new Date().toLocaleDateString("sv")); // the browser and the workspace share a zone (cloud-stack.mjs)
  const nodes = (await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ id: string; title: string; markdown?: string }>;
  for (const day of nodes.filter((n) => n.title === today)) {
    const res = await page.request.patch(`/api/nodes/${day.id}`, { ...H, data: { markdown: "" } });
    expect(res.ok(), `empty today's note ${day.id}: ${res.status()}`).toBe(true);
  }
}

test("NOTE-09: palette mints each template with its scaffold and default tag, no carry-over", async ({ page }) => {
  test.setTimeout(180_000);
  await ready(page, "/?view=notes"); // so the page has a zone to say what today is
  await blankTodaysNote(page);
  await ready(page, "/?view=notes");
  const out: Record<string, string> = {};
  let previousId: string | null = null;
  for (const tpl of TEMPLATES) {
    await openPalette(page);
    await page.locator(".palette-input-wrap input").fill(`>template: ${tpl.label.split(" ")[0]}`);
    await page.locator(".palette-item", { hasText: `New from template: ${tpl.label}` }).click();
    await expect(page.locator(".palette-modal")).toHaveCount(0);
    await expect(page.locator(".obsidian-title-input")).toHaveValue(tpl.title);
    await expect.poll(() => page.locator(".cm-content").innerText()).toContain(tpl.heading.replace("## ", ""));
    const id = selectedId(page)!;
    const node = await (await page.request.get(`/api/nodes/${id}`, H)).json();
    const boot = await (await page.request.get("/api/bootstrap?bodies=none", H)).json();
    const row = boot.nodes.find((x: { id: string }) => x.id === id) ?? {};
    const tagIds = [...(row.class_tag_ids ?? []), ...(row.label_tag_ids ?? [])];
    const tagNames = JSON.stringify((boot.tags ?? []).filter((tg: { id: string }) => tagIds.includes(tg.id)).map((tg: { name: string }) => tg.name));
    const others = TEMPLATES.filter((o) => o !== tpl).map((o) => o.heading);
    out[tpl.label] = `new=${id !== previousId} body=${node.markdown.includes(tpl.heading)} foreignHeadings=${others.filter((h) => h !== "## Agenda" && h !== "## Notes" && node.markdown.includes(h)).length} tag=${tagNames.includes(tpl.tag)}`;
    previousId = id;
    await page.keyboard.press("Escape");
  }
  console.log(`AUDIT NOTE-09 palette ${JSON.stringify(out)}`);
});

test("NOTE-09: slash menu stamps each template into the current note", async ({ page }) => {
  const out: Record<string, string> = {};
  for (const tpl of TEMPLATES) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `Slash ${tpl.label} ${Date.now()}`, markdown: "" } })).json();
    await ready(page, `/?view=notes&node=${n.id}`);
    await page.locator(".cm-content").click();
    await page.keyboard.type(`/${tpl.label.split(" ")[0].toLowerCase()}`);
    const item = page.locator(".slash-menu-title", { hasText: `Template text: ${tpl.label}` });
    const shown = await item.isVisible({ timeout: 5000 }).catch(() => false);
    if (shown) await page.keyboard.press("Enter");
    await expect.poll(async () => (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown, { timeout: 10_000 }).toContain(tpl.heading);
    const body = (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string;
    out[tpl.label] = `menuItem=${shown} stamped=${body.includes(tpl.heading)} triggerLeft=${body.includes("/" + tpl.label.split(" ")[0].toLowerCase())}`;
  }
  console.log(`AUDIT NOTE-09 slash ${JSON.stringify(out)}`);
});

test("NOTE-09: failure paths — create 503 and default-tag failure", async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page, "/?view=notes");
  const before = new Set(((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ id: string }>).map((n) => n.id));
  // 1. POST /api/nodes rejected.
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }) : r.continue());
  await openPalette(page);
  const query = ">template: Reading";
  await page.locator(".palette-input-wrap input").fill(query);
  await page.locator(".palette-item", { hasText: "New from template: Reading notes" }).click();
  await page.waitForTimeout(1500);
  const paletteOpen = await page.locator(".palette-modal").count();
  const keptQuery = paletteOpen ? await page.locator(".palette-input-wrap input").inputValue() : "(closed)";
  const notices = await page.locator(".toast, [role='alert']").allInnerTexts();
  await page.unroute("**/api/nodes");
  const afterCreate = ((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ id: string; title: string }>).filter((n) => !before.has(n.id));
  console.log(`AUDIT NOTE-09 create503 paletteOpen=${paletteOpen} keptQuery=${JSON.stringify(keptQuery)} notices=${JSON.stringify(notices.slice(0, 2))} created=${afterCreate.length}`);
  await page.keyboard.press("Escape");

  // 2. Node created but default tag resolution fails.
  await page.route("**/api/tags/resolve-path", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await openPalette(page);
  await page.locator(".palette-input-wrap input").fill(">template: Meeting");
  await page.locator(".palette-item", { hasText: "New from template: Meeting notes" }).click();
  await page.waitForTimeout(2000);
  const notices2 = await page.locator(".toast, [role='alert']").allInnerTexts();
  await page.unroute("**/api/tags/resolve-path");
  const id = selectedId(page);
  let node: { title: string; markdown: string } | null = null;
  if (id) {
    // Assert the status first: an error body has no `markdown`.
    const res = await page.request.get(`/api/nodes/${id}`, H);
    expect(res.status(), `GET /api/nodes/${id}`).toBe(200);
    node = await res.json();
  }
  console.log(`AUDIT NOTE-09 tag503 opened=${!!node && /^Meeting/.test(node.title)} body=${!!node && (node.markdown ?? "").includes("## Action items")} notices=${JSON.stringify(notices2.slice(0, 2))}`);
});
