// 「最近刪除」 is paged, not cut by age (scan 15, M6): GET /api/history/deleted?days=D is the first page
// and `older_cursor` leads to every older note, page by page, until it is null.
//
// A generated set of notes in two spaces is deleted at random times (many days old, some at the same
// millisecond, some under a millisecond apart), then read through the real route by the owner (both
// spaces) and by a member of space A only, with a random first-page window D and page size L.
//
// Invariants, for each reader:
//  D1  every deleted note the reader can read appears exactly once across the first page and the older pages;
//  D2  the whole list is newest first (deletion time to the millisecond, then id) — the order a client shows;
//  D3  the first page is exactly the notes deleted within the last D days; an older page has at most L notes,
//      and has exactly L when it names a further page (older_cursor not null);
//  D4  the cursor ends: following it takes no more than (notes / L) + 2 requests;
//  D5  a note of space B never reaches the member of space A, on any page.
// Each also has a fixed minimal counterexample below.
//
//   PROPS_SEED=123 PROPS_RUNS=50 npx vitest run src/test/properties/historyDeletedPaging.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import historyRouter from "../../routes/history.js";
import { trashNode } from "../../services/nodeTrash.js";
import type { ActorCtx } from "../../types.js";
import { agentWorld } from "../helpers/agentSessionFixture.js";
import { persistActor } from "../helpers/persistActor.js";
import { seedQ } from "../helpers/seedQ.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

afterAll(async () => { await pool.end(); });

type Listed = { id: string; deleted_at: string };
type Page = { notes: Listed[]; older_cursor: string | null };

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  return app;
}
const get = async (actor: ActorCtx, query: string): Promise<Page> => {
  const r = await appFor(actor).request(`/api/history/deleted?${query}`);
  if (r.status !== 200) throw new Error(`GET deleted?${query} answered ${r.status}`);
  return (await r.json()) as Page;
};

/** A note deleted `ageMinutes` ago (plus `micros` microseconds, to put several inside one millisecond). */
type Spec = { space: "A" | "B"; ageMinutes: number; micros: number };

