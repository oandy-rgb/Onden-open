// What a large write costs the database (issue #2001; review of PR #1938 round 1, point 4): an import that makes thousands of notes in one
// transaction runs every deferred check inside COMMIT, one statement under the request's statement_timeout; an import of a folder makes one
// transaction per note on the same pooled connection. Measured as the database counts it (rows read: sequential and index fetches, every table),
// never as time: on a shared CI machine the same COMMIT took 16.7 s once and 15.1 s once with the same work. The time of 5,000 notes is the bench's
// (scripts/bench/run.ts backend.commit_5000_notes). Each write at two sizes four times apart (500 and 2,000 items: the least that still tells a
// linear cost, at most 4.6 times, from a quadratic one, 16 times): notes made through createNote in one transaction, a drawing saved on each, the
// same with savepoints rolled back, raw SQL writes that mint no version, a folder imported through the import route's entry, a new device joining
// from the snapshot, a backup restored, migration 220's pass; and one ordinary save. Before the fix (a plan cached on the connection while the tables
// were small, kept while they grew; a large write now plans each statement for the tables as they are: db.ts withBulkWrites and the transaction
// that has minted many versions, spine/noteVersions.ts recordVersion; ordinary saves keep the cached plans) the COMMIT of
// 2,000 → 5,000 notes read 4,042,000 → 25,105,000 rows on Postgres 16 (6.2 times for 2.5 times the notes), the same on PGlite.
// Parts that still grow faster are pinned below (`it.fails`) with what reads the rows; docs/agents/mistakes.md (2026-11-23) lists the same.
// realPostgresAlso: the COMMIT of a server runs the deferred triggers and the statement timeout applies to it there
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { allowUnstampedWrite, dbDriver, planThisTransactionForTablesAsTheyAre, q, withBulkWrites, withSavepoint, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import { importObsidian } from "../modules/importers/obsidian/import.js";
import backupRouter from "../routes/backup.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createNote } from "../services/noteCreate.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { moveToSpace, relinkAfterMove } from "../services/spaces.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { buildSourceWorld, capture, fillFrom, openNode, type SourceWorld } from "./helpers/stampedWorld.js";
import { LINK_LOOKUP_TABLES, expectOverHalfAWholeRead, expectUnderHalfAWholeRead, largestRows, readEachWhole, minusRows, rowsReadByTable, showLinkRows, sumRows, wholeReads, type Rows } from "./helpers/rowsRead.js";

registerShippedModules();

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A new database for one measurement, with no autovacuum: what a measurement sees must not depend on when the server happens to analyze a table
 *  between two of a write's transactions (on a real Postgres the import's growth read 4.4 times once and 2.6 times once for the same files). It is
 *  also the desktop's and the browser's case (PGlite has no autovacuum), and the stricter one for the linear assertions: no statistics catch up. */
async function measuredNode(name: string): Promise<RealNode> {
  const node = await openNode(name); open.push(node);
  await onNode(node, async () => {
    for (const { t } of (await q<{ t: string }>(`SELECT quote_ident(relname) AS t FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`)).rows) {
      await q(`ALTER TABLE ${t} SET (autovacuum_enabled = false)`);
    }
  });
  return node;
}

const VERSION_TABLES = ["note_versions", "note_version_positions", "note_version_events"];

/** One write, counted: `work` the rows read inside its transaction(s) before COMMIT, `commit` the rows read from the COMMIT on. */
type Cost = { items: number; work: Rows; commit: Rows; ms: number };

/** Everything `run` makes the database read (every connection's counts in), as `work`: for writes that are not one transaction. */
async function counted(items: number, run: () => Promise<void>): Promise<Cost> {
  await awaitCountsOfEveryConnection();
  const before = await rowsReadByTable("pg_stat_user_tables");
  const t0 = performance.now();
  await run();
  const ms = performance.now() - t0;
  await awaitCountsOfEveryConnection();
  return { items, work: minusRows(await rowsReadByTable("pg_stat_user_tables"), before), commit: new Map(), ms };
}

/** `write` in one event transaction, counted. */
async function oneTransaction(world: SourceWorld, items: number, write: () => Promise<void>): Promise<Cost> {
  await awaitCountsOfEveryConnection();
  const before = await rowsReadByTable("pg_stat_user_tables");
  let work: Rows = new Map();
  const t0 = performance.now();
  await withTransaction(() => withEventTransaction(world.ws, async () => { await write(); work = await rowsReadByTable("pg_stat_xact_user_tables"); }));
  const ms = performance.now() - t0;
  await awaitCountsOfEveryConnection();
  return { items, work, commit: minusRows(await rowsReadByTable("pg_stat_user_tables"), before, work), ms };
}

type Measured = { notes: Cost; ink: Cost; join: Cost; kept: Cost; raw: Cost; versions: number; drawings: number; keptVersions: number; keptNotes: number };

/** `count` notes made in one transaction, then one drawing saved on each of them in another; then a new device joins from that database's
 *  snapshot (the rows read on the joining device). */
