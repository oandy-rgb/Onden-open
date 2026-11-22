// Review module (modules/review) — the FSRS review loop against a real DB:
//   • enrolment is the note's own function reference: PUT /api/review/cards/:id puts the
//     note in the queue as a new card; DELETE retires it (schedules stay);
//   • grading goes through the spine: an ATTRIBUTE_SET on _review_state is
//     emitted with correct attribution, and restoring that event (inverse-
//     undo, the inbox-reject path) returns the card to its prior state;
//   • FSRS interval progression is exact under an injected clock (the grade
//     route honours `now` only under NODE_ENV=test);
//   • READ POLICY: queue/stats/grade are bounded by readableNodeIdSet — a
//     viewer never sees a restricted card, an empty-allowlist token sees
//     nothing, and grading an unreadable node 404s (no existence leak).
//
// Mirrors src/test/dayLens.integration.test.ts conventions.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import reviewRouter from "../modules/review/routes.js";
import { DEFAULT_BEHAVIOUR, reviewBehaviourFromSchema } from "../modules/review/service.js";
import { reviewQueueTool, type ReviewQueueResult } from "../modules/review/reviewQueueTool.js";
import nodesRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import type { ActorCtx } from "../types.js";
import { randomUUID } from "node:crypto";
import { withIdempotencyKey } from "../spine/mutate.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ReviewState } from "@onden/contract";
import { seedQ } from "./helpers/seedQ.js";
import { countWritesWithoutStamp } from "../spine/stamps.js";

