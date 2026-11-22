// docs/architecture/proposals/node-rebase-2026-11-16.md §6 ("the server's own case"), owner 2026-11-17 (§11 question 2): a database restored
// from a backup takes a new node id, and THE RESTORE COMMAND does it; a backend start never does.
//
// A database restored from an older pg_dump gets back the `sync_node` and `sync_clock` rows it had then, so without a new id it would go on
// numbering its writes inside a range other nodes may already hold (the "USN rollback" of docs/research/sync-design-vs-literature-2026-11-16.md
// item 1). The renewal is one SQL function (migration 213 sync_renew_node_id), reached by one shell entry (scripts/lib/renewNodeId.sh) that the
// two scripts source. This file reads the scripts and the source tree as text: the restore is a shell script around psql / pg_restore, and a
// database cannot tell "restored" from "never restored" (that is the point of the problem). What the renewal does to a database is proved in
// src/test/nodeRenewal.integration.test.ts.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { lastDefinition, RENEWAL_FUNCTIONS, renewalSql } from "../../../../../scripts/lib/renewNodeIdSql.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const BACKEND = join(REPO, "packages", "backend");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const RESTORE = read("scripts/restore.sh");
const RENEWAL_FILE = read("scripts/lib/renewNodeId.sql");
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
  it("scripts/restore.sh checks the whole backup first, loads it into a new database with the renewal last, and swaps it in only after that", () => {
    expect(RESTORE).toMatch(/source "\$SCRIPT_DIR\/lib\/renewNodeId\.sh"/);
    const code = RESTORE.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    // 1. the backup as SQL must end with pg_dump's last line; it is read once, whole, before anything is touched
    expect(code).toMatch(/END \{ exit done \? 0 : 7 \}/);
    const check = code.indexOf("sql_bytes=$(backup_sql | wc -c)");
    const create = code.indexOf('CREATE DATABASE $(ident "$RESTORING")');
    expect(check).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(check);
    // 2. the load: the backup, then the renewal file and its call, into <name>_restoring; the producer failing stops the group before the call
    const load = code.slice(code.indexOf("backup_sql || exit 1"), code.indexOf('psql_on "$RESTORING"'));
    expect(load.indexOf('cat "$RENEWAL_SQL"')).toBeGreaterThan(0);
    expect(load.indexOf('printf \'%s\\n\' "$call"')).toBeGreaterThan(load.indexOf('cat "$RENEWAL_SQL"'));
    // 3. the swap comes after the outcome, only an outcome of renewed (0), no node id at all (3) or kept on request (5) reaches it,
    //    and it is one transaction
    const outcome = code.indexOf('renewalOutcome "$out"'), swap = code.indexOf('swap="BEGIN;"');
    expect(swap).toBeGreaterThan(outcome);
    expect(code.slice(outcome, swap)).toMatch(/0\|3\|5\) ;;/);
    expect(code.slice(outcome, swap)).toMatch(/4\) discard[\s\S]*exit 1 ;;/);
    expect(code.slice(outcome, swap)).toMatch(/\*\) [\s\S]*discard[\s\S]*exit 1 ;;/);
    expect(code).toMatch(/swap\+=" ALTER DATABASE \$\(ident "\$RESTORING"\) RENAME TO \$\(ident "\$TARGET"\); COMMIT;"/);
    // kept (5) is only reachable with --keep-node-id
    expect(code).toMatch(/--keep-node-id\) KEEP_ID=1 ;;/);
    expect(code).toMatch(/call=\$\(renewalCall "\$overwritten" "\$KEEP_ID"\)/);
    expect(RESTORE).not.toMatch(/WARNING: this backup was made by a version before/);
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

  it("there is one shell entry and one SQL file, and the file calls the one SQL function", () => {
    expect(ENTRY).toMatch(/^renewNodeId\(\) \{/m);
    expect(ENTRY).toMatch(/^renewalCall\(\) \{/m);
    expect(ENTRY).toMatch(/pg_temp\.onden_renew_after_restore\(/);
    expect(ENTRY).toMatch(/cat "\$RENEWAL_SQL"/);
    expect(RENEWAL_FILE).toMatch(/FROM sync_renew_node_id\(\) r;/);
    for (const [name, text] of [["restore.sh", RESTORE], ["restore-drill.sh", DRILL]] as const) {
      const commands = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
      expect(commands, `${name} calls the SQL itself instead of the entry`).not.toMatch(/sync_renew_node_id|onden_renew_after_restore/);
    }
  });

  it("scripts/lib/renewNodeId.sql is what scripts/lib/renewNodeIdSql.mjs makes from the migrations today (run it with --write after a migration redefines one of the functions)", () => {
    expect(RENEWAL_FILE).toBe(renewalSql(MIGRATIONS));
    // each installed definition is, byte for byte, the last migration's (the guard's own reading of "last", below)
    for (const fn of RENEWAL_FUNCTIONS) {
      const last = lastDefinitionOf(fn, MIGRATIONS)!;
      expect(lastDefinition(fn, MIGRATIONS)?.file, fn).toBe(last[0]);
      expect(RENEWAL_FILE).toContain(`-- ${last[0]}\n      EXECUTE $onden_def$${definitionsOf(fn, last[1]).at(-1)}`);
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

  // By meaning, not by a list of files (review of PR #1853, round 2): only the BODY of a definition of sync_take_node_id() writes sync_node; only the body of a
  // definition of sync_renew_node_id() calls sync_take_node_id(); outside definitions no migration and no product code writes sync_node or calls either, except the
  // two entries that exist (src/browser/nodeIdentity.ts takes the browser copy's first id; scripts/lib/renewNodeId.sh renews, tested above), found from the code.
  it("only the body of sync_take_node_id() writes sync_node, only sync_renew_node_id() and the browser copy call it, and no migration calls either", () => {
    const v = nodeIdViolations(backendSources());
    expect(v.writes).toEqual([]);
    expect(v.migrationCalls).toEqual([]);
    expect(v.productCallers).toEqual(["src/browser/nodeIdentity.ts"]);
    expect(backendSources().some(([path, text]) => path.startsWith("db/migrations/") && definitionsOf("sync_take_node_id", text).length > 0)).toBe(true);
  });
  it("the rule above, on made-up files: a third migration that writes sync_node is caught; one that redefines sync_carried_labels() is not", () => {
    const take = "CREATE OR REPLACE FUNCTION sync_take_node_id() RETURNS void AS $$\nBEGIN\n  UPDATE sync_node SET node_id = 'x';\nEND;\n$$ LANGUAGE plpgsql;";
    const renew = "CREATE OR REPLACE FUNCTION sync_renew_node_id() RETURNS void AS $$\nBEGIN\n  PERFORM 1 FROM sync_take_node_id();\nEND;\n$$ LANGUAGE plpgsql;";
    const base: [string, string][] = [["db/migrations/213_x.sql", `${take}\n${renew}`], ["src/browser/nodeIdentity.ts", "await q(`SELECT * FROM sync_take_node_id()`);"]];
    expect(nodeIdViolations(base)).toEqual({ writes: [], migrationCalls: [], productCallers: ["src/browser/nodeIdentity.ts"] });
    expect(nodeIdViolations([...base, ["db/migrations/300_y.sql", "UPDATE sync_node SET node_id = 'mine';"]]).writes).toEqual(["db/migrations/300_y.sql"]);
    expect(nodeIdViolations([...base, ["db/migrations/301_z.sql", "SELECT * FROM sync_take_node_id();"]]).migrationCalls).toEqual(["db/migrations/301_z.sql"]);
    expect(nodeIdViolations([...base, ["src/services/x.ts", "q(`SELECT sync_renew_node_id()`)"]]).productCallers).toEqual(["src/browser/nodeIdentity.ts", "src/services/x.ts"]);
    expect(nodeIdViolations([...base, ["db/migrations/302_labels.sql", "CREATE OR REPLACE FUNCTION sync_carried_labels() RETURNS text[] AS $$ SELECT ARRAY['a']::text[]; $$ LANGUAGE sql;"],
      ["db/migrations/303_renew_again.sql", renew]])).toEqual({ writes: [], migrationCalls: [], productCallers: ["src/browser/nodeIdentity.ts"] });
  });
});

/** The bodies (between the `$$` after the header and the closing `$$`) of every `CREATE OR REPLACE FUNCTION fn(` in `text`. */
function definitionsOf(fn: string, text: string): string[] {
  const out: string[] = [];
  const head = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`, "g");
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const open = text.indexOf("$$", m.index);
    const close = open < 0 ? -1 : text.indexOf("$$", open + 2);
    if (close > 0) out.push(text.slice(m.index, close + 2));
  }
  return out;
}
/** `text` without the definitions of `fns` (what is left is what runs outside them). */
const outside = (text: string, fns: readonly string[]) => fns.reduce((t, fn) => definitionsOf(fn, t).reduce((u, d) => u.replace(d, ""), t), text);
const WRITES_NODE = /UPDATE\s+sync_node\b|INSERT\s+INTO\s+sync_node\b[^;]*DO\s+UPDATE/i;
const CALLS = /\bsync_take_node_id\(\)|\bsync_renew_node_id\(\)/;
function nodeIdViolations(sources: readonly (readonly [string, string])[]): { writes: string[]; migrationCalls: string[]; productCallers: string[] } {
  const writes: string[] = [], migrationCalls: string[] = [], productCallers: string[] = [];
  for (const [path, raw] of sources) {
    const text = CODE(raw);
    // a write outside the body of sync_take_node_id()
    if (WRITES_NODE.test(outside(text, ["sync_take_node_id"]))) writes.push(path);
    // sync_take_node_id() inside any definition but sync_renew_node_id()'s, or a call of either outside a definition
    const rest = outside(text, ["sync_renew_node_id", "sync_take_node_id"]);
    if (path.startsWith("db/migrations/")) { if (CALLS.test(rest)) migrationCalls.push(path); }
    else if (CALLS.test(rest)) productCallers.push(path);
  }
  return { writes: writes.sort(), migrationCalls: migrationCalls.sort(), productCallers: productCallers.sort() };
}

describe("the browser copy takes its id only after its migrations ran (sync_take_node_id is migration 213's)", () => {
  it("src/browser/worker.ts calls migrate() before ensureOwnNodeId()", () => {
    const worker = CODE(read("packages/backend/src/browser/worker.ts"));
    const migrateAt = worker.indexOf("await migrate({ seedNativeActor: false })");
    expect(migrateAt).toBeGreaterThan(-1);
    expect(worker.indexOf("await ensureOwnNodeId()")).toBeGreaterThan(migrateAt);
  });
});

// The restore scripts as a person runs them, against a stand-in psql / docker that writes down what it was given and answers like a live
// database would. What the SQL does is proved on PGlite and Postgres in src/test/restoreRenewalSql.integration.test.ts; restore.sh against
// a real server (CI: PG 18 with pgroonga) in src/test/restoreScript.postgres.integration.test.ts; every era of backup, cut and killed runs in
// the PR that made this (own-node-transport-2026-11-22.md §6 batch 3).
// Formerly pinned here: a backup older than migration 213 was restored with a WARNING, exit 0, and the OLD node id. Now it is renewed.
const OLD_ID = "c2c99cde-163c-4164-b342-8bb94744b0cc", NEW_ID = "1d27eb1c-f154-47d9-a868-068881ab3bcc", REPLACED_ID = "9811c8e6-150b-4002-b84b-cbc79c29694a";
const TRAILER = "\n--\n-- PostgreSQL database dump complete\n--\n";
type Load = { out?: string; err?: string; code?: number };

/** The body of a stand-in psql (DATABASE_URL mode) or `docker` (compose mode): answers restore.sh's reads like a live database that has a
 *  node id (`hasNode`), saves the load's stdin to `stream`, remembers a swap, and writes every call (with .env's version, for docker) to `log`. */
function fakeBody(dir: string, opts: { hasNode: boolean; load: Load; envFile?: string }) {
  const log = join(dir, "calls.log"), stream = join(dir, "stream.sql");
  writeFileSync(join(dir, "load.out"), opts.load.out ?? "");
  writeFileSync(join(dir, "load.err"), opts.load.err ?? "");
  const version = opts.envFile ? `$(sed -n 's/^ONDEN_VERSION=//p' "${opts.envFile}")` : "-";
  return `#!/usr/bin/env bash
printf '%s | version=%s\\n' "$*" "${version}" >> "${log}"
case "$*" in
  "compose version") exit 0 ;;
  *"ps --status running --services"*) echo postgres ;;
  *"config --services"*) printf 'postgres\\nbackend\\n' ;;
  *"backup once"*) echo "[backup] STAMP=20261121T000000Z" ;;
  *"--entrypoint sh backend"*) cat > /dev/null ;;
  *"-f -"*) cat > "${stream}"; cat "${join(dir, "load.out")}"; cat "${join(dir, "load.err")}" >&2; exit ${opts.load.code ?? 0} ;;
  *"string_agg"*) ;;
  *"ALTER DATABASE"*) touch "${join(dir, "swapped")}"; [[ -n "\${FAKE_SWAP_SLOW:-}" ]] && { touch "${join(dir, "swapping")}"; sleep 10 & wait; } ;;
  *"_before_restore_"*) [[ -f "${join(dir, "swapped")}" ]] && echo 1 || echo 0 ;;
  *"FROM pg_database WHERE datname"*) echo 1 ;;
  *"pg_stat_activity"*) ;;
  *"pg_get_userbyid"*) echo onden ;;
  *"to_regclass('public.sync_node') IS NOT NULL"*) echo ${opts.hasNode ? "t" : "f"} ;;
  *"to_regclass('public.workspaces') IS NOT NULL"*) echo t ;;
  *"count(*) FROM public.workspaces"*) echo "\${FAKE_WORKSPACES:-1}" ;;
  *"SELECT node_id FROM public.sync_node"*) echo ${REPLACED_ID} ;;
  *"pg_database_size"*) echo 1000 ;;
  *"df -Pk"*) echo "overlay 100000000 1 99999999 1% /" ;;
