// L1 — Tag hierarchy helpers.
//
// Three core operations:
//   1. resolveOrCreatePath(workspaceId, "a/b/c") → leafTagId
//      Splits the path on '/', walks/creates each segment row, returns
//      the leaf id. Idempotent — re-running with same path returns the
//      existing chain.
//
//   2. descendantsOf(workspaceId, tagId) → string[]
//      Returns the tag's descendant ids (NOT including itself). Used by
//      query layer when filtering `tag = parent` should match all
//      children.
//
//   3. fullPath(workspaceId, tagId) → "a/b/c"
//      Walks parent_id up to NULL. Used by display + autocomplete.
//
// Internal cache scope: per-request only (not memoised across requests
// because tag tree changes need to reflect immediately).
//
// References:
//   - SiYuan Tag dock builds a tree by splitting full names on '/'; we
//     do the same parse but persist the structure (real parent_id) so
//     reparenting + descendant filtering are constant-time.
//   - Obsidian nested tags: in-memory recursive lookup. Onden uses SQL
//     recursive CTE for descendantsOf (set semantics, single query).

import { normalizeText } from "@onden/markdown";
import { pool, q } from "../db.js";
import { db } from "../dbKysely.js";
import { insertTagRow } from "./tagWrites.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority, isWorkspaceOwner } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { RESERVED_TAGS } from "../spine/reservedTagKeys.js";
import { TASK_TAG_NAME } from "../spine/taskIdentity.js";
import type { ActorCtx } from "../types.js";
import { viewLayouts } from "./viewLayouts.js";
import { CodedStatusError } from "../statusError.js";
import { liveNodeSql, liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { isTag, isTagNameShape } from "@onden/markdown/contract";

export class TagNameConflictError extends Error {
  constructor() {
    super("A tag with this name already exists in this parent. Choose another name or parent.");
    this.name = "TagNameConflictError";
  }
}

/** Also recognize the database backstop, after the failed transaction rolls
 * back. Other unique violations retain their own semantics (slug, id, etc.). */
export function isTagNameConflict(error: unknown): boolean {
  if (error instanceof TagNameConflictError) return true;
  if (!error || typeof error !== "object") return false;
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === "23505" && pgError.constraint === "content_nodes_class_tag_workspace_parent_title_uq";
}

// ── The tag-name rule ───────────────────────────────────────────────────────
// A tag name is taken when a LIVE class_tag in the same workspace, under the
// same parent (NULL = root), has exactly this title: no case folding, no
// trimming, no slug normalization — only the Unicode form is not compared
// (NFC, D58: names are written in NFC, and a tag stored decomposed before
// that is still the tag `#name` means). This is the database invariant
// (content_nodes_class_tag_workspace_parent_title_uq, for the NFC names
// written since), so every "is this name free here?" question in the backend
// asks it through tagNameTaken / assertTagNameAvailable / liveTagIdByName.
// Which tag a name WRITTEN in a note means is another question, with case
// folding: tagIdForWrittenName below.
// Callers that need trimming (path segments) trim before asking. A content
// note's title never takes a tag name; a soft-deleted tag frees its name.
// The frontend's TitleTagRow deliberately offers fewer creates (it prefers an
// existing tag whose name differs only in case or parent); the server decides.

/** The id of the live tag named `name` (in either Unicode form) under `parentId` (null = root),
 *  ignoring `exceptId`, or null. Uses q(), so it sees the caller's transaction.
 *  The answer is a preview, not a reservation: the unique index still decides
 *  races, including writers that do not take the event lock. */
export async function liveTagIdByName(
  workspaceId: string, parentId: string | null, name: string, { exceptId = null }: { exceptId?: string | null } = {},
): Promise<string | null> {
  const r = await q<{ id: string }>(`SELECT id FROM content_nodes
    WHERE workspace_id=$1 AND ${liveTagNodeSql()}
      AND normalize(title, NFC)=$3 AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND ($4::uuid IS NULL OR id<>$4::uuid)
    LIMIT 1`, [workspaceId, parentId, normalizeText(name), exceptId]);
  return r.rows[0]?.id ?? null;
}

/** Whether `name` is taken under `parentId` by a tag other than `exceptId`.
 *  tagNameTaken(ws, null, "idea") — a root tag named exactly "idea" exists. */
export async function tagNameTaken(
  workspaceId: string, parentId: string | null, name: string, options: { exceptId?: string | null } = {},
): Promise<boolean> {
  return (await liveTagIdByName(workspaceId, parentId, name, options)) !== null;
}

/** Throw TagNameConflictError (→ 409 tag_name_conflict) when the tag's proposed
 * name and parent are taken; `tagId` is the tag being renamed or moved (it does
 * not conflict with itself), or null for a tag about to be created. Call it
 * after authorizing the write. No information about the conflicting node is
 * returned.
 *
 * assertTagNameAvailable(ws, id, { title: nextTitle, parentId: nextParent })
 */
export async function assertTagNameAvailable(
  workspaceId: string, tagId: string | null, { title, parentId }: { title: string; parentId: string | null },
): Promise<void> {
  if (await tagNameTaken(workspaceId, parentId, title, { exceptId: tagId })) throw new TagNameConflictError();
}

// ── The tag-name shape ──────────────────────────────────────────────────────
// The rule is @onden/markdown's isTagNameShape (sharedContract.ts): the same one decides which `{…}` in a note's text are tags,
// so a name that is accepted here can always be written there, and nothing else can.

export class TagNameShapeError extends CodedStatusError {
  constructor() {
    super(400, "tag_name_invalid", "A tag name cannot contain / # , : { } or program symbols such as ; ( ) [ ] = < > * | $ and quotes, or a line break, or start or end with a space.");
    this.name = "TagNameShapeError";
  }
}

/** Throw TagNameShapeError (→ 400 tag_name_invalid) unless `name` can be a
 *  new tag's name. assertTagNameShape("reading list") passes; "a/b" throws. */
export function assertTagNameShape(name: string): void {
  if (!isTagNameShape(name)) throw new TagNameShapeError();
}

/** A tag create refused for a reason other than a sibling of the same name
 *  (that one is TagNameConflictError). Both answer 409 `{ error: code }`:
 *   * `id_conflict` — the requested id already names another row: a note, a
 *     tag with another name or parent, a trashed tag, another workspace's row;
 *   * `reserved_name` — a root tag with a system tag's title (task,
 *     workspace-config, page) by someone other than the owner;
 *     adoptReservedTag would turn it into that system tag. */
export class TagCreateRefusal extends CodedStatusError {
  constructor(code: "id_conflict" | "reserved_name") {
    super(409, code, code === "id_conflict"
      ? "This id already belongs to something else. Create the tag with a new id."
      : "This name belongs to a system tag. Ask the workspace owner to create it.");
    this.name = "TagCreateRefusal";
  }
}

// `task` stays a name no member may take for a root tag: it is the tasks module's reserved word `{task}`
// (taskIdentity.TASK_TAG_NAME), and the module's own tag node (removed in a later batch) is named by it.
const RESERVED_TITLES: ReadonlySet<string> = new Set([...Object.values(RESERVED_TAGS), TASK_TAG_NAME]);

/**
 * Create one plain tag — the single "create a tag" intent. Typing `#name` in a
 * note (resolveOrCreateTagPath, per missing segment) and the +Tag / sidebar
 * "Create #name" (POST /api/tags) both come here, so they agree on:
 *
 *   * authority — any_space_write: anyone who can write somewhere (an editor
 *     in a shared space) may add a plain tag; a read-only token cannot.
 *     Giving a tag a schema, policy or pack stays the owner's
 *     (changeTagSchema, POST /api/tags/import);
 *   * shape — a class_tag with no tag_schema (a "label" tag; schema_id null
 *     in the catalog), colour #888888, slug picked by insertTagRow;
 *   * name — of the tag-name shape (TagNameShapeError → 400), exact,
 *     unique among live siblings, checked under the event lock
 *     (TagNameConflictError → 409; the DB index is the backstop). The check
 *     sees siblings the actor cannot read, so a 409 tells them such a tag
 *     exists (known limit);
 *   * system names — only the owner may create a ROOT tag titled like a
 *     reserved tag (RESERVED_TAGS): adoptReservedTag gives the system role to
 *     such a tag when none holds it, so for anyone else it is a
 *     TagCreateRefusal("reserved_name"). the tasks module's own tag
 *     (ensureModuleTag) does not come through here: it inserts the
 *     module tag itself;
 *   * record — one TAG_CREATED { name, parent_id } with inverse tag.deleted,
 *     committed with the insert.
 *
 * `id` keeps a client-minted id (the offline/optimistic tag writer reconciles
 * by it); omitted, a fresh UUID. Under the event lock a given id is looked up
 * first: the live tag with this name and parent is returned as it is (a replay
 * whose idempotency key has expired — no second TAG_CREATED); any other row
 * holding the id is TagCreateRefusal("id_conflict"). `parentId` must be a live
 * tag the caller has already resolved; null is a root tag.
 *
 *   const { id } = await createTag({ actor, workspaceId, name: "reading" });
 */
export async function createTag(input: {
  actor: ActorCtx;
  workspaceId: string;
  name: string;
  parentId?: string | null;
  id?: string;
}): Promise<CreatedTag> {
  const { actor, workspaceId } = input;
  // Tag names are stored in NFC (D58), as note titles are.
  const name = normalizeText(input.name);
  const parentId = input.parentId ?? null;
  const insert = () => mutate({
    actor, workspaceId,
    authority: { kind: "any_space_write" },
    event: {
      type: "TAG_CREATED", targetType: "tag", targetId: (row: CreatedTag) => row.id,
      payload: { name, parent_id: parentId },
      txMeta: {
        inverse_op: "tag.deleted",
        prev_field_values: { name, parent_id: parentId },
        ui_context: "tag.create",
      },
    },
    // "after": the TAG_CREATED target is the inserted row's id (the DB returns
    // it; under the unit-test mocks it differs from the requested one).
    timing: "after",
    apply: async (): Promise<CreatedTag> => {
      assertTagNameShape(name);
      if (parentId === null && RESERVED_TITLES.has(name) && !(await isWorkspaceOwner(actor))) {
        throw new TagCreateRefusal("reserved_name");
      }
      // The id comes from the request: it must name a node of THIS workspace (a note's id is refused by kind below).
      if (parentId !== null && !(await db.selectFrom("content_nodes").select("id").where("workspace_id", "=", workspaceId).where("id", "=", parentId).where("deleted_at", "is", null).executeTakeFirst())) {
        throw new CodedStatusError(404, "parent_not_found", "The parent tag does not exist.");
      }
      await assertTagNameAvailable(workspaceId, input.id ?? NO_TAG, { title: name, parentId });
      const row = await insertTagRow(workspaceId, { id: input.id, title: name, parentId });
      return { id: row.id, name: row.title, parent_id: parentId, color: row.color };
    },
  });
  if (!input.id) return insert();
  const id = input.id;
  return withEventTransaction(workspaceId, async () => {
    const held = (await q<{ workspace_id: string; node_type: string; title: string; parent_id: string | null; deleted_at: Date | null; color: string | null }>(
      `SELECT workspace_id::text, node_type, title, parent_id::text, deleted_at, tag_color AS color
         FROM content_nodes WHERE id = $1`, [id],
    )).rows[0];
    if (!held) return insert();
    const sameTag = held.workspace_id === workspaceId && isTag(held) && held.deleted_at === null
      && held.title === name && held.parent_id === parentId;
    if (!sameTag) throw new TagCreateRefusal("id_conflict");
    // Answer the replay only to someone who could have made it.
    await assertAuthority(await resolveCurrentActor(actor, workspaceId), { kind: "any_space_write" });
    return { id, name, parent_id: parentId, color: held.color };
  });
}

export type CreatedTag = { id: string; name: string; parent_id: string | null; color: string | null };

/** No tag has this id: a new tag conflicts with every live sibling. */
const NO_TAG = "00000000-0000-0000-0000-000000000000";

export interface TagRow {
  id: string;
  name: string;
  parent_id: string | null;
  color: string;
}

// ── A tag name written in a note ────────────────────────────────────────────
// Every place that turns a tag name someone WROTE into a tag asks
// tagIdForWrittenName (D63): quick capture's `#a/b` (POST
// /api/tags/resolve-path), frontmatter / import `tags:`, and a block's
// `{a, b}` or Obsidian `#tag ^id` (blockNodes.ts). So `tags: [book]` and
// `{book}` in one note name one tag. The rule:
//   * a path `a/b/c` is walked from the ROOT, one segment per level (split on
//     `/`, trimmed, empty segments dropped). A bare name is a one-segment
//     path: the ROOT tag of that name — `book` never means `課程/book`;
//   * a segment is the sibling titled exactly so (in either Unicode form:
//     both sides are compared in NFC, D58); failing that, the ONE
//     sibling whose title matches case-insensitively (block-nodes.md: tag
//     names match case-insensitively, as #118's queries do). Two or more such
//     siblings and none exact (`Book` and `BOOK`, `book` written) is no
//     match: exact-case siblings may coexist (the tag-name rule above);
//   * no match: with `create`, that segment and the rest are created as
//     written (createTag); without, the answer is null.
// The client's offline lookup (frontend lib/data/tagPaths.ts findTagIdByPath)
// follows the same rule; frontend/src/test/fixtures/writtenTagNameParity.json
// holds both ends to it.

/** A written tag path's segments: in NFC (D58), split on `/`, trimmed, empty
 *  ones dropped. */
function writtenTagSegments(name: string): string[] {
  return normalizeText(name).split("/").map((s) => s.trim()).filter(Boolean);
}

/** The child of `parentId` (null = root) that the written `segment` names, by
 *  the rule above, or null. Uses q(), so it sees the caller's transaction. */
async function writtenSegmentTagId(workspaceId: string, parentId: string | null, segment: string): Promise<string | null> {
  const { rows } = await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes
    WHERE workspace_id=$1 AND ${liveTagNodeSql()}
      AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND lower(normalize(title, NFC)) = lower($3)`, [workspaceId, parentId, segment]);
  // `segment` is NFC (writtenTagSegments); a title stored decomposed before
  // D58 is compared in NFC too.
  const exact = rows.find((row) => normalizeText(row.title) === segment);
  if (exact) return exact.id;
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * The tag a written name or path names, by the rule above: its id, or null
 * when it names none (or has no segment). With `create`, each missing segment
 * is created through createTag (any_space_write, TAG_CREATED) and `created`
 * lists the new ids in path order; `id` is then null only for an empty path.
 *
 *   await tagIdForWrittenName(ws, "課程/Book", { create: false }) // 課程/book's id, or null
 *   await tagIdForWrittenName(ws, "book", { create: true, actor }) // the root book, made if missing
 */
export async function tagIdForWrittenName(
  workspaceId: string,
  name: string,
  options: { create: false } | { create: true; actor: ActorCtx },
): Promise<{ id: string | null; created: string[] }> {
  let parentId: string | null = null;
  const created: string[] = [];
  for (const segment of writtenTagSegments(name)) {
    // Explicit type widening keeps TS from inferring `never` for the loop var.
    const lookupParent: string | null = parentId;
    const existingId = await writtenSegmentTagId(workspaceId, lookupParent, segment);
    if (existingId) {
      parentId = existingId;
      continue;
    }
    if (!options.create) return { id: null, created };
    // Concurrency: a parallel resolve can create this same segment between
    // our lookup and the insert. createTag refuses it as a name conflict (or
    // the unique index trips 23505). That's not an error — adopt the winner
    // so resolving is idempotent under concurrency (M7: the race used to
    // surface as an unhandled 500).
    try {
      const { id: newId } = await createTag({ actor: options.actor, workspaceId, name: segment, parentId: lookupParent });
      created.push(newId);
      parentId = newId;
    } catch (e) {
      if (!isTagNameConflict(e) && (e as { code?: string }).code !== "23505") throw e;
      const winnerId = await writtenSegmentTagId(workspaceId, lookupParent, segment);
      if (!winnerId) throw e; // conflict but no visible winner — surface it
      parentId = winnerId;
    }
  }
  return { id: parentId, created };
}

/**
 * Resolve or create a tag chain from a slash-delimited path: the written-name
 * rule above (tagIdForWrittenName) with `create`. An empty path throws.
 *
 * Emits TAG_CREATED for each new segment so the audit trail captures
 * the tree growth. ER restore can undo by walking the events in
 * reverse.
 */
export async function resolveOrCreateTagPath(
  workspaceId: string,
  path: string,
  actor: ActorCtx,
): Promise<{ leafId: string; created: string[] }> {
  if (writtenTagSegments(path).length === 0) {
    throw new Error("empty tag path");
  }
  const { id, created } = await tagIdForWrittenName(workspaceId, path, { create: true, actor });
  return { leafId: id!, created };
}

/**
 * Return the descendant tag ids of the given tag (not including itself).
 *
 * Uses a recursive CTE — one round-trip regardless of tree depth. Runs on `q`,
 * so inside a transaction it sees that transaction's writes and inside a read
 * snapshot it reads the snapshot.
 *
 * Not `nodeTree.subtreeIds`: this walk follows class_tag children only, so a
 * legacy row that parents a note under a tag (parentKind.ts) ends the branch,
 * which a post-filter of subtreeIds would not; and nodeTree already imports
 * this module.
 */
export async function descendantsOf(
  workspaceId: string,
  tagId: string,
): Promise<string[]> {
  // A1.6: walk hierarchy via content_nodes shadow rows.
  const result = await q<{ id: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM content_nodes
        WHERE parent_id = $2 AND workspace_id = $1
          AND ${liveTagNodeSql()}
       UNION ALL
       SELECT t.id FROM content_nodes t
         JOIN descendants d ON t.parent_id = d.id
        WHERE t.workspace_id = $1
          AND ${liveTagNodeSql("t")}
     )
     SELECT id FROM descendants`,
    [workspaceId, tagId],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Walk parent_id up to NULL, build the full slash-delimited path.
 * Returns "a/b/c" for leaf "c" with chain c ← b ← a.
 *
 * Capped at 16 levels — anything deeper is almost certainly a cycle
 * (shouldn't happen since UPDATE ... SET parent_id triggers should
 * reject cycles, but defensive bound costs nothing).
 */
export async function fullTagPath(
  workspaceId: string,
  tagId: string,
): Promise<string> {
  const segments: string[] = [];
  let current: string | null = tagId;
  for (let i = 0; i < 16 && current !== null; i++) {
    // A1.6: walk via content_nodes shadow.
    // The tag itself must be live; a trashed ancestor still names its level,
    // or an exported path would lose its upper segments and re-import as a root tag.
    const row: { rows: Array<{ name: string; parent_id: string | null }> } = await q(
      `SELECT title AS name, parent_id FROM content_nodes
        WHERE id = $1 AND workspace_id = $2
          AND ${tagNodeSql()} AND ($3 OR ${liveNodeSql()})`,
      [current, workspaceId, current !== tagId],
    );
    if (!row.rows[0]) break;
    segments.unshift(row.rows[0].name);
    current = row.rows[0].parent_id;
  }
  return segments.join("/");
}

/**
 * Fetch the workspace's full tag tree as a flat list with parent links.
 * Caller builds the tree in-memory — keeps the SQL simple.
 */
export async function listTagTree(workspaceId: string): Promise<TagRow[]> {
  // A1.6: list tree via content_nodes shadow.
  const result = await pool.query<TagRow>(
    `SELECT id, title AS name, parent_id::text, tag_color AS color
       FROM content_nodes
      WHERE workspace_id = $1
        AND ${liveTagNodeSql()}
      ORDER BY parent_id NULLS FIRST, title ASC`,
    [workspaceId],
  );
  return result.rows;
}

/**
 * Every tag whose notes count as members of `tagId`: the tag, its child tags
 * (a path like 課程/演算法) and the tags that extend it (`tag_schema.extends`
 * — they inherit its fields and abilities, 「繼承」), each expanded the same way.
 * The ONE membership rule: saved views, /api/query and, on the frontend, the
 * tag page and sidebar (lib/nodeTags.ts memberTagIds/tagMembers) all use it
 * (docs/archive/research/unification-audit-2026-10-14.md, round 3 decision; held
 * together by frontend/src/test/fixtures/tagMembershipParity.json).
 * A view module tag (#月曆…) is the exception: the tags extending it use that
 * view, they are not kinds of it, so its members are only its own (none —
 * rule 6); its page gathers those tags explicitly (tagViews aggregate).
 */
export async function memberTagIds(workspaceId: string, tagId: string): Promise<string[]> {
  const result = await q<{ id: string }>(
    `WITH RECURSIVE members AS (
       SELECT $2::uuid AS id
       UNION
       SELECT t.id FROM content_nodes t
         JOIN members m ON t.parent_id = m.id
             OR (jsonb_typeof(t.tag_schema->'extends') = 'array' AND t.tag_schema->'extends' ? m.id::text)
        WHERE t.workspace_id = $1 AND ${liveTagNodeSql("t")}
          AND NOT EXISTS (SELECT 1 FROM content_nodes v WHERE v.id = $2::uuid AND v.tag_schema->>'module' = ANY($3::text[]))
     )
     SELECT id::text FROM members WHERE id <> $2::uuid`,
    [workspaceId, tagId, viewLayouts()],
  );
  return [tagId, ...result.rows.map((r) => r.id)];
}

/**
 * The member tags (memberTagIds) of every tag NAMED one of `names`: names
 * match the title case-insensitively, and every tag with that title counts —
 * the same name can sit under different parents. An unknown name adds
 * nothing. /api/query `tags` and search `#tag` resolve names through this, so
 * a name lists what the tag page lists (tagMembershipParity holds them to it).
 */
export async function memberTagIdsNamed(workspaceId: string, names: string[]): Promise<string[]> {
  const named = await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND ${liveTagNodeSql()}
        AND lower(normalize(title, NFC)) = ANY($2::text[])`, [workspaceId, names.map((name) => normalizeText(name).toLowerCase())],
  );
  const members = new Set<string>();
  for (const { id } of named.rows) for (const member of await memberTagIds(workspaceId, id)) members.add(member);
  return [...members];
}
