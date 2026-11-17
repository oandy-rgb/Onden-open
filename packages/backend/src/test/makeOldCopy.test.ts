// The test tool src/browser/makeOldCopy.ts (the saved copy an older app left in a browser; e2e/browser-app/smoke.mjs upgrades it).
// It writes notes through today's code, which reads whatever today's migrations made, so the copy must be taken back afterwards to
// exactly what the kept migrations left. Found broken when #1800 made every request read participant_sessions (migration 210) and the
// tool's hand-written exception list did not name it; nothing ran the tool, so nobody saw. This test is the thing that runs it.
//
//   old       the copy holds only migrations below 192 and no object a later migration made; today's migrate() upgrades it and the
//             notes, the read-later mark, the review cards and the capture inbox note are still there;
//   newer     the same copy plus a migration this build has never heard of: the app must refuse to open it (judgeSchema → "newer");
//   poisoned  an old copy that already holds a table the upgrade would make, so the upgrade fails and the copy stays as it was.
// Rounds: the first describe is pure and runs in every round (no database, PGlite, real Postgres), so the file always has a suite.
// The second is registered only when the driver is PGlite — the tool and the copy are PGlite databases of their own, so a real Postgres
// round has nothing to compare: there it does not exist (it is not a skip, and nothing is added to the skip lists), and in the
// no-database round it does not exist either.
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, q } from "../db.js";
import { openPglite } from "../dbPglite.js";
import { portableMigrationSql } from "../dbMigrations.js";
import { judgeSchema } from "../browser/schemaCheck.js";
import { readSchemaCatalog, schemaDifferences, type SchemaCatalog } from "../browser/schemaCatalog.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { dbDriver } from "../db.js";

describe("schemaDifferences (what the tool's check is built on)", () => {
  const table = (columns: Record<string, { type: string; notNull: boolean; default: string | null }>) =>
    ({ columns, constraints: {}, indexes: {}, triggers: {}, policies: {}, rowSecurity: false });
  const catalog = (tables: SchemaCatalog["tables"], extra: Partial<SchemaCatalog> = {}): SchemaCatalog =>
    ({ tables, functions: {}, views: {}, sequences: [], types: {}, unsteppable: {}, ...extra });
  const id = { type: "uuid", notNull: true, default: null };

  it("is empty for the same schema and names a table, a column and an object it cannot step back when they differ", () => {
    const wanted = catalog({ notes: table({ id }) });
    expect(schemaDifferences(wanted, catalog({ notes: table({ id }) }))).toEqual([]);
    const actual = catalog({ notes: table({ id, extra: { type: "text", notNull: false, default: null } }), participant_sessions: table({ id }) }, { unsteppable: { "schema later": "" } });
    expect(schemaDifferences(wanted, actual).map((line) => line.split("\n")[0])).toEqual([
      "only in the actual schema: (cannot be stepped back) schema later",
      "only in the actual schema: column notes. extra",
      "only in the actual schema: table participant_sessions",
    ]);
  });
});

const backend = resolve(import.meta.dirname, "../..");
const migrationDir = join(backend, "db/migrations");
const versions = readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
const kept = versions.filter((v) => Number.parseInt(v, 10) < 192);
const FIRST_LEFT_OUT = 192;

type Made = { file: string; summary: { applied: number; last: string; latest: string; leftOut: number } };

/** A schema built from migration files alone (no app, no tool), the reference the copy is compared with. */
async function schemaOf(list: string[]): Promise<SchemaCatalog> {
  const db = await openPglite({ dataDir: "memory://" });
  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm");
    for (const version of list) await db.exec(portableMigrationSql(readFileSync(join(migrationDir, `${version}.sql`), "utf8")));
    // What migrate() itself adds on PGlite after the files (db.ts), so the reference is what migrate() leaves.
    await db.exec("CREATE INDEX IF NOT EXISTS content_nodes_trgm_idx ON content_nodes USING gin (title gin_trgm_ops, markdown gin_trgm_ops)");
    return await readSchemaCatalog(async (sql, params) => db.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
  } finally { await db.close(); }
}

async function openCopy(file: string) {
  const tar = new Blob([readFileSync(file)]);
  return openPglite({ dataDir: "memory://", loadDataDir: async () => tar });
}

