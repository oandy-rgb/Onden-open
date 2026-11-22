// realPostgresAlso: the temporary function lives in one session; PGlite has only one, so a step split across two connections would pass here.
// What every restore runs once the data is loaded: scripts/lib/renewNodeId.sql (made from the migrations by scripts/lib/renewNodeIdSql.mjs),
// then `SELECT * FROM pg_temp.onden_renew_after_restore(<the id of the database it replaced, or NULL>, <keep the id where it cannot be renewed>)`. scripts/restore.sh, restore-drill.sh
// and the desktop app (packages/desktop/src/nodeRenewal.mjs) run exactly this. The invariant (own-node-transport-2026-11-22.md §6 batch 3):
// after any restore the node's id is a new one and the old id is a former origin ('self-restore', what a snapshot names as `former`,
// migration 214), or the restore is refused and nothing changes; never the old id with success.
// The "backup" is a copy of a node's database (RealNode.open(name, node)); "made before migration 213" is that copy with the three renewal
// functions dropped (the only thing 213 added); "migrations 190 to 205" is it without sync_origins (206 added it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { heldOfFormer } from "../spine/stampedBundle.js";
import { localNodeId } from "../spine/stamps.js";
import { snapshotSourceNode } from "../services/stampedSnapshot.js";
import { openPglite } from "../dbPglite.js";
import { listMigrations, portableMigrationSql } from "../dbMigrations.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { makeRng, markWorld, peerOf, writeFor } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const RENEWAL_SQL = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "scripts", "lib", "renewNodeId.sql"), "utf8");

type Outcome = { outcome: string; before_id: string | null; after_id: string | null; clocks: string; origins: string; reason: string | null };
const rows = <T extends QueryResultRow,>(node: RealNode, text: string, params: unknown[] = []) => onNode(node, async () => (await q<T>(text, params)).rows);
/** The restore's step, in one transaction (pg_temp lives in one session). */
const renewAfterRestore = (node: RealNode, overwritten: string | null, keep = false) => onNode(node, () => withTransaction(async () => {
  await q(RENEWAL_SQL);
  return (await q<Outcome>(`SELECT * FROM pg_temp.onden_renew_after_restore($1, $2)`, [overwritten, keep])).rows[0]!;
}));
const idOf = (node: RealNode) => onNode(node, () => localNodeId());
const formerOf = (node: RealNode) => rows<{ origin: string; have: Record<string, number> }>(node, `SELECT origin, have FROM sync_origins WHERE vouched_by = 'self-restore' ORDER BY origin`);
/** Several statements (no parameters: PGlite runs them as one script). */
const exec = (node: RealNode, text: string) => onNode(node, () => q(text));
const fnExists = (node: RealNode, fn: string) => rows<{ ok: boolean }>(node, `SELECT to_regprocedure($1) IS NOT NULL AS ok`, [`${fn}()`]).then((r) => r[0]!.ok);
const PRE_213 = `DROP FUNCTION sync_renew_node_id(); DROP FUNCTION sync_carried_labels(); DROP FUNCTION sync_take_node_id();`;

const open: RealNode[] = [];
const track = (n: RealNode) => { open.push(n); return n; };
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A node that numbered writes, and a copy of it taken now (the backup). */
async function nodeWithBackup() {
  const na = track(await openNode("a"));
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(7), 6, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  const backup = track(await RealNode.open("a-backup", na));
  return { na, backup, last: Number((await rows<{ n: string }>(na, `SELECT max(next_seq - 1)::text AS n FROM sync_clock`))[0]!.n) };
}