async function notesThenDrawings(count: number): Promise<Measured> {
  const node = await measuredNode(`commit-${count}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    const ids = Array.from({ length: count }, () => randomUUID());
    const notes = await oneTransaction(world, count, async () => {
      for (const [i, id] of ids.entries()) {
        await createNote({ actor: world.owner, workspaceId: world.ws, id, title: `Imported ${i}`, markdown: `Imported note ${i}\n\nwith a line of text`,
          spaceId: world.spaceA, event: { uiContext: "test.import" } });
      }
    });
    const ink = await oneTransaction(world, count, async () => {
      for (const [i, id] of ids.entries()) {
        await setNodeAttribute({ workspaceId: world.ws, actor: world.owner, nodeId: id, attribute: { key: "ink_data", value: `{"v":1,"strokes":["stroke ${i}"]}` } });
      }
    });
    // the same notes again, each in its own savepoint, every fifth rolled back after its note and version were written
    const keptIds: string[] = [];
    const kept = await oneTransaction(world, count, async () => {
      for (let i = 0; i < count; i++) {
        const id = randomUUID();
        await withSavepoint(async () => {
          await createNote({ actor: world.owner, workspaceId: world.ws, id, title: `Kept ${i}`, markdown: `Kept note ${i}`, spaceId: world.spaceA, event: { uiContext: "test.import" } });
          if (i % 5 === 4) throw new Error("rolled back on purpose");
        }).then(() => keptIds.push(id), (e: Error) => { if (e.message !== "rolled back on purpose") throw e; });
      }
    });
    // raw SQL rows that mint no version (a write outside the roots, as a data step does), declared a large write as migrate() and the import do: the
    // commit checks still run for each
    const raw = await withBulkWrites(() => oneTransaction(world, count, () => allowUnstampedWrite("test: raw rows, the cost of the commit checks without versions", async () => {
      for (let i = 0; i < count; i++) {
        await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'content', $3, $4, 'raw', $5)`,
          [randomUUID(), world.ws, `Raw ${i}`, `raw-${count}-${i}`, world.spaceA]);
      }
    })));
    const of = async (unit: string, noteIds: string[]) => Number((await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1 AND unit = $2 AND note_id = ANY($3::uuid[])`, [world.ws, unit, noteIds])).rows[0]!.n);
    const keptNotes = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1 AND title LIKE 'Kept %'`, [world.ws])).rows[0]!.n);
    return { notes, ink, kept, raw, versions: await of("body", ids), drawings: await of("ink_data", ids), keptVersions: await of("body", keptIds), keptNotes };
  }).then(async (m) => {
    const snapshot = await capture(node, world);
    const joining = await measuredNode(`join-${count}`);
    const join = await onNode(joining, () => counted(count, () => fillFrom(joining, world, snapshot)));
    console.log(`[version commit cost] ${dbDriver}: ${count} notes: ${show(m.notes)}; ${count} ink saves: ${show(m.ink)}; ${count} notes in savepoints: ${show(m.kept)}; ${count} raw rows: ${show(m.raw)}; joined from its snapshot: ${show(join)}`);
    return { ...m, join };
  });
}

type Imported = Cost & { made: number; edges: number; wholeStart: Rows; wholeEnd: Rows };
/** `files` Markdown files of one folder, imported the way the import route does it (one transaction per note). `linked`: each file links to two others
 *  by title (linkedFiles); else no file has a link. `edges`: the imported notes' wikilink edges after. `wholeStart` / `wholeEnd`: one read of each link table
 *  whole before and after the import (wholeReads; not counted in `work`). */
