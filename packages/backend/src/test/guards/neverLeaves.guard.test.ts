// Rows of a class that never leave the node (spine/syncClasses.ts `neverLeaves`): the classification names them, snapshotTables.json says how to tell them, and the ONE rule that
// uses both is spine/snapshotTables.ts (the snapshot's `where`, and `stampMayLeaveSql` for the stamps that a snapshot, a change bundle and a digest carry). This guard keeps the two
// lists in step and keeps a second, special-cased filter from growing beside it. What actually crosses the wire is sessionsStayOnTheirNode.integration.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNC_CLASSES } from "../../spine/syncClasses.js";
import { SNAPSHOT_SPECS, stampMayLeaveSql } from "../../spine/snapshotTables.js";

const SRC = join(import.meta.dirname, "..", "..");
const marked = Object.entries(SYNC_CLASSES).filter(([, e]) => e.neverLeaves).map(([table]) => table).sort();

/** A `neverLeaves` that reads ANOTHER table's current rows classifies a stamp by rows that must then outlive the stamp: a tombstone outlives its own
 *  row, and once the row it was judged by is gone, the stamp would leave. Each such read is named here with the invariant that keeps those rows and
 *  the test of the invariant; a new one fails until it is named (or the rule is written over the stamp's own key). */
// ratchet:list never-leaves-cross-table
const CROSS_TABLE_INVARIANTS: Record<string, { reads: string[]; invariant: string; test: [file: string, name: string] }> = {
  space_members: {
    reads: ["actors"],
    invariant: "a temporary session's actors row is never deleted and keeps its id, workspace and type while its workspace exists: the database refuses it (migration 217, trigger actors_keep_session_row); removeActor refuses a session too",
    test: ["sessionActorKept.integration.test.ts", "the database keeps a session's actors row (migration 217)"],
  },
};

/** The tables a SQL fragment reads (FROM / JOIN). */
const tablesRead = (sqlText: string): string[] => [...new Set([...sqlText.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase()))].sort();

const BACKEND = join(SRC, "..");

