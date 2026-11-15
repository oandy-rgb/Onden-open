// Review progress of ONE person on TWO devices, through the real routes.
//
// The same person has two devices. Each has its own, possibly stale, queue
// (GET /api/review/queue) and mints its own Idempotency-Key per action. A
// generated sequence of commands runs against the real app and, in step,
// against a small model: fetch the queue, grade, undo-grade, put off until
// tomorrow, stop, resume, retry an earlier request with the same key, move
// the clock (time passes; the workspace time zone and day-start hour change),
// and trash / restore / move / stop being a card (a note is a card by its own review reference, PUT/DELETE /api/review/cards/:id).
//
// Public surface only: /api/review/* and /api/nodes/*, never the review_states
// table (PR #1586 changes how cards are stored). Per card the model keeps the
// stack of grades not undone, the one-step undo, the hold.
//
// Invariants (the failure message names them):
//   history-kept   a card graded N >= 2 times and undone any number of times still has a schedule
//   undo-one-step  an undo steps back exactly one grade; a retry with the same key changes nothing
//                  more; an undo with nothing to step back answers 409 "nothing to undo", changes nothing
//   counts         reps / lapses equal the grades not undone
//   stopped        a stopped card is never graded, scheduled, or put in a queue
//   numbers-agree  at one instant the queue, the home count (stats), the status page and the deck
//                  counts describe the same set of due cards (the places that count are listed below)
//   no-500         nothing answers 5xx
//   named-undo     a versioned client (grade carries seen_reps, undo carries graded_reps + graded_id from the grade
//                  answer) is refused with 409 when the card changed since it was shown, and an undo removes exactly the
//                  grade it names: never one that merely reached the same reps (grade, undo, another device's grade),
//                  never the whole schedule. A grade is accepted whenever the seen reps equal the stored ones, due or not.
//
// Every place a number of cards is computed (modules/review/service.ts):
//   queue().total                        what a study session gives
//   stats().due / new / learned / new_available     the home line (ReviewHomeSection)
//   status().overdue / today / new_available / rolled_over / forecast[] / stopped
//   decks()[].due                        "study this deck"
//   reviewQueueTool                      the agent's queue: calls queue(), so it is the same number
//
// Known defects (each has a named case at the end, marked it.fails; the random run leaves its
// trigger out so the suite stays green; REVIEW_PROPS_KNOWN=1 puts every trigger back):
//   second-undo    a second undo (new key) after two grades deletes the row: the history is gone
//   double-grade   the same card graded from two devices counts twice (no due / version check);
//                  the same gap lets a card put off until tomorrow be graded from a stale queue
//                  (found by REVIEW_PROPS_KNOWN=1 PROPS_SEED=20261023: tomorrow, then grade)
//   tomorrow-stop  "tomorrow" from a stale device silently un-stops a stopped card
//   status-day     the status page counts by day, the queue by instant
//   deck-subtree   a deck counts only direct children; a study session covers the subtree
//
// When PR #1586 (review cards stored differently) merges, care is needed in: the card-state reads
// (GET /api/review/:id/state, the shape of `state` / `hold`), what "trashed note" and "uncardRef
// note" do to a card's stored progress, and the response of an undo on a card with nothing stored.
//
// Run count and seed: PROPS_RUNS (default 25 here: every run is ~100 requests) and PROPS_SEED.
//
//   PROPS_SEED=123 PROPS_RUNS=500 npx vitest run src/test/properties/reviewState.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise. Own workspace, own actor, own notes.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import type { ReviewRating, ReviewState } from "@onden/contract";
import { q } from "../../db.js";
import { addDays, dayStartInstant, localDayId, resetDayClock, setDayClock } from "../../localDay.js";
import { schedule } from "../../modules/review/fsrs.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { seedQ } from "../helpers/seedQ.js";
import { isTestDatabase } from "../helpers/testDatabase.js";

registerShippedModules();

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let sessionExternalId: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId ? { user: { id: sessionExternalId, name: sessionExternalId, email: `${sessionExternalId}@props.test` } } : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const isTestDb = isTestDatabase();
const { app } = isTestDb ? await import("../../app.js") : { app: null as never };

/** Put every known defect's trigger back into the random run. */
const INCLUDE_KNOWN = process.env.REVIEW_PROPS_KNOWN === "1";
/** Every run is ~100 requests; stay small unless the caller asks for more. */
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 25;

// ── HTTP ─────────────────────────────────────────────────────────────────────

