// A note's slug: the one rule (D55) and how two nodes end with the same slug (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12.6, batch 4a).
// A slug is not a unit. The write path derives it: `slugFor` from the title, then `freeSlug` gives the first of `base`, `base-2`, `base-3`… no live note of the space
// holds (services/nodes.ts uniqueSlug). It travels with a title (spine/stampedMerge/dbRows.ts DERIVED_WITH: the slug of the write that set the title).
// When two live notes of one space want one slug (`settleSlugs`), the note that CLAIMED it later gives way. A note's claim is the latest stamp of what put it where
// it is under that name: its creation, title and restore, the place (`parent`) of it and of every note above it, and the space written for the note at the top
// (`claimOf`). Stamps are replicated, so every node that holds the same writes picks the same note. How the one that gives way is named follows what its claim is:
//   - NAMED (its latest claim is its creation or its title: the slug came with a write that carries it, DERIVED_WITH) → `slug-<first eight of its id>`, the name no
//     node's state changes (the rule of the merge before batch 4a), so any number of notes made or renamed at once on two nodes end the same;
//   - PLACED (a move, the tree it follows, a restore: no write carries its slug) → the first free one from it (`freeSlug`, `-2`…), which is what the write path of a move
//     or a restore gives, so a node that takes that write by bundle ends with the writer's `-2`.
//   - a move, restore or rename made here is the newest write this node holds, so the note it moved (and every note under it) gives way to the notes already in
//     that space, whose slugs never change for it (review of PR #1941, round 1, point 1: a published address changes only by its own note's writes). The same as main;
//   - two nodes that each moved, restored or made a note with one slug in one space without seeing the other's: the later claim gives way, on both nodes, in either
//     order of delivery (test/receivedDerivation.integration.test.ts).
// What this does not settle: the free slug a PLACED loser takes is the first free one on the node's state. Two nodes agree on it when they hold the same notes of
// that space; three or more notes moved or restored to one slug at once, or a note made at the same time with the very `-2` a placed loser takes, can leave two
// nodes with different suffixes.
import { slugify } from "@onden/markdown";
import { isCanvas, isTag } from "@onden/markdown/contract";
import { snapshotRows } from "./snapshotSql.js";
import { liveNodeSql } from "./nodeSql.js";
import { compareOps } from "../hlc.js";

/** What slugFor needs to know about a node: its kind and, for the kinds whose
 *  slug does not follow the title, the slug it was given. */
export type SlugNode = { id?: string; node_type: string; slug?: string; reserved_key?: string | null };

/** The slug a title gives a node, before freeSlug's -2/-3 suffix (D55: the
 *  one rule). A note's is slugify(title); a tag's is `tag-` + slugify(name).
 *  Some slugs name the row, not its title, and never change: a task's
 *  `task-<uuid>`, a canvas's `canvas-<uuid>`, a reserved tag's
 *  `tag-<key>-<id6>` and a system row's `_name` (the Site Config note). */
export function slugFor(node: SlugNode, title: string): string {
  if (node.slug && (node.reserved_key || node.slug.startsWith("_") || (node.id && node.slug === `task-${node.id}`))) return node.slug;
  if (isCanvas(node) && node.id) return `canvas-${node.id}`;
  return isTag(node) ? `tag-${slugify(title)}` : slugify(title);
}

/** The first of `base`, `base-2`, `base-3`… that no live note holds: in `spaceId` when given (null: no space, a tag), else in the workspace; `excludeId` does not count. */
export async function freeSlug(workspaceId: string, base: string, opts: { excludeId?: string; spaceId?: string | null } = {}): Promise<string> {
  let slug = base;
  let i = 2;
  for (;;) {
    // the statement services/nodes.ts uniqueSlug ran before it moved here, word for word
    const params: unknown[] = [workspaceId, slug];
    let where = `workspace_id = $1 AND slug = $2 AND ${liveNodeSql()}`;
    if (opts.excludeId) where += ` AND id <> $${params.push(opts.excludeId)}`;
    if (opts.spaceId !== undefined) where += ` AND space_id IS NOT DISTINCT FROM $${params.push(opts.spaceId)}::uuid`;
    if ((await snapshotRows(`SELECT id FROM content_nodes WHERE ${where}`, params)).rows.length === 0) return slug;
    slug = `${base}-${i++}`;
  }
}

/** The space a note without one counts as in the unique slug index (migration 099 content_nodes_space_slug_uq). */
const NO_SPACE = "00000000-0000-0000-0000-000000000000";

/** A claim: the stamp in the order every node agrees on (hlc.ts compareOps, which stampedMerge/unit.ts compareStamps is), and whether it is a name. */
type Claim = { hlc: { wall: number; counter: number }; origin: string; seq: number; named: boolean };
const later = (a: Claim, b: Claim): number => compareOps(a, b);
/** The oldest claim there is: a note whose writes this node holds no stamp of (a row older than stamps, migration 202's genesis stamps are `wall` 0 too). */
const NO_CLAIM: Claim = { hlc: { wall: 0, counter: 0 }, origin: "", seq: 0, named: true };

