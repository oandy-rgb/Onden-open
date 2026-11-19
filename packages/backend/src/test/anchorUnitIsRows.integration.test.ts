// The anchors unit of a note and its anchor rows never disagree in silence (migration 215 note_anchor_places_is_rows and note_anchor_places_expand; review of PR #1853
// round 2, point 2b). On the node that writes, the unit FOLLOWS the rows at the end of every statement that wrote them, and a unit written any other way that the rows do not make is refused at commit; on the node
// that takes a bundle, the rows follow the unit and are checked to give its head back. Each case changes one thing. SAFETY: the test database (a PGlite, or a `_test`
// database of a real server). Both engines.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { sha256Hex } from "../utils.js";
import { seedQ } from "./helpers/seedQ.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAnchorUnit } from "../spine/stampedMerge/anchorUnit.js";
import { moveAnchorsForBodyChange } from "../services/blockAnchors/index.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { urlOfDatabase } from "./helpers/distSim/nodeDatabaseNames.js";
import pg from "pg";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const BODY = "First paragraph of the note\n\nSecond paragraph of the note\n";
/** The warnings one statement raises on `node`'s database (a PGlite's onNotice, a pg client's notice event): what lands in the database's log. */
async function warningsOf(node: RealNode, sql: string, params: unknown[]): Promise<{ message: string; hint: string | undefined }[]> {
  const out: { message: string; hint: string | undefined }[] = [];
  const keep = (n: { severity?: string; message?: string; hint?: string }) => { if (n.severity === "WARNING") out.push({ message: n.message ?? "", hint: n.hint }); };
  if (node.pg) { await node.pg.query(sql, params, { onNotice: keep }); return out; }
  const c = new pg.Client({ connectionString: urlOfDatabase(node.database!) });
  await c.connect();
  try { c.on("notice", keep); await c.query(sql, params); } finally { await c.end(); }
  return out;
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; hint?: string }) => `${e.code ?? "error"} ${e.hint ?? ""}`.trim());

