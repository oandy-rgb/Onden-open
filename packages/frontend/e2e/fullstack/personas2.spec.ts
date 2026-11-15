import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, requireAdmin, openNoteDecisions, defaultSpaceId, createPublishingSpace, hideFromOthers, siteDesign, H, publishRequest } from "./helpers";

// PERSONA INTENT journeys, batch 2 — more occupations over subsystems the
// first batch didn't touch: a multi-page published course,
// the agent-APPROVE governance path (vs the editor's reject), a developer's
// code+task log, compliance (a sensitive doc in a space that cannot publish
// stays private even when the site is public), and typed CRM records. Stamped titles keep every
// run idempotent on the shared onden_test stack.
const SHOTS = "/tmp/pw-output/shots";

// Cold start runs a membership reconcile that briefly raises the fail-closed
// gate (an inert scrim) — wait it out before driving the workspace.
async function settled(page: Page, url: string): Promise<void> {
  await ready(page, url);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 15_000 });
}

// Root notes go to the default space: a personal space never publishes.
// `space_id`: a space whose publish switch is on, for a note the spec expects on the site.
const mkNote = async (page: Page, title: string, markdown: string, parent_id?: string, space_id?: string): Promise<{ id: string; slug: string }> =>
  (await (await page.request.post("/api/nodes", {
    ...H, data: { title, markdown, ...(parent_id ? { parent_id } : { space_id: space_id ?? await defaultSpaceId(page.request) }) },
  })).json());

const publish = (page: Page, id: string) =>
  page.request.put(`/api/nodes/${id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });

async function agentHeaders(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): a new agent may only suggest, and a suggest-only agent cannot apply tags or create notes (suggest_only, 2026-10-30).
  return { headers: (await createAgent(page.request, name, { reviewRule: "apply" })).headers };
}

// 8 — TEACHER: build a course as a parent unit with child lessons, publish it,
//     and the public site is a NAVIGABLE multi-page course (the note tree lists
//     the unit with its lesson under it).
test("teacher: a parent unit + child lesson publish as a navigable multi-page course", async ({ page }) => {
  const stamp = Date.now();
  const unit = await mkNote(page, `Unit ${stamp}`, "# Unit 1\n\nOverview of the course.", undefined, await createPublishingSpace(page.request));
  const lesson = await mkNote(page, `Lesson ${stamp}`, "# Lesson 1\n\nThe first lesson body.", unit.id);
  await publish(page, unit.id);
  await publish(page, lesson.id);
  // The article frame's left note tree on, so the unit and its lesson read as a course.
  const design = siteDesign({ homeNoteId: unit.id, frames: { article: { tree: true } } });
  const saved = await page.request.patch("/api/workspace/config", { ...H, data: { config: { brand: "Course", locale: "en" }, chrome: design } });
  requireAdmin(saved.status() !== 403, "config needs the owner");
  const pub = await publishRequest(page.request, { title: `Course ${stamp}`, home_node_id: unit.id });
  requireAdmin(pub.status() !== 403, "publish needs the owner");
  expect(pub.status()).toBe(201);

  // The hierarchy reaches the public payload: the lesson hangs under the unit.
  const site = await (await page.request.get("/api/site")).json();
  const payloadLesson = (site.payload?.nodes ?? []).find((n: { id: string }) => n.id === lesson.id);
  expect(payloadLesson?.parent_id).toBe(unit.id);

  // The lesson's public page sits in the same series as its unit: the previous/next
  // links and the note tree (turned on in the article frame) are real links.
  await page.goto(`/site/${lesson.slug}`, { waitUntil: "networkidle" });
  await expect(page.locator(".s-article__title")).toHaveText(`Lesson ${stamp}`);
  await expect(page.locator(".s-tree a", { hasText: `Unit ${stamp}` })).toBeVisible();
  await expect(page.locator(".s-tree a[aria-current='page']")).toHaveText(`Lesson ${stamp}`);
  await page.screenshot({ path: `${SHOTS}/persona-teacher-course.png`, fullPage: true });
});

// 9 — CONSULTANT working WITH an AI agent: the agent drafts a note; the human
//     reviews and APPROVES it (the trust-building flip side of the editor's
//     reject — delegate, then ratify).
test("consultant: approves an agent's drafted note from the inbox", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Assistant ${stamp}`);
  requireAdmin(agentH !== null, "needs admin to mint an agent actor");
  const created = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Draft brief ${stamp}`, markdown: "Proposed outline for the engagement." } } });
  expect(created.ok()).toBeTruthy();

  await settled(page, "/?view=notes");
  // The inbox's 「等你決定」 lists the drafted note; its review card is decided in the note
  // itself (review → inbox, 2026-10-30; helper openNoteDecisions).
  const listed = await openNoteDecisions(page, `Draft brief ${stamp}`);
  const item = page.locator(".inbox-review-item").first();
  await page.screenshot({ path: `${SHOTS}/persona-consultant-inbox.png` });
  await item.locator(".inbox-review-approve").click();
  await expect(page.locator(".inbox-review-item")).toHaveCount(0);
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  await expect(listed).toHaveCount(0);

  // Approving RATIFIES — the agent's note stays in the workspace.
  await expect
    .poll(async () => (await (await page.request.get("/api/bootstrap")).json()).nodes.some((n: { title: string }) => n.title === `Draft brief ${stamp}`))
    .toBe(true);
});

// 10 — DEVELOPER: a dev-log note holds a code snippet and a deploy task; the
//      task is checked off in the agenda — log the work, track the work.
test("developer: a dev log keeps a code snippet and its deploy task is checked off", async ({ page }) => {
  const stamp = Date.now();
  const note = await mkNote(page, `Dev log ${stamp}`, `# Deploy ${stamp}\n\n\`\`\`bash\nkubectl apply -f deploy.yaml ${stamp}\n\`\`\`\n`);
  const taskTitle = `Roll out ${stamp}`;
  await page.request.post(`/api/nodes/${note.id}/tasks`, { ...H, data: { title: taskTitle } });

  // The code snippet is in the editor (the dev's log is real + editable).
  await settled(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".cm-content")).toContainText(`kubectl apply -f deploy.yaml ${stamp}`);
  await page.screenshot({ path: `${SHOTS}/persona-developer-log.png`, fullPage: true });

  // Check the deploy task off on the Tasks page → it persists as done. A task with no date is
  // in 隨時 (Tasks page since 2026-11-06); its box is the row's checkbox button.
  await settled(page, "/?view=tasks");
  await page.getByRole("tab", { name: /^Anytime/ }).click();
  const row = page.getByRole("tabpanel", { name: /^Anytime/ }).locator(".tk-row", { hasText: taskTitle });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("checkbox", { name: `Mark ${taskTitle} done` }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/bootstrap")).json()).tasks.find((t: { title: string; status: string }) => t.title === taskTitle)?.status)
    .toBe("done");
});

