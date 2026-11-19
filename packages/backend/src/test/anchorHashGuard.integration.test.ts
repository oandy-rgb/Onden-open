// Guard of migration 215 (block_anchors_hash_is_body): an anchor row is written with the hash of the body it was measured on, the body of its note as the same
// statement sees it, so its place carries the same write as that body (anchors proposal 2026-11-16 §3.1, step 2). A merge or a snapshot import (the stamp triggers stand aside)
// writes what the core decided and is not checked here. SAFETY: the test database (a PGlite, or a `_test` database of a real server).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { sha256Hex } from "../utils.js";
import { seedQ } from "./helpers/seedQ.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { renameAnchor } from "../services/blockAnchors/index.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const BODY = "First paragraph of the note\n\nSecond paragraph of the note\n";
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? "error");

describe.skipIf(!isTestDb)("an anchor is written with the hash of its note's body", () => {
  let node: RealNode;
  const context = { workspaceId: "" };
  let space = "";
  // a node with a stamped world (it has a stamp clock, so a merge can be opened on it); each test has its own note (the tests of a file run in a shuffled order)
  beforeAll(async () => {
    node = await openNode("guard");
    const world = await buildSourceWorld(node);
    context.workspaceId = world.ws;
    space = world.spaceA;
  }, 300_000);
  afterAll(async () => { await node?.close().catch(() => undefined); });

  const newNote = async (): Promise<string> => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, 'manual', 'content', 'Guarded', 'guarded-' || gen_random_uuid(), $2, $3) RETURNING id::text`,
    [context.workspaceId, BODY, space])).rows[0]!.id;
  const insert = (note: string, id: string, hash: string) => seedQ(
    `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, $2, $3, 0, 27, $4, 'First paragraph of the note')`,
    [context.workspaceId, id, note, hash]);

  it("the hash of the note's body is taken; any other is refused (OD215), on insert and on an update that writes the hash", () => onNode(node, async () => {
    const note = await newNote();
    expect(await refusal(insert(note, "guard-ok", sha256Hex(BODY)))).toBeNull();
    expect(await refusal(insert(note, "guard-bad", sha256Hex("another body")))).toBe("OD215");
    expect(await refusal(seedQ(`UPDATE block_anchors SET at_body_hash = $2 WHERE anchor_id = 'guard-ok' AND workspace_id = $1`, [context.workspaceId, sha256Hex("old body")]))).toBe("OD215");
    // an update that does not write the hash (a status set by the same write that moves the anchors later) is not checked by itself
    expect(await refusal(seedQ(`UPDATE block_anchors SET status = 'maybe', from_utf16 = 0, to_utf16 = 0 WHERE anchor_id = 'guard-ok' AND workspace_id = $1`, [context.workspaceId]))).toBeNull();
  }));

  it("a body written first and its anchors after, in one transaction (what applyBodyChange does), is taken", () => onNode(node, async () => {
    const note = await newNote();
    expect(await refusal(insert(note, "guard-tx", sha256Hex(BODY)))).toBeNull();
    const next = BODY + "\nThird paragraph\n";
    await withTransaction(async () => {
      await q(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, next]);
      await q(`UPDATE block_anchors SET at_body_hash = $2 WHERE note_id = $1`, [note, sha256Hex(next)]);
    });
    expect((await q<{ h: string }>(`SELECT at_body_hash AS h FROM block_anchors WHERE anchor_id = 'guard-tx' AND workspace_id = $1`, [context.workspaceId])).rows[0]!.h).toBe(sha256Hex(next));
  }));

  it("a merge (the stamp triggers stand aside) is not checked here: the core writes what it decided", () => onNode(node, async () => {
    const note = await newNote();
    expect(await refusal(insert(note, "guard-merge", sha256Hex(BODY)))).toBeNull();
    const r = await refusal(withTransaction(async () => {
      await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [context.workspaceId]);
      await q(`UPDATE block_anchors SET at_body_hash = $2 WHERE anchor_id = 'guard-merge' AND workspace_id = $1`, [context.workspaceId, sha256Hex("the other head's body")]);
    }));
    // the switch is honoured only for a workspace that has a stamp clock and is not joining (sync_import_active, migration 205)
    const hasClock = (await q(`SELECT 1 FROM sync_clock WHERE workspace_id = $1`, [context.workspaceId])).rows.length > 0;
    expect(hasClock).toBe(true);
    expect(r).toBeNull();
  }));

  // review of PR #1853, point 2: renameAnchor (the `^id` conversion, services/blockIdMigration.ts) changes anchor_id and writes no hash; on a note whose anchors are stale
  // (its body changed while they were not read) it must not be refused
  it("a rename of an anchor whose hash is stale is not a write of the hash", () => onNode(node, async () => {
    const note = await newNote();
    expect(await refusal(insert(note, "guard-shadow", sha256Hex(BODY)))).toBeNull();
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, BODY + "\nedited elsewhere\n"]); // the anchor is stale now
    expect(await refusal(withTransaction(() => renameAnchor(context.workspaceId, note, "guard-shadow", "guard-renamed")))).toBeNull();
    expect((await q(`SELECT 1 FROM block_anchors WHERE workspace_id = $1 AND anchor_id = 'guard-renamed'`, [context.workspaceId])).rows).toHaveLength(1);
  }));

  it("one statement that writes the anchors of several notes: each is checked against its own note", () => onNode(node, async () => {
    const [n1, n2] = [await newNote(), await newNote()];
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [n2, "Another body\n"]);
    expect(await refusal(insert(n1, "guard-m1", sha256Hex(BODY)))).toBeNull();
    expect(await refusal(insert(n2, "guard-m2", sha256Hex("Another body\n")))).toBeNull();
    const both = (h1: string, h2: string) => refusal(seedQ(
      `UPDATE block_anchors a SET at_body_hash = v.h FROM (VALUES ('guard-m1', $2), ('guard-m2', $3)) v(id, h) WHERE a.workspace_id = $1 AND a.anchor_id = v.id`,
      [context.workspaceId, h1, h2]));
    expect(await both(sha256Hex(BODY), sha256Hex("Another body\n"))).toBeNull();
    expect(await both(sha256Hex(BODY), sha256Hex(BODY))).toBe("OD215"); // the second note's anchor named the first note's body
  }));

  it("an anchor moved to another note (note_id changes) must carry that note's body", () => onNode(node, async () => {
    const [from, to] = [await newNote(), await newNote()];
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [to, "The note it moves into\n"]);
    expect(await refusal(insert(from, "guard-move", sha256Hex(BODY)))).toBeNull();
    expect(await refusal(seedQ(`UPDATE block_anchors SET note_id = $2 WHERE workspace_id = $1 AND anchor_id = 'guard-move'`, [context.workspaceId, to]))).toBe("OD215");
    expect(await refusal(seedQ(`UPDATE block_anchors SET note_id = $2, at_body_hash = $3 WHERE workspace_id = $1 AND anchor_id = 'guard-move'`, [context.workspaceId, to, sha256Hex("The note it moves into\n")]))).toBeNull();
  }));

  it("the body's hash is worked out again when the note changes inside the same transaction", () => onNode(node, async () => {
    const note = await newNote();
    expect(await refusal(withTransaction(async () => {
      await q(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, 'guard-twice', $2, 0, 5, $3, 'First')`, [context.workspaceId, note, sha256Hex(BODY)]);
      await q(`UPDATE content_nodes SET markdown = 'Changed\n' WHERE id = $1`, [note]);
      // a second anchor with the OLD body's hash, after the note changed in the same transaction: refused (the cached hash was of the earlier version)
      await q(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, 'guard-twice2', $2, 0, 5, $3, 'First')`, [context.workspaceId, note, sha256Hex(BODY)]);
    }))).toBe("OD215");
    expect(await refusal(withTransaction(async () => {
      await q(`UPDATE content_nodes SET markdown = 'Changed\n' WHERE id = $1`, [note]);
      await q(`UPDATE block_anchors SET at_body_hash = $2 WHERE note_id = $1`, [note, sha256Hex("Changed\n")]);
    }))).toBeNull();
  }));
});
