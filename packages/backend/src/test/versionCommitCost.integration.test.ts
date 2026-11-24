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
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { buildSourceWorld, capture, fillFrom, openNode, type SourceWorld } from "./helpers/stampedWorld.js";

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
type Rows = Map<string, number>;

/** Rows read so far, by table (sequential and index fetches), by this database with every connection's counts in; `xact`: by this transaction alone. */
async function rowsByTable(view: "pg_stat_user_tables" | "pg_stat_xact_user_tables"): Promise<Rows> {
  return new Map((await q<{ t: string; r: string }>(
    `SELECT relname AS t, (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text AS r FROM ${view}`)).rows.map((r) => [r.t, Number(r.r)]));
}
const minus = (a: Rows, ...b: Rows[]): Rows => new Map([...a].map(([t, n]) => [t, b.reduce((left, m) => left - (m.get(t) ?? 0), n)]));
const sum = (r: Rows, only?: readonly string[]) => [...r].reduce((s, [t, n]) => (only && !only.includes(t) ? s : s + n), 0);
const largest = (r: Rows) => [...r].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(", ");

/** One write, counted: `work` the rows read inside its transaction(s) before COMMIT, `commit` the rows read from the COMMIT on. */
type Cost = { items: number; work: Rows; commit: Rows; ms: number };

/** Everything `run` makes the database read (every connection's counts in), as `work`: for writes that are not one transaction. */
async function counted(items: number, run: () => Promise<void>): Promise<Cost> {
  await awaitCountsOfEveryConnection();
  const before = await rowsByTable("pg_stat_user_tables");
  const t0 = performance.now();
  await run();
  const ms = performance.now() - t0;
  await awaitCountsOfEveryConnection();
  return { items, work: minus(await rowsByTable("pg_stat_user_tables"), before), commit: new Map(), ms };
}

