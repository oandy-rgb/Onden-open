// `![[…]]` embeds in the app: which note an embed names and what kind of
// thing it shows — the one resolver behind the preview (MarkdownRenderer) and
// the editor (lib/editorEmbeds) — plus the drawing loader both draw from.
// The grammar is @onden/markdown embeds.ts; the published site's drawings
// are inlined by the server (backend modules/website/publishing/drawingEmbeds.ts).
//
// Kinds (EmbedKind) and who renders them (lib/embedDom.ts):
//   - drawing: `![[name.excalidraw]]` (an Obsidian Excalidraw import) or any
//     embed of a note that is a handwriting page → its static SVG;
//   - note:    any other note → its first lines (`![[Note]]`), or the section
//              under a heading (`![[Note#Heading]]`), read-only, with a link;
//   - block:   `![[note#^id]]` (the old form; `id` is the paragraph's anchor id) → that block, read-only, with a "— Note" line
//              that opens it. An embed inside embedded text is a link (depth 1);
//   - task:    a task (lib/taskRefs) → a live checkbox row that completes it;
//   - image:   not produced yet — imported `![[file.png]]` became `![](…)`
//     at import (backend importedImageLinks.ts), which renders as an image.
// A drawing is only known once its ink_data is loaded, so a "note" embed
// whose note turns out to be a drawing is drawn as one.

import { embedLabel, fenceScanner, embedMatches, extractBlock, extractSection, nodeRefId, parseEmbed, stripFrontmatter, type EmbedKind, type EmbedRef } from "@onden/markdown";
import { resolveWikilink, type WikilinkNode, type WikilinkSource } from "./wikilinks";
import { anchorSpansOf } from "./blockAnchorStore";
import { loadedPartLinks } from "./partLinkModule";
import type { PartLinkContext } from "./blockLinks";
import { currentTaskRefs, isTaskRef, resolveTaskRef, type TaskRef } from "./taskRefs";

export type ResolvedEmbed<T extends WikilinkNode = WikilinkNode> =
  | { kind: Extract<EmbedKind, "drawing" | "note">; ref: EmbedRef; label: string; node: T; heading: string | null }
  | { kind: "block"; ref: EmbedRef; label: string; node: T; blockId: string }
  /** `![[筆記/段落開頭]]`: a part of `node` named by words (and, in the app, bound to an anchor). The part is read again when
   *  the note's text is at hand (embedExcerpt), through the same reading as every part link (lib/blockLinks). */
  | { kind: "part"; ref: EmbedRef; label: string; node: T; target: string; context: PartLinkContext }
  /** A task, as a live checkbox row. `task` null: it is named by id (the
   *  embed was written to show it) but the reader holds no such task — no
   *  permission, or gone — and the row says so without a title. */
  | { kind: "task"; ref: EmbedRef; label: string; task: TaskRef | null }
  /** Names no note (or no note this one may link to): shown as written. */
  | { kind: "missing"; ref: EmbedRef; label: string };

const EXCALIDRAW = /\.excalidraw$/i;

/** What `![[body]]`, written in `from`, shows: the wikilink rule picks the
 *  note (lib/wikilinks: title, then the name without `.excalidraw`, then an
 *  alias; within `from`'s space first), the body's form picks the kind.
 *
 *  A note of another space is shown too when none in `from`'s space has that
 *  name: `[[` completion offers every readable note, and an embed only reads
 *  what `nodes` holds (the notes this person may read), so showing it reveals
 *  nothing. The link itself stays a title link for the server — no edge, no
 *  backlink — as spaces.md 連結與引用 says. */
