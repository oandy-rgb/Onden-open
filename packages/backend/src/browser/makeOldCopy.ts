// Test tool (docs/architecture/browser-app.md §3, e2e/browser-app/smoke.mjs): the saved copy an OLDER version of the
// app would have left in a browser — the database with only the first migrations applied — holding a few notes.
// `tsx src/browser/makeOldCopy.ts <out.tar.gz> [old|newer|poisoned]`
//   old       (default) every migration from 192 on is left out, then notes are written through the app itself, as a person would;
//   newer     the copy also lists a migration this build has never heard of (a copy made by a newer app);
//   poisoned  an older copy that already holds an object the next migration would collide with, so the upgrade fails.
import { readFile, writeFile } from "node:fs/promises";
import { setEnvironment } from "../config.js";

setEnvironment({
  NODE_ENV: "production",
  ONDEN_DB_DRIVER: "pglite",
  ONDEN_PGLITE_DIR: "memory://",
  BETTER_AUTH_SECRET: "test-copy-only-never-used-to-sign-a-session",
  BETTER_AUTH_URL: "http://localhost",
  LOG_LEVEL: "warn",
});

const out = process.argv[2];
const mode = process.argv[3] ?? "old";
if (!out || !["old", "newer", "poisoned"].includes(mode)) throw new Error("usage: makeOldCopy.ts <out.tar.gz> [old|newer|poisoned]");

const { useMigrationSource, listMigrations } = await import("../dbMigrations.js");
const all = await listMigrations();
// The notes below are written by today's code, which needs the event hash columns (162), the event device column (187) and the write
// stamps (190, mutate() allocates one for every write): those stay in the "old" copy.
const needed = (m: { version: string }) => m.version.startsWith("162_") || m.version.startsWith("187_") || m.version.startsWith("190_");
// What is left out is a rule, not a count: every migration from 192 on (the upgrade applies what is missing, not a prefix). The read-later
// part below needs 192 (remove read-later) to be one of them, the review part needs 195 and 196, and leaving 194 out makes the upgrade run its pointer id move on this copy.
// A count ("the last four") broke each time another migration was merged first; the number the upgrade should report is printed
// as `leftOut` and smoke.mjs reads it from there.
const FIRST_LEFT_OUT = 192;
const leftOut = new Set(all.filter((m) => !needed(m) && Number.parseInt(m.version, 10) >= FIRST_LEFT_OUT).map((m) => m.version));
// The one exception while the notes are written: migration 200 (order keys) is applied first, because today's code writes order_key.
// downgradeOrderKeys() takes it out again before the copy is saved, so the saved copy is exactly `kept` and the upgrade runs 200 on it.
const orderKeys = (m: { version: string }) => m.version.startsWith("200_");
// A migration can make a table IF NOT EXISTS and then index its columns: a table of that name without those columns
// fails the index. Found in the SQL, so this keeps working as migrations are added.
const indexedNewTable = (m: { sql: string }) => [...m.sql.matchAll(/CREATE INDEX IF NOT EXISTS \w+ ON (\w+) \(/g)]
  .map((hit) => hit[1]!).find((name) => m.sql.includes(`CREATE TABLE IF NOT EXISTS ${name} (`));
// The latest such migration may be older than the last two (those can be data-only): "poisoned" leaves it out as well.
const poisonFrom = mode === "poisoned" ? all.filter((m) => !needed(m) && indexedNewTable(m)).pop() : undefined;
if (poisonFrom) leftOut.add(poisonFrom.version);
const kept = all.filter((m) => !leftOut.has(m.version));
useMigrationSource(async () => [...kept, ...all.filter(orderKeys)]);

const { migrate, pglite, q } = await import("../db.js");
const { sqlIdentifier } = await import("../sqlText.js");
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");
const { createLocalSession } = await import("./localSession.js");

await migrate({ seedNativeActor: false });
await (await auth.$context).runMigrations();
// (The module library is brought up to date by the browser app itself when it opens the copy: backfillModuleImports in worker.ts.)
await q(`UPDATE workspaces SET modules_off = $1::jsonb`, [JSON.stringify(["skills", "external_calendars"])]);

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
  // What only an older app wrote, straight to the database (the SQL lives in a file of its own: no current code writes it).
  // Every value is an id made by the app above, so nothing is interpolated from outside.
  const legacy = (await readFile(new URL("./oldReadLater.sql", import.meta.url), "utf8"))
    .replaceAll("__TAG__", tagId).replaceAll("__WORKSPACE__", note.workspace_id).replaceAll("__NOTE__", note.id);
  await (await pglite!.database()).exec(legacy);

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
  await (await pglite!.database()).exec(oldReview);
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
  await (await pglite!.database()).exec((await readFile(new URL("./oldCapture.sql", import.meta.url), "utf8")).replaceAll("__TAG__", inboxId));
}