/** `write` in one event transaction, counted. */
async function oneTransaction(world: SourceWorld, items: number, write: () => Promise<void>): Promise<Cost> {
  await awaitCountsOfEveryConnection();
  const before = await rowsByTable("pg_stat_user_tables");
  let work: Rows = new Map();
  const t0 = performance.now();
  await withTransaction(() => withEventTransaction(world.ws, async () => { await write(); work = await rowsByTable("pg_stat_xact_user_tables"); }));
  const ms = performance.now() - t0;
  await awaitCountsOfEveryConnection();
  return { items, work, commit: minus(await rowsByTable("pg_stat_user_tables"), before, work), ms };
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

/** `files` Markdown files of one folder, imported the way the import route does it (one transaction per note). */
async function folderImport(files: number): Promise<Cost & { made: number }> {
  const node = await measuredNode(`import-${files}`);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    await awaitCountsOfEveryConnection();
    const before = await rowsByTable("pg_stat_user_tables");
    const t0 = performance.now();
    const answer = await importObsidian(world.owner, async () => ({
      files: Array.from({ length: files }, (_, i) => ({ path: `Vault/Note ${i}.md`, content: `# Note ${i}\n\nImported note ${i}\n\nwith a line of text` })),
      upsert: false,
    }));
    const ms = performance.now() - t0;
    await awaitCountsOfEveryConnection();
    // one transaction per note: there is no single COMMIT to tell apart, so the whole import is `work`
    const cost = { items: files, work: minus(await rowsByTable("pg_stat_user_tables"), before), commit: new Map() as Rows, ms, made: answer.imported };
    console.log(`[version commit cost] ${dbDriver}: ${files} files imported: ${show(cost)}`);
    return cost;
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
    const small = sum(smallRows) / saves;
    // one ordinary transaction each, as a workspace grows by hand: no large write brings the statistics up to date
    for (let i = 0; i < more; i++) await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Other ${i}`, markdown: `Other note ${i}`, spaceId: world.spaceA, event: { uiContext: "test.note" } });
    const largeRows = await perSave("large");
    const large = sum(largeRows) / saves;
    console.log(`[version commit cost] ${dbDriver}: one save reads ${small.toFixed(1)} rows in a small workspace (${ms.toFixed(2)} ms each; ${saves} saves: ${largest(smallRows)}), ${large.toFixed(1)} after ${more} more notes (${largest(largeRows)})`);
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

const show = (c: Cost) => `${Math.round(c.ms)} ms; work ${sum(c.work)} rows (${(sum(c.work) / c.items).toFixed(0)} per item; ${largest(c.work)}), `
  + `version tables ${sum(c.work, VERSION_TABLES) + sum(c.commit, VERSION_TABLES)}; from the COMMIT on ${sum(c.commit)} rows (${(sum(c.commit) / c.items).toFixed(1)} per item)`;
const pair = (small: Cost, large: Cost) => `${small.items}: ${show(small)} | ${large.items}: ${show(large)}`;
const versionRows = (c: Cost) => sum(c.work, VERSION_TABLES) + sum(c.commit, VERSION_TABLES);

/** Four times the items may read at most 4 × 1.15 times the rows (linear, with room for the fixed part; quadratic is 16). */
const MAX_ROWS_RATIO = 4 * 1.15;
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
let imported: Promise<[Cost & { made: number }, Cost & { made: number }]> | undefined;
const measureImports = () => (imported ??= (async () => [await folderImport(500), await folderImport(2000)] as [Cost & { made: number }, Cost & { made: number }])());

describe.skipIf(!isTestDb)("the version machinery's cost in one large write", () => {
  it("500 and 2,000 notes made in one transaction, then a drawing saved on each: every note and every drawing has its version", async () => {
    for (const m of await measureWrites()) {
      expect(m.versions, show(m.notes)).toBe(m.notes.items);
      expect(m.drawings, show(m.ink)).toBe(m.ink.items);
    }
  }, 1_800_000);

  it("500 and 2,000 notes made in one transaction: the rows read from the COMMIT on grow linearly, and stay under a cap per note", async () => {
    const [small, large] = await measureWrites();
    expect(sum(large.notes.commit) / sum(small.notes.commit), pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sum(large.notes.commit) / large.notes.items, pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
  }, 1_800_000);

  it("500 and 2,000 drawings saved in one transaction: the rows read from the COMMIT on grow linearly, and stay under a cap per save", async () => {
    const [small, large] = await measureWrites();
    expect(sum(large.ink.commit) / sum(small.ink.commit), pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sum(large.ink.commit) / large.ink.items, pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
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
    expect(sum(large.join.work) / sum(small.join.work), pair(small.join, large.join)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  it("500 and 2,000 notes made in savepoints, every fifth rolled back: the kept notes have their versions, the rolled-back ones leave nothing, and the rows read from the COMMIT on grow linearly", async () => {
    const [small, large] = await measureWrites();
    for (const m of [small, large]) {
      expect(m.keptNotes, show(m.kept)).toBe(m.kept.items * 4 / 5);
      expect(m.keptVersions, show(m.kept)).toBe(m.kept.items * 4 / 5);
    }
    expect(sum(large.kept.commit) / sum(small.kept.commit), pair(small.kept, large.kept)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(sum(large.kept.commit) / large.kept.items, pair(small.kept, large.kept)).toBeLessThanOrEqual(MAX_COMMIT_ROWS_PER_ITEM);
  }, 1_800_000);

  it("500 and 2,000 rows written with raw SQL in one transaction (no version minted): the rows read, inside it and from its COMMIT on, grow linearly", async () => {
    const [small, large] = await measureWrites();
    const all = (c: Cost) => sum(c.work) + sum(c.commit);
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

  // Not the version machinery (issue #2001 point 4, pinned, not fixed in that batch): inside the transaction, each note made reads every note made
  // before it in the same transaction, in services/wikilinkEdges.ts relinkBatch: a note whose link index row is still stale "has not been read yet:
  // look in its text", and every note of this transaction is such a note until the transaction is over. Measured on Postgres 16 (after the version
  // fix), 500 → 2,000 notes: 854,077 → 8,582,332 rows (10 times; content_nodes 0.5 M → 5.7 M, note_link_index 0.1 M → 2.1 M). Recorded in docs/agents/mistakes.md (2026-11-23).
  it.fails("500 and 2,000 notes made in one transaction: the rows read inside the transaction grow linearly (fails today: each note's link check reads every note made before it)", async () => {
    const [small, large] = await measureWrites();
    expect(sum(large.notes.work) / sum(small.notes.work), pair(small.notes, large.notes)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // The drawings' own rows. Each save's row lock (services/attributeChange.ts, `WHERE workspace_id AND node_id AND key`) was planned on
  // node_attributes_key_idx (workspace_id, key) instead of the (node_id, key) key while the statistics said the table held a row or two, and read
  // every drawing of the workspace: 124,750 → 1,999,000 rows of node_attributes (16 times). A large write now brings the statistics up to date at a
  // doubling (db.ts analyzeTablesOfLargeWrite): 27,251 → 27,251.
  it("500 and 2,000 drawings saved in one transaction: the rows read inside the transaction grow linearly", async () => {
    const [small, large] = await measureWrites();
    expect(sum(large.ink.work) / sum(small.ink.work), pair(small.ink, large.ink)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);

  // Not the version machinery either (pinned the same way), and the link check alone (services/wikilinkEdges.ts relinkBatch, 4a's): with the import
  // declared a large write (db.ts withBulkWrites: each statement planned for the tables as they are, the statistics brought up to date at a
  // doubling), every other statement of it grows with the files: measured by blocks read per statement (pg_stat_statements), 500 → 2,000 files,
  // relinkBatch 16,235 → 154,907 (9.5 times), all the others 273,139 → 1,145,722 (4.2 times). relinkBatch reads many rows a block, so it still leads
  // the rows read from content_nodes (Postgres 16 without autovacuum: 798,091 → 6,584,993, 8.3 times), and that is what is asserted.
  it.fails("500 and 2,000 files imported through the import route's entry: the rows read from content_nodes grow linearly (fails today: each file's link check reads the notes imported before it)", async () => {
    const [small, large] = await measureImports();
    expect(sum(large.work, ["content_nodes"]) / sum(small.work, ["content_nodes"]), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
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

  // Pinned, not fixed: the restore's reads of content_nodes. Not the version machinery: a readable-notes query per restored note, and the link check
  // (relinkBatch) over every note restored so far. Only content_nodes is asserted: the restore's total flips between plans from run to run (800 notes:
  // 16,454,983 rows once, 5,202,596 once; spaces 8.8 M once, 0 once). Postgres 16 without autovacuum, 200 → 800 notes: content_nodes 388,395 →
  // 3,462,218 and 4,958,058 rows in two runs (8.9 and 12.8 times).
  it.fails("a backup of 200 and 800 notes restored into an empty space: the rows read from content_nodes grow linearly (fails today: each restored note's checks read every note restored before it)", async () => {
    const [small, large] = await measureRestores();
    expect(sum(large.work, ["content_nodes"]) / sum(small.work, ["content_nodes"]), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
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
    expect(sum(large.work) / sum(small.work), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
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
    expect(sum(large.work) / sum(small.work), pair(small, large)).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 1_800_000);
});