async function folderImport(files: number, linked = false): Promise<Imported> {
  const node = await measuredNode(`import-${linked ? "linked-" : ""}${files}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    const wholeStart = await wholeReads(world.ws, LINK_LOOKUP_TABLES);
    await awaitCountsOfEveryConnection();
    const before = await rowsReadByTable("pg_stat_user_tables");
    const t0 = performance.now();
    const answer = await importObsidian(world.owner, async () => ({
      files: Array.from({ length: files }, (_, i) => ({ path: `Vault/Note ${i}.md`,
        content: linked ? `# Note ${i}\n\n${linkedFiles(files, i).map((k) => `see [[Note ${k}]]`).join(" and ")}` : `# Note ${i}\n\nImported note ${i}\n\nwith a line of text` })),
      upsert: false,
    }));
    const ms = performance.now() - t0;
    await awaitCountsOfEveryConnection();
    // one transaction per note: there is no single COMMIT to tell apart, so the whole import is `work`
    // the imported notes' edges (the world's own notes have one of their own)
    const edges = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM node_edges e JOIN content_nodes s ON s.id = e.source_node_id
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND s.title LIKE 'Note %'`, [world.ws])).rows[0]!.n);
    const work = minusRows(await rowsReadByTable("pg_stat_user_tables"), before);
    const wholeEnd = await wholeReads(world.ws, LINK_LOOKUP_TABLES);
    const cost = { items: files, work, commit: new Map() as Rows, ms, made: answer.imported, edges, wholeStart, wholeEnd };
    console.log(`[version commit cost] ${dbDriver}: ${files} files${linked ? " linking to each other" : ""} imported (${edges} edges): ${show(cost)}; ${showLinkRows(work)}; one read of each whole before ${showLinkRows(wholeStart)}, after ${showLinkRows(wholeEnd)}`);
    return cost;
  });
}

/** The notes a note `i` of `count` links to by title: two others (none to itself), the same in every world of this file that links its notes. */
const linkedFiles = (count: number, i: number): number[] => [...new Set([(i * 7) % count, (i * 13 + 1) % count])].filter((k) => k !== i);
const linkedEdges = (count: number) => Array.from({ length: count }, (_, i) => linkedFiles(count, i).length).reduce((a, b) => a + b, 0);

type Edges = { into: number; out: number };
type LinkedChanges = { notes: number; move: Cost; linkStep: Cost; linkStepControl: Cost; restore: Cost; moved: Edges; shifted: Edges; restored: Edges; whole: Rows };

/** A workspace of `notes` notes in space A, each linking to two others by title (linkedFiles), made through createNote (their edges and link index as a write
 *  leaves them), then analyzed (a server's autovacuum). Besides them: `Moved` and `Shifted` in A each link to a note of A and to three notes of space B, and
 *  are linked to by five notes of A and five of B; `Restored` in A links to two notes of A and is linked to by five, and is put in the trash. Counted: the rows
 *  read to move `Moved` to B (spaces.ts moveToSpace), to re-link `Shifted` once its space is B (relinkAfterMove alone: the link step of a move, and what a
 *  node runs for a note whose space a bundle changed), and to bring `Restored` back; then the edges into and out of each. `linkStepControl`: the negative
 *  control, the link step of `Shifted` run again with one read of each link table whole inside the same transaction (readEachWhole), counted the same way.
 *  `whole`: one read of each link table whole, after (wholeReads). */
async function linkedNoteChanges(notes: number): Promise<LinkedChanges> {
  const node = await measuredNode(`linked-${notes}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    const ids = new Map<string, string>();
    await withTransaction(() => withEventTransaction(world.ws, async () => {
      const make = async (title: string, markdown: string, spaceId: string) => {
        const id = randomUUID(); ids.set(title, id);
        await createNote({ actor: world.owner, workspaceId: world.ws, id, title, markdown, spaceId, event: { uiContext: "test.note" } });
      };
      for (let i = 0; i < notes; i++) await make(`Linked ${i}`, linkedFiles(notes, i).map((k) => `see [[Linked ${k}]]`).join(" and "), world.spaceA);
      for (let k = 0; k < 3; k++) await make(`Far ${k}`, "in space B", world.spaceB);
      await make("Moved", "[[Linked 1]], [[Far 0]], [[Far 1]] and [[Far 2]]", world.spaceA);
      await make("Shifted", "[[Linked 4]], [[Far 0]], [[Far 1]] and [[Far 2]]", world.spaceA);
      await make("Restored", "[[Linked 2]] and [[Linked 3]]", world.spaceA);
      for (let k = 0; k < 5; k++) {
        await make(`Linker A ${k}`, "see [[Moved]], [[Shifted]] and [[Restored]]", world.spaceA);
        await make(`Linker B ${k}`, "see [[Moved]] and [[Shifted]]", world.spaceB);
      }
    }));
    await trashNode(world.owner, world.ws, ids.get("Restored")!);
    await q(`ANALYZE`);
    const move = await counted(1, async () => { await moveToSpace(world.owner, world.ws, ids.get("Moved")!, world.spaceB, null); });
    // the space written as a raw row (not counted), then the link step alone, in a transaction as the move runs it
    await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [ids.get("Shifted")!, world.spaceB]);
    const linkStep = await counted(1, () => withTransaction(() => relinkAfterMove(world.ws, [ids.get("Shifted")!])));
    const restore = await counted(1, async () => { await undeleteNode(world.owner, world.ws, ids.get("Restored")!); });
    const linkStepControl = await counted(1, () => withTransaction(async () => {
      await relinkAfterMove(world.ws, [ids.get("Shifted")!]);
      await readEachWhole(world.ws, LINK_LOOKUP_TABLES);
    }));
    const edgesOf = async (title: string) => (await q<{ into: number; out: number }>(
      `SELECT count(*) FILTER (WHERE target_node_id = $2)::int AS into, count(*) FILTER (WHERE source_node_id = $2)::int AS out
         FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink' AND $2 IN (source_node_id, target_node_id)`, [world.ws, ids.get(title)!])).rows[0]!;
    const whole = await wholeReads(world.ws, LINK_LOOKUP_TABLES);
    const out = { notes, move, linkStep, linkStepControl, restore, moved: await edgesOf("Moved"), shifted: await edgesOf("Shifted"), restored: await edgesOf("Restored"), whole };
    console.log(`[version commit cost] ${dbDriver}: in a workspace of ${notes} linked notes, a linked note moved: ${show(move)}; the link step of a move: ${show(linkStep)} (${showLinkRows(linkStep.work)}); one restored: ${show(restore)} (${showLinkRows(restore.work)}); the link step with one read of each whole inside it (negative control): ${showLinkRows(linkStepControl.work)}; one read of each whole: ${showLinkRows(whole)}`);
    return out;
  });
}

/** The rows one ordinary save reads (the PATCH a person's editor sends, routes/nodes.ts → services/nodeUpdate.ts), averaged over `saves` saves of one
 *  note on a warm connection, first in a small workspace and then after `more` other notes were made: a save must not read more because the
 *  database is larger. */
async function oneSave(saves: number, more: number): Promise<{ small: number; large: number; ms: number }> {
  const node = await measuredNode(`save-${more}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    const id = (await world.call("POST", "/api/nodes", { id: randomUUID(), title: "Saved", markdown: "start", space_id: world.spaceA })).id as string;
    const save = (text: string) => world.call("PATCH", `/api/nodes/${id}`, { markdown: text });
    const perSave = async (label: string) => {
      for (let i = 0; i < 10; i++) await save(`${label} warm ${i}`);
      const cost = await counted(saves, async () => { for (let i = 0; i < saves; i++) await save(`${label} ${i}`); });
      if (label === "small") ms = cost.ms / saves;
      return cost.work;
    };
    let ms = 0;
    const smallRows = await perSave("small");
    const small = sumRows(smallRows) / saves;
    // one ordinary transaction each, as a workspace grows by hand: no large write brings the statistics up to date
    for (let i = 0; i < more; i++) await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Other ${i}`, markdown: `Other note ${i}`, spaceId: world.spaceA, event: { uiContext: "test.note" } });
    const largeRows = await perSave("large");
    const large = sumRows(largeRows) / saves;
    console.log(`[version commit cost] ${dbDriver}: one save reads ${small.toFixed(1)} rows in a small workspace (${ms.toFixed(2)} ms each; ${saves} saves: ${largestRows(smallRows)}), ${large.toFixed(1)} after ${more} more notes (${largestRows(largeRows)})`);
    return { small, large, ms };
  });
}

