import { q, requireTransaction } from "../db.js";
import type { ActorCtx } from "../types.js";
import { extractAttributes, extractFrontmatterAttributes } from "../utils.js";
import { slugify, isSystemAttr } from "@onden/markdown";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { runCascade } from "../spine/mutate.js";
import { recordAttributeChange } from "./attributeChange.js";
import { TAG_NODE_TYPE, isTag, isCanvas } from "@onden/markdown/contract";

import { liveNodeSql } from "../spine/nodeSql.js";
// Wikilink edges live in a leaf module (nodeHooks re-links on an `aliases`
// change, and nodes.ts reaches nodeHooks through attributeChange.ts).
export { relinkTarget, syncWikilinkEdges } from "./wikilinkEdges.js";

/** Post-commit derivation is a new authorized write. Recheck after the queue
 * wait, then commit both attribute rails and their events together. The low-level
 * reconcilers below also serve create flows already inside their root mutation. */
export function syncAuthorizedNodeAttributes(
  workspaceId: string, nodeId: string, markdown: string,
  authenticated: ActorCtx, causeEventId?: string,
): Promise<void> {
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" });
    await syncAttributesAndDispatch(workspaceId, nodeId, markdown, actor, causeEventId);
    await syncFrontmatterAttributes(workspaceId, nodeId, markdown, actor, causeEventId);
  });
}

// Read-then-pick: inherently racy under concurrent creates of the same title
// (both callers can see "free"). The backstop is the DB — migration 064's
// partial unique index (migration 099: per space) rejects the loser with 23505,
// and create paths wrap their INSERT in retryOnSlugConflict below so the race
// resolves to a retry instead of a 500.
//
// Slugs are unique per space (migration 099): pass where the note lives —
// `spaceId` (null = a tag definition), or `parentId` (the note goes under it),
// or `excludeId` alone for a rename (that note's own space). With none of them
// the check spans the workspace (still unique, but a collision can reveal a
// note in a space the caller cannot see).
export type SlugScope = { excludeId?: string; spaceId?: string | null; parentId?: string | null };

export async function uniqueSlug(workspaceId: string, base: string, scope: string | SlugScope = {}): Promise<string> {
  const opts: SlugScope = typeof scope === "string" ? { excludeId: scope } : scope;
  let spaceId: string | null | undefined = opts.spaceId;
  if (spaceId === undefined && opts.parentId) {
    const parent = (await q<{ space_id: string | null; node_type: string }>(
      `SELECT space_id::text, node_type FROM content_nodes WHERE id = $1`, [opts.parentId])).rows[0];
    if (parent && !isTag(parent)) spaceId = parent.space_id;
  }
  if (spaceId === undefined && opts.excludeId) {
    const self = (await q<{ space_id: string | null }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [opts.excludeId])).rows[0];
    if (self) spaceId = self.space_id;
  }
  let slug = base;
  let i = 2;
  for (;;) {
    const params: unknown[] = [workspaceId, slug];
    let where = `workspace_id = $1 AND slug = $2 AND ${liveNodeSql()}`;
    if (opts.excludeId) where += ` AND id <> $${params.push(opts.excludeId)}`;
    if (spaceId !== undefined) where += ` AND space_id IS NOT DISTINCT FROM $${params.push(spaceId)}::uuid`;
    const existing = await q(`SELECT id FROM content_nodes WHERE ${where}`, params);
    if (existing.rows.length === 0) return slug;
    slug = `${base}-${i++}`;
  }
}

/** Tag-node slug (MB3): 'tag-' + the Unicode-preserving slugify, suffixed
 *  unique like every note create. The old inline SQL regexp was ASCII-only —
 *  every pure-CJK tag name collapsed to 'tag--', so the SECOND Chinese tag
 *  hit the (workspace,slug) unique index and surfaced as a 500 (and same-name
 *  segments under different parents collided on 'tag-<name>' the same way). */
export async function uniqueTagSlug(workspaceId: string, name: string, excludeId?: string): Promise<string> {
  return uniqueSlug(workspaceId, slugFor({ node_type: TAG_NODE_TYPE }, name), { excludeId, spaceId: null });
}

/** What slugFor needs to know about a node: its kind and, for the kinds whose
 *  slug does not follow the title, the slug it was given. */
export type SlugNode = { id?: string; node_type: string; slug?: string; reserved_key?: string | null };

/** The slug a title gives a node, before uniqueSlug's -2/-3 suffix (D55: the
 *  one rule). A note's is slugify(title); a tag's is `tag-` + slugify(name).
 *  Some slugs name the row, not its title, and never change: a task's
 *  `task-<uuid>`, a canvas's `canvas-<uuid>`, a reserved tag's
 *  `tag-<key>-<id6>` and a system row's `_name` (the Site Config note). */
export function slugFor(node: SlugNode, title: string): string {
  if (node.slug && (node.reserved_key || node.slug.startsWith("_") || (node.id && node.slug === `task-${node.id}`))) return node.slug;
  if (isCanvas(node) && node.id) return `canvas-${node.id}`;
  return isTag(node) ? `tag-${slugify(title)}` : slugify(title);
}

