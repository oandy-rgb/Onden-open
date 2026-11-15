// Pointer ids are worked out from (parent, target) (db/migrations/194_stamps_s2.sql, causal-stamps proposal §9 point 1):
// two databases that each make the same pointer get the same id, the migration replaces the existing ids without touching
// anything else, and running it again changes nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { getWorkspaceId, pool, q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";

const MIGRATION = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/194_stamps_s2.sql"), "utf8");
const between = (from: string, to: string) => MIGRATION.slice(MIGRATION.indexOf(from), MIGRATION.indexOf(to));
// The pieces a stand-alone database needs: the id function, the trigger that applies it, and the migration's data move.
const ID_FUNCTIONS = between("CREATE OR REPLACE FUNCTION derive_row_id", "-- Before the stamp triggers exist");
const MOVE = between("DO $$\nDECLARE moved bigint", "CREATE OR REPLACE TRIGGER note_pointers_derive_id");
const ID_TRIGGER = "CREATE OR REPLACE TRIGGER note_pointers_derive_id BEFORE INSERT ON note_pointers FOR EACH ROW EXECUTE FUNCTION note_pointer_derive_id();";
const POINTERS_TABLE = `CREATE TABLE note_pointers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, parent_id uuid, target_id uuid NOT NULL,
  sort_order int NOT NULL DEFAULT 0, display_prefix text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (parent_id, target_id))`;