function backupApp(actor: SourceWorld["owner"]) {
  const app = new Hono<{ Variables: { actor: SourceWorld["owner"] } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/backup", backupRouter);
  return app;
}

/** `count` notes (made in one transaction, not counted), backed up, and the backup restored into a new empty space as the restore job does it. */
async function backupRestore(count: number): Promise<Cost & { restored: number }> {
  const node = await measuredNode(`restore-${count}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    await withTransaction(() => withEventTransaction(world.ws, async () => {
      for (let i = 0; i < count; i++) await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Kept ${i}`, markdown: `Kept note ${i}`, spaceId: world.spaceA, event: { uiContext: "test.import" } });
    }));
    const app = backupApp(world.owner);
    const zip = new Uint8Array(await (await app.request("/api/backup/full.zip")).arrayBuffer());
    const uploaded = await app.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: zip });
    const uploadId = ((await uploaded.json()) as { upload_id: string }).upload_id;
    const space = await makeSpace(world.ws, `Restored ${randomUUID().slice(0, 6)}`, [{ id: world.owner.id, permission: "edit" }]);
    const cost = await counted(count, async () => { const answer = await applyAndWait(app, uploadId, space, "empty"); expect(answer.status, await answer.clone().text()).toBe(200); });
    const restored = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE space_id = $1 AND title LIKE 'Kept %'`, [space])).rows[0]!.n);
    console.log(`[version commit cost] ${dbDriver}: a backup of ${count} notes restored (${restored} of them): ${show(cost)}`);
    return { ...cost, restored };
  });
}

/** A migration's pass over `count` notes (220, note_versions_backfill) or tags (231, tag_versions_backfill: a tag's description) of three saves
 *  each, written as older code left them, run as migrate() runs a migration (one transaction, every statement planned for the tables as they are). */
async function backfill(count: number, of: "notes" | "tags" = "notes"): Promise<Cost & { minted: number }> {
  const node = await measuredNode(`backfill-${of}-${count}`);
  return onNode(node, async () => {
    const ws = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('old history', $1) RETURNING id::text`, [`old-${count}`])).rows[0]!.id;
    const owner = (await seedQ<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Owner', 'human') RETURNING id::text`, [ws])).rows[0]!.id;
    const space = (await seedQ<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'S', 'shared') RETURNING id::text`, [ws])).rows[0]!.id;
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
      SELECT md5('old:' || i)::uuid, $1, 'manual', $4, 'Old ' || i, 'old-' || i, 'old ' || i || ' save 3', CASE WHEN $4 = 'content' THEN $2::uuid END
        FROM generate_series(1, $3::int) i`, [ws, space, count, of === "tags" ? "class_tag" : "content"]);
    await seedQ(`INSERT INTO blobs (hash, content, size_bytes) SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex'), t, octet_length(t)
      FROM (SELECT 'old ' || i || ' save ' || s AS t FROM generate_series(1, $1::int) i, generate_series(1, 3) s) x ON CONFLICT DO NOTHING`, [count]);
    await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at, body_hash)
      SELECT $1, 'user', $2, CASE WHEN s = 1 THEN 'NODE_CREATED' ELSE 'NODE_UPDATED' END, 'node', md5('old:' || i)::uuid::text,
             jsonb_build_object('title', 'Old ' || i, 'body_hash', encode(sha256(convert_to('old ' || i || ' save ' || s, 'UTF8')), 'hex')),
             timestamptz '2025-01-01T00:00:00Z' + (i * 1000 + s) * interval '1 second', encode(sha256(convert_to('old ' || i || ' save ' || s, 'UTF8')), 'hex')
        FROM generate_series(1, $3::int) i, generate_series(1, 3) s ORDER BY i, s`, [ws, owner, count]);
    let minted = 0;
    const cost = await counted(count, () => allowUnstampedWrite("test: the migration's data step, as migrate() runs it", () => withTransaction(async () => {
      await q(`SELECT set_config('onden.no_versions', 'on', true)`);
      await q(`SELECT set_config('statement_timeout', '0', true)`);
      await planThisTransactionForTablesAsTheyAre();
      const pass = of === "tags" ? "tag_versions_backfill" : "note_versions_backfill";
      minted = Number((await q<{ versions: string }>(`SELECT versions::text FROM ${pass}($1::uuid)`, [ws])).rows[0]!.versions);
    })));
    console.log(`[version commit cost] ${dbDriver}: migration ${of === "tags" ? "231" : "220"}'s pass over ${count} ${of} × 3 saves (${minted} versions): ${show(cost)}`);
    return { ...cost, minted };
  });
}

const show = (c: Cost) => `${Math.round(c.ms)} ms; work ${sumRows(c.work)} rows (${(sumRows(c.work) / c.items).toFixed(0)} per item; ${largestRows(c.work)}), `
  + `version tables ${sumRows(c.work, VERSION_TABLES) + sumRows(c.commit, VERSION_TABLES)}; from the COMMIT on ${sumRows(c.commit)} rows (${(sumRows(c.commit) / c.items).toFixed(1)} per item)`;
const pair = (small: Cost, large: Cost) => `${small.items}: ${show(small)} | ${large.items}: ${show(large)}`;
const versionRows = (c: Cost) => sumRows(c.work, VERSION_TABLES) + sumRows(c.commit, VERSION_TABLES);