// 11 — COMPLIANCE OFFICER: a sensitive document is moved to a restricted space
//      (only its owner, publishing off); even when the note is marked
//      published, it must NOT leak to the public — opt-in publishing never
//      overrides the space.
test("compliance: a note in a restricted space never reaches the public site", async ({ page }) => {
  const stamp = Date.now();
  const secret = `CONFIDENTIAL${stamp}`;
  const doc = await mkNote(page, `Contract ${stamp}`, `# Contract\n\n${secret} — privileged terms.`);
  await publish(page, doc.id); // the author opts it into the site…

  // …but moves it to a restricted space (new spaces cannot publish).
  await hideFromOthers(page.request, doc.id);

  // The space wins over the publish flag: the doc is absent
  // from the public payload AND its text never appears in the served HTML.
  await expect
    .poll(async () => (await (await page.request.get("/api/site")).json()).payload?.nodes?.some((n: { id: string }) => n.id === doc.id))
    .toBe(false);
  const html = await (await page.request.get(`/site/${doc.slug}`)).text();
  expect(html).not.toContain(secret);
});

// 12 — SALES / CRM: deals are typed records — a #deal tag with a status (select)
//      and an amount (number); a deal carries those validated fields, and a
//      value outside the schema is rejected.
test("sales: a deal carries typed, validated fields", async ({ page }) => {
  const stamp = Date.now();
  const imp = await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `deal${stamp}`,
      fields: [
        { name: "stage", type: "select", label: "Stage", options: ["lead", "won", "lost"], default: "lead" },
        { name: "amount", type: "number", label: "Amount" },
      ],
    },
  });
  requireAdmin(imp.ok(), "needs admin to mint a schema tag");
  const dealTag = await imp.json();
  const deal = await mkNote(page, `ACME deal ${stamp}`, "Negotiating the annual contract.");
  await page.request.put(`/api/nodes/${deal.id}/tags/${dealTag.id}`, { ...H, data: {} }); // seeds stage=lead

  // Applying the tag seeded the typed default; set the amount + advance the stage.
  await page.request.put(`/api/nodes/${deal.id}/attributes/amount`, { ...H, data: { value: "50000", value_type: "number" } });
  await page.request.put(`/api/nodes/${deal.id}/attributes/stage`, { ...H, data: { value: "won", value_type: "text" } });

  const attrs = await (await page.request.get(`/api/nodes/${deal.id}/attributes`)).json();
  const by = (k: string) => (attrs as Array<{ key: string; value: string }>).find((a) => a.key === k)?.value;
  expect(by("stage")).toBe("won");
  expect(by("amount")).toBe("50000");

  // The schema VALIDATES: a stage outside the select options is rejected.
  const bad = await page.request.put(`/api/nodes/${deal.id}/attributes/stage`, { ...H, data: { value: "bogus", value_type: "text" } });
  expect(bad.status()).toBe(422);
});