if (mode === "newer") await q(`INSERT INTO schema_migrations (version) VALUES ('999_from_a_newer_app')`);
if (mode === "poisoned") {
  if (!poisonFrom) throw new Error("no migration creates and indexes a table");
  await q(`CREATE TABLE ${sqlIdentifier(indexedNewTable(poisonFrom)!)} (poison int)`);
}

await downgradeOrderKeys();

/** Take the database back to what the kept migrations left: the integer order in sort_order, no order_key / order_stamp, the
 *  stamp triggers of 190 (194 is left out, so the pointer triggers do not exist yet), and no row for 200 in schema_migrations.
 *  What an older app saved is exactly this; the upgrade then runs migration 200 on it. */
async function downgradeOrderKeys(): Promise<void> {
  const database = await pglite!.database();
  const text = (prefix: string) => all.find((m) => m.version.startsWith(prefix))?.sql ?? "";
  const triggersOf = (sql: string, table: string) => [...sql.matchAll(new RegExp(`CREATE OR REPLACE TRIGGER ${table}_sync_stamp_\\w+[\\s\\S]*?;\\n`, "g"))].map((hit) => hit[0]);
  const restored = [
    ...triggersOf(text("190_"), "content_nodes"),
    ...(kept.some((m) => m.version.startsWith("194_")) ? triggersOf(text("194_"), "note_pointers") : []),
  ];
  await database.exec(`
    DROP TRIGGER IF EXISTS content_nodes_order_stamp ON content_nodes;
    DROP TRIGGER IF EXISTS note_pointers_order_stamp ON note_pointers;
    DROP TRIGGER IF EXISTS content_nodes_sync_stamp_insert ON content_nodes;
    DROP TRIGGER IF EXISTS content_nodes_sync_stamp_update ON content_nodes;
    DROP TRIGGER IF EXISTS content_nodes_sync_stamp_delete ON content_nodes;
    DROP TRIGGER IF EXISTS note_pointers_sync_stamp_insert ON note_pointers;
    DROP TRIGGER IF EXISTS note_pointers_sync_stamp_update ON note_pointers;
    DROP TRIGGER IF EXISTS note_pointers_sync_stamp_delete ON note_pointers;
    DROP FUNCTION IF EXISTS order_stamp_set();
    UPDATE content_nodes c SET sort_order = r.rank FROM (SELECT id, row_number() OVER (PARTITION BY workspace_id, parent_id ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id) - 1 AS rank FROM content_nodes) r WHERE c.id = r.id;
    UPDATE note_pointers p SET sort_order = r.rank FROM (SELECT id, row_number() OVER (PARTITION BY workspace_id, parent_id ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id) - 1 AS rank FROM note_pointers) r WHERE p.id = r.id;
    ALTER TABLE content_nodes ALTER COLUMN sort_order SET DEFAULT 0;
    ALTER TABLE content_nodes ALTER COLUMN sort_order SET NOT NULL;
    ALTER TABLE note_pointers ALTER COLUMN sort_order SET DEFAULT 0;
    ALTER TABLE note_pointers ALTER COLUMN sort_order SET NOT NULL;
    DROP INDEX IF EXISTS content_nodes_order_idx;
    DROP INDEX IF EXISTS note_pointers_parent_idx;
    CREATE INDEX IF NOT EXISTS note_pointers_parent_idx ON note_pointers (workspace_id, parent_id, sort_order);
    ALTER TABLE content_nodes DROP COLUMN order_key, DROP COLUMN order_stamp;
    ALTER TABLE note_pointers DROP COLUMN order_key, DROP COLUMN order_stamp;
    ${restored.join("\n")}
    DELETE FROM schema_migrations WHERE version = '200_order_keys';
  `);
}

const dump = await (await pglite!.database()).dumpDataDir("gzip");
await writeFile(out, Buffer.from(await dump.arrayBuffer()));
process.stdout.write(`${JSON.stringify({ applied: kept.length, last: kept[kept.length - 1]!.version, latest: all[all.length - 1]!.version, leftOut: leftOut.size })}\n`);
await pglite!.end();
process.exit(0);
