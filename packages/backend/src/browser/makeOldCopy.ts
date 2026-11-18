// Test tool (docs/architecture/browser-app.md §3, e2e/browser-app/smoke.mjs): the saved copy an OLDER version of the
// app would have left in a browser — the database with only the first migrations applied — holding a few notes.
// `tsx src/browser/makeOldCopy.ts <out.tar.gz> [old|newer|poisoned]`
//   old       (default) every migration from 192 on is left out of what the copy records, notes are written through the app itself, as a person would;
//   newer     the copy also lists a migration this build has never heard of (a copy made by a newer app);
// Known limit (owner decision 2026-11-17): rows the kept migrations seeded (default and personal spaces, built-in tags) went through the
// left-out migrations' data steps once before the schema was taken back, so they are not exactly what an older app left; the rows that
// only an older app wrote (read-later, review, capture inbox) are written after the step back and are.
//   poisoned  an older copy that already holds an object the next migration would collide with, so the upgrade fails.
import { readFile, writeFile } from "node:fs/promises";
import { setEnvironment } from "../config.js";

setEnvironment({
  NODE_ENV: "production",
  ONDEN_DB_DRIVER: "pglite",
  ONDEN_PGLITE_DIR: "memory://",
  ONDEN_PGLITE_SNAPSHOT: "", // always from an empty database: a test run's migrated template in the environment must not be the start
  BETTER_AUTH_SECRET: "test-copy-only-never-used-to-sign-a-session",
  BETTER_AUTH_URL: "http://localhost",
  LOG_LEVEL: "warn",
});

const out = process.argv[2];
const mode = process.argv[3] ?? "old";
if (!out || !["old", "newer", "poisoned"].includes(mode)) throw new Error("usage: makeOldCopy.ts <out.tar.gz> [old|newer|poisoned]");

