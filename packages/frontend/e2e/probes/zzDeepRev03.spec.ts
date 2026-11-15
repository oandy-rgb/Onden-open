// Feature-audit deepening (2026-10-08): REV-03 — a real three-level subtree
// (course → chapters → cards) with a dedicated review tag (new_per_day = 3):
// deck list counts vs. what "study this deck" actually serves, the daily
// new-card budget in stats/queue/UI, which day the budget belongs to (a card
// first studied at 07:30 Taipei), an empty deck, and counts for a second
// user after read access to the course is revoked. (A chapter shares its
// course's space, so access can only be revoked for the whole course.)
import { test, type Page, type APIRequestContext } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H, psql as sql } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";


test("REV-03: subtree decks, daily budget and its day, empty deck, revoked course", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r03t${stamp}`, fields: [] } })).json();
  const space_id = await defaultSpaceId(req); // the second user must see the course first
  const mk = async (title: string, parent?: string, md = title) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: md, ...(parent ? { parent_id: parent } : { space_id }) } })).json()).id as string;
  const course = await mk(`R03 Course ${stamp}`);
  const ch1 = await mk(`R03 Ch1 ${stamp}`, course), ch2 = await mk(`R03 Ch2 ${stamp}`, course);
  const cards: Record<string, string[]> = { course: [], ch1: [], ch2: [] };
  for (let i = 0; i < 4; i++) cards.ch1.push(await mk(`R03 c1-${i} ${stamp}`, ch1, `Q c1-${i}`));
  for (let i = 0; i < 3; i++) cards.ch2.push(await mk(`R03 c2-${i} ${stamp}`, ch2, `Q c2-${i}`));
  cards.course.push(await mk(`R03 c0 ${stamp}`, course, "Q c0"));
  for (const id of [...cards.course, ...cards.ch1, ...cards.ch2]) await Promise.all([req.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, id)]);
  const empty = await mk(`R03 Empty ${stamp}`);
  await mk(`R03 Empty child ${stamp}`, empty);

  const stats = async (r: APIRequestContext) => { const s = await (await r.get(`/api/review/stats?tag_id=${tag.id}`)).json(); return { due: s.due, new: s.new, new_per_day: s.new_per_day, new_today: s.new_today, new_remaining: s.new_remaining, new_available: s.new_available }; };
  const queue = async (r: APIRequestContext, qs: string) => { const res = await r.get(`/api/review/queue?${qs}`); const j = await res.json().catch(() => ({})); return res.ok() ? { total: j.total, titles: (j.cards as Array<{ title: string }>).map((c) => c.title.replace(` ${stamp}`, "").replace("R03 ", "")) } : { status: res.status(), body: JSON.stringify(j).slice(0, 80) }; };
  const decks = async (r: APIRequestContext) => ((await (await r.get("/api/review/decks")).json()).decks as Array<{ node_id: string; title: string; due: number }>).filter((d) => d.title.includes(String(stamp))).map((d) => `${d.title.replace(` ${stamp}`, "").replace("R03 ", "")}:${d.due}`);

  out.statsStart = await stats(req);
  out.decksStart = await decks(req);
  out.queueTag = await queue(req, `tag_id=${tag.id}`);
  out.queueRootCourse = await queue(req, `root=${course}`);
  out.queueRootCh1 = await queue(req, `root=${ch1}`);
  out.queueRootEmpty = await queue(req, `root=${empty}`);

  // UI: Review page and "study deck" for the course.
  const ui = async (p: Page, label: string) => {
    await ready(p, `/?view=review`);
    await p.waitForTimeout(2500);
    out[`${label}ReviewPage`] = (await p.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
    await ready(p, `/?view=notes&node=${course}`);
    await p.keyboard.press("Control+k");
    await p.locator(".palette-input-wrap input").fill(">Review cards");
    await p.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
    await p.locator(".review-panel").waitFor({ timeout: 10_000 });
    await p.waitForTimeout(2000);
    out[`${label}CourseDeck`] = (await p.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  };
  await ui(page, "owner");

  // Grade three cards through the tag queue (spends today's budget).
  const first = ((await (await req.get(`/api/review/queue?tag_id=${tag.id}`)).json()).cards as Array<{ node_id: string }>).slice(0, 3);
  for (const c of first) out[`grade_${c.node_id.slice(0, 4)}`] = (await req.post(`/api/review/${c.node_id}/grade`, { ...H, data: { rating: 3 } })).status();
  out.statsAfter3 = await stats(req);
  out.queueTagAfter3 = await queue(req, `tag_id=${tag.id}`);
  out.queueRootCourseAfter3 = await queue(req, `root=${course}`);
  out.decksAfter3 = await decks(req);

  // Which day owns the budget? Pretend one of those three was first studied at
  // 2026-10-08 07:30 Taipei (= 2026-10-07T23:30Z) — still "today" for a
  // Taipei student. Isolated e2e DB only.
  const moved = first[0].node_id;
  const raw = sql(`select value from node_attributes where node_id='${moved}' and key='_review_state'`);
  const st = JSON.parse(raw); st.introduced_at = "2026-10-07T23:30:00.000Z"; st.last_review = "2026-10-07T23:30:00.000Z";
  sql(`update node_attributes set value='${JSON.stringify(st)}' where node_id='${moved}' and key='_review_state'`);
  out.statsAfterMorningCard = await stats(req);
  out.queueTagAfterMorningCard = await queue(req, `tag_id=${tag.id}`);
  out.localNow = new Date().toLocaleString("sv", { timeZone: "Asia/Taipei" });

  // Second user (editor) — then the course moves to an owner-only space.
  const tmp = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await tmp.request.post("/api/auth/sign-up/email", { ...H, data: { name: `R03B ${stamp}`, email: `r03b-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await req.post("/api/actors", { ...H, data: { name: `R03B ${stamp}`, type: "human", external_id: su.user.id } })).json();
  await addToDefaultSpace(req, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  out.bStatsBefore = await stats(tmp.request);
  out.bDecksBefore = await decks(tmp.request);
  out.lockApply = await hideFromOthers(req, course).then(() => "moved", (e) => String(e).slice(0, 120));
  out.bStatsAfter = await stats(tmp.request);
  out.bDecksAfter = await decks(tmp.request);
  out.bQueueRootCh2 = await queue(tmp.request, `root=${ch2}`);
  out.bQueueRootCourse = await queue(tmp.request, `root=${course}`);
  out.bGradeLocked = (await tmp.request.post(`/api/review/${cards.ch2[0]}/grade`, { ...H, data: { rating: 3 } })).status();
  out.ownerStillSees = await stats(req);
  await tmp.close();
  console.log("REV03 " + JSON.stringify(out, null, 2));
});
