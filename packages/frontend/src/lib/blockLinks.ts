import { cutToGraphemes, blockExcerpt, blockLinkShown, linkPathReadings, splitBlockLink, readBlockLink, splitWikilink, type BlockLinkEnv, type BlockLinkRead, type LinkNote } from "@onden/markdown";
import { t } from "./i18n";
import { nodeNeedsBody, type ContentNode } from "./api";
import { anchorsVersion, anchorSpansOf, heldAnchors, heldBindings, type NoteAnchor } from "./blockAnchorStore";
import { resolveWikilink, type WikilinkNode, type WikilinkSource } from "./wikilinks";

// How the app reads `[[筆記/段落開頭]]` (the shared reading is @onden/markdown blockLink.ts): the editor, the
// reading view, backlinks, the embeds and the export preview all call `readPartLink` / `partLinkWords`, so none of
// them decides alone what a link points at or what it says. This file only supplies where the facts are: the
// notes the reader holds, the anchors and link bindings the sync brought (lib/blockAnchorStore), the space rule.

/** What a link is read against: the notes the reader holds and the note the link is written in (its space scopes names). */
export type PartLinkContext = {
  nodes: readonly (WikilinkNode & Partial<Pick<ContentNode, "markdown" | "body_len">>)[] | undefined;
  from: WikilinkSource | null;
};

type HeldNode = NonNullable<PartLinkContext["nodes"]>[number];
const byIdCache = new WeakMap<object, Map<string, HeldNode>>();
function byId(nodes: readonly HeldNode[]): Map<string, HeldNode> {
  let map = byIdCache.get(nodes);
  if (!map) byIdCache.set(nodes, map = new Map(nodes.map((n) => [n.id, n])));
  return map;
}

// By anchor id, built the first time it is asked after a change.
let indexed: { version: number; byId: Map<string, NoteAnchor> } | null = null;
function anchorById(anchorId: string): NoteAnchor | null {
  if (indexed?.version !== anchorsVersion()) {
    const byId = new Map<string, NoteAnchor>();
    for (const list of heldAnchors().values()) for (const a of list) byId.set(a.anchor_id, a);
    indexed = { version: anchorsVersion(), byId };
  }
  return indexed.byId.get(anchorId) ?? null;
}

const asNote = (n: HeldNode): LinkNote => ({ id: n.id, title: n.title, markdown: nodeNeedsBody(n) ? null : n.markdown ?? "" });

export function partLinkEnv(ctx: PartLinkContext): BlockLinkEnv {
  const nodes = ctx.nodes ?? [];
  return {
    findNote: (name) => {
      const n = resolveWikilink(name, ctx.from, nodes);
      return n && !n.deleted_at ? asNote(n) : null;
    },
    note: (id) => {
      const n = byId(nodes).get(id);
      // Not held: gone for good, or not this reader's to see. The two read alike so nothing about the note leaks.
      if (!n) return "unreadable";
      return n.deleted_at ? null : asNote(n);
    },
    binding: (sourceId, key) => (sourceId === null ? null : heldBindings().get(sourceId)?.get(key) ?? null),
    anchor: (anchorId) => {
      const a = anchorById(anchorId);
      return a && {
        anchorId: a.anchor_id, noteId: a.note_id, from: a.from, to: a.to, status: a.status, quote: a.quote,
        candidate: a.candidate_from === null || a.candidate_to === null ? null : { from: a.candidate_from, to: a.candidate_to },
      };
    },
  };
}


/** How the link `target` (the part of `[[…]]` before `|`) written in `ctx.from` reads. */
export function readPartLink(target: string, ctx: PartLinkContext): BlockLinkRead {
  return readBlockLink(partLinkEnv(ctx), ctx.from?.id ?? null, target);
}

/** The words a part link shows, or null when `body` is not a part link (the caller shows it as it always did). An alias wins. */
export function partLinkWords(body: string, ctx: PartLinkContext): string | null {
  const { target, alias } = splitWikilink(body);
  if (alias?.trim()) return null;
  const read = readPartLink(target, ctx);
  // The words of a link whose part cannot be shown. Never an id, never the raw `note/words` text of a deleted paragraph.
  if (read.kind === "erased") return t("Deleted paragraph");
  if (read.kind === "unavailable") return t("Content you cannot access");
  const words = blockLinkShown(read, ctx.from?.id ?? null);
  if (words === "" && "noteId" in read && read.noteId === ctx.from?.id) return t("This note");
  return words === "" ? null : words;
}


// ── the address a read part link is drawn with (`#wl:` is the renderer's own sentinel, never shown) ──

/** Where a drawn part link goes: `#wl:<note id>` with `?at=<offset>` for the part, `&maybe=<anchor id>` while it is a guess;
 *  `#wl-gone:<words>` for a link with nowhere to go (the paragraph was deleted, or the note is not this reader's). */
