// 「還原到某時間點」再「撤回這次還原」(#799), through the real routes, against a model.
//
// A generated history runs in three stages on a fresh space:
//   A  (before T)  create (also under a live note), edit, delete (a note with its live
//                  subtree), undelete — every event is moved to before T, in order;
//   B  (after T)   the same kinds of operations, at "now";
// then POST /api/history/rewind to T with the three groups GET /at names, then
//   C  (after the rewind) a few more edits, then POST /rewinds/:id/undo for every note.
//
// Invariants:
//  R1  after the rewind, every note that was alive at T is alive with T's text;
//  R2  every note created after T is in 最近刪除 and readable there (GET /deleted/:id);
//  R3  a note that was in the trash at T is left as the rewind found it;
//  R4  the event log only grows: every event row that existed before the rewind (and
//      before the undo) is still there, unchanged;
//  R5  nothing is hard-deleted: every note ever created is still a row;
//  U1  with no edit after the rewind, the undo puts every note back exactly as before the
//      rewind (text and whether it is in the trash);
//  U2  with edits after the rewind, a word written after the rewind is never lost: it is
//      in the note afterwards, or in a BODY_CONFLICT event of that note (the inbox).
// (Edits after the rewind replace a note's first paragraph at most once, as the note's first
// edit, so no later word is overwritten by another later word.)
// A model check first: the model's text and trash flags equal the database's after stages
// A and B, so a model slip is told from a product bug.
//
// Run count: PROPS_RUNS (default 10: a run is ~40 writes), seed PROPS_SEED.
//   PROPS_SEED=… PROPS_RUNS=200 npx vitest run src/test/properties/historyRewindUndo.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALIGN_VERSION_TIMES_SQL } from "../helpers/alignVersionTimes.js";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../../httpError.js";
import { pool, q } from "../../db.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import historyRouter from "../../routes/history.js";
import { createNote } from "../../services/noteCreate.js";
import { trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { updateNode } from "../../services/nodeUpdate.js";
import type { ActorCtx } from "../../types.js";
import { agentWorld } from "../helpers/agentSessionFixture.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = isTestDatabase();
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 10;
const MINUTE = 60_000;

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/history", historyRouter);
  return app;
}
const call = async (actor: ActorCtx, path: string, json?: unknown) => {
  const r = await appFor(actor).request(`/api/history${path}`, json === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

afterAll(async () => { await awaitAllDispatchers(); await pool.end(); });

// ── Model ────────────────────────────────────────────────────────────────────

type Op =
  | { k: "create"; under: number | null; seed: string }
  | { k: "edit"; n: number; how: "append" | "replaceFirst" | "reset" }
  | { k: "delete"; n: number }
  | { k: "undelete"; n: number };
type NoteM = { id: string; text: string; parent: number | null; deleted: boolean; deletedRoot: number | null; stage: "A" | "B" };

const word = fc.stringMatching(/^[a-z]{3,6}$/);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("create" as const), under: fc.option(fc.nat(30), { nil: null }), seed: word }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("edit" as const), n: fc.nat(30), how: fc.constantFrom("append" as const, "replaceFirst" as const, "reset" as const) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("delete" as const), n: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("undelete" as const), n: fc.nat(30) }) },
);

const applyEdit = (text: string, how: "append" | "replaceFirst" | "reset", tok: string): string => {
  if (how === "reset") return `${tok}\n`;
  if (how === "append") return `${text.trimEnd()}\n\n${tok}\n`;
  const [, ...rest] = text.trimEnd().split("\n\n");
  return `${[tok, ...rest].join("\n\n")}\n`;
};