type Reply = { status: number; body: any };
/** The person is ONE actor: both devices are the same session. */
async function http(method: string, path: string, json?: unknown, key?: string): Promise<Reply> {
  sessionExternalId = "props-review-person";
  try {
    const res = await app.request(path, {
      method,
      headers: {
        [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally { sessionExternalId = null; }
}

// ── Model ────────────────────────────────────────────────────────────────────

const DECKS = 2;
const CARDS = 4;
const NOTES = DECKS + CARDS; // notes 0..DECKS-1 are plain decks, the rest are review cards
const isCard = (i: number) => i >= DECKS;
const START = Date.parse("2026-11-13T02:00:00.000Z");
const ZONES = ["Asia/Taipei", "UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland"];

type Hold = { suspended: boolean; until: string | null };
/** What one undo returns the card to: nothing stored (a second undo), "new", or an earlier schedule. */
type Undo = { k: "none" } | { k: "new" } | { k: "to"; state: ReviewState; ratings: ReviewRating[]; grades: number[] };
type NoteM = {
  id: string;
  parent: number | null;
  live: boolean;
  cardRef: boolean;
  /** The delete that trashed it (a deck takes its live children with it). */
  trash: number | null;
  trashRoot: boolean;
  state: ReviewState | null;
  /** The grades not undone, oldest first; reps = length, lapses = the 1s. */
  ratings: ReviewRating[];
  /** One serial per grade not undone (parallel to `ratings`): the identity of a grade, which reps are not. */
  grades: number[];
  undo: Undo;
  hold: Hold | null;
};
/** What a device last asked for: a versioned grade (what it saw), and the grade whose answer it keeps for an undo. */
type GradeSent = { i: number; rating: ReviewRating; seen: number };
type GradeKept = { i: number; serial: number; reps: number; gradeId?: string };
type Model = {
  notes: NoteM[]; now: number; token: number; devices: [number[], number[]];
  serial: number;
  /** The reps each device saw per card in its last queue fetch (note index -> reps). */
  views: [Map<number, number>, Map<number, number>];
  lastSent: [GradeSent | null, GradeSent | null];
  lastKept: [GradeKept | null, GradeKept | null];
};

const clone = <T>(v: T): T => structuredClone(v);
const iso = (ms: number) => new Date(ms).toISOString();

const enrolled = (n: NoteM, i: number) => isCard(i) && n.live && n.cardRef;
const isHeld = (n: NoteM, now: number) => !!n.hold && (n.hold.suspended || (n.hold.until !== null && Date.parse(n.hold.until) > now));
const isDue = (n: NoteM, now: number) => n.state === null || Date.parse(n.state.due) <= now;
const inQueue = (m: Model, i: number) => { const n = m.notes[i]!; return enrolled(n, i) && !isHeld(n, m.now) && isDue(n, m.now); };
const dueAt = (n: NoteM & { state: ReviewState }) => n.hold?.until && n.hold.until > n.state.due ? n.hold.until : n.state.due;

function subtree(m: Model, root: number): number[] {
  const out = [root];
  for (let k = 0; k < out.length; k++) {
    m.notes.forEach((n, i) => { if (n.live && n.parent === out[k] && !out.includes(i)) out.push(i); });
  }
  return out;
}

// ── Commands ─────────────────────────────────────────────────────────────────

type Dev = 0 | 1;
type Cmd =
  | { t: "advance"; hours: number }
  | { t: "clock"; zone: number; startHour: number }
  | { t: "fetch"; dev: Dev }
  | { t: "grade"; dev: Dev; fromQueue: boolean; pick: number; rating: ReviewRating; again: boolean }
  | { t: "undo"; dev: Dev; pick: number; again: boolean }
  /** A versioned grade: `seen_reps` from the device's last fetch (or, with `replay`, the device's previous request again under a new key: a lost response). */
  | { t: "vgrade"; dev: Dev; pick: number; rating: ReviewRating; again: boolean; replay: boolean }
  /** A versioned undo of the grade the device last kept the answer of (still sent after it was undone: a replay under a new key). */
  | { t: "vundo"; dev: Dev; again: boolean }
  /** Both devices fetch; `first` grades and undoes; the other grades the same card; `first` sends its undo again under a new key. */
  | { t: "handoff"; first: Dev; pick: number; r1: ReviewRating; r2: ReviewRating }
  | { t: "hold"; kind: "tomorrow" | "suspend" | "resume"; dev: Dev; pick: number; again: boolean }
  | { t: "retry"; pick: number }
  | { t: "trash"; pick: number }
  | { t: "undelete"; pick: number }
  | { t: "move"; pick: number; to: number }
  | { t: "tag"; pick: number; on: boolean };

const dev = fc.constantFrom<Dev>(0, 1);
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("advance" as const), hours: fc.constantFrom(0, 1, 3, 5, 8, 20, 24, 30, 49, 100, 300) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("clock" as const), zone: fc.nat(ZONES.length - 1), startHour: fc.nat(6) }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("fetch" as const), dev }) },
  { weight: 9, arbitrary: fc.record({ t: fc.constant("grade" as const), dev, fromQueue: fc.boolean(), pick: fc.nat(20), rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4), again: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("undo" as const), dev, pick: fc.nat(20), again: fc.boolean() }) },
  { weight: 12, arbitrary: fc.record({ t: fc.constant("vgrade" as const), dev, pick: fc.nat(20), rating: fc.constantFrom<ReviewRating>(1, 2, 3, 4), again: fc.boolean(), replay: fc.boolean() }) },
  { weight: 9, arbitrary: fc.record({ t: fc.constant("vundo" as const), dev, again: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("handoff" as const), first: dev, pick: fc.nat(20), r1: fc.constantFrom<ReviewRating>(1, 2, 3, 4), r2: fc.constantFrom<ReviewRating>(1, 2, 3, 4) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("hold" as const), kind: fc.constantFrom("tomorrow" as const, "suspend" as const, "resume" as const), dev, pick: fc.nat(20), again: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("retry" as const), pick: fc.nat(50) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("trash" as const), pick: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("undelete" as const), pick: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("move" as const), pick: fc.nat(20), to: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("tag" as const), pick: fc.nat(20), on: fc.boolean() }) },
);
/** Where each card starts: no deck, or one of the decks. */
const parentsArb = fc.array(fc.nat(DECKS), { minLength: CARDS, maxLength: CARDS });

