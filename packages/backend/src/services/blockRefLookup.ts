// `[[A#^id]]` when A has no block `^id`: which other note the reader can see
// holds it (docs/architecture/block-nodes.md, 段落連結的後援). The choice is
// @onden/markdown chooseBlockHome — the app and the published site share it;
// this adds what only the server has: the readable scope and the index.
//
// Cost: one indexed lookup (note_block_refs, migration 143, kept from the notes' valid anchors) — never a scan
// of bodies. Privacy: candidates are cut by the caller's read scope inside the
// query (readableScopeSql), so a note the reader cannot read is neither
// chosen nor counted toward "several notes hold it" — the answer is the same
// as if it did not exist.

import { chooseBlockHome, isUuid, BLOCK_ID } from "@onden/markdown";
import { q } from "../db.js";
import { noteHoldsAnchor } from "./blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { readableScopeSql } from "./readPolicy.js";
import type { BlockHome } from "@onden/contract";

/** More notes than this hold the id: it is not an id anyone can mean (a
 *  pasted template); the answer is "not found" without reading them. */
const CANDIDATES_MAX = 20;

/** Whether the note holds block `blockRef`: a valid anchor of that id in it — the first half of the rule, the named
 *  note itself, for a server caller. */
export async function noteHoldsBlock(workspaceId: string, noteId: string, blockRef: string): Promise<boolean> {
  return BLOCK_ID.test(blockRef) && noteHoldsAnchor(workspaceId, noteId, blockRef);
}

/** The note, other than `fromNodeId`, that `actor` reads and that holds block
 *  `^blockRef`, or null. `fromNodeId` is the note the link names; a reader who
 *  cannot read it gets null (not even that it exists). Call only after the
 *  named note's own text lacks the id — the caller reads that. */
export async function findBlockHome(
  actor: ActorCtx, workspaceId: string, fromNodeId: string, blockRef: string,
): Promise<BlockHome | null> {
  if (!isUuid(fromNodeId) || !BLOCK_ID.test(blockRef)) return null;
  const fromParams: unknown[] = [workspaceId, fromNodeId];
  const from = (await q<{ space_id: string | null }>(
    `SELECT n.space_id::text FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = $2 AND ${readableScopeSql(actor, "n", fromParams)}`,
    fromParams,
  )).rows[0];
  if (!from) return null;

  const params: unknown[] = [workspaceId, blockRef, fromNodeId];
  const scope = readableScopeSql(actor, "n", params);
  const found = (await q<BlockHome>(
    `SELECT n.id::text, n.title, n.slug, n.space_id::text
       FROM note_block_refs r JOIN content_nodes n ON n.id = r.note_id
      WHERE r.workspace_id = $1 AND r.block_ref = $2 AND n.id <> $3 AND n.node_type = 'content' AND ${scope}
      ORDER BY n.id LIMIT ${CANDIDATES_MAX + 1}`, params,
  )).rows;
  if (found.length === 0 || found.length > CANDIDATES_MAX) return null;
  // The index is the notes' valid anchors, kept in step by every body write (services/noteBlockRefs.ts).
  const holders = found;

  // Which holders sit somewhere under the named note (a moved paragraph's child note).
  const under = new Set((await q<{ cand: string }>(
    `WITH RECURSIVE up(cand, cur, hops) AS (
       SELECT id, parent_id, 0 FROM content_nodes WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT up.cand, n.parent_id, up.hops + 1 FROM up JOIN content_nodes n ON n.id = up.cur WHERE up.hops < 64)
     SELECT DISTINCT cand::text FROM up WHERE cur = $2`, [holders.map((h) => h.id), fromNodeId],
  )).rows.map((r) => r.cand));

  const home = chooseBlockHome(holders.map((h) => ({
    note: h, underNamed: under.has(h.id), sameSpace: h.space_id === from.space_id,
  })));
  return home ? { id: home.note.id, title: home.note.title, slug: home.note.slug, space_id: home.note.space_id } : null;
}