describe.skipIf(!isTestDb)("history rewind → undo (property)", () => {
  let w: Awaited<ReturnType<typeof agentWorld>>;
  beforeAll(async () => {
    w = await agentWorld("rwp", { ownWorkspace: { modules: [] } });
    WS = w.ws;
  });

  const row = async (id: string) => (await q<{ markdown: string; deleted_at: Date | null }>(
    `SELECT markdown, deleted_at FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
  const maxEventId = async () => Number((await q<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.m);
  /** domain_events is append-only; the test owns the clock, so it moves its own new events into the past. */
  async function moveEventsTo(afterId: number, at: Date) {
    await awaitAllDispatchers();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE domain_events SET created_at = $3 WHERE workspace_id = $1 AND id > $2`, [WS, afterId, at]);
      await client.query(ALIGN_VERSION_TIMES_SQL);
      await client.query("COMMIT");
    } finally { client.release(); }
  }
  const allEvents = async () => (await q<{ id: string; j: string }>(
    `SELECT id::text, to_jsonb(domain_events)::text AS j FROM domain_events WHERE workspace_id = $1 ORDER BY domain_events.id`, [WS])).rows;

  // Shrunk by the random run: note P exists at T. After T: create C under P, delete P (C goes with it).
  // Rewind to T undeletes P, and undeleteNode brings P's whole deleted subtree back, C included — a note
  // that did not exist at T. C must stay in 最近刪除 (rewind_kind delete, after P's undelete), and the undo
  // must put both back as they were before the rewind: P deleted, C deleted, never C undeleted under a deleted P.
  it("rewind leaves a note created after T in 最近刪除 when it was deleted with an older parent, and the undo puts both back", async () => {
    const space = await makeSpace(w.ws, `rwp finding ${Math.random()}`, [{ id: w.owner.id, permission: "edit" }]);
    const T = new Date(Date.now() - 60 * MINUTE);
    const parent = await w.note("older parent\n", space);
    await awaitAllDispatchers();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE domain_events SET created_at = $2 WHERE target_id = $1`, [parent, new Date(T.getTime() - 5 * MINUTE)]);
      await client.query(ALIGN_VERSION_TIMES_SQL);
      await client.query("COMMIT");
    } finally { client.release(); }
    const child = (await createNote({ actor: w.owner, workspaceId: w.ws, title: "child", markdown: "born later\n", spaceId: space, parentId: parent, event: { uiContext: "test" } })).node.id as string;
    await trashNode(w.owner, w.ws, parent);
    const at = (await call(w.owner, `/at?t=${encodeURIComponent(T.toISOString())}&space=${space}`)).body;
    const group = (status: string) => at.notes.filter((x: any) => x.status === status).map((x: any) => x.id);
    const done = await call(w.owner, "/rewind", { t: T.toISOString(), space, restore_ids: group("changed"), undelete_ids: group("deleted_since"), delete_ids: group("created_since") });
    expect(done.status).toBe(200);
    expect(done.body.undeleted).toEqual([parent]);
    expect(done.body.deleted).toEqual([child]);
    expect((await row(parent)).deleted_at).toBeNull();
    expect((await row(child)).deleted_at).not.toBeNull();
    expect((await call(w.owner, `/deleted/${child}`)).status).toBe(200);
    const stillThere = await q(`SELECT 1 FROM content_nodes WHERE id = ANY($1::uuid[])`, [[parent, child]]);
    expect(stillThere.rows.length).toBe(2);

    const undo = await call(w.owner, `/rewinds/${done.body.rewind_id}/undo`, { node_ids: [parent, child] });
    expect(undo.status).toBe(200);
    expect(undo.body.undone.sort()).toEqual([parent, child].sort());
    expect((await row(parent)).deleted_at).not.toBeNull();
    expect((await row(child)).deleted_at).not.toBeNull();
    // The child was undeleted while its parent was live: its undo step comes after the parent's undelete step.
    const steps = (await q<{ id: string; target_id: string; event_type: string }>(
      `SELECT id::text, target_id, event_type FROM domain_events WHERE workspace_id = $1 AND (tx_meta ? 'undoes_rewind') AND target_id = ANY($2::text[]) ORDER BY domain_events.id`,
      [WS, [parent, child]])).rows;
    expect(steps.slice(0, 2).map((e) => `${e.event_type}:${e.target_id === parent ? "P" : "C"}`)).toEqual(["NODE_UNDELETED:C", "NODE_DELETED:P"]);
  });

  it("rewind to T, then undo: R1–R5, U1, U2", async () => {
    let counter = 0;
    await checkAsync(fc.asyncProperty(
      fc.array(opArb, { minLength: 1, maxLength: 8 }),
      fc.array(opArb, { maxLength: 6 }),
      fc.array(fc.nat(30), { maxLength: 3 }),
      async (stageA, stageB, laterEdits) => {
        const space = await makeSpace(w.ws, `rwp ${Math.random()}`, [{ id: w.owner.id, permission: "edit" }]);
        const T = new Date(Date.now() - 60 * MINUTE);
        const notes: NoteM[] = [];
        const trace: string[] = [];
        const run = async (ops: Op[], stage: "A" | "B") => {
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]!;
            const since = await maxEventId();
            const target = op.k === "create" ? null : notes.length ? op.n % notes.length : -1;
            const t = target === null || target < 0 ? null : notes[target]!;
            try {
              if (op.k === "create") {
                const liveIdx = notes.flatMap((m, idx) => (!m.deleted ? [idx] : []));
                const under = op.under !== null && liveIdx.length ? liveIdx[op.under % liveIdx.length]! : null;
                const text = `${op.seed}${++counter}\n`;
                const id = (await createNote({
                  actor: w.owner, workspaceId: w.ws, title: `rwp ${counter}`, markdown: text, spaceId: space,
                  parentId: under === null ? null : notes[under]!.id, event: { uiContext: "test" },
                })).node.id as string;
                notes.push({ id, text, parent: under, deleted: false, deletedRoot: null, stage });
                trace.push(`${stage}: create #${notes.length - 1}${under === null ? "" : ` under #${under}`}`);
              } else if (op.k === "edit" && t && !t.deleted) {
                const text = applyEdit(t.text, op.how, `e${++counter}`);
                await updateNode(w.ws, t.id, { markdown: text }, { actor: w.owner });
                t.text = text;
                trace.push(`${stage}: edit #${target} (${op.how})`);
              } else if (op.k === "delete" && t && !t.deleted) {
                await trashNode(w.owner, w.ws, t.id);
                const walk = (idx: number) => notes.forEach((m, j) => { if (m.parent === idx && !m.deleted) { m.deleted = true; m.deletedRoot = target; walk(j); } });
                t.deleted = true; t.deletedRoot = target;
                walk(target!);
                trace.push(`${stage}: delete #${target}`);
              } else if (op.k === "undelete" && t && t.deleted && t.deletedRoot === target && (t.parent === null || !notes[t.parent]!.deleted)) {
                await undeleteNode(w.owner, w.ws, t.id);
                for (const m of notes) if (m.deletedRoot === target) { m.deleted = false; m.deletedRoot = null; }
                trace.push(`${stage}: undelete #${target}`);
              }
            } finally {
              if (stage === "A") await moveEventsTo(since, new Date(T.getTime() - (ops.length - i + 1) * MINUTE));
            }
          }
        };
        const fail = (msg: string) => `${msg}\nsteps:\n${trace.join("\n")}`;
        const dbState = async () => Object.fromEntries(await Promise.all(notes.map(async (m, i) => {
          const r = await row(m.id);
          return [i, { text: r.markdown, deleted: r.deleted_at !== null }];
        })));
        const modelState = () => Object.fromEntries(notes.map((m, i) => [i, { text: m.text, deleted: m.deleted }]));

        await run(stageA, "A");
        const atT = notes.map((m) => ({ text: m.text, deleted: m.deleted }));
        expect(await dbState(), fail("model vs database after stage A")).toEqual(modelState());
        const countA = notes.length;
        await run(stageB, "B");
        expect(await dbState(), fail("model vs database after stage B")).toEqual(modelState());

        // Rewind to T with the groups History shows.
        const before = await dbState();
        const eventsBefore = await allEvents();
        const at = (await call(w.owner, `/at?t=${encodeURIComponent(T.toISOString())}&space=${space}`)).body;
        const group = (status: string) => at.notes.filter((x: any) => x.status === status).map((x: any) => x.id);
        const done = await call(w.owner, "/rewind", {
          t: T.toISOString(), space, restore_ids: group("changed"), undelete_ids: group("deleted_since"), delete_ids: group("created_since"),
        });
        expect(done.status, fail(`rewind answered ${JSON.stringify(done.body)}`)).toBe(200);
        await awaitAllDispatchers();

        const after = await dbState();
        for (let i = 0; i < notes.length; i++) {
          if (i < countA && !atT[i]!.deleted) {
            expect(after[i], fail(`R1 note #${i} alive at T`)).toEqual({ text: atT[i]!.text, deleted: false });
          } else if (i < countA) {
            expect(after[i], fail(`R3 note #${i} was in the trash at T`)).toEqual(before[i]);
          } else {
            expect(after[i]!.deleted, fail(`R2 note #${i} created after T`)).toBe(true);
            expect((await call(w.owner, `/deleted/${notes[i]!.id}`)).status, fail(`R2 note #${i} readable in 最近刪除`)).toBe(200);
          }
        }
        const eventsAfter = new Map((await allEvents()).map((e) => [e.id, e.j]));
        for (const e of eventsBefore) expect(eventsAfter.get(e.id), fail(`R4 event ${e.id}`)).toBe(e.j);
        const stillThere = await q(`SELECT 1 FROM content_nodes WHERE id = ANY($1::uuid[])`, [notes.map((m) => m.id)]);
        expect(stillThere.rows.length, fail("R5 a note row is gone")).toBe(notes.length);

        // Stage C: edits after the rewind, then undo.
        const written: Array<{ idx: number; tok: string }> = [];
        for (const pick of laterEdits) {
          if (!notes.length) break;
          const idx = pick % notes.length;
          if ((await row(notes[idx]!.id)).deleted_at) continue;
          const tok = `later${++counter}`;
          const cur = (await row(notes[idx]!.id)).markdown;
          await updateNode(w.ws, notes[idx]!.id, { markdown: pick % 2 || written.some((x) => x.idx === idx) ? applyEdit(cur, "append", tok) : applyEdit(cur, "replaceFirst", tok) }, { actor: w.owner });
          written.push({ idx, tok });
        }
        const preUndo = await allEvents();
        if (done.body.rewind_id) {
          const undo = await call(w.owner, `/rewinds/${done.body.rewind_id}/undo`, { node_ids: notes.map((m) => m.id) });
          expect(undo.status, fail(`undo answered ${JSON.stringify(undo.body)}`)).toBe(200);
          trace.push(`rewind: ${JSON.stringify(done.body)}`, `undo: ${JSON.stringify(undo.body)}`, `ids: ${JSON.stringify(notes.map((m) => m.id))}`);
        }
        await awaitAllDispatchers();
        const afterUndo = new Map((await allEvents()).map((e) => [e.id, e.j]));
        for (const e of preUndo) expect(afterUndo.get(e.id), fail(`R4 (undo) event ${e.id}`)).toBe(e.j);

        const back = await dbState();
        if (written.length === 0) {
          expect(back, fail("U1 undo without later edits")).toEqual(before);
        } else {
          for (const { idx, tok } of written) {
            const now = await row(notes[idx]!.id);
            const conflicts = (await q<{ p: string }>(
              `SELECT payload::text AS p FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'BODY_CONFLICT'`, [WS, notes[idx]!.id])).rows;
            expect(now.markdown.includes(tok) || conflicts.some((c) => c.p.includes(tok)), fail(`U2 "${tok}" written to #${idx} after the rewind is lost`)).toBe(true);
          }
        }
      },
    ), RUN_CAP);
  }, 600_000);
});