const { useMigrationSource, listMigrations } = await import("../dbMigrations.js");
const all = await listMigrations();
// What is left out is a rule, not a count: every migration from 192 on (the upgrade applies what is missing, not a prefix). The read-later
// part below needs 192 (remove read-later) to be one of them, the review part needs 195 and 196, and leaving 194 out makes the upgrade run its pointer id move on this copy.
// The number the upgrade should report is printed as `leftOut` and smoke.mjs reads it from there.
const FIRST_LEFT_OUT = 192;
const leftOut = new Set(all.filter((m) => Number.parseInt(m.version, 10) >= FIRST_LEFT_OUT).map((m) => m.version));
// A migration can make a table IF NOT EXISTS and then index its columns: a table of that name without those columns
// fails the index. Found in the SQL, so this keeps working as migrations are added.
const indexedNewTable = (m: { sql: string }) => [...m.sql.matchAll(/CREATE INDEX IF NOT EXISTS \w+ ON (\w+) \(/g)]
  .map((hit) => hit[1]!).find((name) => m.sql.includes(`CREATE TABLE IF NOT EXISTS ${name} (`));
// The latest such migration may be older than the last ones (those can be data-only): "poisoned" leaves it out as well.
const poisonFrom = mode === "poisoned" ? all.filter(indexedNewTable).pop() : undefined;
if (poisonFrom) leftOut.add(poisonFrom.version);
const kept = all.filter((m) => !leftOut.has(m.version));

const { migrate, pglite, pool, q } = await import("../db.js");
const { awaitAllDispatchers } = await import("../services/dispatcherQueue.js");
const { sqlIdentifier } = await import("../sqlText.js");
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");
const { createLocalSession } = await import("./localSession.js");
const { readSchemaCatalog, stepBackTo } = await import("./schemaCatalog.js");

// One rule for what today's write path needs: the notes are written on a database that has EVERY migration, and afterwards the schema is
// taken back to what only the kept migrations left (recorded below, read from the catalog), so what an older app saved is exactly that and
// the upgrade runs each left-out migration for real. No migration is named here: one the request path starts reading is applied and
// stepped back like the rest. (Rows the kept migrations seeded went through the left-out migrations' data steps once; the rows
// that only an older app wrote are made after the step back, below.)
useMigrationSource(async () => kept);
await migrate({ seedNativeActor: false });
await (await auth.$context).runMigrations();
// The schema work runs on the database itself, not through the app's query helper: it is not a core write (that helper refuses those outside mutate()).
const rawRun = async (sql: string, params?: unknown[]) => (await pglite!.database()).query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>;
const keptSchema = await readSchemaCatalog(rawRun);
useMigrationSource(async () => all);
await migrate({ seedNativeActor: false });
// (The module library is brought up to date by the browser app itself when it opens the copy: backfillModuleImports in worker.ts.)
await q(`UPDATE workspaces SET modules_off = $1::jsonb`, [JSON.stringify(["skills", "external_calendars"])]);

// What only an older app wrote goes straight to the database, and only once the schema is the old one (the SQL lives in files of their own).
const afterStepBack: string[] = [];

const session = createLocalSession(app, auth.api as never);
await session.signIn();
for (const title of ["舊版留下的筆記一", "舊版留下的筆記二"]) {
  const response = await session.fetchAsLocalUser(new Request(`${session.origin}/api/nodes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, markdown: `${title}的內容` }),
  }));
  if (!response.ok) throw new Error(`could not write a note: ${response.status} ${await response.text()}`);
}

// An older app's read-later: its module tag, a note carrying it and that person's "finished" mark. Migration 192 (left out
// above, so the upgrade runs it) must keep the note and the mark's table; the tag, used, stays as an ordinary tag.
if (mode === "old") {
  const made = await session.fetchAsLocalUser(new Request(`${session.origin}/api/nodes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "舊版稍後讀的文章", markdown: "稍後讀的內容" }),
  }));
  if (!made.ok) throw new Error(`could not write a note: ${made.status} ${await made.text()}`);
  const note = (await made.json()) as { id: string; workspace_id: string };
  const asLocalUser = (path: string, method: string, body: unknown) => session.fetchAsLocalUser(new Request(`${session.origin}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const tag = await asLocalUser("/api/tags", "POST", { name: "read-later" });
  if (!tag.ok) throw new Error(`could not make a tag: ${tag.status} ${await tag.text()}`);
  const tagId = ((await tag.json()) as { id: string }).id;
  const tagged = await asLocalUser(`/api/nodes/${note.id}/tags/${tagId}`, "PUT", {});
  if (!tagged.ok) throw new Error(`could not tag the note: ${tagged.status} ${await tagged.text()}`);
  // What only an older app wrote (the SQL lives in a file of its own: no current code writes it).
  // Every value is an id made by the app above, so nothing is interpolated from outside.
  const legacy = (await readFile(new URL("./oldReadLater.sql", import.meta.url), "utf8"))
    .replaceAll("__TAG__", tagId).replaceAll("__WORKSPACE__", note.workspace_id).replaceAll("__NOTE__", note.id);
  afterStepBack.push(legacy);

  // An older app's review: the module tag, a note that was a card through it, and a paragraph card. Migration 195 (left out above)
  // must give both their own reference, so the queue still holds two cards after the upgrade.
  const cardNote = await asLocalUser("/api/nodes", "POST", { title: "舊版複習的卡片", markdown: "複習的內容" });
  if (!cardNote.ok) throw new Error(`could not write a note: ${cardNote.status} ${await cardNote.text()}`);
  const cardNoteId = ((await cardNote.json()) as { id: string }).id;
  const reviewTag = await asLocalUser("/api/tags", "POST", { name: "review" });
  if (!reviewTag.ok) throw new Error(`could not make a tag: ${reviewTag.status} ${await reviewTag.text()}`);
  const reviewTagId = ((await reviewTag.json()) as { id: string }).id;
  const reviewTagged = await asLocalUser(`/api/nodes/${cardNoteId}/tags/${reviewTagId}`, "PUT", {});
  if (!reviewTagged.ok) throw new Error(`could not tag the note: ${reviewTagged.status} ${await reviewTagged.text()}`);
  const oldReview = (await readFile(new URL("./oldReview.sql", import.meta.url), "utf8"))
    .replaceAll("__TAG__", reviewTagId).replaceAll("__WORKSPACE__", note.workspace_id).replaceAll("__NOTE__", note.id);
  afterStepBack.push(oldReview);
}

// An older app's capture inbox: the module tag (a random id then) with a note on it. Migration 201 (left out above, so the upgrade runs it)
// gives the tag its derived id and must keep the note on it; the default and personal spaces the older migrations made have random ids too.
if (mode === "old") {
  const asLocalUser = (path: string, method: string, body: unknown) => session.fetchAsLocalUser(new Request(`${session.origin}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const inbox = await asLocalUser("/api/tags", "POST", { name: "收件匣" });
  if (!inbox.ok) throw new Error(`could not make a tag: ${inbox.status} ${await inbox.text()}`);
  const inboxId = ((await inbox.json()) as { id: string }).id;
  const captured = await asLocalUser("/api/nodes", "POST", { title: "舊版收件匣的筆記", markdown: "收件匣的內容" });
  if (!captured.ok) throw new Error(`could not write a note: ${captured.status} ${await captured.text()}`);
  const capturedId = ((await captured.json()) as { id: string }).id;
  const tagged = await asLocalUser(`/api/nodes/${capturedId}/tags/${inboxId}`, "PUT", {});
  if (!tagged.ok) throw new Error(`could not tag the note: ${tagged.status} ${await tagged.text()}`);
  afterStepBack.push((await readFile(new URL("./oldCapture.sql", import.meta.url), "utf8")).replaceAll("__TAG__", inboxId));
}

// The schema goes back to what the kept migrations left, and the record of applied migrations with it.
// Writing notes queued post-commit cascades: let them land before the schema is stepped back and the copy is dumped.
await awaitAllDispatchers();
await stepBackTo(rawRun, keptSchema);
await rawRun(`DELETE FROM schema_migrations WHERE version <> ALL($1::text[])`, [kept.map((m) => m.version)]);
for (const sql of afterStepBack) await (await pglite!.database()).exec(sql);

if (mode === "newer") await rawRun(`INSERT INTO schema_migrations (version) VALUES ('999_from_a_newer_app')`);
if (mode === "poisoned") {
  if (!poisonFrom) throw new Error("no migration creates and indexes a table");
  await rawRun(`CREATE TABLE ${sqlIdentifier(indexedNewTable(poisonFrom)!)} (poison int)`);
}

const dump = await (await pglite!.database()).dumpDataDir("gzip");
await writeFile(out, Buffer.from(await dump.arrayBuffer()));
process.stdout.write(`${JSON.stringify({ applied: kept.length, last: kept[kept.length - 1]!.version, latest: all[all.length - 1]!.version, leftOut: leftOut.size })}\n`);
await pool.end(); // drains background work, then ends
process.exit(0);