/** The review settings a tag's stored schema currently yields (clamped). */
const loadReviewBehaviour = async (workspaceId: string, tagId: string) => {
  const row = await q<{ behaviour: Record<string, unknown> | null }>(
    `SELECT tag_schema->'behaviour' AS behaviour FROM content_nodes WHERE workspace_id=$1 AND id=$2`, [workspaceId, tagId]);
  return reviewBehaviourFromSchema(row.rows[0]?.behaviour);
};

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
// The Idempotency-Key header becomes ambient, as in src/index.ts.
app.use("*", async (c, next) => {
  const key = c.req.header("idempotency-key");
  return key ? withIdempotencyKey(key, next) : next();
});
app.route("/api/review", reviewRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/events", eventsRouter);

const admin: ActorCtx = { id: "rv-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "rv-viewer", name: "Viewer", role: "viewer", type: "human" };
// Delegated bearer token whose agent belongs to no space: readable set = ∅.
const scopedToken: ActorCtx = {
  id: "rv-token", name: "Scoped token", role: "admin", type: "agent",
  tokenScope: { tokenId: "rv-tok-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

const T0 = "2026-02-01T08:00:00.000Z";
const DAY_MS = 86_400_000;

type Card = { node_id: string; title: string; markdown: string; ink_data: string | null; state: ReviewState | null };
type Queue = { cards: Card[]; total: number };
type Stats = { due: number; new: number; learned: number; new_available: number };
type GradeRes = { node_id: string; rating: number; state: ReviewState };

describe.skipIf(!isTestDb)("review module (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let reviewTagId = "";
  let untagId = "";     // enrolled then untagged
  let secretId = "";    // carries #review, lives in an admin-only space

  const mkNode = async (title: string): Promise<string> => {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'content', $2, $3, '## body of ' || $2) RETURNING id`,
      [WS, title, `rv-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`],
    );
    return r.rows[0]!.id;
  };

  /** A review card: the note holds its own function reference (migration 195). */
  const makeCard = (noteId: string) => seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2) ON CONFLICT DO NOTHING`, [WS, noteId]);
  const queue = async (now?: string): Promise<Queue> =>
    (await (await app.request(`/api/review/queue?${now ? `&now=${encodeURIComponent(now)}` : ""}`)).json()) as Queue;
  const stats = async (now?: string): Promise<Stats> =>
    (await (await app.request(`/api/review/stats?${now ? `&now=${encodeURIComponent(now)}` : ""}`)).json()) as Stats;
  const grade = (nodeId: string, rating: number, now: string) =>
    app.request(`/api/review/${nodeId}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, now }),
    });
  const queueAt = async (query: string): Promise<Queue> => (await (await app.request(`/api/review/queue?${query}`)).json()) as Queue;
  const inQueue = (qr: Queue, id: string) => qr.cards.some((card) => card.node_id === id);
  // Each grading test drives a card of its own, so none depends on the grades
  // another test left behind.
  let cardSeq = 0;
  const enrolledCard = async (): Promise<string> => {
    const id = await mkNode(`card-${stamp}-${++cardSeq}`);
    currentActor = admin;
    expect((await app.request(`/api/review/cards/${id}`, { method: "PUT", body: "{}" })).status).toBe(200);
    return id;
  };
  /** An enrolled card the admin graded Good once at T0 (due T0 + 4 days). */
  const gradedCard = async (): Promise<string> => {
    const id = await enrolledCard();
    expect((await grade(id, 3, T0)).status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    await setModulesOn(WS, null);
    for (const actor of [admin, viewer, scopedToken]) Object.assign(actor, await persistActor(WS, actor));
    // persistActor joined the default space; this token's agent reaches no space.
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [scopedToken.id]);

    // Explicit module identity permits an isolated tag for every test run.
    // The workspace's review module tag: where the daily limits (behaviour.review) are read from; it does not make cards.
    reviewTagId = (await seedClassTag(WS, { name: `review-fixture-${stamp}` })).tagId;
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [reviewTagId]);

    untagId = await mkNode(`untag-${stamp}`);

    // Restricted card: #review on a node in a space only the admin is in.
    secretId = await mkNode(`secret-${stamp}`);
    await putInSpace(secretId, await adminOnlySpace(WS, `rv-secret-${stamp}`, [admin.id]));
    await makeCard(secretId);
  });

  it("enrol via the real tag route → new card in the queue, due immediately", async () => {
    currentActor = admin;
    const cardId = await mkNode(`card-${stamp}-enrol`);
    const before = await stats(T0);
    const res = await app.request(`/api/review/cards/${cardId}`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(200);
    const qr = await queue(T0);
    const card = qr.cards.find((x) => x.node_id === cardId);
    expect(card).toBeTruthy();
    expect(card!.state).toBeNull(); // never graded = new
    expect(card!.markdown).toContain("body of"); // panel renders without a second fetch
    const after = await stats(T0);
    expect(after.due).toBe(before.due + 1);
    expect(after.new).toBe(before.new + 1);
  });

  it("a handwritten card (empty markdown, ink_data) rides the queue with its strokes", async () => {
    currentActor = admin;
    // An ink note: blank markdown, strokes parked in the ink_data attribute —
    // the case that used to render a blank review card.
    const inkId = await mkNode(`ink-${stamp}`);
    await seedQ(`UPDATE content_nodes SET markdown = '' WHERE id = $1`, [inkId]);
    const inkDoc = JSON.stringify({
      version: 1,
      strokes: [{ id: "s1", points: [[10, 10], [40, 40]], color: "#1a1a1a", size: 4, toolId: "pen" }],
      erased: {}, page: { width: 1000 },
    });
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       VALUES ($1, $2, 'ink_data', $3, 'text', false, 'explicit')
       ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [WS, inkId, inkDoc],
    );
    await app.request(`/api/review/cards/${inkId}`, { method: "PUT", body: "{}" });
    const card = (await queue(T0)).cards.find((x) => x.node_id === inkId);
    expect(card).toBeTruthy();
    expect(card!.markdown).toBe("");
    // The queue carries ink_data so the panel can render a thumbnail without a
    // second roundtrip — this is what fixes the empty handwritten card.
    expect(card!.ink_data).toBe(inkDoc);
    // retire so it doesn't crowd later read-policy assertions
    await app.request(`/api/review/cards/${inkId}`, { method: "DELETE" });
  });

  it("grading writes only the grader's own progress, with no event on the shared note", async () => {
    const cardId = await enrolledCard();
    const eventsBefore = await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [cardId]);
    const res = await grade(cardId, 3, T0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GradeRes;
    expect(body.state.reps).toBe(1);
    // FSRS-4.5 first Good: stability w[2]=3.7145 → 4-day interval, exactly.
    expect(new Date(body.state.due).getTime() - new Date(T0).getTime()).toBe(4 * DAY_MS);

    const mine = await q<{ actor_id: string; state: string }>(
      `SELECT actor_id, state FROM review_states WHERE node_id = $1`, [cardId]);
    expect(mine.rows.map((r) => r.actor_id)).toEqual([admin.id]);
    expect(JSON.parse(mine.rows[0]!.state).reps).toBe(1);
    // Personal progress is not a change to the note: nobody's history shows it.
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [cardId])).rowCount).toBe(eventsBefore.rowCount);

    // Graded → no longer due at T0 for the grader.
    expect(inQueue(await queue(T0), cardId)).toBe(false);
  });

  it("a grade and its undo are each one write through the write entry: one stamp, none skipped, no event", async () => {
    const cardId = await enrolledCard();
    const seq = async () => Number((await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [WS])).rows[0]!.n);
    // Making the card is an event of the note (it is the note's own reference now); grading and undoing add none.
    const eventsBefore = (await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [cardId])).rowCount;
    const [seq0, bypass0] = [await seq(), await countWritesWithoutStamp(WS)];
    expect((await grade(cardId, 3, T0)).status).toBe(200);
    expect([await seq() - seq0, await countWritesWithoutStamp(WS) - bypass0]).toEqual([1, 0]);
    expect((await app.request(`/api/review/${cardId}/undo-grade`, { method: "POST" })).status).toBe(200);
    expect([await seq() - seq0, await countWritesWithoutStamp(WS) - bypass0]).toEqual([2, 0]);
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [cardId])).rowCount).toBe(eventsBefore);
  });

  it("another reader keeps their own schedule, and a read-only viewer can study", async () => {
    // The admin graded the card; the viewer still sees it as new and due.
    const cardId = await gradedCard();
    currentActor = viewer;
    const vq = await queue(T0);
    expect(vq.cards.find((card) => card.node_id === cardId)?.state).toBeNull();
    // Grading is personal progress, so reading the note is enough.
    const res = await grade(cardId, 4, T0);
    expect(res.status).toBe(200);
    const rows = await q<{ actor_id: string; state: string }>(
      `SELECT actor_id, state FROM review_states WHERE node_id = $1 ORDER BY actor_id`, [cardId]);
    expect(rows.rows).toHaveLength(2);
    const adminState = JSON.parse(rows.rows.find((r) => r.actor_id === admin.id)!.state);
    expect(adminState.reps).toBe(1); // the viewer's "Easy" did not touch the admin's card
    await seedQ(`DELETE FROM review_states WHERE node_id = $1 AND actor_id = $2`, [cardId, viewer.id]);
  });

  it("FSRS intervals grow across Good reviews and collapse on Again (frozen clock)", async () => {
    const cardId = await gradedCard();
    // Review exactly when due, twice; each gap must exceed the previous one.
    const s1 = ((await (await grade(cardId, 3, new Date(new Date(T0).getTime() + 4 * DAY_MS).toISOString())).json()) as GradeRes).state;
    const gap1 = new Date(s1.due).getTime() - new Date(s1.last_review).getTime();
    expect(gap1).toBeGreaterThan(4 * DAY_MS);

    const s2 = ((await (await grade(cardId, 3, s1.due)).json()) as GradeRes).state;
    const gap2 = new Date(s2.due).getTime() - new Date(s2.last_review).getTime();
    expect(gap2).toBeGreaterThan(gap1);
    expect(s2.reps).toBe(3);

    // A lapse: stability shrinks, the next gap is shorter, lapses increments.
    const s3 = ((await (await grade(cardId, 1, s2.due)).json()) as GradeRes).state;
    expect(s3.stability).toBeLessThan(s2.stability);
    expect(new Date(s3.due).getTime() - new Date(s3.last_review).getTime()).toBeLessThan(gap2);
    expect(s3.lapses).toBe(1);

    // And the card is back in the queue once its (short) interval elapses.
    const afterLapse = new Date(new Date(s3.due).getTime() + 1000).toISOString();
    expect(inQueue(await queue(afterLapse), cardId)).toBe(true);
  });

  it("undo-grade returns the card to its prior state, for the grader only", async () => {
    const cardId = await gradedCard();
    expect((await grade(cardId, 3, new Date(new Date(T0).getTime() + 4 * DAY_MS).toISOString())).status).toBe(200);
    const before = await q<{ state: string; previous_state: string | null }>(
      `SELECT state, previous_state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [cardId, admin.id]);
    expect(before.rows[0]!.previous_state).toBeTruthy(); // 2 grades in → there IS a prior state
    const res = await app.request(`/api/review/${cardId}/undo-grade`, { method: "POST" });
    expect(res.status).toBe(200);
    const after = await q<{ state: string }>(
      `SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [cardId, admin.id]);
    expect(after.rows[0]!.state).toBe(before.rows[0]!.previous_state);
    // One step only: a second undo (another tab, another Idempotency-Key) is refused and the schedule stays.
    const second = await app.request(`/api/review/${cardId}/undo-grade`, { method: "POST", headers: { "Idempotency-Key": randomUUID() } });
    expect(second.status).toBe(409);
    const kept = await q<{ state: string }>(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [cardId, admin.id]);
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.state).toBe(before.rows[0]!.previous_state);
  });

  it("a second undo with a different Idempotency-Key never resets a card with many reviews", async () => {
    const id = await mkNode(`Double undo ${stamp}`);
    await makeCard(id);
    currentActor = admin;
    // A real client names the reps it saw, so studying the card again before its due date is allowed.
    for (let i = 0; i < 4; i++) {
      const graded = await app.request(`/api/review/${id}/grade`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 3, now: new Date(Date.parse(T0) + i * 3 * DAY_MS).toISOString(), seen_reps: i }) });
      expect(graded.status).toBe(200);
    }
    const undo = (key: string) => app.request(`/api/review/${id}/undo-grade`, { method: "POST", headers: { "Idempotency-Key": key } });
    const first = await undo(randomUUID());
    expect(first.status).toBe(200);
    expect(((await first.json()) as { state: ReviewState }).state.reps).toBe(3);
    expect((await undo(randomUUID())).status).toBe(409);
    const row = await q<{ state: string }>(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [id, admin.id]);
    expect(JSON.parse(row.rows[0]!.state).reps).toBe(3);
  });

  describe("a request is accepted only if the card is still as the screen showed it", () => {
    const post = (id: string, path: string, body: unknown) => app.request(`/api/review/${id}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) });
    const repsOf = async (id: string) => ((await (await app.request(`/api/review/${id}/state`)).json()) as { state: ReviewState | null }).state?.reps ?? 0;

    it("a grade that names no reps is refused when the card is not due: another device graded it since", async () => {
      const id = await mkNode(`Not due ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await grade(id, 3, T0)).status).toBe(200);
      const soon = new Date(Date.parse(T0) + 60 * 60_000).toISOString();
      expect((await grade(id, 3, soon)).status).toBe(409);
      expect(await repsOf(id)).toBe(1);
    });
    it("a grade that names the reps it saw may study a card ahead of its due date", async () => {
      const id = await mkNode(`Ahead ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await grade(id, 3, T0)).status).toBe(200);
      const soon = new Date(Date.parse(T0) + 60 * 60_000).toISOString();
      expect((await post(id, "grade", { rating: 3, now: soon, seen_reps: 1 })).status).toBe(200);
      expect(await repsOf(id)).toBe(2);
    });
    it("a grade that names no reps is refused on a card put off until tomorrow", async () => {
      const id = await mkNode(`Put off ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await grade(id, 3, T0)).status).toBe(200);
      const later = new Date(Date.parse(T0) + 60 * DAY_MS).toISOString();
      expect((await post(id, "tomorrow", { now: later })).status).toBe(200);
      expect((await grade(id, 3, later)).status).toBe(409);
      expect(await repsOf(id)).toBe(1);
    });
    it("\"tomorrow\" from a stale device does not undo a stop made on another device", async () => {
      const id = await mkNode(`Stopped ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await post(id, "suspend", {})).status).toBe(200);
      expect((await post(id, "tomorrow", { now: T0 })).status).toBe(409);
      const hold = ((await (await app.request(`/api/review/${id}/state`)).json()) as { hold: { suspended: boolean } | null }).hold;
      expect(hold?.suspended).toBe(true);
    });
  });

  it("a row from before the first-grade marker (previous_state NULL) is not deleted by undo", async () => {
    const id = await mkNode(`Legacy ${stamp}`);
    await makeCard(id);
    currentActor = admin;
    await grade(id, 3, T0);
    await seedQ(`UPDATE review_states SET previous_state = NULL WHERE node_id = $1 AND actor_id = $2`, [id, admin.id]);
    expect((await app.request(`/api/review/${id}/undo-grade`, { method: "POST" })).status).toBe(409);
    expect((await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [id])).rowCount).toBe(1);
  });

  describe("two devices on one card (grade and undo carry the reps the client saw)", () => {
    const send = (path: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) });
    const repsOf = async (id: string) => {
      const r = await q<{ state: string }>(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [id, admin.id]);
      return r.rows[0] ? (JSON.parse(r.rows[0].state).reps as number) : 0;
    };

    it("the second device grading the same new card is refused, and the card counts once", async () => {
      const id = await mkNode(`Two devices ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: T0, seen_reps: 0 })).status).toBe(200);
      expect((await send(`/api/review/${id}/grade`, { rating: 1, now: T0, seen_reps: 0 })).status).toBe(409);
      expect(await repsOf(id)).toBe(1);
      // The device that now sees reps 1 can grade.
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: new Date(Date.parse(T0) + 4 * DAY_MS).toISOString(), seen_reps: 1 })).status).toBe(200);
      expect(await repsOf(id)).toBe(2);
    });

    it("an older client that sends no seen_reps still grades as before", async () => {
      const id = await mkNode(`Old client ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: T0 })).status).toBe(200);
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: new Date(Date.parse(T0) + 4 * DAY_MS).toISOString() })).status).toBe(200);
      expect(await repsOf(id)).toBe(2);
      expect((await send(`/api/review/${id}/undo-grade`, {})).status).toBe(200);
      expect(await repsOf(id)).toBe(1);
    });

    it("undo by device A after device B graded is refused and keeps B's grade", async () => {
      const id = await mkNode(`Undo after other ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: T0, seen_reps: 0 })).status).toBe(200); // A: reps 1
      expect((await send(`/api/review/${id}/grade`, { rating: 3, now: new Date(Date.parse(T0) + 4 * DAY_MS).toISOString(), seen_reps: 1 })).status).toBe(200); // B: reps 2
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: 1 })).status).toBe(409); // A's undo
      expect(await repsOf(id)).toBe(2);
      // B's own undo (it graded to reps 2) still works.
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: 2 })).status).toBe(200);
      expect(await repsOf(id)).toBe(1);
    });

    it("an undo names its grade: A's undo sent again after B graded the same reps is refused (scan-12 S1)", async () => {
      const id = await mkNode(`Undo by grade id ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      const a = await (await send(`/api/review/${id}/grade`, { rating: 3, now: T0, seen_reps: 0 })).json();
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: 1, graded_id: a.grade_id })).status).toBe(200); // A undoes: the card is new
      const b = await (await send(`/api/review/${id}/grade`, { rating: 1, now: T0, seen_reps: 0 })).json(); // B grades: reps 1 again
      expect(b.grade_id).not.toBe(a.grade_id);
      // A's undo under a new key (lost response): the same reps, not the same grade.
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: 1, graded_id: a.grade_id })).status).toBe(409);
      expect(await repsOf(id)).toBe(1);
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: 1, graded_id: b.grade_id })).status).toBe(200);
      expect((await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [id])).rowCount).toBe(0);
    });

    it("the grade id is never part of the schedule a client reads", async () => {
      const id = await mkNode(`Grade id hidden ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      const graded = await (await send(`/api/review/${id}/grade`, { rating: 3, now: T0, seen_reps: 0 })).json();
      expect(Object.keys(graded.state)).not.toContain("grade_id");
      const read = await (await app.request(`/api/review/${id}/state`)).json();
      expect(Object.keys(read.state)).not.toContain("grade_id");
    });

    it("a malformed version in the request body is a 400", async () => {
      const id = await mkNode(`Bad body ${stamp}`);
      await makeCard(id);
      currentActor = admin;
      expect((await send(`/api/review/${id}/grade`, { rating: 3, seen_reps: -1 })).status).toBe(400);
      expect((await send(`/api/review/${id}/undo-grade`, { graded_reps: "x" })).status).toBe(400);
    });
  });

  it("undoing a FIRST grade deletes the state — the card is new again", async () => {
    currentActor = admin;
    const freshId = await mkNode(`fresh-${stamp}`);
    await app.request(`/api/review/cards/${freshId}`, { method: "PUT", body: "{}" });
    await grade(freshId, 3, T0);
    const res = await app.request(`/api/review/${freshId}/undo-grade`, { method: "POST" });
    expect(res.status).toBe(200);
    const row = await q(`SELECT 1 FROM review_states WHERE node_id = $1`, [freshId]);
    expect(row.rowCount).toBe(0);
    const card = (await queue(T0)).cards.find((x) => x.node_id === freshId);
    expect(card).toBeTruthy();
    expect(card!.state).toBeNull();
    expect((await app.request(`/api/review/${freshId}/undo-grade`, { method: "POST" })).status).toBe(409);
  });

  it("read policy: viewer and a spaceless token never see the restricted card", async () => {
    currentActor = admin;
    expect(inQueue(await queue(T0), secretId)).toBe(true); // admin does

    currentActor = viewer;
    const vq = await queue(T0);
    expect(inQueue(vq, secretId)).toBe(false);
    // grading it doesn't leak existence either
    expect((await grade(secretId, 3, T0)).status).toBe(404);

    currentActor = scopedToken;
    // Tag definitions are global (spaces model), so the deck itself answers,
    // but with no cards; the global queue is likewise an empty successful read
    // for an actor with no readable notes.
    const tagged = await app.request(`/api/review/queue?now=${encodeURIComponent(T0)}`);
    expect(tagged.status).toBe(200);
    expect(((await tagged.json()) as Queue).cards.length).toBe(0);
    const tq = (await (await app.request(`/api/review/queue?now=${encodeURIComponent(T0)}`)).json()) as Queue;
    expect(tq.cards.length).toBe(0);
    const emptyStats = (await (await app.request(`/api/review/stats?now=${encodeURIComponent(T0)}`)).json()) as Stats;
    expect(emptyStats.due).toBe(0);
  });

  it("grade validation: bad rating 400s, unenrolled node 409s, anonymous 401s", async () => {
    const cardId = await enrolledCard();
    expect((await grade(cardId, 5 as unknown as number, T0)).status).toBe(400);
    const plainId = await mkNode(`plain-${stamp}`);
    expect((await grade(plainId, 3, T0)).status).toBe(409);
    currentActor = null;
    expect((await grade(cardId, 3, T0)).status).toBe(401);
    currentActor = admin;
  });

  // ⑥ agent 解題: the read-only reviewQueue tool — same read-policy as the HTTP
  // queue (review service queue()/deck() → readableScopeSql), so an agent only pulls cards inside
  // its grant. The agent works solutions with updateNode; it never grades.
  it("reviewQueue tool: read-policy bounded; due-only vs whole deck; no grade tool", async () => {
    const run = (actor: ActorCtx | null, args: Record<string, unknown> = {}) =>
      reviewQueueTool.handler(args, { actor: actor as ActorCtx, workspaceId: WS, dryRun: false }) as Promise<ReviewQueueResult>;
    const cardId = await enrolledCard();

    // admin sees the enrolled card AND the restricted one (it's in their read set)
    const adminQ = await run(admin, { due_only: false });
    const adminIds = adminQ.cards.map((c) => c.node_id);
    expect(adminIds).toContain(cardId);
    expect(adminIds).toContain(secretId);

    // the restricted card is invisible to the viewer (not in its space)
    const viewerIds = (await run(viewer, { due_only: false })).cards.map((c) => c.node_id);
    expect(viewerIds).not.toContain(secretId);

    // a token whose agent is in no space sees nothing — no existence oracle
    expect((await run(scopedToken, { due_only: false })).cards.length).toBe(0);

    // due_only (default) ⊆ whole deck; limit caps the batch
    const due = await run(admin);
    expect(due.cards.length).toBeLessThanOrEqual(adminQ.cards.length);
    expect((await run(admin, { due_only: false, limit: 1 })).cards.length).toBe(1);

    // the module exposes NO grade-style agent tool (humans grade)
    const review = (await import("../modules/review/index.js")).reviewModule;
    expect((review.agentTools ?? []).map((t) => t.name)).toEqual(["reviewQueue"]);
  });

  // 練這組: the groups the status page lists, and the same scopes on the queue route and the agent's tool.
  it("groups route lists groups; a group's scope gives the same cards on the queue route and in the reviewQueue tool", async () => {
    currentActor = admin;
    const run = (args: Record<string, unknown>) =>
      reviewQueueTool.handler(args, { actor: admin, workspaceId: WS, dryRun: false }) as Promise<ReviewQueueResult>;
    const cardId = await enrolledCard();
    const byNote = (await (await app.request("/api/review/groups?by=note")).json()) as { by: string; groups: Array<{ id: string | null; title: string; due: number; new: number }> };
    expect(byNote.by).toBe("note");
    const row = byNote.groups.find((g) => g.id === cardId);
    expect(row).toMatchObject({ due: 0, new: 1 });
    expect((await queueAt(`root=${cardId}`)).total).toBe(1);
    expect((await run({ root: cardId })).cards.map((c) => c.node_id)).toEqual([cardId]);
    expect((await run({ root: cardId, due_only: false })).cards.map((c) => c.node_id)).toEqual([cardId]);
    // A card under no tag group is in the 「沒有標籤」 row, and its scope on both entrances is the same.
    const byTag = (await (await app.request("/api/review/groups?by=tag")).json()) as { groups: Array<{ id: string | null; due: number; new: number }> };
    const none = byTag.groups.find((g) => g.id === null);
    expect(none).toBeDefined();
    expect((await queueAt("untagged=true")).total).toBe(none!.due + none!.new);
    expect((await run({ untagged: true })).total).toBe(none!.due + none!.new);
    // Bad requests: an unknown grouping, and two scopes at once.
    expect((await app.request("/api/review/groups?by=deck")).status).toBe(400);
    expect((await app.request(`/api/review/queue?root=${cardId}&untagged=true`)).status).toBe(400);
    expect(reviewQueueTool.inputSchema.safeParse({ root: cardId, untagged: true }).success).toBe(false);
    // A reader who cannot read the card sees no row for it.
    currentActor = viewer;
    const viewerRows = (await (await app.request("/api/review/groups?by=note")).json()) as { groups: Array<{ id: string | null }> };
    expect(viewerRows.groups.map((g) => g.id)).not.toContain(secretId);
    currentActor = admin;
  });

  // ⑥ pack-borne ECA: behaviour.review on the #review tag's schema steers the
  // scheduler — the pack mechanism doing real work, with server-side clamps.
  it("behaviour.review drives the scheduler: interval cap and retention; a stored new_per_day limits nothing; reset restores defaults", async () => {
    currentActor = admin;
    // The explicitly enabled tag owns its scheduler settings on the same node.
    const schemaId = reviewTagId; // the collection id IS the class_tag node id
    await seedQ(
      `UPDATE content_nodes
          SET tag_schema = COALESCE(tag_schema, '{}'::jsonb)
                           || jsonb_build_object('name','review','slug','rv-review-${stamp}','fields','[]'::jsonb),
              updated_at = now()
        WHERE id = $1`, [reviewTagId]);
    try {
      await seedQ(
        `UPDATE content_nodes SET tag_schema = tag_schema ||
           '{"behaviour":{"modules":{"review":{"enabled":true}},"review":{"request_retention":0.8,"maximum_interval_days":2,"new_per_day":1}}}'::jsonb,
           updated_at = now()
         WHERE id = $1`, [schemaId]);

      // A quiet day far from the other tests' clocks: nothing introduced yet.
      const TB = "2026-05-01T08:00:00.000Z";
      const ids = await Promise.all([1, 2, 3].map((i) => mkNode(`eca-${stamp}-${i}`)));
      for (const id of ids) {
        await app.request(`/api/review/cards/${id}`, { method: "PUT", body: "{}" });
      }

      // A stored new_per_day=1 is not read any more: every never-graded card rides the queue (the person's one daily cap is the only limit).
      const q1 = await queue(TB);
      expect(q1.cards.filter((c) => c.state === null).length).toBeGreaterThanOrEqual(3);
      for (const id of ids) expect(inQueue(q1, id)).toBe(true);
      expect((await stats(TB)).new_available).toBeGreaterThanOrEqual(3);

      // maximum_interval_days=2 caps the first Good (4 days under defaults).
      const res = await grade(ids[0]!, 3, TB);
      expect(res.status).toBe(200);
      const st = ((await res.json()) as GradeRes).state;
      expect(new Date(st.due).getTime() - new Date(TB).getTime()).toBe(2 * DAY_MS);

      // Grading one new card leaves the others in the queue (nothing but the daily cap limits new cards).
      const q2 = await queue(TB);
      expect(inQueue(q2, ids[1]!) && inQueue(q2, ids[2]!)).toBe(true);

      // Hostile/fat-fingered packs are clamped server-side, not obeyed.
      await seedQ(
        `UPDATE content_nodes SET tag_schema = tag_schema ||
           '{"behaviour":{"modules":{"review":{"enabled":true}},"review":{"request_retention":0.2,"maximum_interval_days":9999999}}}'::jsonb,
           updated_at = now()
         WHERE id = $1`, [schemaId]);
      const clamped = await loadReviewBehaviour(WS, reviewTagId);
      expect(clamped.requestRetention).toBe(0.7);          // floor
      expect(clamped.maximumIntervalDays).toBe(36500);     // ceiling

      // A fractional pack must not expose fractional card counts or schedule
      // sub-day intervals. The persisted schema is read by both stats and grade.
      await seedQ(
        `UPDATE content_nodes SET tag_schema = tag_schema ||
           '{"behaviour":{"modules":{"review":{"enabled":true}},"review":{"maximum_interval_days":2.9}}}'::jsonb,
           updated_at = now()
         WHERE id = $1`, [schemaId]);
      const TB2 = "2026-05-02T08:00:00.000Z";
      const roundedGrade = await grade(ids[1]!, 3, TB2);
      expect(roundedGrade.status).toBe(200);
      const roundedState = ((await roundedGrade.json()) as GradeRes).state;
      expect(new Date(roundedState.due).getTime() - new Date(TB2).getTime()).toBe(2 * DAY_MS);
    } finally {
      await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"behaviour":{"modules":{"review":{"enabled":true}}}}'::jsonb, updated_at = now() WHERE id = $1`, [schemaId]);
    }
    // With behaviour cleared, defaults are back in force.
    expect(await loadReviewBehaviour(WS, reviewTagId)).toEqual(DEFAULT_BEHAVIOUR);
  });

  it("untag retires the card from queue and stats", async () => {
    currentActor = admin;
    await app.request(`/api/review/cards/${untagId}`, { method: "PUT", body: "{}" });
    expect(inQueue(await queue(T0), untagId)).toBe(true);
    const before = await stats(T0);
    const res = await app.request(`/api/review/cards/${untagId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(inQueue(await queue(T0), untagId)).toBe(false);
    const after = await stats(T0);
    expect(after.due).toBe(before.due - 1);
  });

  // ?root=<id> — focus the session on one note's subtree (its deck). The read
  // gate still applies first; the scope only narrows, never widens.
  it("queue ?root scopes to the note's subtree", async () => {
    currentActor = admin;
    const mkChild = async (title: string, parentId: string): Promise<string> => {
      const r = await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
         VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id`,
        [WS, title, `rv-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, parentId],
      );
      return r.rows[0]!.id;
    };
    const enrol = (id: string) => app.request(`/api/review/cards/${id}`, { method: "PUT", body: "{}" });

    const lecture = await mkNode(`lecture-${stamp}`);     // the deck root
    const a1 = await mkChild(`la1-${stamp}`, lecture);    // card directly under it
    const a2 = await mkChild(`la2-${stamp}`, a1);         // card nested deeper
    const outsider = await mkNode(`outsider-${stamp}`);   // a card in another deck
    await enrol(a1); await enrol(a2); await enrol(outsider);

    const global = await queue(T0);
    expect(inQueue(global, a1) && inQueue(global, a2) && inQueue(global, outsider)).toBe(true);

    const scoped = (await (await app.request(
      `/api/review/queue?root=${lecture}&now=${encodeURIComponent(T0)}`)).json()) as Queue;
    expect(inQueue(scoped, a1)).toBe(true);       // self-subtree, any depth
    expect(inQueue(scoped, a2)).toBe(true);
    expect(inQueue(scoped, outsider)).toBe(false); // a different deck is excluded
    expect(scoped.cards.every((c) => c.node_id === a1 || c.node_id === a2)).toBe(true);
  });

  // /decks — the home strip's "study this lecture" entries: notes that host
  // due cards, with per-deck counts. A deck is a non-card direct parent.
  it("decks lists notes hosting due cards with counts; card-parents aren't decks", async () => {
    currentActor = admin;
    const mkChild = async (title: string, parentId: string): Promise<string> => {
      const r = await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
         VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id`,
        [WS, title, `rv-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, parentId],
      );
      return r.rows[0]!.id;
    };
    const enrol = (id: string) => app.request(`/api/review/cards/${id}`, { method: "PUT", body: "{}" });
    const decksOf = async (now: string) =>
      ((await (await app.request(`/api/review/decks?now=${encodeURIComponent(now)}`)).json()) as { decks: Array<{ node_id: string; title: string; due: number }> }).decks;

    const deck = await mkNode(`deck-${stamp}`);
    const c1 = await mkChild(`dc1-${stamp}`, deck);
    const c2 = await mkChild(`dc2-${stamp}`, deck);
    const nested = await mkChild(`dnest-${stamp}`, c1); // a card under a card
    await enrol(c1); await enrol(c2); await enrol(nested);

    let decks = await decksOf(T0);
    expect(decks.find((d) => d.node_id === deck)?.due).toBe(2);     // c1 + c2, both due
    expect(decks.find((d) => d.node_id === deck)?.title).toBe(`deck-${stamp}`);
    expect(decks.some((d) => d.node_id === c1)).toBe(false);        // c1 is a card, not a deck

    // Grading c1 'easy' schedules it far out → it leaves the due set → count drops.
    await grade(c1, 4, T0);
    decks = await decksOf(T0);
    expect(decks.find((d) => d.node_id === deck)?.due).toBe(1);
  });

  it("personal settings override the tag's for that person only, and can be reset", async () => {
    const mine = await mkNode(`personal-${stamp}`); await makeCard(mine);
    const theirs = await mkNode(`personal-b-${stamp}`); await makeCard(theirs);
    const later = "2027-01-01T00:00:00.000Z";
    const days = async (id: string) => {
      const due = ((await (await grade(id, 3, later)).json()) as GradeRes).state.due;
      return Math.round((new Date(due).getTime() - new Date(later).getTime()) / DAY_MS);
    };
    currentActor = viewer;
    const put = (body: unknown) => app.request(`/api/review/settings/${reviewTagId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ maximum_interval_days: 9999999 })).status).toBe(400);
    // The new-card number is gone from what can be set (the person's one daily cap replaced it).
    expect((await put({ new_per_day: 0 })).status).toBe(400);
    expect((await put({ maximum_interval_days: 2 })).status).toBe(200);
    expect((await (await app.request(`/api/review/settings/${reviewTagId}`)).json()).mine).toEqual({ maximum_interval_days: 2 });
    expect(await days(mine)).toBe(2);
    currentActor = admin;
    expect(await days(theirs)).toBeGreaterThan(2); // the admin keeps the tag's settings
    currentActor = viewer;
    expect((await app.request(`/api/review/settings/${reviewTagId}`, { method: "DELETE" })).status).toBe(200);
    const again = await mkNode(`personal-c-${stamp}`); await makeCard(again);
    expect(await days(again)).toBeGreaterThan(2);
  });

  it("PATCH merges personal settings: a sent field replaces, null removes, the rest is kept (W25)", async () => {
    currentActor = viewer;
    const path = `/api/review/settings/${reviewTagId}`;
    const send = (method: string, body: unknown) => app.request(path, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await send("PUT", { request_retention: 0.85, maximum_interval_days: 90 })).status).toBe(200);
    expect((await (await send("PATCH", { maximum_interval_days: 30 })).json()).mine)
      .toEqual({ request_retention: 0.85, maximum_interval_days: 30 });
    expect((await (await send("PATCH", { maximum_interval_days: null })).json()).mine)
      .toEqual({ request_retention: 0.85 });
    expect((await send("PATCH", { maximum_interval_days: 9999999 })).status).toBe(400);
    expect((await send("PATCH", { new_per_day: 3 })).status).toBe(400);
    expect((await send("PATCH", { surprise: 1 })).status).toBe(400);
    // Clearing the last field removes the row: the person follows the tag again.
    expect((await (await send("PATCH", { request_retention: null })).json()).mine).toBeNull();
    expect((await (await app.request(path)).json()).mine).toBeNull();
  });

  it("a retried grade or undo (same Idempotency-Key) applies once", async () => {
    const id = await mkNode(`Retry ${stamp}`);
    await makeCard(id);
    currentActor = admin;
    const post = (path: string, key: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    const gradeKey = randomUUID();
    expect((await post(`/api/review/${id}/grade`, gradeKey, { rating: 3, now: T0 })).status).toBe(200);
    const retried = await post(`/api/review/${id}/grade`, gradeKey, { rating: 3, now: T0 });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ deduped: true });
    const state = async () => ((await (await app.request(`/api/review/${id}/state`)).json()) as { state: ReviewState | null }).state;
    expect((await state())!.reps).toBe(1);

    // Grade again, then undo twice with one key: one step back, not two.
    expect((await grade(id, 3, new Date(Date.parse(T0) + 60 * DAY_MS).toISOString())).status).toBe(200);
    expect((await state())!.reps).toBe(2);
    const undoKey = randomUUID();
    expect((await post(`/api/review/${id}/undo-grade`, undoKey, {})).status).toBe(200);
    expect((await post(`/api/review/${id}/undo-grade`, undoKey, {})).status).toBe(200);
    expect((await state())!.reps).toBe(1);
  });
});
