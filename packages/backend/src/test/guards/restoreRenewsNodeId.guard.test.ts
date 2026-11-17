// docs/architecture/proposals/node-rebase-2026-11-16.md §6 ("the server's own case"), owner 2026-11-17 (§11 question 2): a database restored
// from a backup takes a new node id, and THE RESTORE COMMAND does it; a backend start never does.
//
// A database restored from an older pg_dump gets back the `sync_node` and `sync_clock` rows it had then, so without a new id it would go on
// numbering its writes inside a range other nodes may already hold (the "USN rollback" of docs/research/sync-design-vs-literature-2026-11-16.md
// item 1). The renewal is one SQL function (migration 213 sync_renew_node_id), reached by one shell entry (scripts/lib/renewNodeId.sh) that the
// two scripts source. This file reads the scripts and the source tree as text: the restore is a shell script around psql / pg_restore, and a
// database cannot tell "restored" from "never restored" (that is the point of the problem). What the renewal does to a database is proved in
// src/test/nodeRenewal.integration.test.ts.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const BACKEND = join(REPO, "packages", "backend");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const RESTORE = read("scripts/restore.sh");
const DRILL = read("scripts/restore-drill.sh");
const ENTRY = read("scripts/lib/renewNodeId.sh");
const DRILL_INVARIANTS = read("packages/backend/scripts/drillInvariants.ts");

/** Every product source file of the backend (no tests), and every migration, as [path relative to the backend, text]. */
function backendSources(): [string, string][] {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : walk(path);
    return /\.(ts|sql)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
  return [...walk(join(BACKEND, "src")), ...walk(join(BACKEND, "db", "migrations"))].map((p) => [relative(BACKEND, p).split("\\").join("/"), readFileSync(p, "utf8")]);
}
const CODE = (text: string) => text.split("\n").filter((line) => !/^\s*(--|\/\/|\*|\/\*)/.test(line)).join("\n");

describe("restore gives the database a new node id (node-rebase-2026-11-16.md §6)", () => {
  it("scripts/restore.sh runs the node-id renewal after it loads the dump and before the backend starts", () => {
    expect(RESTORE).toMatch(/renewNodeId/);
    expect(RESTORE).toMatch(/source "\$SCRIPT_DIR\/lib\/renewNodeId\.sh"/);
    // after the load (both ways of loading), before the closing line that tells the person to start the backend
    const call = RESTORE.indexOf('renewal=$(renewNodeId "${db_psql[@]}")');
    expect(call).toBeGreaterThan(RESTORE.lastIndexOf("psql --set ON_ERROR_STOP=on --quiet"));
    expect(call).toBeLessThan(RESTORE.indexOf('echo "[restore] done.'));
    // a failure stops the script before it says "done"
    expect(RESTORE.slice(call, RESTORE.indexOf('echo "[restore] done.'))).toMatch(/\*\)[\s\S]*exit 1/);
  });

  it("the restore drill renews the node id on its throwaway database and checks it differs from the one in the backup", () => {
    expect(DRILL).toMatch(/renewNodeId/);
    expect(DRILL).toMatch(/source "\$repo\/scripts\/lib\/renewNodeId\.sh"/);
    expect(DRILL).toMatch(/compare [^\n]*--node-renewed/);
    expect(DRILL_INVARIANTS).toMatch(/node_id_renewed/);
    // at the place restore.sh does it: after the "before" snapshot of the backup, before the migrations
    expect(DRILL.indexOf('renew_step "還原後、migration 前"')).toBeGreaterThan(DRILL.indexOf("--out \"$work/before.json\""));
    expect(DRILL.indexOf('renew_step "還原後、migration 前"')).toBeLessThan(DRILL.indexOf("tsx scripts/drillMigrate.ts"));
  });

  it("there is one shell entry, and it calls the one SQL function", () => {
    expect(ENTRY).toMatch(/^renewNodeId\(\) \{/m);
    expect(ENTRY).toMatch(/FROM sync_renew_node_id\(\)/);
    for (const [name, text] of [["restore.sh", RESTORE], ["restore-drill.sh", DRILL]] as const) {
      const commands = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
      expect(commands, `${name} calls the SQL itself instead of the entry`).not.toMatch(/sync_renew_node_id/);
    }
  });
});

describe("a backend start never renews the node id", () => {
  it("no product code and no migration calls sync_renew_node_id(); only migrations define it", () => {
    const naming = backendSources().filter(([, text]) => /\bsync_renew_node_id\b/.test(CODE(text))).map(([path]) => path);
    expect(naming).toContain("db/migrations/213_renew_node_id.sql");
    expect(naming.filter((path) => !path.startsWith("db/migrations/"))).toEqual([]);
    for (const path of naming) expect(CODE(read(`packages/backend/${path}`)), path).not.toMatch(/SELECT[^;]*\bsync_renew_node_id\(\)|PERFORM\s+sync_renew_node_id/i);
  });

  it("only sync_take_node_id() changes sync_node.node_id (the browser copy's first id takes it by the same rule)", () => {
    const changing = backendSources().filter(([, text]) => /UPDATE\s+sync_node\b|INSERT\s+INTO\s+sync_node\b[^;]*DO\s+UPDATE/i.test(CODE(text))).map(([path]) => path);
    expect(changing).toEqual(["db/migrations/213_renew_node_id.sql"]);
    const takers = backendSources().filter(([, text]) => /\bsync_take_node_id\(\)/.test(CODE(text))).map(([path]) => path).sort();
    expect(takers).toEqual(["db/migrations/213_renew_node_id.sql", "src/browser/nodeIdentity.ts"]);
  });
});