/**
 * Each note's claim to the name it has where it is (see the header): the latest of the stamps of its creation (`*`), title and deletion, the `parent` of it and of
 * every note above it, and the `space` of the note at the top (migration 218 content_nodes_at_top: a note under another note is in its space).
 */
async function claimOf(workspaceId: string, ids: readonly string[]): Promise<Map<string, Claim>> {
  const rows = (await snapshotRows<{ id: string; origin: string; seq: string; wall: string; counter: number; named: boolean }>(
    `WITH RECURSIVE up(start, id, parent, depth) AS (
       SELECT c.id, c.id, c.parent_id, 0 FROM content_nodes c WHERE c.workspace_id = $1 AND c.id = ANY($2::uuid[])
       UNION ALL
       SELECT u.start, p.id, p.parent_id, u.depth + 1 FROM up u JOIN content_nodes p ON p.id = u.parent
        WHERE NOT content_nodes_at_top(u.parent) AND u.depth < 10000
     )
     SELECT u.start::text AS id, s.origin, s.seq::text AS seq, s.hlc_wall::text AS wall, s.hlc_counter AS counter, (u.depth = 0 AND s.field IN ('*', 'title')) AS named
       FROM up u JOIN sync_stamps s ON s.workspace_id = $1 AND s.table_name = 'content_nodes' AND s.row_key = u.id::text
      WHERE s.field = 'parent' OR (s.field = 'space' AND content_nodes_at_top(u.parent)) OR (u.depth = 0 AND s.field IN ('*', 'title', 'deleted'))`,
    [workspaceId, ids])).rows;
  const out = new Map<string, Claim>(ids.map((id) => [id, NO_CLAIM]));
  for (const r of rows) {
    const c: Claim = { hlc: { wall: Number(r.wall), counter: r.counter }, origin: r.origin, seq: Number(r.seq), named: r.named };
    const order = later(c, out.get(r.id)!);
    // one write that set the title and the place (a note made under a parent) is a place: its slug is not the title's alone
    if (order > 0 || (order === 0 && !c.named)) out.set(r.id, c);
  }
  return out;
}

/** Of `a` and `b`, the one that gives way (the later claim; of two equal claims, one write, the larger id), and whether its claim is a name (see the header). */
async function givesWay(workspaceId: string, a: string, b: string): Promise<{ id: string; named: boolean }> {
  const claims = await claimOf(workspaceId, [a, b]);
  const order = later(claims.get(a)!, claims.get(b)!);
  const id = (order === 0 ? a > b : order > 0) ? a : b;
  return { id, named: claims.get(id)!.named };
}

const setSlug = (workspaceId: string, id: string, slug: string) =>
  snapshotRows(`UPDATE content_nodes SET slug = $3 WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id, slug]);

/**
 * Give each note of `wanted` (which holds a name no note has, `~` and its id, or its slug already) the slug it wants, in id order. Where another live note of its
 * space holds it, the one that claimed it later takes the first free one from it (the rule above). In the caller's transaction. The same function where a note
 * is moved here (services/spaces.ts), and where a bundle brings notes (spine/stampedMerge/dbRows.ts).
 */
export async function settleSlugs(workspaceId: string, wanted: readonly { id: string; slug: string }[]): Promise<void> {
  for (const { id, slug } of [...wanted].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const row = (await snapshotRows<{ live: boolean; space: string | null }>(`SELECT (${liveNodeSql()}) AS live, space_id::text AS space FROM content_nodes WHERE workspace_id = $1 AND id = $2::uuid`, [workspaceId, id])).rows[0];
    if (!row) continue;
    if (!row.live) { await setSlug(workspaceId, id, slug); continue; }
    // in the exact form of the unique index content_nodes_space_slug_uq (workspace_id, COALESCE(space_id, zero uuid), slug) WHERE deleted_at IS NULL, so it is one index lookup.
    // Without the space term only the workspace prefix of the index applies: on a real Postgres with current statistics every lookup read the workspace's notes (one scan per note)
    const other = (await snapshotRows<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND COALESCE(space_id, '${NO_SPACE}'::uuid) = $4::uuid AND slug = $2 AND ${liveNodeSql()} AND id <> $3::uuid`,
      [workspaceId, slug, id, row.space ?? NO_SPACE])).rows[0];
    if (!other) { await setSlug(workspaceId, id, slug); continue; }
    const loser = await givesWay(workspaceId, id, other.id);
    const renamed = (by: string) => (loser.named ? Promise.resolve(`${slug}-${by.split("-")[0]}`) : freeSlug(workspaceId, slug, { excludeId: by, spaceId: row.space }));
    if (loser.id === id) { await setSlug(workspaceId, id, await renamed(id)); continue; }
    // the note that held it gives way: it lets go of the name first, so the first free one from it is not the name itself
    await setSlug(workspaceId, other.id, `~${other.id}`);
    await setSlug(workspaceId, id, slug);
    await setSlug(workspaceId, other.id, await renamed(other.id));
  }
}
