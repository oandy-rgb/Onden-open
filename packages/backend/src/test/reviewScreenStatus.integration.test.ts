// The review screen and status page (docs/architecture/proposals/review-strengthen-2026-11-13.md 3.2, 3.4):
// a card's neighbours and next intervals, "tomorrow", stop and resume,
// undo, the daily cap, the forecast and the often-forgotten list. Every
// schedule is per person, so each case runs with two people in one workspace.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import type { ReviewState, ReviewStatus, ReviewQueue } from "@onden/contract";
import { persistActor } from "./helpers/persistActor.js";
import reviewRouter from "../modules/review/routes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { resetDayClock, setDayClock } from "../localDay.js";

registerShippedModules();

const DAY = 86_400_000;
// 10:00 in Taipei on 2026-11-13: the workspace's day is cut at Taipei midnight, not UTC's.
const NOW = "2026-11-13T02:00:00.000Z";
const TOMORROW_STARTS = "2026-11-13T16:00:00.000Z"; // 2026-11-14 00:00 in Taipei
const at = (days: number) => new Date(new Date(NOW).getTime() + days * DAY).toISOString();

let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter);
const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const queue = async (now = NOW) => (await (await req(`/api/review/queue?now=${encodeURIComponent(now)}`)).json() as ReviewQueue);
const status = async (now = NOW) => (await (await req(`/api/review/status?now=${encodeURIComponent(now)}`)).json() as ReviewStatus);
const ids = (cards: ReviewQueue["cards"]) => cards.map(card => card.node_id);

