// relinkTarget finds the notes linking to a name through note_link_index
// (migration 146) and reads the text only of notes without a row. Both ways
// must give the edges the text-reading rule gives: each scenario runs the same
// stale edges through relinkTarget twice, once with the index and once with
// every row stale (every note read from its text), and compares.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { trashNode } from "../services/nodeTrash.js";
import { indexMissingNoteLinks, relinkTarget, syncWikilinkEdges } from "../services/wikilinkEdges.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { relinkAfterMove } from "../services/spaces.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeRng } from "./helpers/distSim/rng.js";
import { LONG_TITLE } from "./helpers/longTitle.js";
import { expectUnderHalfAWholeRead, linkReadsCanTell, minusRows, rowsReadByTable, wholeReads } from "./helpers/rowsRead.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

type EdgeRow = { source_node_id: string; target_node_id: string; edge_type: string; status: string; origin: string };

describe.skipIf(!isTestDb)("relinkTarget through the link index equals reading the texts", () => {
  let actor: ActorCtx = { id: "relink-index-admin", name: "Indexer", role: "admin", type: "human" };
  let spaceA = "";
  let spaceB = "";
  const stamp = () => randomUUID().replace(/-/g, "").slice(0, 8);

  const note = async (title: string, markdown: string, spaceId = spaceA) =>
    (await createNote({ actor, workspaceId, title, markdown, spaceId, event: { uiContext: "test.relinkIndex" } })).node.id as string;
  const tagNote = async (title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id::text`,
    [workspaceId, title, `tag-${title.toLowerCase().replace(/\s+/g, "-")}`],
  )).rows[0]!.id;
  const edges = async (): Promise<EdgeRow[]> => (await q<EdgeRow>(
    `SELECT source_node_id::text, target_node_id::text, edge_type, status, origin FROM node_edges
      WHERE workspace_id = $1 AND origin = 'wikilink' ORDER BY source_node_id, target_node_id`, [workspaceId],
  )).rows;
  const putEdges = async (rows: EdgeRow[]) => {
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    for (const e of rows) {
      await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, e.source_node_id, e.target_node_id, e.edge_type, e.status, e.origin]);
    }
  };
  const indexed = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_link_index WHERE workspace_id = $1 AND NOT stale`, [workspaceId])).rows[0]!.n);

  /** The stale edges `before`, relinked for `ids` with the index and without it. */
  async function bothWays(ids: string[]) {
    const before = await edges();
    await withTransaction(() => relinkTarget(workspaceId, ids));
    const viaIndex = await edges();
    await putEdges(before);
    const saved = (await q(`SELECT note_id, workspace_id, link_lc, link_slug, stale FROM note_link_index WHERE workspace_id = $1`, [workspaceId])).rows;
    await q(`UPDATE note_link_index SET stale = true WHERE workspace_id = $1`, [workspaceId]);
    await withTransaction(() => relinkTarget(workspaceId, ids));
    const viaText = await edges();
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    await putEdges(viaIndex);
    for (const r of saved) {
      await q(`UPDATE note_link_index SET link_lc = $2, link_slug = $3, stale = $4 WHERE note_id = $1`, [r.note_id, r.link_lc, r.link_slug, r.stale]);
    }
    return { before, viaIndex, viaText };
  }

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('RelinkIndex', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    spaceA = await makeSpace(workspaceId, `A ${stamp()}`, [{ id: actor.id, role: "manager" }]);
    spaceB = await makeSpace(workspaceId, `B ${stamp()}`, [{ id: actor.id, role: "manager" }]);
  });

  it("a rename, aliases, a node reference, a tag and a recreated title give the same edges both ways", async () => {
    const s = stamp();
    const alpha = await note(`Old name ${s}`, "target one");
    const beta = await note(`Beta ${s}`, "target two");
    const gamma = await note(`Gamma ${s}`, "target three");
    const tag = await tagNote(`reading ${s}`);
    const old = await note(`Old Delta ${s}`, "will be trashed");
    const links = [
      `[[Alpha Name ${s}]]`, `[[ALPHA NAME ${s}|shown]]`, `[[alpha name ${s}#Goals]]`, `[[alpha-name-${s}]]`,
      `[[AK${s}]]`, `[[Al${s}]]`, `[[Alt Name ${s}]]`, `[[onden://node/${gamma}]]`,
      `[[study ${s}]]`, `[[Study ${s}]]`, `[[Delta ${s}]]`, `![[Alpha Name ${s}]]`, `[[Ａlpha Name ${s}]]`,
    ];
    const sources = new Map<string, string>();
    for (const [i, link] of links.entries()) sources.set(link, await note(`Source ${i} ${s}`, `see ${link} here`));
    sources.set("other-space", await note(`Source far ${s}`, `see [[Alpha Name ${s}]] and [[study ${s}]]`, spaceB));
    sources.set("many", await note(`Source many ${s}`, links.join("\n")));
    sources.set("prose", await note(`Source prose ${s}`, `Alpha Name ${s} without brackets, AK${s}`));
    sources.set("trashed", await note(`Source trashed ${s}`, `see [[Alpha Name ${s}]]`));
    await trashNode(actor, workspaceId, sources.get("trashed")!);

    // What names each target changes without relinking: the edges go stale.
    await seedQ(`UPDATE content_nodes SET title = $2, slug = $3 WHERE id = $1`, [alpha, `Alpha Name ${s}`, `alpha-name-${s}`]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'aliases',$3,'text','ui')`,
      [workspaceId, beta, JSON.stringify([`Al${s}`, `alt name ${s}`])]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'aliases',$3,'text','ui')`,
      [workspaceId, alpha, `ak${s}`]);
    await seedQ(`UPDATE content_nodes SET title = $2, slug = $3 WHERE id = $1`, [tag, `Study ${s}`, `study-${s}`]);
    const delta = await note(`Delta ${s}`, "recreated after the trash of the old one");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [old]);

    expect(await indexed()).toBeGreaterThan(sources.size);
    const ids = [alpha, beta, gamma, tag, delta];
    const { before, viaIndex, viaText } = await bothWays(ids);
    expect(viaIndex).toEqual(viaText);
    // Not a vacuous comparison: the rename wired links the stale edges lacked.
    expect(viaIndex.length).toBeGreaterThan(before.length);
    const to = (id: string) => viaIndex.filter((e) => e.target_node_id === id).map((e) => e.source_node_id);
    expect(to(alpha)).toContain(sources.get(`[[Alpha Name ${s}]]`));
    expect(to(alpha)).toContain(sources.get(`[[alpha-name-${s}]]`));
    expect(to(alpha)).toContain(sources.get(`[[AK${s}]]`));
    expect(to(alpha)).not.toContain(sources.get("other-space"));
    expect(to(alpha)).not.toContain(sources.get("prose"));
    expect(to(beta)).toContain(sources.get(`[[Alt Name ${s}]]`));
    expect(to(gamma)).toContain(sources.get(`[[onden://node/${gamma}]]`));
    expect(to(tag)).toContain(sources.get("other-space"));
    expect(to(delta)).toContain(sources.get(`[[Delta ${s}]]`));
  });

  it("a text changed behind syncWikilinkEdges's back is read from the text, not from a stale row", async () => {
    const s = stamp();
    const target = await note(`Target ${s}`, "");
    const src = await note(`Src ${s}`, "nothing yet");
    expect(await indexed()).toBeGreaterThan(0);
    // No sync: the trigger makes the row stale, so the new link is found in the text.
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [src, `now [[Target ${s}]]`]);
    expect((await q(`SELECT stale FROM note_link_index WHERE note_id = $1`, [src])).rows[0]).toEqual({ stale: true });
    await withTransaction(() => relinkTarget(workspaceId, [target]));
    expect((await edges()).some((e) => e.source_node_id === src && e.target_node_id === target)).toBe(true);
  });

  it("an embed-only note is read from its text whichever plan Postgres picks", async () => {
    // The pgroonga text index reads "![[" as one token, so a LIKE '%[[%' it
    // answered dropped "see ![[Name]]"; that plan won only under some table
    // statistics (a full suite run), so it is forced here.
    const s = stamp();
    const target = await note(`Embedded ${s}`, "");
    const src = await note(`Embedder ${s}`, "nothing yet");
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [src, `see ![[Embedded ${s}]] here`]);
    await withTransaction(async () => {
      for (const plan of ["seqscan", "indexscan", "nestloop", "mergejoin"]) await q(`SET LOCAL enable_${plan} = off`);
      await withTransaction(() => relinkTarget(workspaceId, [target]));
    });
    expect((await edges()).some((e) => e.source_node_id === src && e.target_node_id === target)).toBe(true);
  });

  it("indexMissingNoteLinks writes the rows syncWikilinkEdges writes", async () => {
    const s = stamp();
    const src = await note(`Indexed ${s}`, `see [[Some Name ${s}#Part|shown]] and [[other-${s}]]`);
    const row = async () => (await q<{ link_lc: string[]; link_slug: string[]; stale: boolean }>(`SELECT link_lc, link_slug, stale FROM note_link_index WHERE note_id = $1`, [src])).rows[0]!;
    const written = await row();
    expect(written.stale).toBe(false);
    expect(written.link_lc).toContain(`some name ${s}`);
    await q(`UPDATE note_link_index SET link_lc = '{}', link_slug = '{}', stale = true WHERE note_id = $1`, [src]);
    expect(await indexMissingNoteLinks({ workspaceId })).toBeGreaterThan(0);
    expect(await row()).toEqual(written);
    // A note whose text has no link is indexed too (a stale row would mean "read me"); a note without a row gets one.
    const plain = await note(`Plain ${s}`, "no links");
    await q(`DELETE FROM note_link_index WHERE note_id = $1`, [plain]);
    await indexMissingNoteLinks({ workspaceId });
    expect((await q(`SELECT link_lc, stale FROM note_link_index WHERE note_id = $1`, [plain])).rows[0]).toEqual({ link_lc: [], stale: false });
    // Syncing again keeps one row per note.
    const { markdown } = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [src])).rows[0]!;
    await withTransaction(() => syncWikilinkEdges(workspaceId, src, markdown));
    expect((await q(`SELECT 1 FROM note_link_index WHERE note_id = $1`, [src])).rowCount).toBe(1);
  });
  /** `n` notes titled `Many <i> <s>` in space A (bulk, as a change bundle makes them), their ids in title order. */
  const manyNotes = async (n: number, s: string): Promise<string[]> => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     SELECT $1, 'manual', 'content', 'Many ' || g || ' ' || $2, 'many-' || g || '-' || $2, 'plain body ' || g, $3 FROM generate_series(0, $4::int - 1) g
     ORDER BY g RETURNING id::text`, [workspaceId, s, spaceA, n],
  )).rows.map((r) => r.id);

  /** The edges `run` leaves from the edges `before`, then put `before` back. */
  async function edgesAfter(before: EdgeRow[], run: () => Promise<void>): Promise<EdgeRow[]> {
    await putEdges(before);
    await run();
    const after = await edges();
    await putEdges(before);
    return after;
  }

  it("many targets at once (worked out a batch at a time) give the edges one call per target gives, both ways: titles, slugs, aliases, a tag from another space, case and NFD", async () => {
    const s = stamp();
    const many = await manyNotes(130, s);
    const aliased = await note(`Aliased ${s}`, "a target named by its alias");
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'aliases',$3,'text','ui')`,
      [workspaceId, aliased, JSON.stringify([`Other Name ${s}`])]);
    const tag = await tagNote(`Batched Tag ${s}`);
    const accented = await note(`Café Ünï ${s}`, "a title in NFC"); // linked below in NFD and another case
    const ids = [...many, aliased, tag, accented]; // three batches, in id order
    const sources = {
      across: await note(`Across ${s}`, `[[Many 0 ${s}]] and [[Many 129 ${s}]]`),
      slug: await note(`By slug ${s}`, `see [[many-70-${s}]]`),
      alias: await note(`By alias ${s}`, `see [[other name ${s}]]`),
      tag: await note(`Tag from B ${s}`, `see [[batched tag ${s}]]`, spaceB),
      nfd: await note(`By NFD ${s}`, `see [[${`CAFÉ ünï ${s}`.normalize("NFD")}]]`),
      far: await note(`Far ${s}`, `[[Many 5 ${s}]] is in another space`, spaceB),
    };
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    const before = await edges();
    const batched = await edgesAfter(before, () => withTransaction(() => relinkTarget(workspaceId, ids)));
    const single = await edgesAfter(before, async () => { for (const id of ids) await withTransaction(() => relinkTarget(workspaceId, [id])); });
    expect(batched).toEqual(single);
    const pairs = batched.map((e) => `${e.source_node_id}>${e.target_node_id}`);
    expect(pairs).toEqual(expect.arrayContaining([
      `${sources.across}>${many[0]}`, `${sources.across}>${many[129]}`, `${sources.slug}>${many[70]}`,
      `${sources.alias}>${aliased}`, `${sources.tag}>${tag}`, `${sources.nfd}>${accented}`,
    ]));
    expect(pairs).not.toContain(`${sources.far}>${many[5]}`); // a title resolves within its space
    const { viaIndex, viaText } = await bothWays(ids);
    expect(viaIndex).toEqual(viaText);
    expect(viaIndex).toEqual(batched);
  }, 120_000);

  it("a move of more than one batch of notes into another space (spaces.relinkAfterMove) gives the edges one move per note gives", async () => {
    const s = stamp();
    const moved: string[] = [];
    for (let i = 0; i < 60; i++) moved.push(await note(`Moved ${i} ${s}`, `next: [[Moved ${(i + 1) % 60} ${s}]], stay: [[Stay ${s}]]`));
    const stay = await note(`Stay ${s}`, `back to [[Moved 3 ${s}]]`);
    const waiting = await note(`Waiting ${s}`, `in B: [[Moved 40 ${s}]] and [[Moved 7 ${s}]]`, spaceB);
    await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = ANY($1::uuid[])`, [moved, spaceB]);
    const before = await edges();
    const batched = await edgesAfter(before, () => withTransaction(() => relinkAfterMove(workspaceId, moved)));
    const single = await edgesAfter(before, async () => { for (const id of moved) await withTransaction(() => relinkAfterMove(workspaceId, [id])); });
    expect(batched).toEqual(single);
    const pairs = batched.map((e) => `${e.source_node_id}>${e.target_node_id}`);
    expect(pairs).toEqual(expect.arrayContaining([`${moved[0]}>${moved[1]}`, `${waiting}>${moved[40]}`, `${waiting}>${moved[7]}`]));
    expect(pairs.some((p) => p.startsWith(`${stay}>`) || p.endsWith(`>${stay}`))).toBe(false); // now across spaces
  }, 120_000);

  it("six times the targets look the link index up no more often (once for all the batches, not once a batch)", async () => {
    // Per batch, a look-up of the index was a scan of the whole index whenever the planner judged it small, so a change bundle's rows read grew with its square
    // (PR #1941 CI, stampedBundleScale on a real Postgres). Counted as scans of the table, which does not depend on what else the test database holds.
    const scans = async (ids: string[]) => withTransaction(async () => {
      const count = async () => Number((await q<{ n: string }>(
        `SELECT (COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0))::text AS n FROM pg_stat_xact_user_tables WHERE relname = 'note_link_index'`)).rows[0]?.n ?? 0);
      const before = await count();
      await relinkTarget(workspaceId, ids);
      const scanned = (await count()) - before;
      if (process.env.ONDEN_RELINK_SCANS === "1") console.log(`[relink scans] ${ids.length} targets: ${scanned}`);
      return scanned;
    });
    // 2 batches and 8: one look-up a batch was 6 more scans. A plan may answer one look-up with both GIN indexes (two scans), hence the 2.
    const small = await scans(await manyNotes(60, stamp()));
    const large = await scans(await manyNotes(360, stamp()));
    expect(large, `index scans: ${small} for 60 targets, ${large} for 360`).toBeLessThanOrEqual(small + 2);
  });

  // Metamorphic (issue #2021): the links into N notes worked out in one call (a batch at a time) equal N calls of one note each, on a random world: titles shared
  // between notes, slugs, aliases, two spaces, a tag, links by title, by slug and by alias, some notes indexed and some not. A fresh seed every run; a red
  // names it, to be shrunk to a scenario above.
  it("on a random world, the links into 70 notes worked out at once equal 70 relinks of one note each", async () => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const rng = makeRng(seed);
    const s = stamp();
    const names = Array.from({ length: 12 }, (_, i) => `Name ${i} ${s}`);
    const link = () => rng.pick([
      () => `[[${rng.pick(names)}]]`, () => `[[${rng.pick(names).toUpperCase()}]]`, () => `[[name-${rng.int(12)}-${s}]]`,
      () => `[[alias ${rng.int(6)} ${s}]]`, () => `[[nothing ${s}]]`, () => `![[${rng.pick(names)}]]`,
    ])();
    const targets: string[] = [];
    for (let i = 0; i < 70; i++) {
      const body = Array.from({ length: rng.int(4) }, link).join(" and ");
      const title = rng.chance(0.5) ? rng.pick(names) : `Note ${i} ${s}`;
      const id = rng.chance(0.1) ? await tagNote(`${title} tag ${i}`) : await note(title, body || "no links", rng.chance(0.3) ? spaceB : spaceA);
      if (rng.chance(0.2)) {
        await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'aliases', $3, 'ui')`,
          [workspaceId, id, JSON.stringify([`alias ${rng.int(6)} ${s}`])]);
      }
      targets.push(id);
    }
    const stale = targets.filter(() => rng.chance(0.3));
    await q(`UPDATE note_link_index SET stale = true WHERE note_id = ANY($1::uuid[])`, [stale]);
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    const before = await edges();
    const batched = await edgesAfter(before, () => withTransaction(() => relinkTarget(workspaceId, targets)));
    const single = await edgesAfter(before, async () => { for (const id of targets) await withTransaction(() => relinkTarget(workspaceId, [id])); });
    expect(batched, `seed ${seed}`).toEqual(single);
    // negative control: the comparison is between edges that exist (the world has links that resolve), not two empty lists
    expect(batched.filter((e) => targets.includes(e.target_node_id)).length, `seed ${seed}`).toBeGreaterThan(0);
  }, 120_000);

  /** Raw notes in space A (a title of any length: NODE_TITLE_MAX is the writers' cap, not the database's, and a bundle is not held to it). */
  const rawNotes = async (notes: ReadonlyArray<{ title: string; slug: string }>) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     SELECT $1, 'manual', 'content', x.title, x.slug, 'a raw note', $2 FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS x(title, slug, o) ORDER BY x.o RETURNING id::text`,
    [workspaceId, spaceA, notes.map((n) => n.title), notes.map((n) => n.slug)])).rows.map((r) => r.id);
  const linksOut = async (source: string) => (await q<{ id: string }>(
    `SELECT target_node_id::text AS id FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink' AND source_node_id = $2 ORDER BY 1`, [workspaceId, source])).rows.map((r) => r.id);

  // The title index (migration 241 content_nodes_title_key_idx) keys a title's first 500 characters, lower-cased in NFC; the look-ups find candidates by that
  // key and the exact rule (linkMatchesNodeSql) compares the whole title.
  it("two notes whose titles share their first 500 characters: a link to one names that one only, from the linking note's save and from a relink of the two", async () => {
    const s = stamp();
    const head = `Shared head ${s} `.padEnd(500, "a");
    const [one, two] = await rawNotes([{ title: `${head} one`, slug: `long-one-${s}` }, { title: `${head} two`, slug: `long-two-${s}` }]);
    const linker = await note(`Long linker ${s}`, `see [[${head.toUpperCase()} ONE]]`);
    expect(await linksOut(linker), "the linking note's save").toEqual([one]);
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND source_node_id = $2`, [workspaceId, linker]);
    await withTransaction(() => relinkTarget(workspaceId, [one!, two!]));
    expect(await linksOut(linker), "a relink of both").toEqual([one]);
  });

  it("a note titled with 700 four-byte characters (2,800 bytes, over btree's limit of a row; its key is 2,000): it is written, and a note that links to it by its slug gets the edge when it is relinked", async () => {
    const s = stamp();
    expect(Buffer.byteLength(LONG_TITLE)).toBe(2800);
    const linker = await note(`Long title linker ${s}`, `see [[long-title-${s}]]`);
    const [long] = await rawNotes([{ title: LONG_TITLE, slug: `long-title-${s}` }]);
    await withTransaction(() => relinkTarget(workspaceId, [long!]));
    expect(await linksOut(linker)).toEqual([long]);
  });

  // Found with the test above (review of PR #2023, round 2), not made by it: note_link_index (migration 146) keeps each link target of a note's text as an entry
  // of its GIN index note_link_index_lc_idx, and GIN refuses an entry over 2,712 bytes ("index row size 2816 exceeds maximum 2712"), so the save of a note whose
  // text links to such a title fails whole (and so would the derivation of a bundle that holds one). Recorded in docs/agents/mistakes.md (2026-11-23, issue #2001
  // point 4 list, item 1).
  it.fails("FINDING: a note whose text links to a title of 2,800 bytes by that title is saved and linked to it (fails today: the link index's GIN refuses an entry over 2,712 bytes)", async () => {
    const s = stamp();
    const [long] = await rawNotes([{ title: `${LONG_TITLE}${s}`, slug: `long-link-${s}` }]);
    try {
      const linker = await note(`Long link ${s}`, `see [[${LONG_TITLE}${s}]]`);
      expect(await linksOut(linker)).toEqual([long]);
    } catch (e) {
      // Only the pinned reason fails this test (so the it.fails passes); a failure for any other reason passes it, and the it.fails is red.
      if (/exceeds maximum 2712/.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  });

  // The `aliases` rule of linkCandidatesSql reads every `aliases` attribute of the workspace (node_attributes_key_idx answers `key = 'aliases'`, not the alias):
  // what a note saved with a link reads grows with the notes that have aliases. An Obsidian folder whose pages mostly have `aliases` still imports in time that
  // grows with the square of its pages. Review of PR #2023, round 2; recorded in docs/agents/mistakes.md (2026-11-23, issue #2001 point 4 list, item 1).
  it.fails("FINDING: a note saved with a link, in a workspace where 300 more notes have aliases: it reads fewer than half a read of their aliases more (fails today: the alias rule reads every `aliases` attribute of the workspace)", async () => {
    const s = stamp();
    const withAliases = async (from: number, count: number) => {
      const ids = await rawNotes(Array.from({ length: count }, (_, k) => ({ title: `Aliased ${from + k} ${s}`, slug: `aliased-${from + k}-${s}` })));
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) SELECT $1, x, 'aliases', $3, 'text', 'ui' FROM unnest($2::uuid[]) x`,
        [workspaceId, ids, JSON.stringify([`other name ${s}`])]);
    };
    const body = `see [[nothing named ${s}]]`;
    const linker = await note(`Alias linker ${s}`, body);
    const save = () => withTransaction(async () => {
      const from = await rowsReadByTable("pg_stat_xact_user_tables");
      await syncWikilinkEdges(workspaceId, linker, body);
      return minusRows(await rowsReadByTable("pg_stat_xact_user_tables"), from);
    });
    await withAliases(0, 100);
    const small = { rows: await save(), whole: await wholeReads(workspaceId, ["node_attributes"]) };
    await withAliases(100, 300);
    const m = { rows: await save(), whole: await wholeReads(workspaceId, ["node_attributes"]), units: 1, tables: ["node_attributes"], baseline: small };
    if (!linkReadsCanTell("aliases", m)) return; // a measurement that counts nothing passes this test, so the it.fails is red
    expectUnderHalfAWholeRead("a save with a link, 300 more notes with aliases", m);
  });
});
