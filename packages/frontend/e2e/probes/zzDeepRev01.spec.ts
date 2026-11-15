// Feature-audit deepening (2026-10-07): REV-01 — enrolment via a review-enabled
// tag: rename the tag, remove membership, disable the function, and a card the
// viewer cannot read.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";

const queue = async (req: APIRequestContext, tagId?: string) => {
  const r = await req.get(`/api/review/queue${tagId ? `?tag_id=${tagId}` : ""}`, H);
  const j = await r.json().catch(() => ({}));
  return { s: r.status(), titles: ((j.cards ?? []) as Array<{ title: string }>).map((c) => c.title), total: j.total };
};

test("REV-01: rename, remove, disable, and unreadable cards", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `Rev01-${s}`, fields: [] } })).json();
  // Default space: the second human below must see CardA/CardB.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (t: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: `Q: ${t}?\nA: yes`, space_id } })).json()).id as string;
  const a = await mk(`CardA ${s}`), b = await mk(`CardB ${s}`), secret = await mk(`CardSecret ${s}`);
  for (const id of [a, b, secret]) await Promise.all([page.request.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(page.request, id)]);
  await hideFromOthers(page.request, secret); // an owner-only space
  const mine = (titles: string[]) => titles.filter((t) => t.endsWith(String(s))).sort();
  out.initial = JSON.stringify(mine((await queue(page.request, tag.id)).titles));

  // Rename the capability tag → enrolment survives.
  await page.request.patch(`/api/nodes/${tag.id}`, { ...H, data: { title: `Rev01-renamed-${s}` } });
  out.afterRename = JSON.stringify(mine((await queue(page.request, tag.id)).titles));

  // Remove one membership → that card leaves the queue; UI drawer reflects it after refresh.
  await page.request.delete(`/api/nodes/${b}/tags/${tag.id}`, H);
  out.afterRemove = JSON.stringify(mine((await queue(page.request, tag.id)).titles));

  // Another human (editor) does not see the owner-only card, and its count excludes it.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R01 ${s}`, email: `r01-${s}@example.com`, password: `pw-${s}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `R01 ${s}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const eq = await queue(human.request, tag.id);
  const estats = await (await human.request.get(`/api/review/stats?tag_id=${tag.id}`, H)).json();
  out.editor = `queue=${JSON.stringify(mine(eq.titles))} statsNew=${estats.new} leaksSecret=${JSON.stringify(eq).includes("CardSecret")}`;
  out.editorGradeSecret = String((await human.request.post(`/api/review/${secret}/grade`, { ...H, data: { rating: 3 } })).status());
  await human.close();

  // UI: home review line and drawer after the changes.
  await ready(page, "/?view=notes");
  const ui = await page.locator(".home-start-review").innerText().catch(() => "(no home review line)");
  out.homeLine = JSON.stringify(ui.replace(/\s+/g, " ").slice(0, 80));

  // Disable the review function → the remaining card leaves the queue; re-enable brings it back with its state.
  await page.request.post(`/api/review/${a}/grade`, { ...H, data: { rating: 3 } });
  const disable = await page.request.patch(`/api/tags/${tag.id}/modules`, { ...H, data: { review: false } });
  out.afterDisable = `${disable.status()} ${JSON.stringify(mine((await queue(page.request)).titles))}`;
  await page.request.patch(`/api/tags/${tag.id}/modules`, { ...H, data: { review: true } });
  const attrs = await (await page.request.get(`/api/nodes/${a}/attributes`, H)).json();
  out.afterReenable = `queue=${JSON.stringify(mine((await queue(page.request, tag.id)).titles))} stateKept=${attrs.some((x: { key: string }) => x.key === "_review_state")}`;
  console.log(`AUDIT REV-01 ${JSON.stringify(out)}`);
});
