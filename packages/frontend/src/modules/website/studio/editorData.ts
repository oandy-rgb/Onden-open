// What the studio's canvas and pickers read from this device's notes. The
// design stores ids only; the canvas draws the same components as the site from
// `puck.metadata` (SiteRenderMeta), filled here from the local store. It is a
// preview: the server freezes the real lists at publish (design doc §5.3), and
// the canvas shows only what would be published, so a note that is not
// published appears as the 「未發布」 placeholder and never as its content.
import { compareText, compareTitles, firstImage, mediaSrc, noteSummary } from "@onden/markdown";
import { walkHome, type SiteDesignV2, type SiteRow } from "@onden/site";
import type { SiteNote, SiteRenderMeta } from "@onden/site/react";
import { TAG_PAGE_ROWS_MAX } from "@onden/markdown";
import type { ContentNode, Tag } from "../../../lib/api";
import { getApiBase, nodeNeedsBody } from "../../../lib/api";
import { splitTagSections } from "../../../lib/tagTree";
import { nodeTagIds, shownTags, listsAsNote } from "../../../lib/nodeTags";
import { isShownPropertyKey } from "../../../lib/childFields";
import type { Space } from "../../../lib/spaces";
import { PUBLISHED_ATTR, publishBlocker, siteStanding, type PublishBlocker } from "../publishBlocker";
import { byUpdatedDesc } from "../../../lib/noteOrder";
import { isNote } from "@onden/markdown/contract";

const FIELD_COLUMNS_MAX = 4;

/** A note the studio can pick: a readable content note on a space that can
 *  publish (not a tag, not the site's own settings note). A note in a space
 *  that cannot publish is in no studio list; see `blockedNotes`. */
export type StudioNote = {
  id: string;
  title: string;
  slug: string;
  updatedAt: string;
  /** Marked `_published`: the next Publish puts it on the site. */
  published: boolean;
};

export type StudioTag = { id: string; name: string; memberCount: number };

/** A note something keeps off the site, for the places that say so: a block
 *  that points at it, and the publish dialog's 「沒有發布的筆記」. */
export type BlockedNote = { id: string; title: string; blocker: PublishBlocker; marked: boolean };

const isPageNode = (node: ContentNode) => listsAsNote(node);
/** A space the viewer knows cannot publish (an unknown space does not count, as in publishBlocker). */
const inClosedSpace = (node: ContentNode, spaces: readonly Space[]) => publishBlocker(node, spaces)?.reason === "space";
/** The notes the studio lists and counts: page notes outside closed spaces. */
const studioPageNodes = (nodes: readonly ContentNode[], spaces: readonly Space[]) =>
  nodes.filter((node) => isPageNode(node) && !inClosedSpace(node, spaces));

export function studioNotes(nodes: readonly ContentNode[], spaces: readonly Space[]): StudioNote[] {
  const parents = new Set(nodes.map((node) => node.parent_id));
  return studioPageNodes(nodes, spaces).map((node) => ({
    id: node.id, title: node.title, slug: node.slug, updatedAt: node.updated_at ?? "",
    published: siteStanding(node, spaces, parents.has(node.id)).on,
  })).sort((a, b) => compareText(b.updatedAt, a.updatedAt));
}

export function blockedNotes(nodes: readonly ContentNode[], spaces: readonly Space[]): BlockedNote[] {
  return nodes.filter(isPageNode).flatMap((node) => {
    const blocker = publishBlocker(node, spaces);
    return blocker ? [{ id: node.id, title: node.title, blocker, marked: node.attrs?.[PUBLISHED_ATTR] === "true" }] : [];
  });
}

/** Tags the owner can show on the site, with their member counts. Reserved and
 *  hidden tags are left out, and so are notes that cannot be published. */