esac
exit 0
`;
}
function fakePsql(dir: string, opts: { hasNode: boolean; load: Load }) {
  writeFileSync(join(dir, "psql"), fakeBody(dir, opts));
  chmodSync(join(dir, "psql"), 0o755);
  return { log: join(dir, "calls.log"), stream: join(dir, "stream.sql") };
}
const dumpIn = (dir: string, sql: string) => { const p = join(dir, "onden-20261101T000000Z.sql.gz"); writeFileSync(p, gzipSync(sql)); return p; };
const runRestore = (dir: string, dump: string, ...flags: string[]) => spawnSync("bash", [join(REPO, "scripts/restore.sh"), dump, "--yes", ...flags], {
  env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden" }, encoding: "utf8",
});
const renewedRow = (origins = 1) => `onden-renewal renewed ${OLD_ID} ${NEW_ID} 1 ${origins} -\n`;

describe("scripts/restore.sh: every restore ends on a new node id, or refuses and changes nothing", () => {
  const work = mkdtempSync(join(tmpdir(), "restore-renews-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const caseDir = (name: string) => { const d = join(work, name); mkdirSync(d); return d; };
  const DUMP_TEXT = `-- a backup older than migration 213: no CREATE FUNCTION public.sync_renew_node_id\nCREATE TABLE public.sync_node (singleton boolean);${TRAILER}`;
  const swapped = (log: string) => existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => /ALTER DATABASE "onden" RENAME TO "onden_before_restore_[0-9A-Z]+"; ALTER DATABASE "onden_restoring" RENAME TO "onden"; COMMIT;/.test(l));

  it("a backup older than migration 213: loaded into onden_restoring with the renewal after it, then swapped in; exit 0 with the new id", () => {
    const dir = caseDir("pre213");
    const { log, stream } = fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const run = runRestore(dir, dumpIn(dir, DUMP_TEXT));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`[restore] the restored database is a new node: id ${OLD_ID} -> ${NEW_ID}`);
    expect(run.stdout).toMatch(/\[restore\] the replaced database is kept as onden_before_restore_/);
    expect(run.stderr).not.toMatch(/WARNING/);
    const sent = readFileSync(stream, "utf8");
    expect(sent.startsWith(DUMP_TEXT)).toBe(true);
    expect(sent.indexOf(RENEWAL_FILE)).toBeGreaterThan(DUMP_TEXT.length - 1);
    expect(sent.trimEnd().endsWith("FROM pg_temp.onden_renew_after_restore(NULL, false);")).toBe(true);
    const calls = readFileSync(log, "utf8").split("\n");
    expect(calls.find((l) => l.includes("-f -"))).toMatch(/postgres:\/\/nobody@localhost\/onden_restoring /);
    expect(swapped(log)).toBe(true);
  });

  it("over a database that had another id (restored since the backup): that id is passed to the renewal, to be kept as a former id", () => {
    const dir = caseDir("replaced");
    const { stream } = fakePsql(dir, { hasNode: true, load: { out: renewedRow(2) } });
    const run = runRestore(dir, dumpIn(dir, DUMP_TEXT));
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(stream, "utf8").trimEnd().endsWith(`FROM pg_temp.onden_renew_after_restore('${REPLACED_ID}', false);`)).toBe(true);
    expect(run.stdout).toMatch(/former ids recorded: 2/);
  });

  it("a backup from migrations 190 to 205 is refused (exit 1, no swap) and the message names --keep-node-id; with it, the backup goes back with a WARNING", () => {
    const dir = caseDir("e190");
    const { log } = fakePsql(dir, { hasNode: true, load: { err: "psql:<stdin>:9: ERROR:  onden-restore: no-origins-table\n", code: 3 } });
    const run = runRestore(dir, dumpIn(dir, DUMP_TEXT));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ERROR: restore refused, nothing was changed: this backup was made by a version that numbered its writes but had no table to record a former node id \(migrations 190 to 205/);
    expect(run.stderr).toMatch(/--keep-node-id/);
    expect(run.stdout).not.toMatch(/done\.|is a new node/);
    expect(swapped(log)).toBe(false);

    const kept = caseDir("e190-keep");
    const k = fakePsql(kept, { hasNode: true, load: { out: `onden-renewal kept ${OLD_ID} ${OLD_ID} 0 0 no-origins-table\n` } });
    const again = runRestore(kept, dumpIn(kept, DUMP_TEXT), "--keep-node-id");
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(k.stream, "utf8").trimEnd().endsWith(`FROM pg_temp.onden_renew_after_restore('${REPLACED_ID}', true);`)).toBe(true);
    expect(again.stderr).toMatch(/WARNING: --keep-node-id: the restored database was NOT given a new node id/);
    expect(again.stderr).toMatch(/sync_restore_kept_node_id/);
    expect(swapped(k.log)).toBe(true);
  });

  it("a cut backup, a load that fails, or one that answers without a renewal row: exit 1, no swap, never 'done'", () => {
    for (const [name, text, load] of [
      ["cut", DUMP_TEXT.replace(TRAILER, "\n"), { out: renewedRow() }],
      ["broken", DUMP_TEXT, { err: "ERROR:  syntax error at or near \"x\"\n", code: 3 }],
      ["silent", DUMP_TEXT, { out: "" }],
    ] as const) {
      const dir = caseDir(name);
      const { log } = fakePsql(dir, { hasNode: false, load });
      const run = runRestore(dir, dumpIn(dir, text));
      expect(run.status, name).toBe(1);
      expect(run.stderr, name).toMatch(name === "cut" ? /damaged or incomplete[\s\S]*Nothing was changed/ : /the database is as it was before/);
      expect(run.stdout, name).not.toMatch(/done\./);
      expect(swapped(log), name).toBe(false);
    }
  });

  it("interrupted while the swap is being sent, after it went through: says the restore HAD completed (never 'as it was'), exit 130 (review round 2, point 1)", async () => {
    const dir = caseDir("interrupt-swap");
    fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const child = spawn("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden", FAKE_SWAP_SLOW: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += String(c); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 200 && !existsSync(join(dir, "swapping")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dir, "swapping"))).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(130);
    expect(stderr).toMatch(/interrupted, but the restore HAD completed/);
    expect(stderr).not.toMatch(/as it was/);
  }, 30_000);

  it("interrupted while loading (before the swap): the live database is as it was, and the new database is dropped", async () => {
    const dir = caseDir("interrupt-load");
    writeFileSync(join(dir, "psql"), fakeBody(dir, { hasNode: false, load: { out: renewedRow() } }).replace('*"-f -"*) cat >', '*"-f -"*) touch "' + join(dir, "loading") + '"; sleep 10 & wait; cat >'));
    chmodSync(join(dir, "psql"), 0o755);
    const child = spawn("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden" },
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += String(c); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 200 && !existsSync(join(dir, "loading")); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill("SIGTERM");
    expect(await exited).toBe(130);
    expect(stderr).toMatch(/interrupted: the live database is as it was/);
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    expect(calls).toMatch(/DROP DATABASE IF EXISTS "onden_restoring" WITH \(FORCE\)[^\n]*\n[\s\S]*DROP DATABASE IF EXISTS "onden_restoring" WITH \(FORCE\)/);
    expect(calls).not.toMatch(/ALTER DATABASE/);
  }, 30_000);

  // the laptop drill of 2026-11-22: here `swapped` answers "not yet", and under set -e the old trap ended the script on that answer, silently
  it("interrupted after the load, before the swap is sent: says the live database is as it was, drops the new database, never swaps, exit 130", async () => {
    const dir = caseDir("interrupt-before-swap");
    fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const hold = join(dir, "hold");
    const child = spawn("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden", ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP: hold },
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += String(c); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 200 && !existsSync(hold); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(hold)).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(130);
    expect(stderr).toMatch(/interrupted: the live database is as it was/);
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    expect(calls.split("\n").filter((l) => l.includes(`DROP DATABASE IF EXISTS "onden_restoring" WITH (FORCE)`))).toHaveLength(2);
    expect(calls).not.toMatch(/ALTER DATABASE/);
  }, 30_000);

  it("a second restore of the same database while one runs is refused and changes nothing; once the first is gone, its lock is taken over", async () => {
    const dir = caseDir("lock");
    fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const hold = join(dir, "hold");
    const lockDir = join(dir, "tmp");
    mkdirSync(lockDir, { recursive: true });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden", TMPDIR: lockDir };
    const first = spawn("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], { env: { ...env, ONDEN_RESTORE_TEST_HOLD_BEFORE_SWAP: hold } });
    const firstExited = new Promise<number | null>((resolve) => first.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 200 && !existsSync(hold); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(hold)).toBe(true);
    const lockName = readdirSync(lockDir).find((f) => f.startsWith("onden-restore-"));
    expect(lockName, "the first run holds a lock").toBeDefined();
    const before = readFileSync(join(dir, "calls.log"), "utf8").length;
    const second = spawnSync("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], { env, encoding: "utf8" });
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/another restore of this database is running/);
    expect(readFileSync(join(dir, "calls.log"), "utf8").slice(before), "the second run asked the server nothing").toBe("");
    rmSync(hold, { force: true });
    expect(await firstExited).toBe(0);
    // a lock left by a process that is gone (kill -9) does not block the next run
    expect(readdirSync(lockDir).filter((f) => f.startsWith("onden-restore-")), "released when the first run ended").toEqual([]);
    const stale = join(lockDir, lockName!);
    mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, "pid"), "999999\n");
    const third = spawnSync("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], { env, encoding: "utf8" });
    expect(third.status, third.stderr).toBe(0);
    expect(readdirSync(lockDir).filter((f) => f.startsWith("onden-restore-")), "the lock is released at the end").toEqual([]);
  }, 30_000);

  it("a database name too long for its copy's name (63 bytes, past which Postgres cuts names) is refused before anything is asked of the server", () => {
    const dir = caseDir("long-name");
    const { log } = fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const run = spawnSync("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: `postgres://nobody@localhost/${"n".repeat(40)}` }, encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/too long for its copy's name/);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  it("a target that holds no workspace (the empty schema compose starts with): the replaced database is dropped after the swap, not kept", () => {
    const dir = caseDir("empty-target");
    const { log } = fakePsql(dir, { hasNode: false, load: { out: renewedRow() } });
    const run = spawnSync("bash", [join(REPO, "scripts/restore.sh"), dumpIn(dir, DUMP_TEXT), "--yes"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: "postgres://nobody@localhost/onden", FAKE_WORKSPACES: "0", ONDEN_RESTORE_STAMP: "S9" }, encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/held no workspace \(an empty schema\), so it was not kept/);
    const calls = readFileSync(log, "utf8");
    expect(calls.indexOf(`DROP DATABASE "onden_before_restore_S9"`)).toBeGreaterThan(calls.indexOf("ALTER DATABASE"));
  });

  it("a backup with no node id at all (before migration 190) into an empty database: exit 0 and says the database takes its first id at its first write", () => {
    const dir = caseDir("pre190");
    fakePsql(dir, { hasNode: false, load: { out: "onden-renewal no-node-id - - 0 0 -\n" } });
    const run = runRestore(dir, dumpIn(dir, `CREATE TABLE public.content_nodes (id uuid);${TRAILER}`));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/has no node id \(made before migration 190/);
  });
});