describe("the browser copy takes its id only after its migrations ran (sync_take_node_id is migration 213's)", () => {
  it("src/browser/worker.ts calls migrate() before ensureOwnNodeId()", () => {
    const worker = CODE(read("packages/backend/src/browser/worker.ts"));
    const migrateAt = worker.indexOf("await migrate({ seedNativeActor: false })");
    expect(migrateAt).toBeGreaterThan(-1);
    expect(worker.indexOf("await ensureOwnNodeId()")).toBeGreaterThan(migrateAt);
  });
});

// Today's behaviour, kept until scripts/upgrade.sh rollback switches the version before it restores (spine/stampedMerge/README.md
// 「接上傳輸前必須完成」): then restore.sh can bring the function in first and renew. Until that batch, a backup older than migration 213
// restored into a fresh database keeps its node id, with a warning and exit code 0 (so that rollback goes on).
describe("a backup older than migration 213 (no sync_renew_node_id in it), until upgrade.sh rollback switches the version first", () => {
  const work = mkdtempSync(join(tmpdir(), "restore-old-backup-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("restore.sh loads it, warns that the node id stays, exits 0, and sends no renewal", () => {
    const log = join(work, "psql.log");
    // a stand-in psql: takes the dump, answers "no such function", and writes down every statement it was given
    const fakePsql = join(work, "psql");
    writeFileSync(fakePsql, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
cat > /dev/null
case "$*" in *to_regprocedure*) echo f ;; esac
`);
    chmodSync(fakePsql, 0o755);
    const dump = join(work, "onden-old.sql.gz");
    writeFileSync(dump, gzipSync("SELECT 1;\n"));
    const run = spawnSync("bash", [join(REPO, "scripts/restore.sh"), dump, "--yes"], {
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/never_used" }, encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/\[restore\] WARNING: this backup was made by a version before the node-id step \(migration 213\); the restored database keeps the node id/);
    expect(run.stdout).toMatch(/\[restore\] done\./);
    expect(run.stdout).not.toMatch(/is a new node/);
    const sent = readFileSync(log, "utf8");
    expect(sent).toMatch(/to_regprocedure\('sync_renew_node_id\(\)'\)/);
    expect(sent).not.toMatch(/FROM sync_renew_node_id\(\)/);
  });
});

/** The text of the LAST migration (by file name, the order migrate() runs them) that defines `fn`: the definition a database ends up with. A later migration
 *  that redefines a function is how it changes (an applied migration is never edited), so a check of the function reads this one, not a file by name. */
function lastDefinitionOf(fn: string, migrations: readonly (readonly [name: string, text: string])[]): readonly [string, string] | undefined {
  const defines = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`);
  return [...migrations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([, text]) => defines.test(text)).at(-1);
}
const MIGRATIONS = readdirSync(join(BACKEND, "db", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(BACKEND, "db", "migrations", f), "utf8")] as const);
const labelListOf = (text: string): string[] | undefined =>
  /jsonb_object_agg\(l, c\.next_seq - 1\) FROM unnest\(ARRAY\[([^\]]*)\]\)/.exec(text)?.[1]?.split(",").map((l) => l.trim().replace(/^'|'$/g, ""));

describe("the old id is held for every label a bundle carries (the migration that defines sync_renew_node_id() has its own copy of the list)", () => {
  it("the labels the last definition of sync_renew_node_id() writes into sync_origins.have are spine/stampedMerge/dbUnits.ts CARRIED_LABELS, in order", async () => {
    const { CARRIED_LABELS } = await import("../../spine/stampedMerge/index.js");
    const last = lastDefinitionOf("sync_renew_node_id", MIGRATIONS);
    expect(last, "no migration defines sync_renew_node_id()").toBeDefined();
    // a label added to CARRIED_LABELS needs a NEW migration that redefines sync_renew_node_id() with it (213 is applied and never edited): until then a restored
    // server would hold its old id from 0 for that label
    expect(labelListOf(last![1]), `${last![0]} no longer writes have from a label list`).toEqual([...CARRIED_LABELS]);
  });

  it("lastDefinitionOf takes the latest migration that defines the function, whatever order the files are listed in, and ignores ones that only call it", () => {
    const def = (labels: string) => `CREATE OR REPLACE FUNCTION sync_renew_node_id() … jsonb_object_agg(l, c.next_seq - 1) FROM unnest(ARRAY[${labels}]) AS l`;
    const files = [["300_later_redefinition.sql", def("'a', 'b', 'new_label'")], ["213_renew_node_id.sql", def("'a', 'b'")], ["400_only_a_caller.sql", "SELECT * FROM sync_renew_node_id();"], ["100_other.sql", "CREATE TABLE x (id int);"]] as const;
    expect(lastDefinitionOf("sync_renew_node_id", files)?.[0]).toBe("300_later_redefinition.sql");
    expect(labelListOf(lastDefinitionOf("sync_renew_node_id", files)![1])).toEqual(["a", "b", "new_label"]);
    expect(lastDefinitionOf("sync_renew_node_id", files.filter(([name]) => name !== "300_later_redefinition.sql"))?.[0]).toBe("213_renew_node_id.sql");
    expect(lastDefinitionOf("sync_renew_node_id", [["100_other.sql", "CREATE TABLE x (id int);"]])).toBeUndefined();
  });
});
