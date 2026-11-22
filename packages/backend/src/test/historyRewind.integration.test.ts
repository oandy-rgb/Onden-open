// History rewind (routes/history.ts → services/history/pointInTime.ts, rewind.ts):
// the notes as they were at T, putting them back, and taking that back.
// Real routes and actors; events are moved into the past so a test owns the clock.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { Hono } from "hono";
import fc from "fast-check";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import historyRouter from "../routes/history.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

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

// Trashing and restoring queue derived-state work; let it finish before the pool closes.
afterAll(async () => { await awaitAllDispatchers(); await pool.end(); });

type World = Awaited<ReturnType<typeof agentWorld>>;
const edit = (w: World, id: string, markdown: string, who: ActorCtx = w.owner) => updateNode(w.ws, id, { markdown }, { actor: who });
const HOUR = 3_600_000;
const T = new Date(Date.now() - HOUR); // every "before" event is moved to before T; everything else stays at now

/** Move every event of `ids` that is not yet in the past to `minutesBeforeT` before T. */
async function inThePast(ids: string[], minutesBeforeT: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica"); // domain_events is append-only
    await client.query(`UPDATE domain_events SET created_at = $2 WHERE target_id = ANY($1::text[]) AND created_at > $3`,
      [ids, new Date(T.getTime() - minutesBeforeT * 60_000), T]);
    await client.query(ALIGN_VERSION_TIMES_SQL);
    await client.query("COMMIT");
  } finally { client.release(); }
}
const rewindBody = (over: Record<string, unknown> = {}) => ({ t: T.toISOString(), restore_ids: [], undelete_ids: [], delete_ids: [], ...over });
const live = async (id: string) => (await q<{ markdown: string; title: string; deleted_at: Date | null }>(
  `SELECT markdown, title, deleted_at FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
const eventCount = async (ids: string[]) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE target_id = ANY($1::text[])`, [ids])).rows[0]!.n);