export function partLinkHref(read: BlockLinkRead): string | null {
  switch (read.kind) {
    case "part": return `#wl:${read.part.noteId}?at=${read.part.from}`;
    case "maybe": return `#wl:${read.part.noteId}?at=${read.part.from}&maybe=${read.anchorId}`;
    case "lost": return `#wl:${read.noteId}?lost=${read.anchorId}${read.guess ? `&at=${read.guess.from}` : ""}`;
    case "pending": return `#wl:${read.noteId}`;
    // Not a part of that note: the link is whatever it was before (an unresolved link a click turns into a note).
    case "no-such-part": case "not-a-part": return null;
    case "ambiguous": return `#wl:${read.options[0]!.noteId}`;
    case "erased": return `#wl-gone:${encodeURIComponent(cutToGraphemes(read.quote, 120))}`;
    case "unavailable": return "#wl-gone:";
  }
}

/** The pieces of a `#wl:` payload after the target: the part's offset, the anchor to confirm while it is a guess (`maybe`), and
 *  the anchor of a paragraph that is not found (`lost`; `at` is then the best guess, if any). */
export function partLinkTail(payload: string): { base: string; at: number | null; maybe: string | null; lost: string | null } {
  const q = payload.search(/\?(?:at|lost)=/);
  if (q < 0) return { base: payload, at: null, maybe: null, lost: null };
  const params = new URLSearchParams(payload.slice(q + 1));
  const at = params.has("at") ? Number(params.get("at")) : NaN;
  return { base: payload.slice(0, q), at: Number.isInteger(at) && at >= 0 ? at : null, maybe: params.get("maybe"), lost: params.get("lost") };
}

/** Where the note's name ends and the part's words begin in a link target: the index of the `/` between them, or -1 when
 *  the target is not a part link. The name is the longest start of the target that names a note held here (a title may
 *  itself hold a `/`); a link to a note since renamed or gone splits at its first `/`. */
export function partLinkSlash(target: string, ctx: PartLinkContext): number {
  const readings = linkPathReadings(target);
  if (readings.length === 0) return -1;
  if (target.trim().startsWith("/")) return target.indexOf("/");
  const env = partLinkEnv(ctx);
  const known = readings.find((r) => r.note !== "" && env.findNote(r.note));
  return known ? target.indexOf(known.note) + known.note.length : target.indexOf("/");
}

// ── the old `[[筆記#^id]]` (read as before; new links are written as part links) ──────────────────────────

/** What the old `[[Note#^id]]` shows: the note and the start of the paragraph the anchor `id` names (「筆記 › 開頭」), never the id.
 *  The text of old notes no longer carries the `^id`; the link keeps reading because the migration kept each id as the anchor's.
 *  A note whose text is not downloaded yet reads as its name only (never as deleted); a `[[#^id]]` to a heading, table or
 *  quote reads 「這篇筆記」. Null when `body` is not such a link, or has an alias (the alias is what shows). */
export function legacyBlockWords(body: string, ctx: PartLinkContext & { selfMarkdown?: string }): string | null {
  const link = splitBlockLink(body);
  if (!link || link.alias?.trim()) return null;
  let markdown: string | null;
  let noteId: string | undefined;
  let title: string | null = link.target;
  if (link.target === "") {
    if (ctx.selfMarkdown === undefined) return t("This note");
    markdown = ctx.selfMarkdown;
    noteId = ctx.from?.id;
    title = null;
  } else {
    const note = resolveWikilink(link.target, ctx.from, ctx.nodes);
    if (!note) return link.target;
    markdown = nodeNeedsBody(note) ? null : note.markdown ?? "";
    noteId = note.id;
    title = link.target;
  }
  if (markdown === null) return title;
  const excerpt = blockExcerpt(markdown, link.blockId, noteId ? anchorSpansOf(noteId, markdown) : []);
  if (excerpt === null) return title === null ? t("Deleted paragraph") : `${title} › ${t("Deleted paragraph")}`;
  if (excerpt === "") return title ?? t("This note");
  return title === null ? excerpt : `${title} › ${excerpt}`;
}

// ── `![[筆記/段落]]` (lib/embeds reads these once this module is loaded) ───────────────────────────────

/** What `![[target]]` shows when it names a part of a held note: the part (`kind: "part"`, read again against the note's text
 *  when it is at hand) or, when the paragraph is lost, the note itself. Null: not a part of any note held here. */
export function partEmbedOf<T extends WikilinkNode>(
  target: string, from: WikilinkSource | null | undefined, nodes: readonly T[] | undefined,
): { kind: "part" | "note"; node: T; context: PartLinkContext } | null {
  const context: PartLinkContext = { nodes, from: from ? { id: from.id, space_id: from.space_id } : null };
  const read = readPartLink(target, context);
  const named = "part" in read ? read.part.noteId : "noteId" in read ? read.noteId : null;
  const node = named ? nodes?.find((n) => n.id === named) : undefined;
  if (!node) return null;
  if (read.kind === "part" || read.kind === "maybe" || read.kind === "pending") return { kind: "part", node, context };
  return read.kind === "lost" ? { kind: "note", node, context } : null;
}

/** The text of the part `target` names, read against `markdown` (the note's text as just loaded, not the row, which may be slim). */
export function partEmbedText(target: string, context: PartLinkContext, node: HeldNode, markdown: string): string | null {
  const loaded = { ...node, markdown, body_len: markdown.length };
  const read = readPartLink(target, { ...context, nodes: (context.nodes ?? []).map((n) => (n.id === loaded.id ? loaded : n)) });
  if (read.kind !== "part" && read.kind !== "maybe") return null;
  return markdown.slice(read.part.from, read.part.to).trim() || null;
}