export function studioTags(nodes: readonly ContentNode[], tags: readonly Tag[], spaces: readonly Space[]): StudioTag[] {
  const counts = new Map<string, number>();
  for (const node of studioPageNodes(nodes, spaces)) {
    for (const id of nodeTagIds(node)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return splitTagSections(tags).own
    .map((tag) => ({ id: tag.id, name: tag.name, memberCount: counts.get(tag.id) ?? 0 }))
    .sort((a, b) => b.memberCount - a.memberCount || compareTitles(a.name, b.name));
}

/** The default design's inputs, computed locally the way the server does: the
 *  workspace home when it is on the site, else the top note of the space with
 *  the most published notes; and the tag with the most published members. */
export function defaultDesignInputs(
  notes: readonly StudioNote[], nodes: readonly ContentNode[], tags: readonly Tag[], homeNodeId: string | null,
): { homeNoteId: string | null; topTagId: string | null } {
  const published = new Set(notes.filter((n) => n.published).map((n) => n.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let homeNoteId: string | null = homeNodeId && published.has(homeNodeId) ? homeNodeId : null;
  // Else the top untagged note of the space with the most pages on the site (backend publishing/siteHome.ts
  // siteHomeFor, which alone also weighs the slug and falls back to a tagged page; the default design has no cover
  // note rather than a tagged one).
  if (homeNoteId === null) {
    const perSpace = new Map<string | null, number>();
    for (const id of published) { const space = byId.get(id)?.space_id ?? null; perSpace.set(space, (perSpace.get(space) ?? 0) + 1); }
    const rank = (id: string) => {
      const node = byId.get(id);
      return [
        -(perSpace.get(node?.space_id ?? null) ?? 0),
        node?.parent_id && published.has(node.parent_id) ? 1 : 0,
      ];
    };
    const order = (a: number[], b: number[]) => a.findIndex((x, i) => x !== b[i]);
    const untagged = [...published].filter((id) => (byId.get(id)?.class_tag_ids?.length ?? 0) === 0);
    homeNoteId = untagged.reduce<string | null>((best, id) => {
      if (best === null) return id;
      const [ra, rb] = [rank(id), rank(best)];
      const i = order(ra, rb);
      return i >= 0 && ra[i]! < rb[i]! ? id : best;
    }, null);
  }
  const counts = new Map<string, number>();
  for (const id of published) for (const tagId of nodeTagIds(byId.get(id) ?? {})) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
  const usable = new Set(shownTags(tags).filter((tag) => !tag.reserved_key && tag.schema_id).map((tag) => tag.id));
  let topTagId: string | null = null;
  for (const [id, count] of counts) {
    if (usable.has(id) && count > (topTagId ? counts.get(topTagId)! : 0)) topTagId = id;
  }
  return { homeNoteId, topTagId };
}

// ── The canvas' metadata ─────────────────────────────────────────────────

/** A note's Markdown: the store's, or — for a note held without its body (slim
 *  bootstrap) — the body read on demand. The store's text wins once it has any,
 *  so an edit made from the canvas shows at once. */
export function noteMarkdown(node: ContentNode, bodies?: ReadonlyMap<string, string>): string {
  return nodeNeedsBody(node) ? bodies?.get(node.id) ?? "" : node.markdown ?? "";
}

export type MetaInput = {
  nodes: readonly ContentNode[];
  tags: readonly Tag[];
  notes: readonly StudioNote[];
  design: SiteDesignV2;
  /** Markdown of notes the store holds without a body (slim bootstrap), once read. */
  bodies?: ReadonlyMap<string, string>;
  /** Notes shown as published although they are not yet (the 「一起發布」 preview). */
  alsoPublished?: ReadonlySet<string>;
  renderMarkdown: SiteRenderMeta["renderMarkdown"];
};

export function buildEditorMeta(input: MetaInput): SiteRenderMeta {
  const { nodes, tags, notes, design, bodies, alsoPublished } = input;
  const tagName = new Map(tags.map((tag) => [tag.id, tag.name]));
  const dateTags = new Set(design.frames.date_tags);
  const onSite = new Set(notes.filter((n) => n.published).map((n) => n.id));
  for (const id of alsoPublished ?? []) onSite.add(id);
  const siteNodes = nodes.filter((node) => isPageNode(node) && onSite.has(node.id));

  const markdownOf = (node: ContentNode) => noteMarkdown(node, bodies);
  const dateOf = (node: ContentNode) =>
    nodeTagIds(node).some((id) => dateTags.has(tagName.get(id) ?? "")) ? (node.created_at ?? "").slice(0, 10) || undefined : undefined;
  const siteNote = (node: ContentNode): SiteNote => ({
    id: node.id, title: node.title, slug: node.slug, markdown: markdownOf(node), date: dateOf(node),
    tags: nodeTagIds(node).flatMap((id) => tagName.get(id) ?? []),
  });
  const rowOf = (node: ContentNode): SiteRow => {
    const markdown = markdownOf(node);
    const image = firstImage(markdown);
    const fields = Object.fromEntries(
      Object.entries(node.attrs ?? {}).filter(([key, value]) => isShownPropertyKey(key) && typeof value === "string" && value !== "").slice(0, FIELD_COLUMNS_MAX),
    );
    return {
      id: node.id, title: node.title, slug: node.slug, date: dateOf(node) ?? "", fields,
      image: image ? mediaSrc(image, { apiBase: getApiBase() }) : "",
      excerpt: noteSummary(markdown, { title: node.title, maxLen: 80 }),
    };
  };

  const membersOf = (tagId: string) =>
    siteNodes.filter((node) => nodeTagIds(node).includes(tagId))
      .sort(byUpdatedDesc)
      .map(rowOf);

  const notesById: Record<string, SiteNote> = {};
  for (const node of siteNodes) notesById[node.id] = siteNote(node);

  const resolved: Record<string, SiteRow[]> = {};
  const tagNames: Record<string, string> = {};
  walkHome(design.home, (component) => {
    if (component.type !== "tag_view" && component.type !== "timeline") return;
    const tagId = typeof component.props.tagId === "string" ? component.props.tagId : "";
    if (!tagId) return;
    resolved[component.props.id] = membersOf(tagId).slice(0, TAG_PAGE_ROWS_MAX);
    const name = tagName.get(tagId);
    if (name) tagNames[tagId] = name;
  });

  // A block that points at a note which is not on the site draws its title and
  // 「未發布」, in the studio only: the words never reach the canvas.
  const drafts: Record<string, { title: string }> = {};
  for (const id of referencedNoteIds(design)) {
    const node = !onSite.has(id) ? nodes.find((n) => n.id === id && isNote(n)) : undefined;
    if (node) drafts[id] = { title: node.title };
  }

  return {
    notes: notesById, resolved, tagNames, drafts,
    renderMarkdown: input.renderMarkdown,
    // Links in the canvas select, they do not navigate.
    hrefFor: () => "#",
    editing: true,
  };
}

/** The note ids a design points at (`note` components), in page order. */
export function referencedNoteIds(design: SiteDesignV2): string[] {
  const ids: string[] = [];
  walkHome(design.home, (component) => {
    if (component.type === "note" && typeof component.props.noteId === "string" && component.props.noteId) ids.push(component.props.noteId);
  });
  return [...new Set(ids)];
}