// Each test starts one to three PGlite databases (about 2 s each, more when the machine is busy), so the 5 s default is too short.
describe("a pointer's id is worked out from its parent and target", { timeout: 60_000 }, () => {
  const parent = randomUUID(); const target = randomUUID(); const other = randomUUID();
  const makeDb = async () => {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(POINTERS_TABLE);
    await db.exec(ID_FUNCTIONS);
    await db.exec(ID_TRIGGER);
    return db;
  };
  const idOf = async (db: PGlite, p: string | null, t: string, workspace = randomUUID()) =>
    (await db.query<{ id: string }>(`INSERT INTO note_pointers (workspace_id, parent_id, target_id) VALUES ($1, $2, $3) RETURNING id::text`, [workspace, p, t])).rows[0]!.id;

  it("two databases that each make the same pointer get the same id", async () => {
    const [a, b] = [await makeDb(), await makeDb()];
    const [fromA, fromB] = [await idOf(a, parent, target), await idOf(b, parent, target)];
    expect(fromA).toBe(fromB);
    expect(fromA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // the pointer another workspace id or a retry makes is the same one: the ids come from the two notes only
    expect(await idOf(await makeDb(), parent, target, randomUUID())).toBe(fromA);
  });

  it("another parent, another target or the top level gives another id", async () => {
    const db = await makeDb();
    const ids = [await idOf(db, parent, target), await idOf(db, other, target), await idOf(db, parent, other), await idOf(db, null, target), await idOf(db, null, other)];
    expect(new Set(ids).size).toBe(5);
  });

  it("the id a caller supplies is replaced by the derived one", async () => {
    const db = await makeDb();
    const supplied = (await db.query<{ id: string }>(
      `INSERT INTO note_pointers (id, workspace_id, parent_id, target_id) VALUES ($1, $2, $3, $4) RETURNING id::text`, [randomUUID(), randomUUID(), parent, target])).rows[0]!.id;
    expect(supplied).toBe(await idOf(await makeDb(), parent, target));
  });

  it("the same pointer cannot be made twice, also at the top level of a fresh database", async () => {
    const db = await makeDb();
    await idOf(db, null, target);
    await expect(idOf(db, null, target)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("the migration replaces every id once, leaves the rest alone and says how many (PGlite, no other tables)", async () => {
    const db = await makeDb();
    const notices: string[] = [];
    const workspace = randomUUID();
    await db.exec(`ALTER TABLE note_pointers DISABLE TRIGGER note_pointers_derive_id`);
    const pairs: Array<[string | null, string]> = [[parent, target], [other, target], [null, target], [null, target], [null, other]];
    for (const [i, [p, t]] of pairs.entries()) {
      await db.query(`INSERT INTO note_pointers (id, workspace_id, parent_id, target_id, sort_order, display_prefix, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval)`,
        [randomUUID(), workspace, p, t, i, i % 2 ? "x" : null, `${i} seconds`]);
    }
    await db.exec(`ALTER TABLE note_pointers ENABLE TRIGGER note_pointers_derive_id`);
    const snapshot = async () => (await db.query<Record<string, unknown>>(`SELECT * FROM note_pointers ORDER BY sort_order`)).rows;
    const before = await snapshot();
    await db.exec(MOVE, { onNotice: (n) => { notices.push(n.message ?? ""); } });
    const after = await snapshot();
    // content: everything but the id is as it was
    expect(after.map(({ id: _id, ...rest }) => rest)).toEqual(before.map(({ id: _id, ...rest }) => rest));
    const derived = async (p: string | null, t: string) => (await db.query<{ id: string }>(`SELECT derive_row_id('note_pointer', COALESCE($1::text, ''), $2::text)::text AS id`, [p, t])).rows[0]!.id;
    expect(after.map((r) => r.id)).toEqual([
      await derived(parent, target), await derived(other, target), await derived(null, target),
      before[3]!.id, // the second top-level pointer on the same target keeps its id
      await derived(null, other),
    ]);
    expect(notices).toEqual(["194: 4 pointer id(s) replaced by a derived id; 1 extra top-level duplicate(s) keep their old id"]);

    // again: nothing changes
    notices.length = 0;
    await db.exec(MOVE, { onNotice: (n) => { notices.push(n.message ?? ""); } });
    expect(await snapshot()).toEqual(after);
    expect(notices).toEqual(["194: 0 pointer id(s) replaced by a derived id; 1 extra top-level duplicate(s) keep their old id"]);
  });

  // Two top-level pointers on one target that tie on created_at: the first run gives the derived id to one of them; a second
  // run must keep choosing that same row, or it would try to give the same id to the other and hit the primary key.
  it("a re-run with two top-level pointers that tie on created_at keeps the same winner and does not hit the primary key", async () => {
    const db = await makeDb();
    const workspace = randomUUID();
    const first = "00000000-0000-4000-8000-000000000001"; const second = "00000000-0000-4000-8000-000000000002";
    await db.exec(`ALTER TABLE note_pointers DISABLE TRIGGER note_pointers_derive_id`);
    for (const id of [second, first]) {
      await db.query(`INSERT INTO note_pointers (id, workspace_id, parent_id, target_id, sort_order, created_at) VALUES ($1, $2, NULL, $3, 0, '2026-01-01T00:00:00Z')`, [id, workspace, target]);
    }
    await db.exec(`ALTER TABLE note_pointers ENABLE TRIGGER note_pointers_derive_id`);
    const derivedId = (await db.query<{ id: string }>(`SELECT derive_row_id('note_pointer', '', $1::text)::text AS id`, [target])).rows[0]!.id;
    const ids = async () => (await db.query<{ id: string }>(`SELECT id::text FROM note_pointers`)).rows.map((r) => r.id).sort();
    await db.exec(MOVE);
    const once = await ids();
    expect(once).toEqual([derivedId, second].sort()); // the smallest old id won the tie
    for (let run = 0; run < 3; run++) {
      await db.exec(MOVE); // must not throw
      expect(await ids()).toEqual(once);
    }
  });

  it("the read-only preview query in the migration's header gives the numbers the move then produces", async () => {
    const db = await makeDb();
    const lines = MIGRATION.split("\n");
    const start = lines.findIndex((l) => l.startsWith("--   WITH d AS"));
    const end = lines.findIndex((l, i) => i > start && l.includes("FROM r;"));
    const query = lines.slice(start, end + 1).map((l) => l.replace(/^--/, "")).join("\n").replace(/;\s*$/, "");
    const workspace = randomUUID();
    await db.exec(`ALTER TABLE note_pointers DISABLE TRIGGER note_pointers_derive_id`);
    for (const [i, [p, t]] of ([[parent, target], [other, target], [null, target], [null, target]] as Array<[string | null, string]>).entries()) {
      await db.query(`INSERT INTO note_pointers (id, workspace_id, parent_id, target_id, created_at) VALUES ($1, $2, $3, $4, now() + $5::interval)`, [randomUUID(), workspace, p, t, `${i} seconds`]);
    }
    await db.exec(`ALTER TABLE note_pointers ENABLE TRIGGER note_pointers_derive_id`);
    const read = async () => (await db.query<Record<string, string | number>>(query)).rows[0]!;
    expect(Number((await read()).pointers)).toBe(4);
    expect(Number((await read()).ids_replaced)).toBe(3);
    expect(Number((await read()).extra_top_level_duplicates_left_alone)).toBe(1);
    await db.exec(MOVE);
    expect(Number((await read()).ids_replaced)).toBe(0);
    expect(Number((await read()).extra_top_level_duplicates_left_alone)).toBe(1);
  });
});

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("the migration over the real tables", () => {
  let ws = "";
  let space = "";
  const notes: string[] = [];
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    const owner = await persistActor(ws, { id: "", name: "Pointer Owner", role: "admin", type: "human" });
    space = await makeSpace(ws, `pointer ids ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, space_id) VALUES ($1, $2, 'manual', 'content', $3, $4, $5)`, [id, ws, `pointer note ${i}`, `pointer-${id}`, space]);
      notes.push(id);
    }
  });
  afterAll(async () => { await pool.end(); });

  it("replaces the ids, keeps every other column and every row, and leaves the stamps untouched; a second run changes nothing", async () => {
    const [a, b, c, d] = notes as [string, string, string, string];
    // pointers as they were before this migration: random ids (the id trigger is off while they are written)
    await seedQ(`ALTER TABLE note_pointers DISABLE TRIGGER note_pointers_derive_id`);
    const legacy = new Map<string, string>();
    for (const [p, t] of [[a, b], [a, c], [b, c], [c, d], [null, d]] as Array<[string | null, string]>) {
      const id = randomUUID();
      legacy.set(`${p}/${t}`, id);
      await seedQ(`INSERT INTO note_pointers (id, workspace_id, parent_id, target_id, sort_order, display_prefix) VALUES ($1, $2, $3, $4, 7, 'pin')`, [id, ws, p, t]);
    }
    await seedQ(`ALTER TABLE note_pointers ENABLE TRIGGER note_pointers_derive_id`);
    const mine = `target_id = ANY($1::uuid[])`;
    const rows = async () => (await q(`SELECT id::text, workspace_id::text, parent_id::text, target_id::text, sort_order, display_prefix, created_at::text FROM note_pointers WHERE ${mine} ORDER BY parent_id NULLS FIRST, target_id`, [[b, c, d]])).rows as Array<Record<string, string>>;
    const before = await rows();
    const stampsBefore = (await q(`SELECT count(*)::int AS n FROM sync_stamps WHERE table_name = 'note_pointers'`)).rows[0];
    await rerunMigration("194_stamps_s2");
    const after = await rows();
    expect(after.length).toBe(before.length);
    expect(after.map(({ id: _id, ...rest }) => rest)).toEqual(before.map(({ id: _id, ...rest }) => rest));
    for (const row of after) {
      const want = (await q<{ id: string }>(`SELECT derive_row_id('note_pointer', COALESCE($1::text, ''), $2::text)::text AS id`, [row.parent_id, row.target_id])).rows[0]!.id;
      expect(row.id).toBe(want);
      expect(row.id).not.toBe(legacy.get(`${row.parent_id}/${row.target_id}`));
    }
    expect((await q(`SELECT count(*)::int AS n FROM sync_stamps WHERE table_name = 'note_pointers'`)).rows[0]).toEqual(stampsBefore);
    await rerunMigration("194_stamps_s2");
    expect(await rows()).toEqual(after);
  });
});
