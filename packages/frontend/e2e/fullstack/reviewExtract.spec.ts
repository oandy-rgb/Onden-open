// 抓題 (⑥ composite learning flow): the palette's "Extract review cards"
// carves a lecture's Q:/A: blocks into CHILD notes tagged #review — they
// land in the FSRS queue and under the lecture in the tree (立體化: cards
// grow in the structure). Re-running is idempotent by question title.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";



async function makeNode(page: Page, title: string, markdown: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json();
}

async function runExtract(page: Page) {
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await page.locator(".palette-trigger").click();
  const paletteInput = page.locator(".palette-input-wrap input");
  await paletteInput.waitFor({ timeout: 10_000 });
  await paletteInput.fill(">extract");
  await page.locator(".palette-item", { hasText: "Extract review cards (Q:/A:)" }).click();
}

test("extract Q/A → review card children (their own references); re-run is a no-op", async ({ page }) => {
  const stamp = Date.now();
  const lecture = await makeNode(page, `Mitosis lecture ${stamp}`, [
    "## Phases",
    "prose about phases",
    "",
    `Q: What are the phases of mitosis? (${stamp})`,
    "A: Prophase, metaphase, anaphase, telophase.",
    "",
    `Q: What holds sister chromatids together? (${stamp})`,
    "A: Cohesin.",
  ].join("\n"));

  await ready(page, `/?view=notes&node=${lecture.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });

  await runExtract(page);

  // two children created under the lecture
  await expect.poll(async () => {
    const boot = await (await page.request.get("/api/bootstrap", H)).json();
    return (boot.nodes as Array<{ parent_id: string | null }>).filter((n) => n.parent_id === lecture.id).length;
  }, { timeout: 15_000 }).toBe(2);

  const boot = await (await page.request.get("/api/bootstrap", H)).json();
  const kids = (boot.nodes as Array<{ parent_id: string | null; title: string; markdown: string; sort_order: number }>)
    .filter((n) => n.parent_id === lecture.id)
    .sort((a, b) => a.sort_order - b.sort_order);
  expect(kids.map((k) => k.title)).toEqual([
    `What are the phases of mitosis? (${stamp})`,
    `What holds sister chromatids together? (${stamp})`,
  ]);
  // the card carries the answer + a wikilink back to its lecture
  expect(kids[1].markdown).toContain("Cohesin.");
  expect(kids[1].markdown).toContain(`[[Mitosis lecture ${stamp}]]`);
  // the lecture body is NOT rewritten (unlike split)
  const parent = (boot.nodes as Array<{ id: string; markdown: string }>).find((n) => n.id === lecture.id)!;
  expect(parent.markdown).toContain("A: Cohesin.");

  // Each extracted note is a review card of its own (its own reference; no tag is involved). Asked of the card itself rather
  // than of the queue, which the person's daily cap may crowd on a warmed stack.
  for (const kid of kids as unknown as Array<{ id: string }>) {
    expect(await (await page.request.get(`/api/review/cards/${kid.id}`, H)).json()).toMatchObject({ card: true, node_id: kid.id });
  }
  // The lecture itself is not a card: only the notes extracted from it are.
  expect(await (await page.request.get(`/api/review/cards/${lecture.id}`, H)).json()).toMatchObject({ card: false });

  // 講義 task+due (front of the flow): extraction drops a study task on the
  // lecture due TODAY, surfaced on the agenda (new cards are due now).
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const agenda = await (await page.request.get("/api/tasks/agenda", H)).json();
  const allTasks = Object.values(agenda.buckets as Record<string, Array<{ title: string; node_id: string; due_date: string | null }>>).flat();
  const studyTask = allTasks.find((tk) => tk.node_id === lecture.id && tk.title === `Study: Mitosis lecture ${stamp}`);
  expect(studyTask, "a study task landed on the lecture").toBeTruthy();
  expect(studyTask!.due_date).toBe(today);

  // idempotent: extracting again creates no new cards AND no second study task
  await runExtract(page);
  await expect(page.getByText("All 2 cards already extracted")).toBeVisible({ timeout: 10_000 });
  const boot2 = await (await page.request.get("/api/bootstrap", H)).json();
  expect((boot2.nodes as Array<{ parent_id: string | null }>).filter((n) => n.parent_id === lecture.id).length).toBe(2);
  const agenda2 = await (await page.request.get("/api/tasks/agenda", H)).json();
  const studyTasks2 = Object.values(agenda2.buckets as Record<string, Array<{ title: string; node_id: string }>>).flat()
    .filter((tk) => tk.node_id === lecture.id && tk.title === `Study: Mitosis lecture ${stamp}`);
  expect(studyTasks2).toHaveLength(1);
});

test("a lecture on a board: extracted cards land NEXT TO it (立體化)", async ({ page }) => {
  const stamp = Date.now();
  const lecture = await makeNode(page, `Meiosis lecture ${stamp}`, [
    `Q: What is crossing over? (${stamp})`,
    "A: Exchange of homologous chromosome segments in prophase I.",
    "",
    `Q: How many divisions in meiosis? (${stamp})`,
    "A: Two.",
  ].join("\n"));
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `StudyBoard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, {
    ...H, data: { data: { nodes: [{ nodeId: lecture.id, x: 100, y: 200, width: 300 }], edges: [] } },
  });

  // load AFTER placement so the client bootstrap carries the membership
  await ready(page, `/?view=notes&node=${lecture.id}`);
  await page.locator(".cm-content").first().waitFor({ timeout: 20_000 });
  await runExtract(page);
  await expect(page.getByText(`placed on “StudyBoard ${stamp}”`)).toBeVisible({ timeout: 15_000 });

  const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
  const entries = saved.data.nodes as Array<{ nodeId: string; x: number; y: number }>;
  expect(entries).toHaveLength(3); // lecture + 2 cards
  // two-column grid right of the anchor: base x = 100 + 300 + 80 = 480
  // (The board stores cards as rows without an order, so compare the grid
  // slots, left to right.)
  const cards = entries.filter((e) => e.nodeId !== lecture.id);
  expect(cards.map((e) => [e.x, e.y]).sort((p, q) => p[0] - q[0] || p[1] - q[1])).toEqual([[480, 200], [760, 200]]);
});