// ── One run ──────────────────────────────────────────────────────────────────

type Sent = { method: string; path: string; json?: unknown; key: string };
type Known = "second-undo" | "double-grade" | "tomorrow-stop" | "status-day" | "deck-subtree";
const ALL_KNOWN: Known[] = ["second-undo", "double-grade", "tomorrow-stop", "status-day", "deck-subtree"];

class Run {
  m: Model;
  sent: Sent[] = [];
  trace: string[] = [];
  problem: string | null = null;
  readonly created: string[] = [];
  constructor(readonly known: ReadonlySet<Known>) {
    this.m = { notes: [], now: START, token: 0, devices: [[], []], serial: 0, views: [new Map(), new Map()], lastSent: [null, null], lastKept: [null, null] };
  }
  fail(msg: string) { if (!this.problem) this.problem = `${msg}\n  trace:\n    ${this.trace.join("\n    ")}`; }
  eq(label: string, actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) this.fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  async call(method: string, path: string, json?: unknown, key?: string): Promise<Reply> {
    const r = await http(method, path, json, key);
    if (r.status >= 500) this.fail(`no-500: ${method} ${path} answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r;
  }

  async setup(parents: number[]) {
    for (let i = 0; i < NOTES; i++) {
      const parent = isCard(i) ? (parents[i - DECKS]! < DECKS ? parents[i - DECKS]! : null) : null;
      const r = await http("POST", "/api/nodes", {
        title: `RP-${i}`, markdown: "", parent_id: parent === null ? null : this.m.notes[parent]!.id,
      }, randomUUID());
      if (r.status !== 201) throw new Error(`setup: creating note ${i} answered ${r.status} ${JSON.stringify(r.body)}`);
      if (isCard(i)) {
        const card = await http("PUT", `/api/review/cards/${r.body.id}`, undefined, randomUUID());
        if (card.status !== 200) throw new Error(`setup: making note ${i} a card answered ${card.status} ${JSON.stringify(card.body)}`);
      }
      this.created.push(r.body.id);
      this.m.notes.push({ id: r.body.id, parent, live: true, cardRef: isCard(i), trash: null, trashRoot: false, state: null, ratings: [], grades: [], undo: { k: "none" }, hold: null });
    }
  }

  /** Remove this run's notes and progress so the next run starts clean. */
  async cleanup() {
    if (!this.created.length) return;
    await seedQ("DELETE FROM review_states WHERE node_id = ANY($1::uuid[])", [this.created]);
    await seedQ("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [this.created]);
  }

  nowIso() { return iso(this.m.now); }
  cardIdx(pick: number) { return DECKS + (pick % CARDS); }

  // ── what a refusal must be ──────────────────────────────────────────────────

  /** The status the contract gives each review action on card `i`, from the model. */
  expectGrade(i: number): 200 | 404 | 409 {
    const n = this.m.notes[i]!;
    if (!n.live) return 404;
    if (!n.cardRef) return 409;
    if (n.hold?.suspended) return 409;
    if (!inQueue(this.m, i)) return 409; // double-grade: not due (graded from the other device, or put off)
    return 200;
  }
  expectUndo(i: number): 200 | 404 | 409 {
    const n = this.m.notes[i]!;
    if (!n.live) return 404;
    if (!n.state) return 409;
    if (n.hold?.suspended) return 409;
    if (n.undo.k === "none") return 409; // second-undo: nothing to step back
    return 200;
  }
  expectHold(kind: "tomorrow" | "suspend" | "resume", i: number): 200 | 404 | 409 {
    const n = this.m.notes[i]!;
    if (!n.live) return 404;
    if (kind === "resume") return 200;
    if (!n.cardRef) return 409;
    if (kind === "tomorrow" && n.hold?.suspended) return 409; // tomorrow-stop: a stop is not undone by a stale device
    return 200;
  }

  /** Whether the random run leaves this command out: it would hit a known defect. */
  skips(c: Cmd): boolean {
    const m = this.m;
    if (c.t === "vgrade") return this.versionedRequest(c) === null;
    if (c.t === "vundo") return m.lastKept[c.dev] === null;
    if (c.t === "grade" && this.gradeTarget(c) === null) return true; // a device that has not fetched a queue has nothing to grade from it
    if (this.known.size === ALL_KNOWN.length) return false;
    if (c.t === "grade") {
      const i = this.gradeTarget(c)!;
      const n = m.notes[i]!;
      return !this.known.has("double-grade") && enrolled(n, i) && !n.hold?.suspended && !inQueue(m, i);
    }
    if (c.t === "undo") {
      const n = m.notes[this.cardIdx(c.pick)]!;
      return !this.known.has("second-undo") && n.live && n.state !== null && !n.hold?.suspended && n.undo.k === "none";
    }
    if (c.t === "hold") {
      const n = m.notes[this.cardIdx(c.pick)]!;
      return c.kind === "tomorrow" && !this.known.has("tomorrow-stop") && n.live && n.cardRef && !!n.hold?.suspended;
    }
    if (c.t === "move") {
      const i = c.pick % NOTES, n = m.notes[i]!;
      const to = this.moveTarget(c);
      if (!n.live || (to !== null && !m.notes[to]!.live)) return true;
      // Depth stays one (cards and decks under a deck or at the top) unless deck-subtree is on.
      return !this.known.has("deck-subtree") && (!isCard(i) || (to !== null && isCard(to)));
    }
    return false;
  }
  /** What a versioned grade asks for, or null when the device has nothing to grade (never fetched a card / nothing to replay). */
  versionedRequest(c: Extract<Cmd, { t: "vgrade" }>): GradeSent | null {
    if (c.replay && this.m.lastSent[c.dev]) return this.m.lastSent[c.dev];
    const seen = [...this.m.views[c.dev].entries()];
    if (!seen.length) return null;
    const [i, reps] = seen[c.pick % seen.length]!;
    return { i, rating: c.rating, seen: reps };
  }
  gradeTarget(c: Extract<Cmd, { t: "grade" }>): number | null {
    if (!c.fromQueue) return this.cardIdx(c.pick);
    const q = this.m.devices[c.dev];
    return q.length ? q[c.pick % q.length]! : null;
  }
  moveTarget(c: Extract<Cmd, { t: "move" }>): number | null {
    const choices = this.known.has("deck-subtree") ? NOTES : DECKS;
    const t = c.to % (choices + 1);
    return t === choices ? null : t;
  }

  // ── executing ───────────────────────────────────────────────────────────────

  /** Send one write; with `again` send the very same key a second time at once. */
  async write(method: string, path: string, json: unknown | undefined, expected: 200 | 404 | 409, again: boolean): Promise<Reply> {
    const key = randomUUID();
    const r = await this.call(method, path, json, key);
    if (r.status !== expected) this.fail(`${method} ${path} answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}, expected ${expected}`);
    if (r.status === 200 && !r.body?.deduped) this.sent.push({ method, path, json, key });
    if (again && !this.problem) {
      const r2 = await this.call(method, path, json, key);
      if (r.status === 200) {
        if (r2.status !== 200 || r2.body?.deduped !== true) this.fail(`undo-one-step: the same key sent again answered ${r2.status} ${JSON.stringify(r2.body).slice(0, 200)}, expected 200 {deduped:true}`);
      } else if (r2.status !== r.status) this.fail(`a refused request sent again with its key answered ${r2.status}, first ${r.status}`);
    }
    return r;
  }

  async exec(c: Cmd) {
    const m = this.m;
    this.trace.push(`${JSON.stringify(c)} @${this.nowIso()}`);
    switch (c.t) {
      case "advance": m.now += c.hours * 3_600_000; break;
      case "clock": setDayClock({ timeZone: ZONES[c.zone]!, dayStartHour: c.startHour }); break;
      case "fetch": {
        const r = await this.call("GET", `/api/review/queue?now=${encodeURIComponent(this.nowIso())}`);
        m.devices[c.dev] = (r.body?.cards ?? []).map((card: { node_id: string }) => m.notes.findIndex(n => n.id === card.node_id));
        m.views[c.dev] = new Map((r.body?.cards ?? []).map((card: { node_id: string; state: ReviewState | null }) =>
          [m.notes.findIndex(n => n.id === card.node_id), card.state?.reps ?? 0] as [number, number]));
        break;
      }
      case "grade": {
        const i = this.gradeTarget(c)!;
        const n = m.notes[i]!;
        const expected = this.expectGrade(i);
        const before = clone(n);
        const r = await this.write("POST", `/api/review/${n.id}/grade`, { rating: c.rating, now: this.nowIso() }, expected, c.again);
        if (expected === 200 && r.status === 200) {
          const prev = n.state;
          n.state = { ...schedule(prev, c.rating, new Date(m.now)), introduced_at: prev?.introduced_at ?? this.nowIso() };
          n.undo = prev ? { k: "to", state: prev, ratings: before.ratings, grades: before.grades } : { k: "new" };
          n.ratings = [...n.ratings, c.rating];
          n.grades = [...n.grades, ++m.serial];
          n.hold = null;
          this.eq("grade answered state", r.body.state, n.state);
        } else if (before.hold?.suspended && n.live) {
          const after = await this.stateOf(i);
          this.eq("stopped: a refused grade left the card as it was", { state: after.state, hold: after.hold }, { state: before.state, hold: before.hold });
        }
        break;
      }
      case "undo": {
        const i = this.cardIdx(c.pick);
        const n = m.notes[i]!;
        const expected = this.expectUndo(i);
        const r = await this.write("POST", `/api/review/${n.id}/undo-grade`, undefined, expected, c.again);
        if (expected === 409 && r.status === 409 && n.state && n.undo.k === "none") this.eq("undo-one-step: refusal body", r.body, { error: "nothing to undo" });
        if (expected === 200 && r.status === 200) {
          if (n.undo.k === "to") { n.state = n.undo.state; n.ratings = n.undo.ratings; n.grades = n.undo.grades; } else { n.state = null; n.ratings = []; n.grades = []; }
          n.undo = { k: "none" };
          n.hold = null;
          this.eq("undo answered state", r.body.state, n.state);
        }
        break;
      }
      case "handoff": {
        const other: Dev = c.first === 0 ? 1 : 0;
        const steps: Cmd[] = [
          { t: "fetch", dev: c.first }, { t: "fetch", dev: other },
          { t: "vgrade", dev: c.first, pick: c.pick, rating: c.r1, again: false, replay: false }, { t: "vundo", dev: c.first, again: false },
          { t: "vgrade", dev: other, pick: c.pick, rating: c.r2, again: false, replay: false }, { t: "vundo", dev: c.first, again: false },
        ];
        for (const step of steps) if (!this.skips(step)) { await this.exec(step); if (this.problem) break; }
        break;
      }
      case "vgrade": {
        const ask = this.versionedRequest(c)!;
        const n = m.notes[ask.i]!;
        m.lastSent[c.dev] = ask;
        // The card as the server holds it: gone, not a card, stopped, or changed since this device saw it, are refusals; due-ness is not checked.
        const expected: 200 | 404 | 409 = !n.live ? 404 : !n.cardRef || n.hold?.suspended || ask.seen !== n.ratings.length ? 409 : 200;
        const before = clone(n);
        const r = await this.write("POST", `/api/review/${n.id}/grade`, { rating: ask.rating, now: this.nowIso(), seen_reps: ask.seen }, expected, c.again);
        if (expected === 200 && r.status === 200) {
          const prev = n.state;
          n.state = { ...schedule(prev, ask.rating, new Date(m.now)), introduced_at: prev?.introduced_at ?? this.nowIso() };
          n.undo = prev ? { k: "to", state: prev, ratings: before.ratings, grades: before.grades } : { k: "new" };
          n.ratings = [...n.ratings, ask.rating];
          n.grades = [...n.grades, ++m.serial];
          n.hold = null;
          this.eq("grade answered state", r.body.state, n.state);
          m.lastKept[c.dev] = { i: ask.i, serial: m.serial, reps: n.ratings.length, gradeId: r.body.grade_id };
        }
        break;
      }
      case "vundo": {
        const kept = m.lastKept[c.dev]!;
        const n = m.notes[kept.i]!;
        const expected: 200 | 404 | 409 = !n.live ? 404
          : !n.state || n.hold?.suspended || n.undo.k === "none" || n.grades[n.grades.length - 1] !== kept.serial ? 409 : 200;
        const r = await this.write("POST", `/api/review/${n.id}/undo-grade`, { graded_reps: kept.reps, ...(kept.gradeId ? { graded_id: kept.gradeId } : {}) }, expected, c.again);
        if (expected === 200 && r.status === 200) {
          if (n.undo.k === "to") { n.state = n.undo.state; n.ratings = n.undo.ratings; n.grades = n.undo.grades; } else { n.state = null; n.ratings = []; n.grades = []; }
          n.undo = { k: "none" };
          n.hold = null;
          this.eq("undo answered state", r.body.state, n.state);
        }
        break;
      }
      case "hold": {
        const i = this.cardIdx(c.pick);
        const n = m.notes[i]!;
        const expected = this.expectHold(c.kind, i);
        const r = await this.write("POST", `/api/review/${n.id}/${c.kind}`, c.kind === "tomorrow" ? { now: this.nowIso() } : undefined, expected, c.again);
        if (expected === 200 && r.status === 200) {
          n.hold = c.kind === "resume" ? null
            : c.kind === "suspend" ? { suspended: true, until: null }
              : { suspended: false, until: dayStartInstant(addDays(localDayId(new Date(m.now)), 1)).toISOString() };
          if (c.kind === "tomorrow") {
            const wait = Date.parse(n.hold!.until!) - m.now;
            if (wait <= 0 || wait > 27 * 3_600_000) this.fail(`tomorrow: the card is put off by ${wait / 3_600_000} hours, expected (0, 27]`);
          }
          this.eq("hold answer", r.body.hold, n.hold);
        }
        break;
      }
      case "retry": {
        if (!this.sent.length) break;
        const s = this.sent[c.pick % this.sent.length]!;
        const r = await this.call(s.method, s.path, s.json, s.key);
        if (r.status !== 200 || r.body?.deduped !== true) this.fail(`undo-one-step: an old request sent again with its key answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}, expected 200 {deduped:true}`);
        break;
      }
      case "trash": {
        const i = c.pick % NOTES, n = m.notes[i]!;
        if (!n.live) break;
        const r = await this.call("DELETE", `/api/nodes/${n.id}`, undefined, randomUUID());
        if (r.status !== 200) { this.fail(`trash answered ${r.status} ${JSON.stringify(r.body)}`); break; }
        const token = ++m.token;
        for (const k of subtree(m, i)) { m.notes[k]!.live = false; m.notes[k]!.trash = token; }
        n.trashRoot = true;
        break;
      }
      case "undelete": {
        const i = c.pick % NOTES, n = m.notes[i]!;
        if (n.live || !n.trashRoot || (n.parent !== null && !m.notes[n.parent]!.live)) break;
        const r = await this.call("POST", `/api/nodes/${n.id}/undelete`, undefined, randomUUID());
        if (r.status !== 200) { this.fail(`undelete answered ${r.status} ${JSON.stringify(r.body)}`); break; }
        const token = n.trash;
        for (const k of m.notes) if (k.trash === token) { k.live = true; k.trash = null; k.trashRoot = false; }
        break;
      }
      case "move": {
        const i = c.pick % NOTES, n = m.notes[i]!;
        const to = this.moveTarget(c);
        if (to !== null && subtree(m, i).includes(to)) break; // not under itself
        const r = await this.call("PATCH", `/api/nodes/${n.id}`, { parent_id: to === null ? null : m.notes[to]!.id }, randomUUID());
        if (r.status !== 200) { this.fail(`move answered ${r.status} ${JSON.stringify(r.body)}`); break; }
        n.parent = to;
        break;
      }
      case "tag": {
        const i = this.cardIdx(c.pick), n = m.notes[i]!;
        if (!n.live || n.cardRef === c.on) break;
        const r = await this.call(c.on ? "PUT" : "DELETE", `/api/review/cards/${n.id}`, undefined, randomUUID());
        if (r.status !== 200) { this.fail(`tag answered ${r.status} ${JSON.stringify(r.body)}`); break; }
        n.cardRef = c.on;
        break;
      }
    }
  }

  async stateOf(i: number) {
    const r = await this.call("GET", `/api/review/${this.m.notes[i]!.id}/state`);
    return { status: r.status, state: r.body?.state ?? null, hold: r.body?.hold ?? null };
  }

  // ── what must hold after every command ──────────────────────────────────────

  /** Each card's schedule and hold equal the model's; reps / lapses equal the grades not undone. */
  async verifyCards() {
    for (let i = DECKS; i < NOTES; i++) {
      const n = this.m.notes[i]!;
      const got = await this.stateOf(i);
      if (!n.live) { this.eq(`card ${i} (trashed) state route`, got.status, 404); continue; }
      this.eq(`card ${i} schedule`, got.state, n.state);
      this.eq(`card ${i} hold`, got.hold, n.hold);
      if (n.ratings.length >= 2 && got.state === null) this.fail(`history-kept: card ${i} was graded ${n.ratings.length} times and now has no schedule`);
      this.eq(`counts: card ${i} reps`, got.state?.reps ?? 0, n.ratings.length);
      this.eq(`counts: card ${i} lapses`, got.state?.lapses ?? 0, n.ratings.filter(r => r === 1).length);
      if (this.problem) return;
    }
  }

  /** The numbers every screen shows, at one instant, against the model and against each other. */
  async verifyViews() {
    const m = this.m;
    const now = encodeURIComponent(this.nowIso());
    const [qr, sr, tr, dr] = await Promise.all([
      this.call("GET", `/api/review/queue?now=${now}`), this.call("GET", `/api/review/stats?now=${now}`),
      this.call("GET", `/api/review/status?now=${now}`), this.call("GET", `/api/review/decks?now=${now}`),
    ]);
    if ([qr, sr, tr, dr].some(r => r.status !== 200)) return this.fail(`a counting route did not answer 200: ${[qr, sr, tr, dr].map(r => r.status)}`);
    const idx = (id: string) => m.notes.findIndex(n => n.id === id);

    // The queue is the model's due set: due cards (most overdue first), then new ones.
    const want = m.notes.map((_, i) => i).filter(i => inQueue(m, i));
    const got: number[] = qr.body.cards.map((c: { node_id: string }) => idx(c.node_id));
    this.eq("numbers-agree: queue cards", [...got].sort(), [...want].sort());
    this.eq("numbers-agree: queue total", qr.body.total, want.length);
    const dueGot = qr.body.cards.filter((c: { state: unknown }) => c.state !== null).map((c: { state: ReviewState }) => c.state.due);
    this.eq("queue: most overdue first", dueGot, [...dueGot].sort());
    for (const c of qr.body.cards) if (m.notes[idx(c.node_id)]!.hold?.suspended) this.fail(`stopped: a stopped card is in the queue`);
    const queueNew = qr.body.cards.filter((c: { state: unknown }) => c.state === null).length;
    const queueDue = qr.body.cards.length - queueNew;

    // Home line (stats): one number of cards to study, the new ones, the learned ones.
    const live = m.notes.map((_, i) => i).filter(i => enrolled(m.notes[i]!, i) && !isHeld(m.notes[i]!, m.now));
    const newCount = live.filter(i => m.notes[i]!.state === null).length;
    this.eq("numbers-agree: home count (stats.due) = queue total", sr.body.due, qr.body.total);
    this.eq("stats.new", sr.body.new, newCount);
    this.eq("stats.learned", sr.body.learned, live.length - newCount);
    this.eq("numbers-agree: stats.new_available = new cards in the queue", sr.body.new_available, queueNew);

    // Status page: by workspace day.
    const today = localDayId(new Date(m.now));
    const dayOf = (n: NoteM & { state: ReviewState }) => localDayId(new Date(dueAt(n)));
    const scheduled = m.notes.map((n, i) => ({ n, i })).filter(({ n, i }) => enrolled(n, i) && !n.hold?.suspended && n.state) as Array<{ n: NoteM & { state: ReviewState }; i: number }>;
    const byDay = scheduled.filter(({ n }) => dayOf(n) <= today).length;
    this.eq("status: overdue + today = cards due by workspace day", tr.body.overdue + tr.body.today, byDay);
    const skew = byDay !== queueDue;
    if (!skew || this.known.has("status-day")) this.eq("numbers-agree: status (by day) = queue (by instant)", tr.body.overdue + tr.body.today, queueDue);
    this.eq("numbers-agree: status.new_available = new cards in the queue", tr.body.new_available, queueNew);
    this.eq("status: nothing rolled over (no cap set)", tr.body.rolled_over, 0);
    this.eq("status: forecast", tr.body.forecast, Array.from({ length: 7 }, (_, k) => {
      const date = addDays(today, k + 1);
      return { date, count: scheduled.filter(({ n }) => dayOf(n) === date).length };
    }));
    const stopped = m.notes.map((_, i) => i).filter(i => enrolled(m.notes[i]!, i) && m.notes[i]!.hold?.suspended);
    this.eq("stopped: status lists exactly the stopped cards", tr.body.stopped.map((c: { node_id: string }) => idx(c.node_id)).sort(), stopped);

    // Decks: every plain note with ready cards under it, counted over its subtree = what its study session gives.
    const ready = (i: number) => inQueue(m, i);
    const decks = new Map<number, number>(dr.body.decks.map((d: { node_id: string; due: number }) => [idx(d.node_id), d.due]));
    for (let d = 0; d < DECKS; d++) {
      if (!m.notes[d]!.live) { if (decks.has(d)) this.fail(`a trashed deck is listed`); continue; }
      const inside = subtree(m, d).filter(i => isCard(i) && ready(i)).length;
      this.eq(`numbers-agree: deck ${d} count (subtree)`, decks.get(d) ?? 0, inside);
      if (inside > 0) {
        const session = await this.call("GET", `/api/review/queue?root=${m.notes[d]!.id}&now=${now}`);
        this.eq(`numbers-agree: deck ${d} count = its study session`, decks.get(d) ?? 0, session.body?.total);
      }
    }
  }
}

// ── The property ─────────────────────────────────────────────────────────────

describe.skipIf(!isTestDb)("review progress of one person on two devices (random command sequences against a model)", () => {
  const stats = { runs: 0, commands: 0, skipped: 0 };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Props review', $1) RETURNING id::text`, [`props-review-${randomUUID()}`])).rows[0]!.id;
    expect((await http("GET", "/api/spaces")).status).toBe(200); // the person becomes the owner
  });
  afterAll(async () => { resetDayClock(); });

  async function play(parents: number[], cmds: Cmd[], known: ReadonlySet<Known>): Promise<string | null> {
    const run = new Run(known);
    resetDayClock();
    try {
      await run.setup(parents);
      for (const [at, c] of cmds.entries()) {
        if (run.skips(c)) { stats.skipped++; continue; }
        stats.commands++;
        await run.exec(c);
        if (!run.problem) await run.verifyCards();
        // The four counting routes are the dear part: every second command and after the last.
        if (!run.problem && (at % 2 === 1 || at === cmds.length - 1)) await run.verifyViews();
        if (run.problem) break;
      }
      return run.problem;
    } finally {
      resetDayClock();
      await run.cleanup();
    }
  }

  it(`random commands from two devices keep every review invariant (seed from PROPS_SEED${INCLUDE_KNOWN ? ", known defects included" : ""})`, { timeout: 3_000_000 }, async () => {
    const known = new Set<Known>(INCLUDE_KNOWN ? ALL_KNOWN : []);
    await checkAsync(
      fc.asyncProperty(parentsArb, fc.array(cmdArb, { minLength: 1, maxLength: 24 }), async (parents, cmds) => {
        stats.runs++;
        const problem = await play(parents, cmds, known);
        if (problem) throw new Error(problem);
      }),
      RUN_CAP,
    );
    process.stderr.write(`[review props] ${JSON.stringify(stats)}\n`);
  });

  // ── Named regression cases: one per defect, minimal, expected to fail until fixed ──────────
  // Each plays a fixed script through the same runner with every known trigger on; the problem it
  // reports is the invariant that breaks. `it.fails`: when the defect is fixed the case turns red,
  // delete `.fails`. Found by the random run with REVIEW_PROPS_KNOWN=1 (seed in each comment).

  /** `REVIEW_PROPS_SHOW=1` prints what each named case breaks (an it.fails hides it). */
  const clean = (problem: string | null) => {
    if (process.env.REVIEW_PROPS_SHOW) process.stderr.write(`[review props] ${expect.getState().currentTestName}\n  ${problem?.split("\n")[0] ?? "no problem (the defect is fixed?)"}\n`);
    expect(problem).toBeNull();
  };
  const grade = (dev: Dev = 0, pick = 0, rating: ReviewRating = 3): Cmd => ({ t: "grade", dev, fromQueue: false, pick, rating, again: false });
  const later = (hours: number): Cmd => ({ t: "advance", hours });
  const undo = (dev: Dev = 0, pick = 0): Cmd => ({ t: "undo", dev, pick, again: false });
  const all = new Set<Known>(ALL_KNOWN);
  const flat = [0, 0, 0, 0];

  it("FINDING second-undo: a card graded twice and undone twice (two keys) loses its schedule; the second undo should answer 409", async () => {
    const problem = await play(flat, [grade(), later(96), grade(), undo(), undo()], all);
    clean(problem);
  });
  // ── Versioned clients (seen_reps / graded_reps + graded_id): fixed sequences, plain tests ────────────────
  const fetch = (dev: Dev): Cmd => ({ t: "fetch", dev });
  const vgrade = (dev: Dev, rating: ReviewRating = 3, replay = false): Cmd => ({ t: "vgrade", dev, pick: 0, rating, again: false, replay });
  const vundo = (dev: Dev): Cmd => ({ t: "vundo", dev, again: false });

  it("scan-12 S2: the same new card graded from two devices counts once (the second is refused with 409)", async () => {
    clean(await play(flat, [fetch(0), fetch(1), vgrade(0), vgrade(1)], all));
  });
  it("scan-12 S2: a grade lost in transit and resent under a NEW key is refused, not counted twice", async () => {
    clean(await play(flat, [fetch(0), vgrade(0), vgrade(0, 3, true)], all));
  });
  it("scan-12 S1: undo, then undo again from the same device (new key) keeps the schedule of a card graded twice", async () => {
    clean(await play(flat, [fetch(0), vgrade(0), later(96), fetch(0), vgrade(0), vundo(0), vundo(0)], all));
  });
  it("scan-12 S1: undo on device A after device B graded again is refused and keeps B's grade (same reps, another grade)", async () => {
    // A grades a new card (reps 1) and undoes it (new card). B, which saw the new card, grades it: reps 1 again.
    // A's undo sent again under a new key names reps 1 too, but not B's grade: it must be refused.
    clean(await play(flat, [fetch(0), fetch(1), vgrade(0), vundo(0), vgrade(1), vundo(0)], all));
  });
  it("scan-12 S1: the same, on a card that already had a schedule (undo returns to the earlier schedule, not to new)", async () => {
    clean(await play(flat, [grade(), later(96), fetch(0), fetch(1), vgrade(0), vundo(0), vgrade(1), vundo(0)], all));
  });
  it("scan-12 S1: an older client's second undo (no versions, new key) answers 409 and keeps the schedule", async () => {
    clean(await play(flat, [grade(), later(96), grade(), undo(0), undo(1)], all));
  });

  it.fails("FINDING double-grade: the same due card graded from two devices counts twice (reps 2 after one study round)", async () => {
    const problem = await play(flat, [{ t: "fetch", dev: 0 }, { t: "fetch", dev: 1 }, { t: "grade", dev: 0, fromQueue: true, pick: 0, rating: 3, again: false }, { t: "grade", dev: 1, fromQueue: true, pick: 0, rating: 3, again: false }], all);
    clean(problem);
  });
  it.fails("FINDING tomorrow-stop: 'tomorrow' sent by a stale device un-stops a card stopped on the other device", async () => {
    const problem = await play(flat, [{ t: "hold", kind: "suspend", dev: 0, pick: 0, again: false }, { t: "hold", kind: "tomorrow", dev: 1, pick: 0, again: false }], all);
    clean(problem);
  });
  it.fails("FINDING status-day: a card due this afternoon is counted by the status page but not by the queue", async () => {
    // Graded 02:00 UTC, due 4 days later at 02:00 UTC; at 01:00 UTC that day it is the same day but not yet due.
    const problem = await play(flat, [grade(), later(4 * 24 - 1)], all);
    clean(problem);
  });
  // The daily new-card budget (new_per_day) no longer exists: the person's one cap (reviewsPerDay) counts due and new cards
  // together everywhere, so the home line, the queue and the status page agree. Kept as a plain test, not a finding.
  it("the daily cap (reviewsPerDay) limits the home count, the queue and the status page alike", async () => {
    const run = new Run(all);
    try {
      await run.setup(flat);
      expect((await http("PUT", "/api/me/prefs/reviewsPerDay", { value: 1 })).status).toBe(200);
      const now = encodeURIComponent(run.nowIso());
      const queue = (await http("GET", `/api/review/queue?now=${now}`)).body;
      const stats = (await http("GET", `/api/review/stats?now=${now}`)).body;
      const status = (await http("GET", `/api/review/status?now=${now}`)).body;
      expect(queue.total).toBe(1);
      expect(stats.due).toBe(1);
      expect(stats.new_available).toBe(1);
      expect(status.new_available).toBe(1);
    } finally {
      await http("PUT", "/api/me/prefs/reviewsPerDay", { value: null });
      await run.cleanup();
    }
  });
  it.fails("FINDING deck-subtree: a deck counts only its direct children, its study session covers the subtree", async () => {
    // Card 2 (note index) moves under card 3, which sits in deck 0: the session for deck 0 offers both.
    const problem = await play([0, 0, 0, 0], [{ t: "move", pick: 3, to: 4 }], all);
    clean(problem);
  });
});