/** Four times the items may read at most 4 × 1.15 times the rows (linear, with room for the fixed part; quadratic is 16). */
const MAX_ROWS_RATIO = 4 * 1.15;
/** The tables the larger write read more than `max` times what the smaller read, as `table small → large`. Only tables the larger write read at least one row an
 *  item of: fewer is not growth (a table read in the larger write alone counts as over). */
const tablesGrowingOver = (small: Cost, large: Cost, max: number) => [...large.work]
  .filter(([t, n]) => n >= large.items && n / (small.work.get(t) ?? 0) > max).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${small.work.get(t) ?? 0} → ${n}`);
/** Every table the larger write read at least one row an item of, `table small → large (times)`, for a message. */
const growthByTable = (small: Cost, large: Cost) => [...large.work].filter(([, n]) => n >= large.items).sort((a, b) => b[1] - a[1])
  .map(([t, n]) => `${t} ${small.work.get(t) ?? 0} → ${n} (${(n / (small.work.get(t) ?? 0)).toFixed(2)})`).join(", ");
/** From the COMMIT on, per note or ink save of the larger write. Measured after the fix on Postgres 16 at 2,000 notes: 148 per note (a fixed part of
 *  about 250,000 rows, 260,500 at 500 notes, then about 24 per note); before it, 2,021 per note. */
const MAX_COMMIT_ROWS_PER_ITEM = 200;

/** One ordinary save in a small workspace (oneSave): a fixed cap, about 1.2 times the most measured (1,092 rows on PGlite). */
const MAX_ROWS_ONE_SAVE = 1300;

// The tests read the same measurements (a few minutes on a real Postgres, more on PGlite): made once, by whichever test runs first.
let written: Promise<[Measured, Measured]> | undefined;
const measureWrites = () => (written ??= (async () => [await notesThenDrawings(500), await notesThenDrawings(2000)] as [Measured, Measured])());
let saved: Promise<{ small: number; large: number; ms: number }> | undefined;
const measureSave = () => (saved ??= oneSave(20, 2000));
let imported: Promise<[Imported, Imported]> | undefined;
const measureImports = () => (imported ??= (async () => [await folderImport(500), await folderImport(2000)] as [Imported, Imported])());
let linkedImports: Promise<Imported> | undefined;
const measureLinkedImports = () => (linkedImports ??= folderImport(2000, true));
let linkedChanges: Promise<[LinkedChanges, LinkedChanges]> | undefined;
const measureLinkedChanges = () => (linkedChanges ??= (async () => [await linkedNoteChanges(500), await linkedNoteChanges(2000)] as [LinkedChanges, LinkedChanges])());
/** A change to one note in a workspace four times larger may read at most this many times the rows (the fixed part; one read of every note is 4 times). */
const MAX_ROWS_RATIO_SAME_WORK = 1.15;

describe.skipIf(!isTestDb)("the version machinery's cost in one large write", () => {
  it("500 and 2,000 notes made in one transaction, then a drawing saved on each: every note and every drawing has its version", async () => {
    for (const m of await measureWrites()) {
      expect(m.versions, show(m.notes)).toBe(m.notes.items);
      expect(m.drawings, show(m.ink)).toBe(m.ink.items);
    }
  }, 1_800_000);

  it("500 and 2,000 notes made in one transaction: the rows read from the COMMIT on grow linearly, and stay under a cap per note", async () => {
    const [small, large] = await measureWrites();
    expect(sumRows(large.notes.commit) / sumRows(small.notes.commit), pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sumRows(large.notes.commit) / large.notes.items, pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
  }, 1_800_000);

  it("500 and 2,000 drawings saved in one transaction: the rows read from the COMMIT on grow linearly, and stay under a cap per save", async () => {
    const [small, large] = await measureWrites();
    expect(sumRows(large.ink.commit) / sumRows(small.ink.commit), pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sumRows(large.ink.commit) / large.ink.items, pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
  }, 1_800_000);

  it("in both writes, the rows the version tables are read for, inside the transaction and from its COMMIT on, grow linearly", async () => {
    const [small, large] = await measureWrites();
    expect(versionRows(large.notes) / versionRows(small.notes), pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(versionRows(large.ink) / versionRows(small.ink), pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  it("500 and 2,000 files imported through the import route's entry, one transaction each: every file is a note, and the version tables are read for linearly", async () => {
    const [small, large] = await measureImports();
    expect([small.made, large.made]).toEqual([500, 2000]);
    expect(versionRows(large) / versionRows(small), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  it("500 and 2,000 notes with a drawing each: a new device that joins from the snapshot reads rows linearly", async () => {
    const [small, large] = await measureWrites();
    expect(sumRows(large.join.work) / sumRows(small.join.work), pair(small.join, large.join)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  it("500 and 2,000 notes made in savepoints, every fifth rolled back: the kept notes have their versions, the rolled-back ones leave nothing, and the rows read from the COMMIT on grow linearly", async () => {
    const [small, large] = await measureWrites();
    for (const m of [small, large]) {
      expect(m.keptNotes, show(m.kept)).toBe(m.kept.items * 4 / 5);
      expect(m.keptVersions, show(m.kept)).toBe(m.kept.items * 4 / 5);
    }
    expect(sumRows(large.kept.commit) / sumRows(small.kept.commit), pair(small.kept, large.kept)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sumRows(large.kept.commit) / large.kept.items, pair(small.kept, large.kept)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
  }, 1_800_000);

  it("500 and 2,000 rows written with raw SQL in one transaction (no version minted): the rows read, inside it and from its COMMIT on, grow linearly", async () => {
    const [small, large] = await measureWrites();
    const all = (c: Cost) => sumRows(c.work) + sumRows(c.commit);
    expect(all(large.raw) / all(small.raw), pair(small.raw, large.raw)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // Ordinary saves keep the cached plans (planning each statement cost about 5 % of a save on PGlite): a save in a small workspace reads what it read
  // before issue #2001. Measured, Postgres 16 and PGlite without autovacuum, 20 saves of one note: 525–715 rows a save on Postgres, 716–1,092 on PGlite.
  it("one ordinary save in a small workspace reads at most 1,300 rows", async () => {
    const { small } = await measureSave();
    expect(small).toBeLessThanOrEqual(MAX_ROWS_ONE_SAVE);
  }, 1_800_000);

  // Pinned (statistics, not a cached plan, and not new): the read check of a save (spine/spaceScope.ts, `SELECT 1 FROM content_nodes n WHERE n.id = $1
  // … n.space_id IN (writable spaces)`, three times a save) is planned on content_nodes_space_idx instead of the primary key when the statistics say
  // the table holds a few rows: every save reads every note of the space. A server's autovacuum analyzes the table; the desktop and the browser
  // (PGlite) have none. Postgres 16 without autovacuum, 20 saves of one note: 528 → 29,046 rows a save before every write transaction planned each
  // statement for the tables as they are; 528–714 → 6,250–8,253 while every one did (content_nodes about 8,000 of them). Ordinary saves keep the
  // cached plans again (a large write is declared, db.ts withBulkWrites), so the first numbers hold.
  it.fails("one ordinary save reads no more rows after 2,000 more notes were made in the workspace (fails today: its read check reads every note of the space)", async () => {
    const { small, large } = await measureSave();
    expect(large, `one save: ${small} rows in a small workspace, ${large} after 2,000 more notes`).toBeLessThanOrEqual(small * 1.15);
  }, 1_800_000);

  // Not the version machinery (issue #2001 point 4, pinned, not fixed in that batch). It was first the link check of each note (services/wikilinkEdges.ts
  // relinkBatch reading every note made before it: Postgres 16, 500 → 2,000 notes, 854,077 → 8,582,332 rows), fixed by issue #2021 (about 26 rows a note
  // whatever the workspace holds, PGlite). What still grows is the place of each new note among the workspace's top-level notes: the last `order_key`
  // (`ORDER BY order_key COLLATE "C" DESC LIMIT 1`) is a sort of every top-level note, about one row read per note made before it (PGlite, 1,000 notes:
  // 991 rows a note); content_nodes_order_idx does not answer an order in the "C" collation. Postgres 16 after issue #2021: 403,104 → 4,425,130 rows of
  // content_nodes. Recorded in docs/agents/mistakes.md (2026-11-23).
  // Per table, not the sum (review of PR #2023, round 3): on PGlite the 500-note write's other reads (the link index read whole while it is small) kept the
  // sum at 3.96 times (749,551 → 2,969,528 rows), under the bound, while content_nodes grew 469,416 → 2,397,133 (5.1 times); Postgres 18: content_nodes
  // 273,600 → 2,201,389 (8.0 times; public CI run 46134884873). The same PGlite run had node_attributes over the bound too, a little (6,015 → 28,515, 4.74
  // times; not traced, not pinned: the message prints every table over).
  it.fails("FINDING: 500 and 2,000 notes made in one transaction: inside the transaction each table is read at most 4.6 times more (fails today: content_nodes grows with the square of the notes, each note's place among the top-level notes sorts every one made before it)", async () => {
    const [small, large] = await measureWrites();
    const over = tablesGrowingOver(small.notes, large.notes, MAX_ROWS_RATIO);
    console.log(`[version commit cost] ${dbDriver}: notes made in one transaction, 500 → 2,000, by table: ${growthByTable(small.notes, large.notes)}; over ${MAX_ROWS_RATIO} times: ${over.join(", ") || "none"}`);
    // Only the pinned reason fails this test (so the it.fails passes): content_nodes over the bound. content_nodes under it (fixed, or a measurement that
    // counts nothing) passes it, and the it.fails is red.
    if (!over.some((t) => t.startsWith("content_nodes "))) return;
    expect(over, pair(small.notes, large.notes)).toEqual([]);
  }, 1_800_000);

  // The drawings' own rows. Each save's row lock (services/attributeChange.ts, `WHERE workspace_id AND node_id AND key`) was planned on
  // node_attributes_key_idx (workspace_id, key) instead of the (node_id, key) key while the statistics said the table held a row or two, and read
  // every drawing of the workspace: 124,750 → 1,999,000 rows of node_attributes (16 times). A large write now brings the statistics up to date at a
  // doubling (db.ts analyzeTablesOfLargeWrite): 27,251 → 27,251.
  it("500 and 2,000 drawings saved in one transaction: the rows read inside the transaction grow linearly", async () => {
    const [small, large] = await measureWrites();
    expect(sumRows(large.ink.work) / sumRows(small.ink.work), pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // The link check of each file (services/wikilinkEdges.ts relinkBatch, 4a's) read the notes imported before it: with the import declared a large write,
  // every other statement already grew with the files (blocks read per statement, pg_stat_statements, 500 → 2,000 files: relinkBatch 16,235 → 154,907,
  // 9.5 times; all the others 273,139 → 1,145,722, 4.2 times), and content_nodes was read 798,091 → 6,584,993 rows (Postgres 16 without autovacuum, 8.3
  // times). Its look-ups were planned as scans of tables the planner judged small; they now read by key (services/wikilinkEdges.ts notesWithIdsSql, one look-up an
  // id; the link index's GIN indexes without a pending list, migration 241), and so does the free-slug look-up of each file (spine/noteSlugs.ts freeSlug: the
  // space compared as the unique slug index keys it). Issue #2021.
  it("500 and 2,000 files imported through the import route's entry: the rows read from content_nodes grow linearly", async () => {
    const [small, large] = await measureImports();
    expect(sumRows(large.work, ["content_nodes"]) / sumRows(small.work, ["content_nodes"]), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);
});

// The `[[links]]` of what an import, a move and a restore make or change (issue #2021; review of PR #2023, round 1, point 2): a note saved with links looked
// for the notes they name by title, lower-cased in NFC, with no index (wikilinkEdges.ts syncWikilinkEdges, wikilinkTargets), and the edges into a note were
// read without an index by target (relinkBatch, relinkAfterMove): each read every note, or every edge, of the workspace. Migration 241 indexes both, and the
// look-ups read through them (linkCandidatesSql, services/wikilinkEdges.ts notesWithIdsSql).
//
// The bound (helpers/rowsRead.ts expectUnderHalfAWholeRead), per link table, in the 2,000-note workspace: under half of one read of it whole, each time the
// forbidden look-up would run (once a file, once a step). A ratio against the 500-note workspace was not a bound: there the planner rightly reads the small
// tables whole (the link step: 1,732 rows at 500 notes, 158 at 2,000, Postgres 18, public CI run 46127420639), so one more read of the whole workspace in the
// larger one (+2,033) still left the ratio under 1.15; and an import of interlinked files reading every note once a file stayed under 4.6 times.
describe.skipIf(!isTestDb)("the links of an import, a move and a restore, measured the same way", () => {
  // Before issue #2021 (Postgres 18, public CI run 46127423272, before-fix branch): 6,652,519 rows of content_nodes, 5,519,374 of node_edges for 2,000 files.
  it("2,000 files that link to each other, imported through the import route's entry: every link is an edge, and each file reads less of each link table than half of one read of it whole", async () => {
    const m = await measureLinkedImports();
    expect(m.made).toBe(2000);
    expect(m.edges).toBe(linkedEdges(2000));
    expectUnderHalfAWholeRead("2,000 files linking to each other imported", { rows: m.work, whole: m.wholeEnd, units: m.items, tables: LINK_LOOKUP_TABLES });
  }, 1_800_000);

  // Before issue #2021 (same run): content_nodes 2,115, node_edges 12,057, note_link_index 2,047 rows.
  it("in a workspace of 500 and of 2,000 linked notes, the link step of a move (relinkAfterMove): the note's links in and out follow it to its new space, and in the larger one it reads less of each link table than half of one read of it whole", async () => {
    const [small, large] = await measureLinkedChanges();
    for (const m of [small, large]) expect(m.shifted, show(m.linkStep)).toEqual({ into: 5, out: 3 });
    expectUnderHalfAWholeRead("the link step of a move, 2,000 notes", { rows: large.linkStep.work, whole: large.whole, units: 1, tables: LINK_LOOKUP_TABLES });
  }, 1_800_000);

  // The negative control of the bound (review of PR #2023, round 3): the same link step with the look-up the bound forbids, one read of each link table whole,
  // run inside its transaction and counted by the same path (counted, every connection's counts in). It must break the bound for every table: a measurement
  // that missed what runs in its window, or a bound too loose to catch one whole read, makes this red.
  it("negative control: in the workspace of 2,000 linked notes, the link step of a move with one read of each link table whole inside its measured window breaks that bound", async () => {
    const [, large] = await measureLinkedChanges();
    expectOverHalfAWholeRead("the link step of a move with one read of each whole inside it, 2,000 notes", { rows: large.linkStepControl.work, whole: large.whole, units: 1, tables: LINK_LOOKUP_TABLES });
  }, 1_800_000);

  it("in a workspace of 500 and of 2,000 linked notes, a linked note moved to another space: its links in and out follow it", async () => {
    for (const m of await measureLinkedChanges()) expect(m.moved, show(m.move)).toEqual({ into: 5, out: 3 });
  }, 1_800_000);

  // Pinned: not the links (their step is asserted above). Found by this measurement (review of PR #2023, round 1, point 2), PGlite, 500 → 2,000 notes, rows a
  // statement: the move's own `UPDATE content_nodes … SET space_id` reads sync_stamps 1,402 → 4,402 (its stamp triggers), and the website's audience hook
  // (spaceAudienceCommitted: `SELECT n.id FROM content_nodes n LEFT JOIN node_attributes flag … '_published' WHERE n.workspace_id …`) reads every note of the
  // workspace, 531 → 2,031. Recorded in docs/agents/mistakes.md (2026-11-23, issue #2001 point 4 list).
  it.fails("in a workspace of 500 and of 2,000 linked notes, the whole move of a linked note reads no more rows in the larger one (fails today: the space update's stamp triggers read sync_stamps, the website's audience hook reads every note)", async () => {
    const [small, large] = await measureLinkedChanges();
    expect(sumRows(large.move.work) / sumRows(small.move.work), pair(small.move, large.move)).toBeLessThanOrEqual(MAX_ROWS_RATIO_SAME_WORK);
  }, 1_800_000);

  // Before issue #2021 (same run): content_nodes 2,092, node_edges 8,055, note_link_index 2,047 rows.
  it("in a workspace of 500 and of 2,000 linked notes, a linked note brought back from the trash: its links in and out come back, and in the larger one the restore reads less of each link table than half of one read of it whole", async () => {
    const [small, large] = await measureLinkedChanges();
    for (const m of [small, large]) expect(m.restored, show(m.restore)).toEqual({ into: 5, out: 2 });
    expectUnderHalfAWholeRead("a linked note restored, 2,000 notes", { rows: large.restore.work, whole: large.whole, units: 1, tables: LINK_LOOKUP_TABLES });
  }, 1_800_000);
});

let restores: Promise<[Cost & { restored: number }, Cost & { restored: number }]> | undefined;
const measureRestores = () => (restores ??= (async () => [await backupRestore(200), await backupRestore(800)] as [Cost & { restored: number }, Cost & { restored: number }])());
let backfills: Promise<[Cost & { minted: number }, Cost & { minted: number }]> | undefined;
let tagBackfills: Promise<[Cost & { minted: number }, Cost & { minted: number }]> | undefined;
const measureTagBackfills = () => (tagBackfills ??= (async () => [await backfill(500, "tags"), await backfill(2000, "tags")] as [Cost & { minted: number }, Cost & { minted: number }])());
const measureBackfills = () => (backfills ??= (async () => [await backfill(500), await backfill(2000)] as [Cost & { minted: number }, Cost & { minted: number }])());

describe.skipIf(!isTestDb)("the other bulk writes of issue #2001 point 4, measured the same way (rows per item)", () => {
  // A restore writes what the backup holds without minting versions: their rows go in through spine/importedHistory.ts. Those are asserted linear.
  it("a backup of 200 and 800 notes restored into an empty space: every note restored, and the version tables are read for linearly", async () => {
    const [small, large] = await measureRestores();
    expect([small.restored, large.restored]).toEqual([small.items, large.items]);
    expect(versionRows(large) / versionRows(small), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // The restore's reads of content_nodes. Not the version machinery. Before issue #2021 also the link check (relinkBatch) over every note restored so far:
  // Postgres 16 without autovacuum, 200 → 800 notes, content_nodes 388,395 → 3,462,218 and 4,958,058 rows in two runs (8.9 and 12.8 times); the restore's
  // total flipped between plans from run to run (800 notes: 16,454,983 rows once, 5,202,596 once). What still grows (review of PR #2023, round 1, point 5;
  // rows of content_nodes a statement, PGlite, 200 → 800 notes): each restored note sets its `_published` value, the website module hears it
  // (modules/website/index.ts attributeCommitted → effects.ts requestSiteRebuild → publishing/takenDown.ts recordTakedowns) and works out the published set
  // (publishing/publishedSet.ts publishedNodeIds: `SELECT n.id FROM content_nodes n LEFT JOIN node_attributes flag … WHERE n.workspace_id = $1 …`), which
  // reads every note of the workspace: 64,554 rows in 203 runs → 978,054 in 803 (15 times). The restore as a whole read 202,357 → 981,887 (4.9 times).
  // Pinned on both drivers: on Postgres it measured 4.0 times twice, but that was with a planner setting this PR no longer has, and a plan of that statement
  // that reads fewer notes is the planner's choice, not a guarantee. Recorded in docs/agents/mistakes.md (2026-11-23, issue #2001 point 4 list).
  it.fails("a backup of 200 and 800 notes restored into an empty space: the rows read from content_nodes grow linearly (fails today: each restored note's `_published` value makes the website work out its published set, which reads every note of the workspace)", async () => {
    const [small, large] = await measureRestores();
    expect(sumRows(large.work, ["content_nodes"]) / sumRows(small.work, ["content_nodes"]), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // Pinned, not fixed: migration 220 has run on every server that has it, and a later migration cannot run before it, so a change would only reach
  // databases still older than 220 (an old desktop or self-hosted copy upgrading). Its INSERT INTO nv_candidates plans content_nodes at one row (a
  // table its statistics have not seen grow) and seq-scans it once per old save in a nested loop. Measured on Postgres 16, 500 → 2,000 notes × 3
  // saves: 787,505 → 12,149,983 rows (15.4 times); 5,000 notes: 75,370,038 rows, 19.2 s. Recorded in docs/agents/mistakes.md (2026-11-23).
  it("migration 220's pass over 500 and 2,000 notes of old saves: every save becomes a version", async () => {
    const [small, large] = await measureBackfills();
    expect([small.minted, large.minted]).toEqual([1500, 6000]);
  }, 1_800_000);

  it.fails("migration 220's pass over 500 and 2,000 notes of old saves: the rows read grow linearly (fails today: content_nodes is read once per save)", async () => {
    const [small, large] = await measureBackfills();
    expect(sumRows(large.work) / sumRows(small.work), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // Migration 231 (a tag's description, in main since PR #1982) has the same shape as 220: its INSERT INTO tv_candidates reads content_nodes once per
  // old save, planning each statement for the tables as they are notwithstanding (the statistics say content_nodes holds a few rows). Postgres 16,
  // 500 → 2,000 tags × 3 saves: 772,995 → 12,091,982 rows (15.6 times), 0.5 s → 3.5 s. Pinned, not fixed: whether to change 231 before it reaches
  // a server is the owner's decision (an ANALYZE of content_nodes and domain_events before its pass would most likely do; not tried).
  it("migration 231's pass over 500 and 2,000 tags of old description saves: every save becomes a version", async () => {
    const [small, large] = await measureTagBackfills();
    expect([small.minted, large.minted]).toEqual([1500, 6000]);
  }, 1_800_000);

  it.fails("migration 231's pass over 500 and 2,000 tags of old description saves: the rows read grow linearly (fails today: content_nodes is read once per save)", async () => {
    const [small, large] = await measureTagBackfills();
    expect(sumRows(large.work) / sumRows(small.work), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);
});