describe.skipIf(!isTestDb)("history deleted list: paged by cursor, nothing cut by age (model based)", () => {
  let w: Awaited<ReturnType<typeof agentWorld>>;
  let member: ActorCtx;
  let spaceA = "";
  let spaceB = "";
  let seq = 0;

  beforeAll(async () => {
    w = await agentWorld("delpage", { ownWorkspace: { modules: [] } });
    WS = w.ws;
    member = await persistActor(WS, { id: "", name: `Member ${w.stamp}`, role: "editor", type: "human" });
    spaceA = await makeSpace(WS, `A ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: member.id, role: "editor" }]);
    spaceB = await makeSpace(WS, `B ${w.stamp}`, [{ id: w.owner.id, role: "manager" }]);
  });

  /** Creates and deletes the notes of `specs`; returns their ids in spec order. */
  async function deleteAt(specs: Spec[]): Promise<string[]> {
    const ids: string[] = [];
    for (const spec of specs) {
      const id = await w.note(`n${++seq}\n`, spec.space === "A" ? spaceA : spaceB);
      await trashNode(w.owner, WS, id);
      // A fixture sets the time: the same millisecond for equal ages, `micros` apart inside it.
      await seedQ(
        `UPDATE content_nodes SET deleted_at = date_trunc('minute', now()) - $2::int * interval '1 minute' + $3::int * interval '1 microsecond' WHERE id = $1`,
        [id, spec.ageMinutes, spec.micros],
      );
      ids.push(id);
    }
    return ids;
  }

  /** Every deleted note of the workspace the reader can read, newest first by the list's own order, from the database. */
  async function expected(reader: ActorCtx): Promise<Array<{ id: string; ms: string; withinDays: (d: number) => boolean }>> {
    const rows = (await q<{ id: string; ms: string; age_days: number }>(
      `SELECT n.id::text AS id, to_char(date_trunc('milliseconds', n.deleted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ms,
              EXTRACT(EPOCH FROM (now() - n.deleted_at)) / 86400.0 AS age_days
         FROM content_nodes n
        WHERE n.workspace_id = $1 AND n.deleted_at IS NOT NULL AND n.hidden = false
          AND n.space_id::text = ANY($2::text[])
        ORDER BY date_trunc('milliseconds', n.deleted_at) DESC, n.id`,
      [WS, reader.id === member.id ? [spaceA] : [spaceA, spaceB]])).rows;
    return rows.map((r) => ({ id: r.id, ms: r.ms, withinDays: (d: number) => r.age_days < d }));
  }

  /** Reads the whole list as a client does and checks D1–D5. */
  async function checkReader(reader: ActorCtx, days: number, limit: number, label: string): Promise<void> {
    const want = await expected(reader);
    const fail = (m: string): never => { throw new Error(`${label}: ${m} (days ${days}, limit ${limit})`); };
    const first = await get(reader, `days=${days}`);
    const inWindow = want.filter((n) => n.withinDays(days)).map((n) => n.id);
    if (JSON.stringify(first.notes.map((n) => n.id)) !== JSON.stringify(inWindow)) fail(`first page is not exactly the last ${days} days (D3)`);
    const all: Listed[] = [...first.notes];
    let cursor = first.older_cursor;
    let requests = 0;
    while (cursor !== null) {
      if (++requests > want.length / limit + 2) fail("the cursor does not end (D4)");
      const page = await get(reader, `before=${encodeURIComponent(cursor)}&limit=${limit}`);
      if (page.notes.length > limit) fail("an older page is longer than the limit (D3)");
      if (page.older_cursor !== null && page.notes.length !== limit) fail("a page names a further page but is not full (D3)");
      if (page.notes.length === 0) fail("an older page is empty");
      all.push(...page.notes);
      cursor = page.older_cursor;
    }
    const ids = all.map((n) => n.id);
    if (new Set(ids).size !== ids.length) fail("a note appears twice (D1)");
    if (JSON.stringify([...ids].sort()) !== JSON.stringify(want.map((n) => n.id).sort())) fail("the pages are not every readable deleted note (D1/D5)");
    if (JSON.stringify(ids) !== JSON.stringify(want.map((n) => n.id))) fail("the list is not newest first (D2)");
    if (first.older_cursor === null && all.length !== first.notes.length) fail("no cursor, yet notes are missing");
  }

  const specArb: fc.Arbitrary<Spec> = fc.record({
    space: fc.constantFrom("A" as const, "B" as const),
    // few distinct times, so equal times are common; the 37 keeps every age off a whole-day boundary
    ageMinutes: fc.constantFrom(5, 60, 1440 * 5 + 37, 1440 * 29 + 37, 1440 * 31 + 37, 1440 * 31 + 37, 1440 * 90 + 37, 1440 * 400 + 37),
    micros: fc.constantFrom(0, 0, 1, 2, 900, 1500),
  });

  it("random deletions × window × page size × readers: D1–D5", async () => {
    await checkAsync(fc.asyncProperty(
      fc.array(specArb, { minLength: 1, maxLength: 9 }), fc.integer({ min: 1, max: 365 }), fc.integer({ min: 1, max: 5 }),
      async (specs, days, limit) => {
        await deleteAt(specs);
        await checkReader(w.owner, days, limit, "owner");
        await checkReader(member, days, limit, "member of A");
      },
    ), 20);
  }, 600_000);

  // ── fixed minimal counterexamples ────────────────────────────────────────
  it("M6: a note deleted 40 days ago is out of the 30-day first page but reachable by the cursor", async () => {
    const [id] = await deleteAt([{ space: "A", ageMinutes: 1440 * 40 + 37, micros: 0 }]);
    const first = await get(w.owner, "days=30");
    expect(first.notes.map((n) => n.id)).not.toContain(id);
    expect(first.older_cursor).not.toBeNull();
    const seen: string[] = [];
    for (let cursor = first.older_cursor, n = 0; cursor !== null && n < 100; n++) {
      const page = await get(w.owner, `before=${encodeURIComponent(cursor)}&limit=50`);
      seen.push(...page.notes.map((x) => x.id));
      cursor = page.older_cursor;
    }
    expect(seen).toContain(id);
  }, 60_000);
  it("notes in one millisecond are split across pages without a gap or a repeat", async () => {
    await deleteAt([0, 1, 2, 3].map((micros) => ({ space: "A" as const, ageMinutes: 1440 * 60 + 37, micros })));
    await checkReader(w.owner, 30, 1, "owner");
  }, 60_000);
  it("nothing in the window: the first page is empty and the cursor still leads to the older notes", async () => {
    // Other tests' notes may be recent too; the invariants are the same with a 1-day window.
    await deleteAt([{ space: "A", ageMinutes: 1440 * 100 + 37, micros: 0 }]);
    await checkReader(w.owner, 1, 2, "owner");
  }, 60_000);
  it("a reader of space A never gets a note of space B, on any page", async () => {
    await deleteAt([{ space: "B", ageMinutes: 1440 * 60 + 37, micros: 0 }, { space: "A", ageMinutes: 1440 * 61 + 37, micros: 0 }]);
    await checkReader(member, 30, 1, "member of A");
  }, 60_000);
  it("a malformed cursor or limit is a 400, not a list", async () => {
    for (const query of ["before=nope", "before=2026-01-01T00:00:00.000Z|not-a-uuid", `before=2026-01-01T00:00:00.000Z|${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}&limit=0`]) {
      expect((await appFor(w.owner).request(`/api/history/deleted?${query}`)).status, query).toBe(400);
    }
  }, 60_000);
});