export function resolveEmbed<T extends WikilinkNode>(
  body: string, from: WikilinkSource | null | undefined, nodes: readonly T[] | undefined,
  /** The tasks the reader holds (lib/taskRefs); defaults to the app's. */
  tasks: readonly TaskRef[] = currentTaskRefs(),
): ResolvedEmbed<T> {
  const ref = parseEmbed(body);
  let label = embedLabel(ref);
  // A quoted region names its note by id when the title could not say which (lib/inkRegionQuote).
  const byId = ref.inkRegion && ref.target ? nodeRefId(ref.target) : null;
  const node = byId
    ? nodes?.find((n) => n.id.toLowerCase() === byId && !isTaskRef(n)) ?? null
    : ref.target
    ? resolveWikilink(ref.target, from, nodes) ?? resolveWikilink(ref.target, from && { id: from.id }, nodes)
    : null;
  // `![[筆記/段落]]`: read by lib/blockLinks (loaded on use, lib/partLinkModule).
  const part = !node && ref.target.includes("/") ? loadedPartLinks()?.partEmbedOf(ref.target, from, nodes) : null;
  if (part) return part.kind === "part"
    ? { kind: "part", ref, label, node: part.node, target: ref.target, context: part.context }
    : { kind: "note", ref, label, node: part.node, heading: null };
  if (node && ref.inkRegion && !ref.label && nodeRefId(ref.target)) label = node.title || label; // named by id: show the note's title
  if (!node && ref.inkRegion) return { kind: "missing", ref, label };
  if (!node) {
    // A task is no note: by id, or by a title no note has. `#anchor` / `#^id`
    // parts name positions inside notes, not inside a task.
    const task = ref.target && !ref.blockId && !ref.heading ? resolveTaskRef(ref.target, tasks) : null;
    if (task) return { kind: "task", ref, label, task };
    if (ref.target && nodeRefId(ref.target)) return { kind: "task", ref, label, task: null };
    return { kind: "missing", ref, label };
  }
  if (ref.blockId) return { kind: "block", ref, label, node, blockId: ref.blockId };
  return { kind: EXCALIDRAW.test(ref.target) ? "drawing" : "note", ref, label, node, heading: ref.heading };
}

// ── Transclusion ───────────────────────────────────────────────────────────
// A block, section or note embed shows part of the source note's Markdown.
// The text comes from the notes the app already holds (the store: sync and
// local edits update it) and, for a note held without its body (slim
// bootstrap), one read of the note — through the data layer, shared by mounts
// within RELOAD_MS (lib/embedSources.ts — kept out of this file so the
// published site, which only resolves embeds, does not load the data layer).
// It never blocks typing: embedDom reads it lazily.

/** A node as the embed reads its body: the app's rows carry `markdown` (""
 *  when slim, with `body_len` saying a body exists). */
export type SourceNode = WikilinkNode & { markdown?: string; body_len?: number };

/** What the embed was last drawn from. Equal versions draw the same text, so
 *  a widget / mount is kept until this changes (a sync or a local edit). */
export function embedSourceVersion(node: WikilinkNode): string {
  if (isTaskRef(node)) return taskVersion(node);
  const { markdown, body_len } = node as SourceNode;
  return markdown ? markdown : `slim:${body_len ?? 0}`;
}

/** What a task row was drawn from: its title and facts, so a change redraws it. */
export function taskVersion(task: TaskRef): string {
  return `task:${task.title}:${JSON.stringify(task.task)}`;
}

/** How many lines of a whole-note embed show before "Show more". */
export const NOTE_EXCERPT_LINES = 20;

export type EmbedExcerpt = { text: string; /** Whole-note embed with lines left out. */ more: boolean; full: string };

/** `![[x]]` inside embedded text becomes `[[x]]`: a link, not a second level
 *  of embedding (depth limit 1, so no loop can form). */
export function flattenEmbeds(text: string): string {
  if (!text.includes("![[")) return text;
  let out = "", last = 0;
  for (const m of embedMatches(text)) {
    out += text.slice(last, m.start) + text.slice(m.start + 1, m.end);
    last = m.end;
  }
  return out + text.slice(last);
}

/** The part of `markdown` an embed shows, or null when the note has no such
 *  block / heading. An empty note shows no text (the source line remains). Pure. */
export function embedExcerpt(embed: Exclude<ResolvedEmbed, { kind: "missing" | "task" }>, markdown: string): EmbedExcerpt | null {
  if (embed.kind === "part") {
    const text = loadedPartLinks()?.partEmbedText(embed.target, embed.context, embed.node, markdown);
    return text ? { text: flattenEmbeds(text), more: false, full: "" } : null;
  }
  if (embed.kind === "block") {
    const part = extractBlock(markdown, embed.blockId, anchorSpansOf(embed.node.id, markdown));
    return part === null ? null : { text: flattenEmbeds(part), more: false, full: "" };
  }
  if (embed.heading) {
    const part = extractSection(markdown, embed.heading);
    return part === null ? null : { text: flattenEmbeds(part), more: false, full: "" };
  }
  const body = stripFrontmatter(markdown).trim();
  const lines = body.split("\n");
  if (lines.length <= NOTE_EXCERPT_LINES) return { text: flattenEmbeds(body), more: false, full: "" };
  const head = lines.slice(0, NOTE_EXCERPT_LINES);
  // A cut inside a code fence would swallow the rest of the page: close it.
  const fence = fenceScanner();
  const states = head.map(fence);
  const open = states[states.length - 1] === "open" || states[states.length - 1] === "inside";
  return { text: flattenEmbeds(head.join("\n") + (open ? "\n```" : "")), more: true, full: flattenEmbeds(body) };
}