/** The free slug node `node.id` gets when it carries `title`: slugFor, unique
 *  in the node's space (its own current slug does not count as taken). For a
 *  write that sets the slug in its own UPDATE (nodeUpdate, tagIdentity,
 *  markLive, the event-history undo). */
export async function slugForTitle(workspaceId: string, node: SlugNode & { id: string }, title: string): Promise<string> {
  return uniqueSlug(workspaceId, slugFor(node, title), node.id);
}

/** True iff e is the Postgres unique-violation (23505) on the slug index
 *  (content_nodes_space_slug_uq, migration 099) — i.e. "lost the
 *  uniqueSlug race", not some other constraint. */
export function isSlugConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === "23505" && err?.constraint === "content_nodes_space_slug_uq";
}

/** Re-run a create that lost the slug race. fn must (a) recompute its slug —
 *  call uniqueSlug INSIDE fn, never before it — and (b) contain the whole
 *  INSERT transaction: Postgres aborts the tx on 23505, so nothing of the
 *  failed attempt survives to resume. Two retries is plenty — each retry
 *  re-reads the now-committed winner and picks the next free suffix; losing
 *  three times in a row means something other than a race is wrong. */
export async function retryOnSlugConflict<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (retries-- <= 0 || !isSlugConflict(e)) throw e;
    }
  }
}

/** Syncs inline `#key=value` attributes from markdown into node_attributes.
 *
 *  Parses the markdown, diffs against existing rows, and for each *changed*
 *  attribute:
 *    1. writes the new value (source='derived')
 *
 *  Non-destructive: attributes not present in the new markdown are preserved.
 *  Markdown represents *additions*, not an authoritative state of every
 *  attribute on the node — explicit attributes (set via the /attributes
 *  endpoint) and older dispatcher-derived ones survive content edits. */
/** Record text-derived values (one rail: inline or frontmatter) through
 *  services/attributeChange.ts, each as its own ATTRIBUTE_SET under the
 *  precedence rule (sync-protocol §5). The
 *  writer must be able to write the note: rooted as a cascade on that check,
 *  so it joins a create's or edit's cascade or opens one after commit. */
async function recordDerivedAttributes(
  workspaceId: string, nodeId: string, values: Record<string, string>,
  source: "markdown" | "frontmatter", actor: ActorCtx, causeEventId?: string,
): Promise<{ changed: Array<{ key: string; old: string | null; new: string }> }> {
  const changed: Array<{ key: string; old: string | null; new: string }> = [];
  await runCascade({ actor, workspaceId, authority: { kind: "node", nodeId, op: "write_node" }, causeEventId }, async () => {
    for (const [key, value] of Object.entries(values)) {
      const result = await recordAttributeChange({
        workspaceId, nodeId, key, actor,
        next: { value, source }, rule: "priority",
        authority: { kind: "cascade" },
        uiContext: `node.${source}.derive`,
      });
      if (result.written) changed.push({ key, old: result.previous?.value ?? null, new: value });
    }
  });
  return { changed };
}

export async function syncAttributesAndDispatch(
  workspaceId: string,
  nodeId: string,
  markdown: string,
  actor: ActorCtx,
  causeEventId?: string,
): Promise<{ changed: Array<{ key: string; old: string | null; new: string }> }> {
  // Reserved `_` keys (`_published`, the task and import indices)
  // belong to their domains, never to text in a note: as with frontmatter
  // below and the attribute API, `_published:: true` in a body must not put a
  // note on the public site.
  const next = Object.fromEntries(Object.entries(extractAttributes(markdown)).filter(([key]) => !isSystemAttr(key)));
  if (Object.keys(next).length === 0) return { changed: [] };

  return recordDerivedAttributes(workspaceId, nodeId, next, "markdown", actor, causeEventId);
}

// W2 P5: extract YAML frontmatter (top-of-doc `---` block) into
// node_attributes with source='frontmatter'. Parallel to the body-inline
// extraction above — different source distinguishes file-level YAML from
// paragraph-level `key:: value`, so future edits to either surface only
// touch their slice.
//
// Reference: Obsidian model treats frontmatter (file-level) and inline
// attrs (block-level) as parallel but distinct sources — Onden mirrors.
//
// Last-write semantics on the SAME key across sources: whichever sync runs
// LAST wins on disk. Currently we call this AFTER syncAttributesAndDispatch
// in the route handler, so frontmatter takes precedence over body-inline
// for keys present in both (matches Obsidian, where frontmatter is the
// authoritative file-level surface).
export async function syncFrontmatterAttributes(
  workspaceId: string,
  nodeId: string,
  markdown: string,
  actor: ActorCtx,
  causeEventId?: string,
): Promise<{ changed: Array<{ key: string; old: string | null; new: string }> }> {
  const parsed = extractFrontmatterAttributes(markdown);
  // Internal indices are owned by their domain, never by user-authored YAML.
  const next = parsed && Object.fromEntries(Object.entries(parsed).filter(([key]) => !isSystemAttr(key)));
  if (next === null || Object.keys(next).length === 0) return { changed: [] };

  return recordDerivedAttributes(workspaceId, nodeId, next, "frontmatter", actor, causeEventId);
}