describe.skipIf(!isTestDb)("History rewind", () => {
  let w: World;
  beforeAll(async () => {
    w = await agentWorld("rw", { ownWorkspace: { modules: [] } });
    WS = w.ws;
  });

  /** changed / same / deleted_since / created_since, each one note. */
  async function scene(inSpace?: string) {
    const space = inSpace ?? await makeSpace(w.ws, `scene ${Math.random()}`, [{ id: w.owner.id, permission: "edit" }]);
    const changed = await w.note("a1\n\nb1\n", space);
    await edit(w, changed, "a2\n\nb1\n");
    await inThePast([changed], 5);
    await edit(w, changed, "a3\n\nb1\n\nnew line\n");
    const same = await w.note("same\n", space);
    await inThePast([same], 5);
    const gone = await w.note("gone body\n", space);
    await inThePast([gone], 5);
    await trashNode(w.owner, w.ws, gone);
    const born = await w.note("born later\n", space);
    return { changed, same, gone, born, space };
  }

  it("at: tells the four statuses apart, counts them, and shows each note then and now", async () => {
    const s = await scene();
    const { status, body } = await call(w.owner, `/at?t=${encodeURIComponent(T.toISOString())}&space=${s.space}`);
    expect(status).toBe(200);
    const byId = new Map<string, any>(body.notes.map((n: any) => [n.id, n]));
    expect(byId.get(s.changed)).toMatchObject({ status: "changed", change: { changed: 1, added: 1, removed: 0 } });
    expect(byId.get(s.gone)).toMatchObject({ status: "deleted_since" });
    expect(byId.get(s.born)).toMatchObject({ status: "created_since" });
    expect(byId.has(s.same)).toBe(false); // the same ones are counted, not listed
    expect(body.counts).toMatchObject({ same: 1, changed: 1, deleted_since: 1, created_since: 1, total: 4 });

    const one = (await call(w.owner, `/at/${s.changed}?t=${encodeURIComponent(T.toISOString())}`)).body;
    expect(one).toMatchObject({ status: "changed", markdown_then: "a2\n\nb1\n", markdown_now: "a3\n\nb1\n\nnew line\n" });
    const deleted = (await call(w.owner, `/at/${s.gone}?t=${encodeURIComponent(T.toISOString())}`)).body;
    expect(deleted).toMatchObject({ status: "deleted_since", markdown_then: "gone body\n", deleted: true });
    expect((await call(w.owner, `/at/${s.born}?t=${encodeURIComponent(T.toISOString())}`)).body).toMatchObject({ status: "created_since", markdown_then: null });
  });

  it("at: leaves out notes the reader cannot read, and validates its parameters", async () => {
    const stranger = await persistActor(w.ws, { id: "", name: `Stranger ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [stranger.id]);
    const secret = await w.note("secret\n");
    await edit(w, secret, "secret 2\n");
    const q_ = `/at?t=${encodeURIComponent(T.toISOString())}`;
    expect((await call(w.owner, q_)).body.notes.map((n: any) => n.id)).toContain(secret);
    expect((await call(stranger, q_)).body.notes.map((n: any) => n.id)).not.toContain(secret);
    expect((await call(stranger, `/at/${secret}?t=${encodeURIComponent(T.toISOString())}`)).status).toBe(404);
    expect((await call(w.owner, "/at?t=yesterday")).status).toBe(400);
    expect((await call(w.owner, "/at")).status).toBe(400);
    expect((await call(w.owner, `${q_}&space=nope`)).status).toBe(400);
    expect((await call(w.owner, "/rewind", rewindBody({ t: "nope" }))).status).toBe(400);
  });

  it("rewind: puts back T's text as a new version, keeps every old event, soft-deletes later notes and brings back deleted ones", async () => {
    const s = await scene();
    const before = await eventCount([s.changed, s.gone, s.born]);
    const { status, body } = await call(w.owner, "/rewind", rewindBody({
      space: s.space, restore_ids: [s.changed], undelete_ids: [s.gone], delete_ids: [s.born],
    }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ restored: [s.changed], undeleted: [s.gone], deleted: [s.born], stale: [], unwritable: [], skipped: [] });
    expect(body.rewind_id).toEqual(expect.any(String));

    expect((await live(s.changed)).markdown).toBe("a2\n\nb1\n");
    const gone = await live(s.gone);
    expect(gone.deleted_at).toBeNull();
    expect(gone.markdown).toBe("gone body\n");
    // soft delete: the row and its text are still there, in 最近刪除
    const born = await live(s.born);
    expect(born.deleted_at).not.toBeNull();
    expect(born.markdown).toBe("born later\n");
    expect((await call(w.owner, `/deleted/${s.born}`)).status).toBe(200);

    expect(await eventCount([s.changed, s.gone, s.born])).toBeGreaterThan(before); // only added to
    const tagged = await q<{ event_type: string; tx_meta: Record<string, string> }>(
      `SELECT event_type, tx_meta FROM domain_events WHERE tx_meta->>'rewind_id' = $1 ORDER BY id`, [body.rewind_id]);
    // the brought-back note already had T's text, so only its undelete is recorded
    expect(tagged.rows.map((r) => r.tx_meta.rewind_kind).sort()).toEqual(["delete", "restore", "undelete"]);
    // the version list gained a version; the rewound note can be rewound again to the same answer (no new writes)
    const again = await call(w.owner, "/rewind", rewindBody({ space: s.space, restore_ids: [s.changed] }));
    expect(again.body).toMatchObject({ rewind_id: null, restored: [], stale: [s.changed] });
  });

  it("rewind: skips what is not in the asked group, what the caller may not write, and reports the counts", async () => {
    const s = await scene();
    const viewer = await persistActor(w.ws, { id: "", name: `Viewer ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid AND space_id <> (SELECT id FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal')`, [viewer.id]);
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'view')`, [s.space, viewer.id]);
    const denied = await call(viewer, "/rewind", rewindBody({ space: s.space, restore_ids: [s.changed], undelete_ids: [s.gone], delete_ids: [s.born] }));
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ rewind_id: null, restored: [], undeleted: [], deleted: [] });
    expect(denied.body.unwritable.sort()).toEqual([s.changed, s.gone, s.born].sort());
    expect((await live(s.changed)).markdown).toBe("a3\n\nb1\n\nnew line\n"); // nothing happened

    // an id in the wrong group (a forged list) is stale, never acted on
    const forged = await call(w.owner, "/rewind", rewindBody({ space: s.space, restore_ids: [s.same, s.born], delete_ids: [s.changed] }));
    expect(forged.body.stale.sort()).toEqual([s.same, s.born, s.changed].sort());
    expect(forged.body.rewind_id).toBeNull();
    expect((await live(s.born)).deleted_at).toBeNull();
    expect((await live(s.changed)).markdown).toBe("a3\n\nb1\n\nnew line\n");
  });

  it("rewind: more than 2000 notes is refused with a plain code, and nothing is written", async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const r = await call(w.owner, "/rewind", rewindBody({ restore_ids: ids }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("rewind_too_many");
  });

  it("rewind: with a space only that space's notes are touched", async () => {
    const other = await makeSpace(w.ws, "Other", [{ id: w.owner.id, permission: "edit" }]);
    const a = await scene();
    const b = await scene(other);
    const r = await call(w.owner, "/rewind", rewindBody({
      space: a.space, restore_ids: [a.changed, b.changed], delete_ids: [a.born, b.born],
    }));
    expect(r.body.restored).toEqual([a.changed]);
    expect(r.body.deleted).toEqual([a.born]);
    expect(r.body.stale.sort()).toEqual([b.changed, b.born].sort()); // not in this space = not in the group
    expect((await live(b.changed)).markdown).toBe("a3\n\nb1\n\nnew line\n");
    expect((await live(b.born)).deleted_at).toBeNull();
  });

  it("rewind: a later note with an older note under it is left alone; one with only later notes under it goes with them", async () => {
    const parent = await w.note("older parent\n");
    await inThePast([parent], 5);
    const keeper = await w.note("older child\n");
    await inThePast([keeper], 5);
    const newParent = await w.note("new parent\n");
    await updateNode(w.ws, keeper, { parent_id: newParent }, { actor: w.owner });
    const loneParent = await w.note("lone parent\n");
    const kid = await w.note("kid\n");
    await updateNode(w.ws, kid, { parent_id: loneParent }, { actor: w.owner });

    const r = await call(w.owner, "/rewind", rewindBody({ space: w.space, delete_ids: [newParent, loneParent, kid] }));
    expect(r.body.skipped).toEqual([newParent]);
    expect((await live(newParent)).deleted_at).toBeNull();
    expect((await live(keeper)).deleted_at).toBeNull();
    expect(r.body.deleted.sort()).toEqual([loneParent, kid].sort());
    expect((await live(kid)).deleted_at).not.toBeNull();
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND parent_id = $2`, [kid, loneParent])).rows).toHaveLength(1); // not orphaned
  });

  it("rewind: a child that was in 最近刪除 at T does not come back with its parent's subtree, keeps its parent, and the undo is symmetric", async () => {
    // Shrunk counterexample of historyRewindUndo.property (seed 20261023): #1 deleted before T, undeleted
    // after T, then deleted again together with #0.
    const parent = await w.note("parent\n");
    await inThePast([parent], 20);
    const child = await w.note("child\n");
    await updateNode(w.ws, child, { parent_id: parent }, { actor: w.owner });
    await inThePast([child], 15);
    await trashNode(w.owner, w.ws, child);
    await inThePast([child], 10);
    await undeleteNode(w.owner, w.ws, child);
    await trashNode(w.owner, w.ws, parent); // child goes with it

    const at = (await call(w.owner, `/at?t=${encodeURIComponent(T.toISOString())}&space=${w.space}`)).body;
    const undeleteIds = at.notes.filter((n: any) => n.status === "deleted_since").map((n: any) => n.id);
    expect(undeleteIds).toEqual([parent]);
    const done = (await call(w.owner, "/rewind", rewindBody({ space: w.space, undelete_ids: undeleteIds }))).body;
    expect(done.undeleted).toEqual([parent]);
    expect(done.deleted).toEqual([child]);
    expect((await live(parent)).deleted_at).toBeNull();
    expect((await live(child)).deleted_at).not.toBeNull(); // was deleted at T
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND parent_id = $2`, [child, parent])).rows).toHaveLength(1);

    const undo = await call(w.owner, `/rewinds/${done.rewind_id}/undo`, { node_ids: [parent, child] });
    expect(undo.status).toBe(200);
    expect(undo.body.undone.sort()).toEqual([parent, child].sort());
    expect((await live(parent)).deleted_at).not.toBeNull();
    expect((await live(child)).deleted_at).not.toBeNull();
    // restoring it on its own later still lands it under its parent
    await undeleteNode(w.owner, w.ws, child);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [child, parent])).rows).toHaveLength(1);
  });

  it("undo: puts every note back as it was before the rewind, and the card says so", async () => {
    const s = await scene();
    const done = (await call(w.owner, "/rewind", rewindBody({ space: s.space, restore_ids: [s.changed], undelete_ids: [s.gone], delete_ids: [s.born] }))).body;
    const today = await q<{ d: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`);
    const cards = (await call(w.owner, `/feed?until=${today.rows[0]!.d}&days=3&space=${s.space}`)).body.days.flatMap((d: any) => d.rewinds);
    const card = cards.find((c: any) => c.rewind_id === done.rewind_id);
    expect(card).toMatchObject({ to: T.toISOString(), undone: false });
    expect(card.notes.map((n: any) => n.kind).sort()).toEqual(["delete", "restore", "undelete"]);

    const ids = [s.changed, s.gone, s.born];
    const undo = await call(w.owner, `/rewinds/${done.rewind_id}/undo`, { node_ids: ids });
    expect(undo.status).toBe(200);
    expect(undo.body.undone.sort()).toEqual([...ids].sort());
    expect(undo.body).toMatchObject({ conflicts: [], kept: [], skipped: [] });
    expect((await live(s.changed)).markdown).toBe("a3\n\nb1\n\nnew line\n");
    expect((await live(s.gone)).deleted_at).not.toBeNull();
    expect((await live(s.born)).deleted_at).toBeNull();
    const after = (await call(w.owner, `/feed?until=${today.rows[0]!.d}&days=3&space=${s.space}`)).body.days.flatMap((d: any) => d.rewinds);
    expect(after.find((c: any) => c.rewind_id === done.rewind_id).undone).toBe(true);
    // a second request (a retry) changes nothing
    const again = await call(w.owner, `/rewinds/${done.rewind_id}/undo`, { node_ids: ids });
    expect(again.body.undone.sort()).toEqual([...ids].sort());
  });

  it("undo: a line edited after the rewind stays; a line both changed keeps the newer text and goes to the inbox; an edited, brought-back note is kept", async () => {
    const s = await scene();
    const mixed = await w.note("one\n\ntwo\n\nthree\n", s.space);
    await inThePast([mixed], 5);
    await edit(w, mixed, "ONE\n\ntwo\n\nTHREE\n");
    const dead = await w.note("dead\n", s.space);
    await inThePast([dead], 5);
    await trashNode(w.owner, w.ws, dead);
    const done = (await call(w.owner, "/rewind", rewindBody({ space: s.space, restore_ids: [mixed], undelete_ids: [dead], delete_ids: [s.born] }))).body;
    expect((await live(mixed)).markdown).toBe("one\n\ntwo\n\nthree\n");
    // after the rewind: someone edits line 1 (conflict) and a different line (no conflict)
    await edit(w, mixed, "uno\n\ntwo\n\nthree\n\nfour\n");
    await edit(w, dead, "dead, then written again\n");
    const undo = (await call(w.owner, `/rewinds/${done.rewind_id}/undo`, { node_ids: [mixed, dead, s.born] })).body;
    expect(undo.undone).toEqual(expect.arrayContaining([mixed, s.born]));
    expect(undo.conflicts).toEqual([mixed]);
    expect(undo.kept).toEqual([dead]);
    const text = (await live(mixed)).markdown;
    expect(text).toContain("uno");        // the newer edit of the shared line is not overwritten
    expect(text).toContain("four");       // nor the new line
    expect(text).toContain("THREE");      // the untouched line went back
    expect((await live(dead)).deleted_at).toBeNull(); // new work is not hidden
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [mixed])).rows.length).toBeGreaterThan(0);
  });

  it("undo: 404 for a rewind that does not exist or none of whose notes the caller can read", async () => {
    expect((await call(w.owner, "/rewinds/not-a-rewind/undo", { node_ids: [] })).status).toBe(404);
  });

  it.skipIf(!isTestDb)("property: random edit histories → rewind to T → every note's text is T's → undo → every note is as before the rewind", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        before: fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 3 }),
        after: fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 2 }),
        fate: fc.constantFrom("keep", "trash"),
      }), { minLength: 1, maxLength: 4 }),
      fc.nat(2),
      async (notes, newNotes) => {
        const space = await makeSpace(w.ws, `prop ${Math.random()}`, [{ id: w.owner.id, permission: "edit" }]);
        const specs: Array<{ id: string; thenText: string; nowText: string; trashed: boolean }> = [];
        for (const n of notes) {
          const text = (versions: string[]) => `${versions.join("\n\n")}\n`;
          const id = await w.note(text(n.before.slice(0, 1)), space);
          for (let i = 1; i < n.before.length; i++) await edit(w, id, text(n.before.slice(0, i + 1)));
          await inThePast([id], 5);
          for (const a of n.after) await edit(w, id, `${(await live(id)).markdown}\n${a}\n`);
          if (n.fate === "trash") await trashNode(w.owner, w.ws, id);
          specs.push({ id, thenText: text(n.before), nowText: (await live(id)).markdown, trashed: n.fate === "trash" });
        }
        const born: string[] = [];
        for (let i = 0; i < newNotes; i++) born.push(await w.note(`born ${i}\n`, space));
        const snapshot = async () => Object.fromEntries(await Promise.all([...specs.map((s) => s.id), ...born].map(async (id) => [id, await live(id)])));
        const preRewind = await snapshot();

        const at = (await call(w.owner, `/at?t=${encodeURIComponent(T.toISOString())}&space=${space}`)).body;
        const group = (status: string) => at.notes.filter((x: any) => x.status === status).map((x: any) => x.id);
        const done = (await call(w.owner, "/rewind", rewindBody({
          space, restore_ids: group("changed"), undelete_ids: group("deleted_since"), delete_ids: group("created_since"),
        }))).body;

        const post = await snapshot();
        for (const s of specs) {
          expect(post[s.id]!.markdown).toBe(s.thenText);
          expect(post[s.id]!.deleted_at).toBeNull();
        }
        for (const id of born) expect(post[id]!.deleted_at).not.toBeNull();

        if (done.rewind_id) {
          const everyone = [...specs.map((s) => s.id), ...born];
          await call(w.owner, `/rewinds/${done.rewind_id}/undo`, { node_ids: everyone });
        }
        const back = await snapshot();
        for (const id of Object.keys(preRewind)) {
          expect(back[id]!.markdown).toBe(preRewind[id]!.markdown);
          expect(back[id]!.title).toBe(preRewind[id]!.title);
          expect(back[id]!.deleted_at === null).toBe(preRewind[id]!.deleted_at === null);
        }
      },
    ), { numRuns: 8 });
  }, 120_000);
});