describe.skipIf(!isTestDb)("a note's anchors unit is its anchor rows", () => {
  let node: RealNode;
  const context = { workspaceId: "" };
  let space = "";
  let owner = "";
  beforeAll(async () => {
    node = await openNode("unit");
    const world = await buildSourceWorld(node);
    context.workspaceId = world.ws;
    space = world.spaceA;
    owner = world.owner.id;
  }, 300_000);
  afterAll(async () => { await node?.close().catch(() => undefined); });

  /** A note with two anchors (each test its own: the tests of a file run in a shuffled order). */
  const noteWithAnchors = async (): Promise<string> => {
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, 'manual', 'content', 'Unit', 'unit-' || gen_random_uuid(), $2, $3) RETURNING id::text`,
      [context.workspaceId, BODY, space])).rows[0]!.id;
    const tag = note.slice(0, 8);
    await seedQ(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES
                 ($1, $4, $2, 0, 27, $3, 'First paragraph of the note'), ($1, $5, $2, 29, 57, $3, 'Second paragraph of the note')`,
      [context.workspaceId, note, sha256Hex(BODY), `u1${tag}`, `u2${tag}`]);
    return note;
  };
  const unitOf = async (note: string) => (await q<{ places: { h: string; a: Record<string, unknown[]> } }>(`SELECT places FROM note_anchor_places WHERE note_id = $1`, [note])).rows[0]?.places ?? null;

  it("the writer's unit is made from its rows at the end of the statement that wrote them, one per note, and holds every anchor", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const unit = await unitOf(note);
    expect(unit?.h).toBe(sha256Hex(BODY));
    expect(Object.keys(unit!.a).sort()).toEqual([`u1${note.slice(0, 8)}`, `u2${note.slice(0, 8)}`]);
    expect(unit!.a[`u1${note.slice(0, 8)}`]).toEqual([0, 27, "valid", null, null, false, "First paragraph of the note", "", ""]);
  }));

  it("a unit written by itself that the rows do not make (one position changed) is refused at commit, and nothing is written", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const before = await unitOf(note);
    expect(await refusal(seedQ(`UPDATE note_anchor_places SET places = jsonb_set(places, ARRAY['a', $2, '1'], '26') WHERE note_id = $1`, [note, `u1${note.slice(0, 8)}`])))
      .toBe("OD215 anchor_unit_not_rows");
    expect(await unitOf(note)).toEqual(before);
  }));

  it("a unit that names an anchor the note has no row for is refused at commit", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    expect(await refusal(seedQ(`UPDATE note_anchor_places SET places = jsonb_set(places, '{a,nosuchrow01}', '[0, 0, "lost", null, null, false, "", "", ""]') WHERE note_id = $1`, [note])))
      .toBe("OD215 anchor_unit_not_rows");
  }));

  it("rows changed by two statements of one transaction: the unit is the rows after the last, and its check looks at that one", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    await withTransaction(async () => {
      await q(`UPDATE block_anchors SET status = 'maybe', candidate_from_utf16 = 0, candidate_to_utf16 = 5 WHERE note_id = $1 AND anchor_id = $2`, [note, `u1${note.slice(0, 8)}`]);
      await q(`UPDATE block_anchors SET quote_prefix = 'x' WHERE note_id = $1 AND anchor_id = $2`, [note, `u2${note.slice(0, 8)}`]);
    });
    const unit = await unitOf(note);
    expect(unit!.a[`u1${note.slice(0, 8)}`]!.slice(2, 5)).toEqual(["maybe", 0, 5]);
    expect(unit!.a[`u2${note.slice(0, 8)}`]![7]).toBe("x");
  }));

  // round 4, point 2: the unit remembers only the last note it wrote, keyed by the statement's start; with the triggers made immediate, each statement writes the unit again
  it("under SET CONSTRAINTS ALL IMMEDIATE, two statements on one note's anchors: the unit is the rows after the second", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const u1 = `u1${note.slice(0, 8)}`;
    await withTransaction(async () => {
      await q(`SET CONSTRAINTS ALL IMMEDIATE`);
      await q(`UPDATE block_anchors SET quote_prefix = 'one' WHERE note_id = $1 AND anchor_id = $2`, [note, u1]);
      await q(`UPDATE block_anchors SET quote_prefix = 'two' WHERE note_id = $1 AND anchor_id = $2`, [note, u1]);
    });
    expect((await unitOf(note))!.a[u1]![7]).toBe("two");
  }));

  // round 4, point 3: a writer never writes a unit a receiver refuses; both count the bytes of the unit's text
  it("the bound on a unit's size is the same number in the database and in the received-unit check", () => onNode(node, async () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../spine/stampedMerge/anchorUnit.ts"), "utf8");
    const ts = Number(/const ANCHOR_UNIT_BYTES_MAX = ([\d_]+);/.exec(source)![1]!.replaceAll("_", ""));
    expect(Number((await q<{ n: string }>(`SELECT anchor_unit_bytes_max()::text AS n`)).rows[0]!.n)).toBe(ts);
  }));
  const unitBytes = async (note: string) => Number((await q<{ n: string }>(`SELECT octet_length(places::text)::text AS n FROM note_anchor_places WHERE note_id = $1`, [note])).rows[0]!.n);
  const MAX = 16_000_000;
  it("a note whose anchors' words would make a unit over the bound: the writer gives up the oldest lost anchors' words first, and its unit is under the bound", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const tag = note.slice(0, 8);
    // nine lost anchors with long quotes (1,900,000 characters each: 17.1 MB of words), made one after another
    for (let k = 0; k < 9; k++) await seedQ(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote, status, created_at)
      VALUES ($1, $2, $3, 0, 0, $4, repeat('q', 1900000), 'lost', now() + make_interval(secs => $5))`, [context.workspaceId, `l${k}${tag}`, note, sha256Hex(BODY), k]);
    expect(await unitBytes(note)).toBeLessThanOrEqual(MAX);
    const words = (await q<{ id: string; n: number }>(`SELECT anchor_id AS id, length(quote) AS n FROM block_anchors WHERE note_id = $1 AND status = 'lost' ORDER BY created_at`, [note])).rows;
    expect(words.map((w) => w.n)).toEqual([0, ...Array(8).fill(1_900_000)]); // the oldest gave its words up; the others kept theirs
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM block_anchors WHERE note_id = $1 AND status = 'valid' AND quote <> ''`, [note])).rows[0]!.n).toBe(2);
    expect(parseAnchorUnit((await q<{ t: string }>(`SELECT places::text AS t FROM note_anchor_places WHERE note_id = $1`, [note])).rows[0]!.t).ok).toBe(true);
  }));
  it("a unit of exactly the bound is written and taken as it is; one character more and the writer gives up a lost anchor's words, with a warning naming the note", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const lost = `lx${note.slice(0, 8)}`;
    await seedQ(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote, status) VALUES ($1, $2, $3, 0, 0, $4, '', 'lost')`,
      [context.workspaceId, lost, note, sha256Hex(BODY)]);
    const base = await unitBytes(note);
    await seedQ(`UPDATE block_anchors SET quote = repeat('x', $3) WHERE workspace_id = $1 AND anchor_id = $2`, [context.workspaceId, lost, MAX - base]);
    expect(await unitBytes(note)).toBe(MAX);
    expect(parseAnchorUnit((await q<{ t: string }>(`SELECT places::text AS t FROM note_anchor_places WHERE note_id = $1`, [note])).rows[0]!.t).ok).toBe(true);
    // words given up cannot be had back: one warning in the database's log names the note and how many of each kind (round 5, point 3)
    const warned = await warningsOf(node, `UPDATE block_anchors SET quote = repeat('x', $3) WHERE workspace_id = $1 AND anchor_id = $2`, [context.workspaceId, lost, MAX - base + 1]);
    expect(warned).toEqual([{ message: `anchors unit of note ${note} was over its bound of ${MAX} bytes: the words of 1 lost, 0 maybe and 0 valid anchors were given up`, hint: "anchor_words_given_up" }]);
    expect(await unitBytes(note)).toBe(base);
    expect((await q<{ q: string }>(`SELECT quote AS q FROM block_anchors WHERE workspace_id = $1 AND anchor_id = $2`, [context.workspaceId, lost])).rows[0]!.q).toBe("");
  }));

  // round 6, point 5: a row's workspace is its note's, whoever writes it (the stamp triggers file it under the note's, every read takes the row's own column)
  it("a row of the three tables in another workspace than its note is refused (OD215 row_not_in_its_notes_workspace), made or moved", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const other = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Other', 'other-' || gen_random_uuid()) RETURNING id::text`)).rows[0]!.id;
    const tries = [
      `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($2, 'ws${note.slice(0, 8)}', $1, 0, 1, '${sha256Hex(BODY)}', 'F')`,
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind) VALUES ($2, $1, 'ws${note.slice(0, 8)}', 'paragraph')`,
      `UPDATE note_anchor_places SET workspace_id = $2 WHERE note_id = $1`,
      // a unit for a note that has none (round 7, point 5: the insert check of note_anchor_places runs, it is not only there by name)
      `INSERT INTO note_anchor_places (note_id, workspace_id, places) SELECT $3::uuid, $2, places FROM note_anchor_places WHERE note_id = $1`,
      `UPDATE block_anchors SET workspace_id = $2 WHERE note_id = $1`,
      `UPDATE block_nodes SET workspace_id = $2 WHERE note_id = $1`,
    ];
    const bare = (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, 'manual', 'content', 'Bare', 'bare-' || gen_random_uuid(), 'x', $2) RETURNING id::text`, [context.workspaceId, space])).rows[0]!.id;
    await withTransaction(() => seedQ(`INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind) VALUES ($1, $2, 'wsrow${note.slice(0, 6)}', 'paragraph')`, [context.workspaceId, note]));
    const refused = [];
    for (const sql of tries) refused.push(await refusal(withTransaction(() => seedQ(sql, sql.includes("$3") ? [note, other, bare] : [note, other]))));
    expect(refused).toEqual(Array(tries.length).fill("OD215 row_not_in_its_notes_workspace"));
    // and a note does not move to another workspace (round 7, point 7)
    expect(await refusal(withTransaction(() => seedQ(`UPDATE content_nodes SET workspace_id = $2 WHERE id = $1`, [note, other])))).toBe("OD215 note_workspace_is_fixed");
  }));

  // round 4, point 4 (and its follow-up: production holds a few such rows): a row code before 215 left in a shape no writer gives it now makes a unit no receiver takes.
  // Both shapes, through both kinds of write: a save of the body (mapping.ts rewrites the row) and a write of another anchor's place alone (the unit's writer puts it
  // right, note_anchor_places_write). After either, the note's unit is one a receiver takes.
  const OLD_SHAPES = [
    { name: "valid with a candidate", spoil: `UPDATE block_anchors SET candidate_from_utf16 = 1, candidate_to_utf16 = 5 WHERE workspace_id = $1 AND anchor_id = $2` },
    { name: "valid and waiting to be looked up", spoil: `UPDATE block_anchors SET recovery_pending = true WHERE workspace_id = $1 AND anchor_id = $2` },
    { name: "lost and standing somewhere", spoil: `UPDATE block_anchors SET status = 'lost' WHERE workspace_id = $1 AND anchor_id = $2` },
  ];
  for (const shape of OLD_SHAPES) for (const write of ["a save of the body", "a write of another anchor's place"] as const) {
    it(`an old row ${shape.name}, then ${write}: the note's unit is one a receiver takes`, () => onNode(node, async () => {
      const note = await noteWithAnchors();
      const [u1, u2] = [`u1${note.slice(0, 8)}`, `u2${note.slice(0, 8)}`];
      // the old shape is made under the merge's stand-aside, as rows from before 215 stand (no unit write follows it, nothing checks it)
      await withTransaction(async () => {
        await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [context.workspaceId]);
        await q(shape.spoil, [context.workspaceId, u1]);
      });
      const text = async () => (await q<{ t: string }>(`SELECT places::text AS t FROM note_anchor_places WHERE note_id = $1`, [note])).rows[0]!.t;
      if (write === "a save of the body") {
        const after = BODY + "\nA third paragraph\n";
        await withEventTransaction(context.workspaceId, async () => {
          await stampTransaction(context.workspaceId, owner);
          await q(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, after]);
          await moveAnchorsForBodyChange({ workspaceId: context.workspaceId, noteId: note, before: BODY, after });
        });
      } else {
        await seedQ(`UPDATE block_anchors SET quote_suffix = 'a place written alone' WHERE workspace_id = $1 AND anchor_id = $2`, [context.workspaceId, u2]);
      }
      expect(parseAnchorUnit(await text()).ok).toBe(true);
    }));
  }

  it("the receiver's expansion: a row the head does not name is lost on the head's body; an anchor the head names and the node has no row for is left out", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const [u1, u2] = [`u1${note.slice(0, 8)}`, `u2${note.slice(0, 8)}`];
    const head = await unitOf(note);
    const other = sha256Hex("the other body");
    // the head says other words around u1 than this node's row (every place field of the entry differs from the row: the expansion must write each of them)
    const moved = [3, 20, "maybe", 1, 2, true, "paragraph of the", "First ", " note"];
    const place = { h: other, a: { [u1]: moved, gone0000001: [0, 0, "lost", null, null, false, "q", "", ""] } };
    await withTransaction(async () => {
      await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [context.workspaceId]);
      await q(`SELECT note_anchor_places_expand_all($1, $2::jsonb)`, [context.workspaceId, JSON.stringify([{ n: note, p: place, h: other, w: { [u2]: ["words from the newest head", "p", "s"] } }])]);
    });
    const rows = (await q<Record<string, unknown>>(
      `SELECT anchor_id, from_utf16, to_utf16, status, candidate_from_utf16 AS cf, candidate_to_utf16 AS ct, recovery_pending AS pending, quote, quote_prefix AS prefix,
              quote_suffix AS suffix, at_body_hash FROM block_anchors WHERE note_id = $1 ORDER BY anchor_id`, [note])).rows;
    expect(rows).toEqual([
      // named: every field as the head says, measured on the head's body (no own hash)
      { anchor_id: u1, from_utf16: 3, to_utf16: 20, status: "maybe", cf: 1, ct: 2, pending: true, quote: "paragraph of the", prefix: "First ", suffix: " note", at_body_hash: other },
      // not named: lost, stands nowhere, measured on the head's body; its words from the newest head that names it (round 3, point 2), not this node's row
      { anchor_id: u2, from_utf16: 0, to_utf16: 0, status: "lost", cf: null, ct: null, pending: false, quote: "words from the newest head", prefix: "p", suffix: "s", at_body_hash: other },
    ]); // and no row for gone0000001
  }));

  // round 4, point 6: an anchor no head names, on two nodes whose rows hold different words for it (one took an older head that named it, one did not): both end with
  // none, a function of the replicated heads alone. Simulated on one node: the same expansion of two rows that differ only in their words.
  it("an anchor no head names: no words after the expansion, whatever words its row held", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const [u1, u2] = [`u1${note.slice(0, 8)}`, `u2${note.slice(0, 8)}`];
    const head = await unitOf(note);
    const place = { h: head!.h, a: { [u1]: head!.a[u1] } };
    const words = async () => (await q<{ q: string; p: string; s: string }>(`SELECT quote AS q, quote_prefix AS p, quote_suffix AS s FROM block_anchors WHERE note_id = $1 AND anchor_id = $2`, [note, u2])).rows[0]!;
    for (const held of ["words an older head wrote", "words a sender's row had"]) {
      await seedQ(`UPDATE block_anchors SET quote = $3, quote_prefix = $3 WHERE workspace_id = $1 AND anchor_id = $2`, [context.workspaceId, u2, held]);
      await withTransaction(async () => {
        await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [context.workspaceId]);
        await q(`SELECT note_anchor_places_expand_all($1, $2::jsonb)`, [context.workspaceId, JSON.stringify([{ n: note, p: place, h: head!.h, w: {} }])]);
      });
      expect(await words()).toEqual({ q: "", p: "", s: "" });
    }
  }));

  it("the receiver's expansion checks the rows give its head back: a head entry the rows cannot give back (a quote of JSON null) is refused", () => onNode(node, async () => {
    const note = await noteWithAnchors();
    const u1 = `u1${note.slice(0, 8)}`;
    const head = await unitOf(note);
    // an entry the expansion writes differently from how the rows read back: a quote of JSON null is kept as the row's quote, so the rows do not give the head back
    const place = { h: head!.h, a: { ...head!.a, [u1]: [0, 27, "valid", null, null, false, null, "", ""] } };
    expect(await refusal(withTransaction(async () => {
      await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [context.workspaceId]);
      await q(`SELECT note_anchor_places_expand_all($1, $2::jsonb)`, [context.workspaceId, JSON.stringify([{ n: note, p: place, h: head!.h, w: {} }])]);
    }))).toBe("OD215 anchor_unit_not_rows");
  }));
});
