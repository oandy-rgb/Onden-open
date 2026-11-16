// realPostgresAlso: this file is the real-Postgres round trip; on PGlite the same two processes each hold an in-memory PGlite.
// A workspace copied from one database to another, each held by a process of its own (the way two devices are), through
// GET and POST /api/snapshot, and the two databases compared afterwards: by the digest the source made, and by reading the rows and
// stamps of both back as JSON. The other files (stampedSnapshot.integration.test.ts) run two PGlite databases in one process, which
// only PGlite allows; this is the same round trip with one database per process, which is what a real server needs. On a real Postgres
// it makes two empty databases on the server of DATABASE_URL (names end in _test), builds each from db/schema.sql and the
// migrations, and drops both at the end.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildDatabase } from "./helpers/databaseBuild.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { compareRowHashes, type TableHashes } from "./helpers/stampedRowHashes.js";
import { compareDigests, type StampedPage, type TableDigest } from "../spine/snapshotSql.js";
import { SHELL_EMPTY_CHECKS, SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { NO_OWN_SHELL_CASE, SHELL_CASES } from "./helpers/stampedShellCases.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "../..");
const worker = resolve(here, "helpers/stampedTwoProcessWorker.ts");

const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";
const tag = randomUUID().replaceAll("-", "").slice(0, 10);
const names = { source: `stampsnap_a_${tag}_test`, receiver: `stampsnap_b_${tag}_test`, damaged: `stampsnap_c_${tag}_test`, shells: `stampsnap_d_${tag}_test`, crash: `stampsnap_e_${tag}_test` };
const urlOf = (database: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; return url.toString(); };

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function makeDatabase(name: string): Promise<void> {
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const c = new pg.Client({ connectionString: urlOf(name) });
  await c.connect();
  try { await buildDatabase(c); } finally { await c.end(); }
}
/** The worker as a process of its own, with one database. */
async function worked(database: string, args: string[], persistIn?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", NODE_ENV: "test", LOG_LEVEL: "warn", VITEST: "", VITEST_WORKER_ID: "", ONDEN_TEST_DB_KEEP: "" };
  if (onPglite) {
    env.ONDEN_PGLITE_DIR = persistIn ?? "memory://"; // one in-memory database for this process, from the migrated template the run built
    // (a database that has to outlive its process, to be started again, is a directory that is migrated from nothing at its first start)
    if (persistIn) delete env.ONDEN_PGLITE_SNAPSHOT;
  }
  else env.DATABASE_URL = urlOf(database);
  if (!persistIn) { /* in memory: nothing to keep */ }
  try { await run("npx", ["tsx", worker, ...args], { cwd: backendDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 280_000 }); }
  catch (e) { throw new Error(`the worker (${args[0]}) failed: ${(e as { stderr?: string }).stderr ?? e}`); }
}

type Exported = { wholeTables: TableHashes; pagesRaw: StampedPage[]; second: { pages: StampedPage[]; summary: Exported["summary"] }; unstamped: number; world: { ws: string; owner: { id: string }; secretNote: string }; summary: { source: string; cut: number; pages: number; digest: TableDigest[] }; stream: string; hidden: string[]; rows: Record<string, string[]>; stamps: unknown[] };
type Imported = { wholeTables: TableHashes; status: number; answer: { pages?: number }; join: Array<{ state: string; applied_through: number }>; digest: TableDigest[]; rows: Record<string, string[]>; stamps: unknown[]; node: string; login: string | null };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const firstRow = (pages: StampedPage[], table: string) => { for (const p of pages) for (const i of p.items) if (i.kind === "row" && i.table === table) return i; throw new Error(`no ${table} row`); };

/** What each damaged copy must be refused with (a pattern over the refusal's code and message), and the copy itself: the source's own pages, spoiled. */
const DAMAGE: Record<string, { expect: RegExp; copy: (source: Exported) => { pages: StampedPage[]; summaryPages?: number; summary?: Exported["summary"]; direct?: boolean } }> = {
  "a value changed in one row (the digests differ)": { expect: /differs from the source/, copy: (s) => { const pages = clone(s.pagesRaw); firstRow(pages, "content_nodes").values.title = "Quietly rewritten"; return { pages }; } },
  "a stamp changed in one place (only the digest can see it)": { expect: /differs from the source/, copy: (s) => { const pages = clone(s.pagesRaw); const row = firstRow(pages, "content_nodes"); if (row.kind === "row") row.stamps[0]!.deleted = !row.stamps[0]!.deleted; return { pages }; } },
  "a page that never arrives": { expect: /differs from the source|violates|did not arrive/, copy: (s) => ({ pages: s.pagesRaw.filter((p) => p.page !== 2), summaryPages: s.pagesRaw.length }) },
  "a page that never arrives, the finish asked for directly": { expect: /did not arrive/, copy: (s) => ({ pages: s.pagesRaw.filter((p) => p.page !== 2), summaryPages: s.pagesRaw.length, direct: true }) },
  "pages in the wrong order": { expect: /violates|not present|foreign key|constraint|order/, copy: (s) => ({ pages: clone(s.pagesRaw).reverse() }) },
  "two exports mixed into one": { expect: /another export/, copy: (s) => ({ pages: [...clone(s.pagesRaw.slice(0, 2)), ...clone(s.second.pages.slice(2))], summary: s.second.summary, summaryPages: s.second.pages.length }) },
  // (every stamp of that one write — one stamp number — is moved, else the copy would be refused first for naming one number with two contents)
  "a stamp far ahead of this machine's clock": { expect: /stamp_clock_ahead|ahead/, copy: (s) => { const pages = clone(s.pagesRaw); const all = pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" ? i.stamps : i.kind === "tombstone" ? [i.stamp] : [])); const chosen = all.find((x) => x.origin === s.summary.source)!; for (const x of all) if (x.origin === chosen.origin && x.seq === chosen.seq) x.wall = Date.now() + BOUND + 3_600_000; return { pages }; } },
  "a row with no stamp at all (this database's own pass would stamp it)": { expect: /join_unstamped_rows|without a stamp|differs from the source/, copy: (s) => { const pages = clone(s.pagesRaw); const row = firstRow(pages, "spaces"); if (row.kind === "row") row.stamps = []; return { pages, direct: true }; } },
};
const BOUND = 10 * 60 * 1000;
function damagedCopies(source: Exported) {
  return Object.entries(DAMAGE).map(([name, d]) => {
    const c = d.copy(source);
    return { name, direct: c.direct ?? false, pages: c.pages, summary: { ...(c.summary ?? source.summary), pages: c.summaryPages ?? c.pages.length } };
  });
}

describe.skipIf(!onPglite && !isTestDatabase())("a snapshot copied between two databases, one process each", { timeout: 300_000 }, () => {
  let dir = "";
  let source!: Exported;
  let receiver!: Imported;
  let refused!: Array<{ name: string; refusal: { code: string | null; message: string } | null; left: Record<string, string> }>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stampsnap-"));
    if (!onPglite) await Promise.all([makeDatabase(names.source), makeDatabase(names.receiver), makeDatabase(names.damaged), makeDatabase(names.shells), makeDatabase(names.crash)]);
    await worked(names.source, ["export", join(dir, "source.json")]);
    await worked(names.receiver, ["import", join(dir, "source.json"), join(dir, "receiver.json")]);
    source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8"));
    writeFileSync(join(dir, "cases.json"), JSON.stringify({ world: source.world, cases: damagedCopies(source) }));
    await worked(names.damaged, ["refuse", join(dir, "cases.json"), join(dir, "refused.json")]);
    refused = JSON.parse(readFileSync(join(dir, "refused.json"), "utf8"));
    receiver = JSON.parse(readFileSync(join(dir, "receiver.json"), "utf8"));
  }, 290_000);
  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!onPglite) await admin(async (c) => { for (const name of Object.values(names)) await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); });
  });

  it("fills the empty database through POST /api/snapshot, and that database is done", () => {
    expect(receiver.status).toBe(200);
    const sent = source.stream.trim().split("\n").filter((line) => (JSON.parse(line) as { kind: string }).kind === "page").length;
    expect(sent).toBeGreaterThan(0);
    expect(receiver.answer.pages).toBe(sent);
    expect(receiver.join).toEqual([{ state: "done", applied_through: sent }]);
    expect(source.summary.pages).toBeGreaterThan(2); // the digest was made over a snapshot cut into small pages: the pages do not change what is read
  });

  it("holds the same in every carried table, in rows and in stamps: the source's digest against what the receiver counts", () => {
    expect(compareDigests(source.summary.digest, receiver.digest)).toEqual([]);
    const rows = Object.fromEntries(source.summary.digest.map((d) => [d.table, d.rows]));
    for (const spec of SNAPSHOT_SPECS) expect(rows[spec.table], `no ${spec.table} row in the world`).toBeGreaterThan(0);
  });

  it("holds the same row by row, read back as JSON: every carried column, every stamp, one by one", () => {
    for (const table of Object.keys(source.rows)) expect(source.rows[table]!.length, `no ${table} row to compare`).toBeGreaterThan(0);
    expect(receiver.rows).toEqual(source.rows);
    expect(source.stamps.length).toBeGreaterThan(50);
    expect(receiver.stamps).toEqual(source.stamps);
  });

  it("holds every row of every carried table, whole tables hashed by SQL that uses neither the digest nor the snapshot's selection: the source has nothing the receiver lacks except what is left out on purpose", () => {
    const comparison = compareRowHashes(source.wholeTables, receiver.wholeTables);
    for (const spec of SNAPSHOT_SPECS) expect(Object.keys(source.wholeTables[spec.table] ?? {}).length, `no ${spec.table} row in the world`).toBeGreaterThan(0);
    expect(comparison.filter((c) => c.missingNotAllowed > 0 || c.extra > 0 || c.different > 0), JSON.stringify(comparison)).toEqual([]);
    // the comparison does look: it finds rows the source has and the receiver does not (the friend's, the space nobody is in …), each one expected
    const missing = Object.fromEntries(comparison.filter((c) => c.missing > 0).map((c) => [c.table, c.missing]));
    // (spaces: the friend's own space, the space only they are in, and — only on a database whose migrations ran from the start, not one built from db/schema.sql — the install's restricted space nobody is in)
    const { spaces, ...others } = missing;
    expect(others).toEqual({ actor_prefs: 1, ai_edit_suggestion_items: 1, content_nodes: 1, node_edges: 1, space_members: 2 });
    expect([2, 3]).toContain(spaces);
    // and the system space and the Site Config note are NOT among the missing ones
    const lacking = (table: string) => Object.entries(source.wholeTables[table]!).filter(([key]) => !(key in receiver.wholeTables[table]!));
    expect(lacking("content_nodes").every(([, row]) => row.allowed)).toBe(true);
    expect(lacking("spaces").every(([, row]) => row.allowed)).toBe(true);
  });

  it("carries the system space and the edited Site Config note, which no member reads as a note; and the rows the source had no stamp for", () => {
    const has = (table: string, text: string) => source.rows[table]!.some((row) => row.includes(text));
    expect(has("spaces", '"kind":"system"')).toBe(true);
    expect(has("content_nodes", "_workspace_config")).toBe(true);
    expect(has("node_attributes", "Round trip (edited)")).toBe(true);
    // the worker took the stamps of the workspace row and of one space away before the export: it stamped them as genesis, the copy matches
    expect(source.unstamped).toBeGreaterThan(0); // (on a real server the workspace row of a boot seed had none to begin with)
    expect((source.stamps as Array<{ table_name: string; origin: string }>).some((s) => s.table_name === "workspaces" && s.origin === "genesis")).toBe(true);
  });

  it("keeps the source's stamps as they were: its node and genesis only, never the receiver's own id; and carries nothing the owner cannot read", () => {
    const origins = new Set((receiver.stamps as Array<{ origin: string }>).map((s) => s.origin));
    expect(origins.has(source.summary.source)).toBe(true);
    expect(origins.has(receiver.node)).toBe(false);
    expect([...origins].every((o) => o === source.summary.source || o === "genesis")).toBe(true);
    expect(receiver.node).not.toBe(source.summary.source);
    expect(JSON.stringify(receiver.rows)).not.toContain("private words");
    expect(source.hidden).toContain(source.world.secretNote);
    expect(receiver.login).toBe("login-of-local");
  });

  for (const [name, d] of Object.entries(DAMAGE)) {
    it(`refuses ${name}, and leaves nothing of the workspace behind`, () => {
      const result = refused.find((r) => r.name === name)!;
      expect(result.refusal, "was not refused").not.toBeNull();
      expect(`${result.refusal!.code ?? ""} ${result.refusal!.message}`).toMatch(d.expect);
      expect(result.left).toEqual({ workspaces: "0", content_nodes: "0", spaces: "0", actors: "0", sync_stamps: "0", sync_clock: "0", sync_join: "0" });
    });
  }

  describe("what is an empty shell, and a join cut off by a dead process", () => {
    type Shells = { fresh: { noPerson: string | null }; withPerson: string | null; results: Array<{ name: string; table: string; baseline: string | null; refusal: string | null; error?: string }>; after: { persons: string; again: string | null } };
    let shells!: Shells;
    beforeAll(async () => {
      await worked(names.shells, ["shells", join(dir, "shells.json")]);
      shells = JSON.parse(readFileSync(join(dir, "shells.json"), "utf8"));
    }, 290_000);

    it("a fresh install is an empty shell, before and after its first sign-in (the product's own sign-in, on this engine)", () => {
      expect(shells.fresh.noPerson, "before anyone signed in").toBeNull();
      expect(shells.withPerson, "after the first sign-in").toBeNull();
    });

    it("every kind of thing a person puts in a database makes it not empty: refused with join_not_empty, and the database is as it was", () => {
      const wrong = shells.results.filter((r) => r.refusal !== "join_not_empty");
      expect(wrong, JSON.stringify(wrong)).toEqual([]);
      // ...and not for the row the case needed to point at: with only that row (a built-in tag, the Site Config note) the database is still empty
      expect(shells.results.filter((r) => r.baseline !== null), "a case that is refused already before it adds its own row").toEqual([]);
      expect(shells.results).toHaveLength(SHELL_CASES.length);
      expect(shells.after).toEqual({ persons: "1", again: null });
    });

    it("has a case for every table a snapshot carries and every table that must be empty, or says why not", () => {
      const reasons = new Set(SHELL_CASES.map((c) => c.reason));
      // (the tables the snapshot does not carry that must be empty are the bare `SELECT 1 FROM <table>` probes of the shell checks)
      const mustBeEmpty = SHELL_EMPTY_CHECKS.flatMap((check) => /^SELECT 1 FROM (\w+)$/.exec(check.sql)?.[1] ?? []);
      const tables = [...SNAPSHOT_SPECS.map((spec) => spec.table), ...mustBeEmpty];
      expect(tables.filter((t) => !reasons.has(t) && t !== "stamp" && !(t in NO_OWN_SHELL_CASE)), "add a case to helpers/stampedShellCases.ts, or an exemption with its reason").toEqual([]);
      expect(Object.keys(NO_OWN_SHELL_CASE).filter((t) => !tables.includes(t) || reasons.has(t)), "a stale exemption").toEqual([]);
    });

    it(`${onPglite ? "ends without giving up" : "is killed (SIGKILL)"} after one page: the next start finds an empty, usable database with the same person, and the join can be made again`, async () => {
      const keep = onPglite ? join(dir, "crash-db") : undefined;
      // (the process kills itself: SIGKILL on a real server, so `worked` reports a failure and the proof that it got that far is the file it wrote first)
      await worked(names.crash, ["half", join(dir, "source.json"), join(dir, "half.json")], keep).then(() => { if (!onPglite) throw new Error("the half-way process was not killed"); }, (e) => { if (onPglite) throw e; });
      const half = JSON.parse(readFileSync(join(dir, "half.json"), "utf8")) as { person: string; write: { status?: number; code?: string } };
      expect(half.write.code, "a workspace that is being joined takes no ordinary write").toBe("workspace_joining");
      await worked(names.crash, ["boot", join(dir, "boot.json")], keep);
      const boot = JSON.parse(readFileSync(join(dir, "boot.json"), "utf8")) as { ws: string; people: Array<{ id: string; external_id: string | null; owner: boolean }>; joins: number; workspaces: string; accepts: string | null };
      expect(boot.joins).toBe(0);
      expect(boot.workspaces).toBe("1");
      expect(boot.ws).not.toBe(source.world.ws);
      expect(boot.people).toEqual([{ id: half.person, external_id: "login-of-local", owner: true }]); // the same person, with the sign-in and the ownership
      expect(boot.accepts, "the database is an empty shell again").toBeNull();
    }, 290_000);
  });
});