describe("scripts/upgrade.sh rollback: the older image is pulled without touching .env; .env switches right before the restore; a refused restore puts it back", () => {
  const work = mkdtempSync(join(tmpdir(), "rollback-order-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const rollback = (name: string, load: Load) => {
    const dir = join(work, name), backups = join(dir, "backups");
    mkdirSync(backups, { recursive: true });
    const envFile = join(dir, ".env");
    writeFileSync(envFile, `ONDEN_VERSION=v2\nONDEN_BACKUP_DIR=${backups}\n`);
    writeFileSync(join(backups, "onden-20261101T000000Z.note.txt"), "pre-upgrade from=v1 to=v2\n");
    writeFileSync(join(backups, "onden-20261101T000000Z.sql.gz"), gzipSync(`SELECT 1;${TRAILER}`));
    writeFileSync(join(backups, "onden-content-20261101T000000Z.tar.gz"), gzipSync(""));
    writeFileSync(join(dir, "docker"), fakeBody(dir, { hasNode: false, load, envFile }));
    chmodSync(join(dir, "docker"), 0o755);
    const run = spawnSync("bash", [join(REPO, "scripts/upgrade.sh"), "rollback"], {
      input: "yes\n", encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ENV_FILE: envFile, HEALTH_TIMEOUT_S: "3", DATABASE_URL: "" },
    });
    return { run, calls: readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean), env: readFileSync(envFile, "utf8") };
  };

  it("the pull runs with .env still on the newer version; the load and the swap with .env on the older one; the content and the start after the swap", () => {
    const { run, calls, env } = rollback("ok", { out: renewedRow() });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    expect(calls[at(/ pull /)]).toMatch(/version=v2$/);
    const load = at(/psql/) >= 0 ? calls.findIndex((c) => /psql/.test(c) && /-f -/.test(c)) : -1;
    expect(load).toBeGreaterThan(at(/ pull /));
    expect(calls[load]).toMatch(/version=v1$/);
    const swap = at(/ALTER DATABASE/);
    expect(swap).toBeGreaterThan(load);
    expect(at(/backup once "?pre-rollback|backup once pre-rollback/)).toBeLessThan(load);
    expect(at(/--entrypoint sh backend/)).toBeGreaterThan(swap);
    expect(calls.map((c) => / up -d$/.test(c.split(" | ")[0]!)).lastIndexOf(true)).toBeGreaterThan(swap);
    expect(env).toMatch(/^ONDEN_VERSION=v1$/m);
    expect(run.stdout).toContain(`is a new node: id ${OLD_ID} -> ${NEW_ID}`);
  });

  it("a refused restore (a backup that cannot get a new id): .env names the newer version again, the services start, nothing of the content is touched, exit 1", () => {
    const { run, calls, env } = rollback("refused", { err: "ERROR:  onden-restore: no-origins-table\n", code: 3 });
    expect(run.status).toBe(1);
    expect(env).toMatch(/^ONDEN_VERSION=v2$/m);
    expect(calls.some((c) => /--entrypoint sh backend/.test(c))).toBe(false);
    expect(calls.some((c) => /ALTER DATABASE/.test(c))).toBe(false);
    expect(calls.at(-1)!).toMatch(/ up -d \| version=v2$/);
    expect(run.stderr).toMatch(/restore refused, nothing was changed/);
    expect(run.stderr).toMatch(/資料庫沒有還原/);
  });
});

/** The text of the LAST migration (by file name, the order migrate() runs them) that defines `fn`: the definition a database ends up with. A later migration
 *  that redefines a function is how it changes (an applied migration is never edited), so a check of the function reads this one, not a file by name. */
function lastDefinitionOf(fn: string, migrations: readonly (readonly [name: string, text: string])[]): readonly [string, string] | undefined {
  const defines = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`);
  return [...migrations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([, text]) => defines.test(text)).at(-1);
}
const MIGRATIONS = readdirSync(join(BACKEND, "db", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(BACKEND, "db", "migrations", f), "utf8")] as const);
/** The labels of the last `CREATE OR REPLACE FUNCTION sync_carried_labels()` in `text`. */
const carriedListOf = (text: string): string[] | undefined => {
  const body = text.slice(text.lastIndexOf("CREATE OR REPLACE FUNCTION sync_carried_labels("));
  return /ARRAY\[([^\]]*)\]/.exec(body)?.[1]?.split(",").map((l) => l.trim().replace(/^'|'$/g, ""));
};
const labelListOf = (text: string): string[] | undefined =>
  /jsonb_object_agg\(l, c\.next_seq - 1\) FROM unnest\(ARRAY\[([^\]]*)\]\)/.exec(text)?.[1]?.split(",").map((l) => l.trim().replace(/^'|'$/g, ""));

describe("the old id is held for every label a bundle carries (the migration that defines sync_renew_node_id() has its own copy of the list)", () => {
  it("the labels the last definition of sync_carried_labels() names are spine/stampedMerge/dbUnits.ts CARRIED_LABELS, in order, and the last sync_renew_node_id() reads it", async () => {
    const { CARRIED_LABELS } = await import("../../spine/stampedMerge/index.js");
    const labels = lastDefinitionOf("sync_carried_labels", MIGRATIONS);
    expect(labels, "no migration defines sync_carried_labels()").toBeDefined();
    // a label added to CARRIED_LABELS needs a NEW migration that redefines sync_carried_labels() with it (an applied migration is never edited)
    expect(carriedListOf(labels![1]), `${labels![0]} no longer names the labels`).toEqual([...CARRIED_LABELS]);
    const renew = lastDefinitionOf("sync_renew_node_id", MIGRATIONS);
    expect(renew![1]).toMatch(/jsonb_object_agg\(l, c\.next_seq - 1\) FROM unnest\(sync_carried_labels\(\)\) AS l/);
  }, 60_000);

  it("lastDefinitionOf takes the latest migration that defines the function, whatever order the files are listed in, and ignores ones that only call it", () => {
    const def = (labels: string) => `CREATE OR REPLACE FUNCTION sync_renew_node_id() … jsonb_object_agg(l, c.next_seq - 1) FROM unnest(ARRAY[${labels}]) AS l`;
    const files = [["300_later_redefinition.sql", def("'a', 'b', 'new_label'")], ["213_renew_node_id.sql", def("'a', 'b'")], ["400_only_a_caller.sql", "SELECT * FROM sync_renew_node_id();"], ["100_other.sql", "CREATE TABLE x (id int);"]] as const;
    expect(lastDefinitionOf("sync_renew_node_id", files)?.[0]).toBe("300_later_redefinition.sql");
    expect(labelListOf(lastDefinitionOf("sync_renew_node_id", files)![1])).toEqual(["a", "b", "new_label"]);
    expect(lastDefinitionOf("sync_renew_node_id", files.filter(([name]) => name !== "300_later_redefinition.sql"))?.[0]).toBe("213_renew_node_id.sql");
    expect(lastDefinitionOf("sync_renew_node_id", [["100_other.sql", "CREATE TABLE x (id int);"]])).toBeUndefined();
  });
});