function stateOf(due: string, extra: Partial<ReviewState> = {}): string {
  return JSON.stringify({ due, stability: 4, difficulty: 5, reps: 3, lapses: 0, state: "review", last_review: at(-4), ...extra });
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("review screen and status page", () => {
  let ann: ActorCtx, bob: ActorCtx, parentId = "";
  const notes: string[] = [];

  const makeNote = async (title: string, markdown = "", parent: string | null = null) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown,parent_id)
      VALUES($1::uuid,$2,'manual','content',$3,$1::text,$4,$5)`, [id, context.workspaceId, title, markdown, parent]);
    notes.push(id);
    return id;
  };
  /** The note's or paragraph's own review reference: what makes it a card (migration 195). */
  const makeCard = (holder: { node?: string; block?: string }) => seedQ(
    `INSERT INTO function_refs(workspace_id,function_id,${holder.node ? "holder_node_id" : "holder_block_id"}) VALUES($1,'review',$2)`, [context.workspaceId, holder.node ?? holder.block]);
  /** A whole-note card: the note holds a review reference; each person's schedule is given (null = never graded). */
  const noteCard = async (title: string, states: { ann?: string | null; bob?: string | null }, parent: string | null = null) => {
    const id = await makeNote(title, "", parent);
    await makeCard({ node: id });
    for (const [who, person] of [["ann", ann], ["bob", bob]] as const) {
      const state = states[who];
      if (state) await seedQ("INSERT INTO review_states(workspace_id,node_id,actor_id,state) VALUES($1,$2,$3,$4)", [context.workspaceId, id, person.id, state]);
    }
    return id;
  };
  const as = (person: ActorCtx) => { actor = person; };
  /** A person's one daily cap (actor_prefs "reviewsPerDay"); null removes it. */
  const setCap = async (person: ActorCtx, limit: number | null) => {
    if (limit === null) await seedQ("DELETE FROM actor_prefs WHERE actor_id=$1 AND key='reviewsPerDay'", [person.id]);
    else await seedQ(`INSERT INTO actor_prefs(actor_id,key,value) VALUES($1,'reviewsPerDay',$2::jsonb)
      ON CONFLICT(actor_id,key) DO UPDATE SET value=EXCLUDED.value`, [person.id, JSON.stringify(limit)]);
  };
  const noteCardFor = async (title: string, person: ActorCtx, state: string | null) => {
    const id = await makeNote(title);
    await makeCard({ node: id });
    if (state) await seedQ("INSERT INTO review_states(workspace_id,node_id,actor_id,state) VALUES($1,$2,$3,$4)", [context.workspaceId, id, person.id, state]);
    return id;
  };

  beforeAll(async () => {
    context.workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Review screen',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    ann = await persistActor(context.workspaceId, { id: "x", name: "Ann", role: "admin", type: "human" });
    bob = await persistActor(context.workspaceId, { id: "x", name: "Bob", role: "editor", type: "human" });
    parentId = await makeNote("計算機組織");
    setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 0 });
    as(ann);
  });
  afterAll(async () => {
    resetDayClock();
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [context.workspaceId]);
    await deleteWorkspaceActors(context.workspaceId);
  });
  const clearCards = async () => {
    await seedQ("DELETE FROM review_states WHERE workspace_id=$1", [context.workspaceId]);
    await seedQ("DELETE FROM function_refs WHERE workspace_id=$1 AND function_id='review'", [context.workspaceId]);
    await seedQ("DELETE FROM actor_prefs WHERE key='reviewsPerDay'");
  };

  it("shows a paragraph card's note name and the paragraphs around it, and a note card's parent", async () => {
    await clearCards();
    const markdown = "第一段是背景。\n\n二分搜尋的時間複雜度？ O(log n) {卡}\n\n第三段是例子。\n";
    const noteId = await makeNote("演算法", markdown, parentId);
    const span = { start: markdown.indexOf("二分搜尋"), end: markdown.indexOf("\n\n", markdown.indexOf("二分搜尋")) };
    await seedQ(`INSERT INTO block_anchors(workspace_id,anchor_id,note_id,from_utf16,to_utf16,at_body_hash,quote)
      VALUES($1,'ctx1',$2,$3,$4,$5,$6)`, [context.workspaceId, noteId, span.start, span.end, createHash("sha256").update(markdown).digest("hex"), markdown.slice(span.start, span.end)]);
    const blockId = (await seedQ<{ id: string }>("INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,'ctx1','ctx1','paragraph','q') RETURNING id::text", [context.workspaceId, noteId])).rows[0]!.id;
    await makeCard({ block: blockId });
    const wholeNote = await noteCard("暫存器", {}, parentId);

    const cards = (await queue()).cards;
    expect(cards.find(card => card.block?.id === blockId)?.context).toEqual({ source_title: "演算法", before: "第一段是背景。", after: "第三段是例子。" });
    expect(cards.find(card => card.node_id === wholeNote)?.context).toEqual({ source_title: "計算機組織", before: null, after: null });
  });

  it("each button's interval is what grading with that button then schedules", async () => {
    await clearCards();
    const fresh = await noteCard("新卡", {});
    const old = await noteCard("舊卡", { ann: stateOf(at(-1)) });
    const cards = (await queue()).cards;
    for (const id of [fresh, old]) {
      const intervals = cards.find(card => card.node_id === id)!.next_days;
      for (const rating of [1, 2, 3, 4] as const) {
        const graded = await (await req(`/api/review/${id}/grade`, "POST", { rating, now: NOW })).json() as { state: ReviewState };
        expect(Math.round((new Date(graded.state.due).getTime() - new Date(NOW).getTime()) / DAY)).toBe(intervals[rating]);
        // Undo steps back, so the next rating is tried from the same schedule.
        expect((await req(`/api/review/${id}/undo-grade`, "POST")).status).toBe(200);
      }
    }
  });

  it("undo steps one grade back, and refuses on a card that was only put off", async () => {
    await clearCards();
    const id = await noteCard("復原", { ann: stateOf(at(-1), { reps: 3 }) });
    await req(`/api/review/${id}/grade`, "POST", { rating: 3, now: NOW });
    const undone = await (await req(`/api/review/${id}/undo-grade`, "POST")).json() as { state: ReviewState };
    expect(undone.state.reps).toBe(3);
    const fresh = await noteCard("只是延後", {});
    expect((await req(`/api/review/${fresh}/tomorrow`, "POST", { now: NOW })).status).toBe(200);
    expect((await req(`/api/review/${fresh}/undo-grade`, "POST")).status).toBe(409);
  });

  it("tomorrow puts only this person's card off, until the workspace's next day starts, without grading", async () => {
    await clearCards();
    const due = await noteCard("到期卡", { ann: stateOf(at(-1)), bob: stateOf(at(-1)) });
    const fresh = await noteCard("新卡", {});
    const response = await req(`/api/review/${due}/tomorrow`, "POST", { now: NOW });
    expect(await response.json()).toMatchObject({ node_id: due, hold: { suspended: false, until: TOMORROW_STARTS } });
    expect((await req(`/api/review/${fresh}/tomorrow`, "POST", { now: NOW })).status).toBe(200);

    expect(ids((await queue()).cards)).not.toContain(due);
    expect(ids((await queue()).cards)).not.toContain(fresh);
    as(bob);
    try { expect(ids((await queue()).cards)).toContain(due); } finally { as(ann); }
    // Not graded: the schedule is exactly what it was.
    const state = await (await req(`/api/review/${due}/state`)).json() as { state: ReviewState; hold: { until: string } };
    expect(state.state.reps).toBe(3);
    expect(state.state.last_review).toBe(at(-4));
    expect(state.hold.until).toBe(TOMORROW_STARTS);
    // Tomorrow it is back, new cards included.
    expect(ids((await queue("2026-11-13T16:00:01.000Z")).cards)).toEqual(expect.arrayContaining([due, fresh]));
    // The status page already counts it under tomorrow.
    expect((await status()).forecast[0]).toMatchObject({ date: "2026-11-14", count: 1 });
  });

  it("stop reviewing leaves a card out for this person only, keeps its schedule, and resume brings it back", async () => {
    await clearCards();
    const id = await noteCard("停用", { ann: stateOf(at(-1)), bob: stateOf(at(-1)) });
    expect((await req(`/api/review/${id}/suspend`, "POST")).status).toBe(200);
    expect(ids((await queue()).cards)).not.toContain(id);
    const stats = await (await req(`/api/review/stats?now=${encodeURIComponent(NOW)}`)).json() as { due: number };
    expect(stats.due).toBe(0);
    expect((await status()).stopped.map(card => card.node_id)).toEqual([id]);
    as(bob);
    try {
      expect(ids((await queue()).cards)).toContain(id);
      expect((await status()).stopped).toEqual([]);
    } finally { as(ann); }

    expect(await (await req(`/api/review/${id}/resume`, "POST")).json()).toMatchObject({ node_id: id, hold: null });
    expect(ids((await queue()).cards)).toContain(id);
    expect((await (await req(`/api/review/${id}/state`)).json() as { state: ReviewState }).state.reps).toBe(3);
    expect((await status()).stopped).toEqual([]);
  });

  it("works the same for a paragraph card", async () => {
    await clearCards();
    const noteId = await makeNote("段落卡", "問題一\n答案\n");
    const blockId = (await seedQ<{ id: string }>("INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,'blk','blk','paragraph','問題一') RETURNING id::text", [context.workspaceId, noteId])).rows[0]!.id;
    await makeCard({ block: blockId });
    expect((await queue()).cards.some(card => card.block?.id === blockId)).toBe(true);
    expect((await req(`/api/review/blocks/${blockId}/suspend`, "POST")).status).toBe(200);
    expect((await queue()).cards.some(card => card.block?.id === blockId)).toBe(false);
    expect((await status()).stopped[0]).toMatchObject({ block: { id: blockId, ref: "blk" } });
    expect((await req(`/api/review/blocks/${blockId}/resume`, "POST")).status).toBe(200);
    expect((await req(`/api/review/blocks/${blockId}/tomorrow`, "POST", { now: NOW })).status).toBe(200);
    expect((await queue()).cards.some(card => card.block?.id === blockId)).toBe(false);
  });

  it("grading a card ends its hold", async () => {
    await clearCards();
    const id = await noteCard("改評分", { ann: stateOf(at(-1)) });
    await req(`/api/review/${id}/tomorrow`, "POST", { now: NOW });
    const shown = await (await req(`/api/review/${id}/state`)).json() as { state: ReviewState | null };
    expect((await req(`/api/review/${id}/grade`, "POST", { rating: 3, now: NOW, seen_reps: shown.state?.reps ?? 0 })).status).toBe(200);
    expect((await (await req(`/api/review/${id}/state`)).json() as { hold: unknown }).hold).toBeNull();
  });

  it("refuses to put off, stop or grade a card the person cannot read (and a note that is not a card)", async () => {
    await clearCards();
    const secret = await makeNote("私人卡");
    await putInSpace(secret, await adminOnlySpace(context.workspaceId, "only-ann-2", [ann.id]));
    await makeCard({ node: secret });
    const plain = await makeNote("不是卡片");
    as(bob);
    try {
      for (const action of ["tomorrow", "suspend", "resume"]) expect((await req(`/api/review/${secret}/${action}`, "POST", { now: NOW })).status).toBe(404);
      expect((await status()).stopped).toEqual([]);
    } finally { as(ann); }
    expect((await req(`/api/review/${plain}/suspend`, "POST")).status).toBe(409);
  });

  it("holds back due cards over a person's own daily cap, most overdue first, and rolls them to tomorrow", async () => {
    await clearCards();
    const cards = [] as string[];
    for (const [index, days] of [-5, -4, -3, -2].entries()) cards.push(await noteCard(`積壓-${index}`, { ann: stateOf(at(days)), bob: stateOf(at(days)) }));
    await setCap(ann, 2);
    expect(ids((await queue()).cards)).toEqual([cards[0], cards[1]]);
    const mine = await status();
    expect(mine).toMatchObject({ overdue: 2, today: 0, rolled_over: 2, reviews_per_day: 2, reviewed_today: 0 });
    expect(mine.forecast[0]!.count).toBe(2);
    // Bob set no cap: he sees all four.
    as(bob);
    try { expect((await queue()).cards).toHaveLength(4); expect((await status()).reviews_per_day).toBeNull(); } finally { as(ann); }
    // A grade today uses up the cap, so the next due card waits.
    await req(`/api/review/${cards[0]}/grade`, "POST", { rating: 3, now: NOW });
    expect(ids((await queue()).cards)).toEqual([cards[1]]);
    expect((await status()).reviewed_today).toBe(1);
    // Tomorrow the day's count starts again.
    expect((await queue(at(1))).cards.length).toBe(2);
    // Removing the cap lifts it.
    await setCap(ann, null);
    expect((await queue()).cards).toHaveLength(3);
  });

  it("counts overdue apart from today and the next seven days, and lists often-forgotten cards", async () => {
    await clearCards();
    await noteCard("逾期", { ann: stateOf(at(-3)) });
    await noteCard("今天", { ann: stateOf(at(0)) });
    await noteCard("明天", { ann: stateOf(at(1)) });
    await noteCard("第三天", { ann: stateOf(at(3)) });
    await noteCard("第三天另一張", { ann: stateOf(at(3)) });
    await noteCard("太遠", { ann: stateOf(at(9)) });
    const forgotten = await noteCard("常忘", { ann: stateOf(at(2), { lapses: 5 }) });
    await noteCard("忘三次", { ann: stateOf(at(2), { lapses: 3 }) });
    await noteCard("新的", {});
    const page = await status();
    expect(page).toMatchObject({ today_date: "2026-11-13", overdue: 1, today: 1, new_available: 1, rolled_over: 0, reviews_per_day: null, forgotten_min: 4 });
    expect(page.forecast.map(day => day.count)).toEqual([1, 2, 2, 0, 0, 0, 0]);
    expect(page.forecast[0]!.date).toBe("2026-11-14");
    expect(page.forgotten).toEqual([{ node_id: forgotten, title: "常忘", lapses: 5, block: null }]);
    // Bob graded nothing: he has no schedule to count, only new cards.
    as(bob);
    try { expect(await status()).toMatchObject({ overdue: 0, today: 0, forgotten: [] }); } finally { as(ann); }
  });

  it("one cap per person covers due and new cards together, and the status page and decks match the queue", async () => {
    await clearCards();
    // 6 due and 6 new cards. Cap 5 of the 12 cards.
    const cards: string[] = [];
    for (const group of [0, 1, 2]) {
      for (const days of [-3, -2]) cards.push(await noteCardFor(`到期-${group}-${days}`, ann, stateOf(at(days))));
      for (const index of [0, 1]) cards.push(await noteCardFor(`新-${group}-${index}`, ann, null));
    }
    await setCap(ann, 5);
    const shown = await queue();
    expect(shown.cards).toHaveLength(5);
    expect(shown.total).toBe(5);
    // Due first (most overdue first), new cards only fill what is left.
    expect(shown.cards.filter(card => card.state !== null)).toHaveLength(5);
    const page = await status();
    expect(page.overdue + page.today).toBe(5);
    expect(page.new_available).toBe(0);
    expect(page).toMatchObject({ rolled_over: 1, reviews_per_day: 5, reviewed_today: 0 });
    const counts = await (await req(`/api/review/stats?now=${encodeURIComponent(NOW)}`)).json() as { due: number; new_available: number };
    expect(counts.due).toBe(5);
    expect(counts.new_available).toBe(0);
    // Grade two: three left. One due card is left, then the new cards fill the remaining places.
    for (const card of shown.cards.slice(0, 2)) await req(`/api/review/${card.node_id}/grade`, "POST", { rating: 3, now: NOW });
    const later = await queue();
    expect(later.cards).toHaveLength(3);
    const laterPage = await status();
    expect(laterPage.reviewed_today).toBe(2);
    expect(laterPage.overdue + laterPage.today + laterPage.new_available).toBe(later.total);
    // A cap larger than the due cards leaves places for new cards, counted once.
    await setCap(ann, 8);
    const wide = await queue();
    const widePage = await status();
    // 4 due cards are left and 6 places: all 4, then 2 of the 6 new cards.
    expect(wide.total).toBe(6);
    expect(wide.cards.filter(card => card.state === null)).toHaveLength(2);
    expect(widePage.overdue + widePage.today + widePage.new_available).toBe(wide.total);
    // Cards held back are only hidden: no schedule was rewritten.
    const untouched = (await seedQ<{ n: string }>("SELECT count(*)::text AS n FROM review_states WHERE workspace_id=$1 AND actor_id=$2", [context.workspaceId, ann.id])).rows[0]!.n;
    expect(untouched).toBe("6");
    // Opening a deck gives at most what is left: 6 places, 2 already used.
    await setCap(ann, 6);
    await seedQ("UPDATE content_nodes SET parent_id=$1 WHERE id=ANY($2::uuid[])", [parentId, cards]);
    const decks = (await (await req(`/api/review/decks?now=${encodeURIComponent(NOW)}`)).json() as { decks: Array<{ node_id: string; due: number }> }).decks;
    expect(decks.find(deck => deck.node_id === parentId)?.due).toBe(4);
    expect((await queue()).cards).toHaveLength(4);
  });

  it("a hold-only row (a new card put off or stopped) uses none of the daily cap", async () => {
    await clearCards();
    await setCap(ann, 2);
    const first = await noteCardFor("新一", ann, null);
    const second = await noteCardFor("新二", ann, null);
    const third = await noteCardFor("新三", ann, null);
    expect((await req(`/api/review/${first}/suspend`, "POST")).status).toBe(200);
    const row = (await seedQ<{ state: string }>("SELECT state FROM review_states WHERE node_id=$1 AND actor_id=$2", [first, ann.id])).rows[0]!;
    expect(JSON.parse(row.state)).toEqual({ hold: { suspended: true, until: null } });
    expect(ids((await queue()).cards).sort()).toEqual([second, third].sort());
    expect((await status()).new_available).toBe(2);
    expect((await status()).reviewed_today).toBe(0);
    // Resumed, it is an ordinary new card again: the cap of 2 still shows two of the three.
    expect((await req(`/api/review/${first}/resume`, "POST")).status).toBe(200);
    expect((await queue()).cards).toHaveLength(2);
    // Put off until tomorrow, it is no review today either.
    expect((await req(`/api/review/${second}/tomorrow`, "POST", { now: NOW })).status).toBe(200);
    expect(ids((await queue()).cards).sort()).toEqual([first, third].sort());
    // One graded today does use the cap.
    await req(`/api/review/${first}/grade`, "POST", { rating: 3, now: NOW });
    expect((await status()).new_available).toBe(1);
    expect((await status()).reviewed_today).toBe(1);
  });

  it("a stale second client cannot grade or undo a card stopped on another device", async () => {
    await clearCards();
    const id = await noteCard("兩台裝置", { ann: stateOf(at(-1), { reps: 3 }) });
    await req(`/api/review/${id}/grade`, "POST", { rating: 3, now: NOW });
    expect((await req(`/api/review/${id}/suspend`, "POST")).status).toBe(200);
    const before = (await seedQ<{ state: string; previous_state: string | null }>("SELECT state, previous_state FROM review_states WHERE node_id=$1 AND actor_id=$2", [id, ann.id])).rows[0]!;
    // The other device, still holding the old queue, grades it or steps it back.
    expect((await req(`/api/review/${id}/grade`, "POST", { rating: 4, now: NOW })).status).toBe(409);
    expect((await req(`/api/review/${id}/undo-grade`, "POST")).status).toBe(409);
    const after = (await seedQ<{ state: string; previous_state: string | null }>("SELECT state, previous_state FROM review_states WHERE node_id=$1 AND actor_id=$2", [id, ann.id])).rows[0]!;
    expect(after).toEqual(before);
    expect((await (await req(`/api/review/${id}/state`)).json() as { hold: { suspended: boolean } }).hold.suspended).toBe(true);
    // After resuming, both work again.
    await req(`/api/review/${id}/resume`, "POST");
    expect((await req(`/api/review/${id}/undo-grade`, "POST")).status).toBe(200);
  });

  it("lists the cards this person stopped inside one note, for the note's own review command to offer back", async () => {
    await clearCards();
    const root = await makeNote("課本");
    const chapter = await noteCard("第一章", { ann: stateOf(at(-1)) }, root);
    const elsewhere = await noteCard("別處", { ann: stateOf(at(-1)) });
    const blockId = await (async () => {
      const noteId = await makeNote("段落所在", "問題\n答案\n", root);
      const id = (await seedQ<{ id: string }>("INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,'stp','stp','paragraph','問題') RETURNING id::text", [context.workspaceId, noteId])).rows[0]!.id;
      await makeCard({ block: id });
      return id;
    })();
    const stopped = async (id: string) => (await (await req(`/api/review/${id}/stopped`)).json() as { stopped: Array<{ node_id: string; block: { id: string } | null }> }).stopped;
    expect(await stopped(root)).toEqual([]);
    for (const path of [`/${chapter}`, `/${elsewhere}`, `/blocks/${blockId}`]) expect((await req(`/api/review${path}/suspend`, "POST")).status).toBe(200);
    const inside = await stopped(root);
    expect(inside.map(card => card.block?.id ?? card.node_id).sort()).toEqual([chapter, blockId].sort());
    // Only this person's own stops, only inside the note.
    as(bob);
    try { expect(await stopped(root)).toEqual([]); } finally { as(ann); }
    expect((await stopped(chapter)).map(card => card.node_id)).toEqual([chapter]);
    // Resumed cards leave the list; a note this person cannot read answers 404.
    await req(`/api/review/${chapter}/resume`, "POST");
    expect((await stopped(root)).map(card => card.block?.id)).toEqual([blockId]);
    const secret = await makeNote("私人");
    await putInSpace(secret, await adminOnlySpace(context.workspaceId, "only-ann-3", [ann.id]));
    as(bob);
    try { expect((await req(`/api/review/${secret}/stopped`)).status).toBe(404); } finally { as(ann); }
  });

  describe("a workspace whose time zone changes its clock", () => {
    afterAll(() => { setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 0 }); });
    it("puts a card off until the next local day starts, across the spring-forward and fall-back days", async () => {
      setDayClock({ timeZone: "America/New_York", dayStartHour: 0 });
      await clearCards();
      const id = await noteCard("夏令", { ann: stateOf("2026-03-01T00:00:00.000Z") });
      const cases = [
        // 2026-03-08 is the 23-hour day (clocks jump at 02:00): the 9th starts at 04:00 UTC.
        { now: "2026-03-08T12:00:00.000Z", until: "2026-03-09T04:00:00.000Z" },
        { now: "2026-03-07T12:00:00.000Z", until: "2026-03-08T05:00:00.000Z" },
        // 2026-11-01 is the 25-hour day: the 2nd starts at 05:00 UTC.
        { now: "2026-11-01T12:00:00.000Z", until: "2026-11-02T05:00:00.000Z" },
        { now: "2026-10-31T12:00:00.000Z", until: "2026-11-01T04:00:00.000Z" },
      ];
      for (const { now, until } of cases) {
        expect(await (await req(`/api/review/${id}/tomorrow`, "POST", { now })).json(), now).toMatchObject({ hold: { until } });
        const justBefore = new Date(new Date(until).getTime() - 1000).toISOString();
        const justAfter = new Date(new Date(until).getTime() + 1000).toISOString();
        expect(ids((await queue(justBefore)).cards), `before ${until}`).not.toContain(id);
        expect(ids((await queue(justAfter)).cards), `after ${until}`).toContain(id);
      }
      // The status page counts by that clock too: at 23:30 on the 7th (local) the card put off to the 8th is not today's.
      await req(`/api/review/${id}/tomorrow`, "POST", { now: "2026-03-08T12:00:00.000Z" });
      const page = await status("2026-03-08T12:00:00.000Z");
      expect(page.today_date).toBe("2026-03-08");
      expect(page.forecast[0]).toMatchObject({ date: "2026-03-09", count: 1 });
    });
  });
});