/** Every non-test source file under `dir` (src/ by default; also scripts/), with its path from the backend package. */
function sourceFiles(dir = SRC): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" || e.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|mjs)$/.test(e.name) && !e.name.endsWith(".test.ts") ? [{ file: path.slice(BACKEND.length + 1), text: readFileSync(path, "utf8") }] : [];
  });
}
const MIGRATIONS = join(BACKEND, "db", "migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).map((f) => ({ file: `db/migrations/${f}`, text: readFileSync(join(MIGRATIONS, f), "utf8") }));

describe("rows that never leave the node", () => {
  it("the classification and the snapshot list name the same tables", () => {
    expect(SNAPSHOT_SPECS.filter((s) => s.neverLeaves).map((s) => s.table).sort()).toEqual(marked);
    expect(marked).toEqual(["actors", "space_members"]); // the rows of a temporary session
  });

  it("a table with stamps judges them by its key alone: neverLeaves uses only primary-key columns, and the stamp's key is those columns joined by '/' in order", () => {
    for (const spec of SNAPSHOT_SPECS.filter((s) => s.neverLeaves && s.stamps?.length)) {
      const used = [...spec.neverLeaves!.matchAll(/\bt\.(\w+)/g)].map((m) => m[1]!);
      for (const column of used) expect(spec.pk, `${spec.table}: neverLeaves reads ${column}, which is not part of the key: the stamp of a deleted row cannot be judged`).toContain(column);
      for (const def of spec.stamps!) expect(def.rowKey, `${spec.table}: the row key must be the key columns joined by '/'`).toBe(spec.pk.map((c) => `t.${c}::text`).join(" || '/' || "));
    }
  });

  it("a neverLeaves that reads another table's rows names the invariant that keeps them, and the test of it exists", () => {
    const crossing = Object.fromEntries(SNAPSHOT_SPECS.filter((s) => s.neverLeaves).map((s) => [s.table, tablesRead(s.neverLeaves!).filter((t) => t !== s.table)] as const).filter(([, reads]) => reads.length > 0));
    expect(Object.keys(crossing).sort(), "a neverLeaves reads another table: name it in CROSS_TABLE_INVARIANTS with the invariant that keeps those rows").toEqual(Object.keys(CROSS_TABLE_INVARIANTS).sort());
    for (const [table, named] of Object.entries(CROSS_TABLE_INVARIANTS)) {
      expect(crossing[table], `${table}: the tables its neverLeaves reads`).toEqual(named.reads);
      const [file, name] = named.test;
      expect(readFileSync(join(SRC, "test", file), "utf8"), `${table}: the test of "${named.invariant}"`).toContain(name);
    }
  });

  // The invariant is kept by the DATABASE (migration 217; its tests are in sessionActorKept.integration.test.ts, which need a database). This guard
  // runs without one: it checks that the trigger is in the migration and in the schema, and, as a second layer, reads the source for a delete that
  // forgot sessions (a text scan cannot see every spelling; the trigger can).
  it("the database keeps a session's row: migration 217 and the schema define the trigger on DELETE and on UPDATE of id, workspace_id, type, and on TRUNCATE", () => {
    for (const text of [readFileSync(join(MIGRATIONS, "217_keep_session_actor_rows.sql"), "utf8"), readFileSync(join(BACKEND, "db", "schema.sql"), "utf8")]) {
      expect(text).toMatch(/CREATE TRIGGER actors_keep_session_row BEFORE DELETE OR UPDATE OF id, workspace_id, type ON actors\s+FOR EACH ROW EXECUTE FUNCTION actors_keep_session_row\(\)/);
      expect(text).toMatch(/CREATE TRIGGER actors_keep_session_rows_truncate BEFORE TRUNCATE ON actors\s+FOR EACH STATEMENT EXECUTE FUNCTION actors_keep_session_row\(\)/);
      // run under session_replication_role = replica too, and read the real tables whatever the connection's search_path
      expect(text).toMatch(/ENABLE ALWAYS TRIGGER actors_keep_session_row;/);
      expect(text).toMatch(/ENABLE ALWAYS TRIGGER actors_keep_session_rows_truncate;/);
      expect(text).toMatch(/SET search_path = public, pg_temp/);
    }
    // nothing after 217 drops or disables it
    for (const { file, text } of migrationFiles().filter((m) => Number(/(\d+)_/.exec(m.file)![1]) > 217)) {
      expect(text, `${file} drops or disables the trigger that keeps a session's actors row`).not.toMatch(/(DROP\s+TRIGGER|DISABLE\s+TRIGGER)[^;]*actors_keep_session_row|DROP\s+FUNCTION[^;]*actors_keep_session_row/i);
    }
  });

  it("second layer, in the source: every DELETE FROM actors in src/, scripts/ and the migrations excludes type 'session'; no query-builder delete of actors", () => {
    const files = [...sourceFiles(), ...sourceFiles(join(BACKEND, "scripts")), ...migrationFiles()];
    const deletes = files.flatMap(({ file, text }) => [...text.matchAll(/DELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?"?actors\b"?[^`;]*/gi)].map((m) => ({ file, statement: m[0] })));
    expect(deletes.map((d) => d.file), "control: the removal of a member is found").toContain("src/services/actors.ts");
    expect(deletes.map((d) => d.file), "control: scripts/ is read").toContain("scripts/bMcpSmoke.ts");
    // `type <> 'session'` as a condition of its own: an OR beside it would let a session's row through
    for (const d of deletes) expect(d.statement, `${d.file}: DELETE FROM actors must keep a session's row`).toMatch(/AND\s+type\s*<>\s*'session'(?![^']*\bOR\b)|type\s*<>\s*'session'\s+AND(?![^']*\bOR\b)/i);
    expect(files.filter(({ text }) => /deleteFrom\(\s*["'](?:public\.)?actors\b/.test(text)).map((f) => f.file)).toEqual([]);
  });

  it("the rule is not repeated: no `where` of the snapshot list names a session, and the stamp filter is the one function every stamp read asks", () => {
    for (const spec of SNAPSHOT_SPECS) expect(spec.where({ nodeRow: () => "true", node: () => "true", space: () => "true", person: () => "true" }).replace(spec.neverLeaves ?? "", ""), `${spec.table} filters sessions by itself`).not.toMatch(/session/);
    const asked = (file: string) => readFileSync(join(SRC, file), "utf8").includes("stampMayLeaveSql(");
    expect(["spine/snapshotSql.ts"].map(asked)).toEqual([true]);
    expect(readFileSync(join(SRC, "spine/snapshotSql.ts"), "utf8").match(/stampMayLeaveSql\(\)/g)?.length).toBe(3); // readStampsOf, readTombstoneChunk, the digest
    expect(stampMayLeaveSql()).toContain("space_members");
  });
});