if (dbDriver === "pglite") describe("makeOldCopy: the copy an older app left", () => {
  let dir: string;
  const made: Record<string, Made> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "old-copy-"));
    await Promise.all(["old", "newer", "poisoned"].map(async (mode) => {
      const file = join(dir, `${mode}.tar.gz`);
      const { stdout } = await promisify(execFile)("npx", ["tsx", "src/browser/makeOldCopy.ts", file, mode], { cwd: backend, timeout: 280_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", ONDEN_PGLITE_SNAPSHOT: "" } });
      made[mode] = { file, summary: JSON.parse(stdout.trim().split("\n").pop()!) };
    }));
  }, 300_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("old: records exactly the migrations below 192 and holds no object a later migration made", async () => {
    const copy = await openCopy(made.old!.file);
    try {
      const recorded = (await copy.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
      expect(recorded).toEqual(kept);
      expect(made.old!.summary).toMatchObject({ applied: kept.length, last: kept.at(-1), latest: versions.at(-1), leftOut: versions.length - kept.length });

      const reference = await schemaOf(kept);
      const everything = await schemaOf(versions);
      // The check must mean something: the left-out migrations did make objects (participant_sessions is the one that broke the tool).
      expect(schemaDifferences(reference, everything).length).toBeGreaterThan(0);
      expect(Object.keys(everything.tables)).toContain("participant_sessions");

      const actual = await readSchemaCatalog(async (sql, params) => copy.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
      // The sign-in library makes its own four tables when the tool runs and migrate() makes schema_migrations; no migration file does.
      const notFromMigrations = Object.keys(actual.tables).filter((name) => !(name in everything.tables) && !(name in reference.tables)).sort();
      expect(notFromMigrations).toEqual(["account", "schema_migrations", "session", "user", "verification"]);
      for (const name of notFromMigrations) delete actual.tables[name];
      expect(schemaDifferences(reference, actual)).toEqual([]);
      expect(Object.keys(actual.tables)).not.toContain("participant_sessions");
      expect(versions.filter((v) => Number.parseInt(v, 10) >= FIRST_LEFT_OUT).length).toBe(made.old!.summary.leftOut);
    } finally { await copy.close(); }
  }, 120_000);

  it("old: today's migrate() upgrades it, and the notes, the read-later mark, the review cards and the capture inbox note are there", async () => {
    const node = await RealNode.open("old-copy", undefined, made.old!.file);
    try {
      await onNode(node, async () => {
        await migrate({ seedNativeActor: false });
        expect((await q<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version)).toEqual(versions);
        const titles = (await q<{ title: string }>("SELECT title FROM content_nodes WHERE deleted_at IS NULL")).rows.map((r) => r.title);
        for (const title of ["舊版留下的筆記一", "舊版留下的筆記二", "舊版稍後讀的文章", "舊版複習的卡片", "舊版收件匣的筆記"]) expect(titles).toContain(title);
        // 192 keeps the mark's table under another name; 195 gives the note and the paragraph that were cards a reference of their own.
        expect((await q("SELECT 1 FROM read_later_done_removed_192")).rows).toHaveLength(1);
        expect((await q("SELECT 1 FROM function_refs WHERE function_id = 'review' AND holder_node_id IS NOT NULL")).rows.length).toBeGreaterThanOrEqual(1);
        expect((await q("SELECT 1 FROM function_refs WHERE function_id = 'review' AND holder_block_id IS NOT NULL")).rows.length).toBeGreaterThanOrEqual(1);
        // 201 gives the capture inbox tag a derived id (version 5) and keeps the note on it.
        const inbox = (await q<{ id: string }>("SELECT id FROM content_nodes WHERE title = '收件匣' AND node_type = 'class_tag'")).rows;
        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
        expect((await q("SELECT 1 FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE nt.tag_id = $1 AND n.title = '舊版收件匣的筆記'", [inbox[0]!.id])).rows).toHaveLength(1);
      });
    } finally { await node.close(); }
  }, 240_000);

  it("newer: the copy also lists a migration this build has never heard of, so the app refuses it", async () => {
    const copy = await openCopy(made.newer!.file);
    try {
      const recorded = (await copy.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
      expect(recorded).toEqual([...kept, "999_from_a_newer_app"]);
      expect(judgeSchema(recorded, versions)).toEqual({ kind: "newer", unknown: ["999_from_a_newer_app"] });
    } finally { await copy.close(); }
  }, 60_000);

  it("poisoned: an old copy that already holds a table the upgrade makes, so the upgrade fails and rolls back", async () => {
    const node = await RealNode.open("poisoned-copy", undefined, made.poisoned!.file);
    try {
      await onNode(node, async () => {
        // It fails on the poison (a table of the name a migration makes, without its columns), not for another reason.
        await expect(migrate({ seedNativeActor: false })).rejects.toThrow(/column .* does not exist/);
        // The failed migration rolled back: no record of it, and what is recorded is still exactly the kept migrations plus the ones before it.
        const recorded = (await q<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
        expect(recorded.slice(0, kept.length)).toEqual(kept);
        expect(recorded).not.toContain(versions.at(-1));
      });
    } finally { await node.close(); }
  }, 240_000);
});
