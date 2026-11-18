// A vitest reporter that stops tests from vanishing with a green exit.
//
// Integration tests sit behind `describe.skipIf(!isTestDb)` and, on PGlite, behind named `needs…` skips. Without a
// database they all skip and the run still exits 0, which is how ~2,900 backend tests went unrun in a "passing" lane.
// This reporter reads the finished run and says, at the end, how many tests ran and how many skipped (DB-gated
// files counted apart); then it fails the run when anything skipped that nobody listed:
//
//   mode                                   what may skip
//   ONDEN_TESTS_WITHOUT_DATABASE=1         anything (the run says it is a no-database run: `npm run test:no-db`)
//   ONDEN_DB_DRIVER=pglite                 only what `expected.pglite` lists, per file and exact count
//   a `_test` DATABASE_URL (real Postgres) only what `expected.postgres` lists
//   no database and no flag                nothing: every DB-gated test would skip, so the run fails
//
// `strict: "gated"` limits the check to DB-gated files (the frontend has other, unrelated skips).
// A run with `-t <pattern>` skips everything else by design, so it is reported but never failed.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

export const NO_DATABASE_FLAG = "ONDEN_TESTS_WITHOUT_DATABASE";

export class SkipGateReporter {
  /** @param {{ strict?: "all" | "gated", isGated: (file: string, text: string) => boolean, expected?: { pglite?: Record<string, number>, postgres?: Record<string, number> } }} options */
  constructor(options) {
    this.options = { strict: "all", expected: {}, ...options };
    /** test file -> background jobs it left running at pool.end(), by registrant (see onUserConsoleLog) */
    this.leftBehind = new Map();
  }

  onInit(ctx) {
    this.root = ctx.config.root;
    this.filtered = Boolean(ctx.config.testNamePattern);
  }

  /** backend/src/dbClose.ts logs "pool.end() waited for N background job(s) in <file> [<registrant>: n, …]" when a test
   *  file closes the database with work still running. Recorded here, never a failure (decision in #1860). */
  onUserConsoleLog(log) {
    const m = /pool\.end\(\) waited for (\d+) background job\(s\) in (\S+) \[([^\]]*)\]/.exec(log.content);
    if (!m) return;
    const entry = this.leftBehind.get(m[2]) ?? { jobs: 0, byName: new Map() };
    entry.jobs += Number(m[1]);
    for (const part of m[3].split(", ")) {
      const [name, n] = part.split(": ");
      entry.byName.set(name, (entry.byName.get(name) ?? 0) + Number(n));
    }
    this.leftBehind.set(m[2], entry);
  }

  onTestRunEnd(testModules, _unhandledErrors, reason) {
    const noDatabase = process.env[NO_DATABASE_FLAG] === "1";
    const driver = process.env.ONDEN_DB_DRIVER === "pglite" ? "pglite" : "postgres";
    const mode = noDatabase ? "no-database" : driver === "pglite" ? "pglite" : /_test\b/.test(process.env.DATABASE_URL ?? "") ? "postgres" : "no DATABASE_URL";
    const tally = { gated: { ran: 0, skipped: 0 }, other: { ran: 0, skipped: 0 } };
    const skippedByFile = new Map();
    for (const module of testModules) {
      const file = relative(this.root, module.moduleId).split("\\").join("/");
      let text = "";
      try { text = readFileSync(module.moduleId, "utf8"); } catch { /* a virtual module: not DB-gated */ }
      const gated = this.options.isGated(file, text);
      const bucket = gated ? tally.gated : tally.other;
      for (const test of module.children.allTests()) {
        if (test.task?.mode === "todo") continue;
        if (test.result().state === "skipped") { bucket.skipped++; skippedByFile.set(file, [(skippedByFile.get(file)?.[0] ?? 0) + 1, gated]); }
        else bucket.ran++;
      }
    }
    const total = (key) => tally.gated[key] + tally.other[key];
    console.log(`\n[tests] mode: ${mode}. ran ${total("ran")}, skipped ${total("skipped")}; DB-gated files: ran ${tally.gated.ran}, skipped ${tally.gated.skipped}.`);
    if (this.leftBehind.size > 0) {
      console.log(`[tests] ${this.leftBehind.size} test file(s) closed the database with background work still running (recorded only; each should await it, e.g. awaitAllDispatchers):`);
      for (const [file, { jobs, byName }] of [...this.leftBehind].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${file} -> ${[...byName].map(([name, n]) => `${name}: ${n}`).join(", ")} (${jobs} job${jobs === 1 ? "" : "s"})`);
      }
    }
    if (noDatabase || this.filtered || reason !== "passed") return;

    const expected = this.options.expected[driver] ?? {};
    const problems = [];
    const files = new Set([...skippedByFile.keys(), ...testModules.map((m) => relative(this.root, m.moduleId).split("\\").join("/")).filter((f) => f in expected)]);
    for (const file of [...files].sort()) {
      const [skipped, gated] = skippedByFile.get(file) ?? [0, false];
      if (this.options.strict === "gated" && !gated && !(file in expected)) continue;
      const listed = expected[file] ?? 0;
      if (skipped > listed) problems.push(`${file}: ${skipped} skipped${listed ? `, ${listed} listed` : ", none listed"}`);
      else if (skipped < listed) problems.push(`${file}: only ${skipped} skipped but ${listed} listed (lower the count in the skip list)`);
    }
    if (problems.length === 0) return;
    const hint = tally.gated.skipped > 0 && mode === "no DATABASE_URL"
      ? "no database: set DATABASE_URL to a `_test` database (or ONDEN_DB_DRIVER=pglite with a `_test` URL), or start an explicit no-database run with ONDEN_TESTS_WITHOUT_DATABASE=1 (`npm run test:no-db`)."
      : "tests were skipped that the skip list for this driver does not name; run them, or (PGlite/real-Postgres-only tests) fix the list.";
    console.error(`\n[tests] FAILED: skipped tests in a ${mode} run, which must not skip them silently.\n${hint}`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more files`);
    process.exitCode = 1;
  }
}