describe.skipIf(!isTestDb)("scripts/lib/renewNodeId.sql: the step every restore runs after loading", () => {
  it("a backup made before migration 213 (no renewal functions): the migrations' own definitions are installed, the node takes a new id, the old one is held to its last number", async () => {
    const { backup, last } = await nodeWithBackup();
    await exec(backup, PRE_213);
    const old = await idOf(backup);
    const r = await renewAfterRestore(backup, old); // upgrade.sh rollback: the database it replaces is the same server, same id
    expect(r.outcome).toBe("renewed");
    expect(r.before_id).toBe(old);
    expect(r.after_id).not.toBe(old);
    expect(await idOf(backup)).toBe(r.after_id);
    for (const fn of ["sync_take_node_id", "sync_carried_labels", "sync_renew_node_id"]) expect(await fnExists(backup, fn)).toBe(true);
    const former = await formerOf(backup);
    expect(former.map((f) => f.origin)).toEqual([old]);
    expect(heldOfFormer(former[0]!.have)).toBe(last);
    // what a snapshot names as former (migration 214): the old id is this node's, not another node's
    expect(await onNode(backup, () => withTransaction(async () => snapshotSourceNode((await q<{ id: string }>(`SELECT id::text FROM workspaces LIMIT 1`)).rows[0]!.id)))).toBe(r.after_id);
  }, 300_000);

  it("the database it replaced had another id (restored since the backup): that id is a former origin too, held up to 0", async () => {
    const { backup, last } = await nodeWithBackup();
    const old = await idOf(backup);
    const replaced = "0b6c3e1e-7d34-4a8e-9a43-3d8f7f1b2c55";
    const r = await renewAfterRestore(backup, replaced);
    expect(r.outcome).toBe("renewed");
    const former = new Map((await formerOf(backup)).map((f) => [f.origin, heldOfFormer(f.have)]));
    expect(former).toEqual(new Map([[old, last], [replaced, 0]]));
    expect(Number(r.origins)).toBe(2 * Number(r.clocks)); // one row per workspace for each, in this one-workspace world
  }, 300_000);

  it("a database that has the functions keeps its own (a host checkout older than the backup does not replace them)", async () => {
    const { backup } = await nodeWithBackup();
    await exec(backup, `CREATE OR REPLACE FUNCTION sync_carried_labels() RETURNS text[] AS $$ SELECT ARRAY['marker']::text[]; $$ LANGUAGE sql IMMUTABLE;`);
    const r = await renewAfterRestore(backup, null);
    expect(r.outcome).toBe("renewed");
    expect(Object.keys((await formerOf(backup))[0]!.have)).toEqual(["marker"]);
  }, 300_000);

  it("refused, nothing changed: a backup that numbered writes but has no sync_origins (migrations 190 to 205); one with no node id while the replaced database had one; a malformed id", async () => {
    const { backup } = await nodeWithBackup();
    const old = await idOf(backup);
    await exec(backup, `${PRE_213} DROP TABLE sync_origins;`);
    await expect(renewAfterRestore(backup, null)).rejects.toThrow(/onden-restore: no-origins-table/);
    expect(await idOf(backup)).toBe(old);
    expect(await fnExists(backup, "sync_renew_node_id")).toBe(false);
    await expect(renewAfterRestore(backup, "not-a-node")).rejects.toThrow(/onden-restore: bad-node-id/);

    await exec(backup, `DROP TABLE sync_node CASCADE;`);
    await expect(renewAfterRestore(backup, old)).rejects.toThrow(/onden-restore: no-node-table/);
    expect((await renewAfterRestore(backup, null)).outcome).toBe("no-node-id"); // a backup before migration 190 into an empty database: nothing was ever numbered
  }, 300_000);

  it("--keep-node-id where the rule cannot hold: the database keeps its id and records it in sync_restore_kept_node_id (one row per such restore)", async () => {
    const { backup } = await nodeWithBackup();
    const old = await idOf(backup);
    await exec(backup, `${PRE_213} DROP TABLE sync_origins;`);
    const r = await renewAfterRestore(backup, "0b6c3e1e-7d34-4a8e-9a43-3d8f7f1b2c55", true);
    expect(r).toMatchObject({ outcome: "kept", before_id: old, after_id: old, reason: "no-origins-table" });
    expect(await idOf(backup)).toBe(old);
    // one row per workspace of the database (migration 224), each naming the kept id
    const kept = await rows<{ ws: string; node_id: string; overwritten: string; reason: string }>(backup, `SELECT workspace_id::text AS ws, node_id, overwritten, reason FROM sync_restore_kept_node_id ORDER BY 1`);
    const workspaces = (await rows<{ id: string }>(backup, `SELECT id::text AS id FROM workspaces ORDER BY 1`)).map((r) => r.id);
    expect(kept).toEqual(workspaces.map((ws) => ({ ws, node_id: old, overwritten: "0b6c3e1e-7d34-4a8e-9a43-3d8f7f1b2c55", reason: "no-origins-table" })));
    expect(workspaces.length).toBeGreaterThan(0);
    // with keep, a database the rule CAN renew is still renewed: keeping is only the way out of a refusal; and a renewal empties the table
    // (migration 224: a row <=> the current id is one a restore kept), here a row a restore before the backup had left
    const { backup: other } = await nodeWithBackup();
    await exec(other, `INSERT INTO sync_restore_kept_node_id (workspace_id, node_id, reason) SELECT id, '0b6c3e1e-7d34-4a8e-9a43-3d8f7f1b2c55', 'no-origins-table' FROM workspaces`);
    expect((await renewAfterRestore(other, null, true)).outcome).toBe("renewed");
    expect(await rows(other, `SELECT * FROM sync_restore_kept_node_id`)).toEqual([]);
  }, 300_000);
});

// Review of PR #1937, point 8: the file installs the LAST definitions; one that called a helper an older backup does not have would only fail
// at a restore. So: a database with only the migrations before 213 (what such a backup is), numbered writes, then the file and its call.
describe.skipIf(!isTestDb)("scripts/lib/renewNodeId.sql on a database that only had the migrations before 213", () => {
  it("installs its definitions there and renews; the old id is held to the last number it gave", async () => {
    const db = await openPglite({ dataDir: "memory://" });
    try {
      await db.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
      const older = (await listMigrations()).filter((m) => Number.parseInt(m.version, 10) < 213);
      for (const m of older) await db.exec(portableMigrationSql(m.sql));
      expect((await db.query<{ ok: boolean }>(`SELECT to_regprocedure('sync_renew_node_id()') IS NULL AS ok`)).rows[0]!.ok).toBe(true);
      const ws = (await db.query<{ id: string }>(`SELECT id::text AS id FROM workspaces ORDER BY created_at LIMIT 1`)).rows[0]?.id
        ?? (await db.query<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('w', 'w') RETURNING id::text AS id`)).rows[0]!.id;
      for (let i = 0; i < 3; i++) await db.transaction(async (tx) => {
        await tx.query(`SELECT * FROM sync_lock_clock($1::uuid)`, [ws]);
        await tx.query(`UPDATE sync_clock SET next_seq = next_seq + 1 WHERE workspace_id = $1::uuid`, [ws]);
      });
      const old = (await db.query<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
      await db.exec(RENEWAL_SQL);
      const r = (await db.query<Outcome>(`SELECT * FROM pg_temp.onden_renew_after_restore(NULL, false)`)).rows[0]!;
      expect(r).toMatchObject({ outcome: "renewed", before_id: old });
      expect(r.after_id).not.toBe(old);
      const former = (await db.query<{ origin: string; have: Record<string, number> }>(`SELECT origin, have FROM sync_origins WHERE vouched_by = 'self-restore'`)).rows;
      expect(former.map((f) => [f.origin, heldOfFormer(f.have)])).toEqual([[old, 3]]);
    } finally {
      await db.close();
    }
  }, 300_000);
});
