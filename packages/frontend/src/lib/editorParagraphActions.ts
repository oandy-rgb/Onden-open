// What a person does to THE PARAGRAPH the caret is in, from the phone bar's
// ¶ menu, its "# Tag" button and the desktop selection bubble: tag it, link
// to it, start a [[link]]. Each is one edit on the live editor view, so the
// editor's own undo takes it back and its save carries it.
//
// "The paragraph" is the block @onden/markdown blockTagSlot reads (paragraph,
// list item, heading or quote) — the same place a typed `{tag}` goes. A body
// `#word` is never written here: only `{name}` on the block applies a tag.

import type { EditorView } from "@codemirror/view";
import { writeClipboard } from "./clipboard";
import { addBlockTag, blockLinkSource, blockLinkText, blockTagSlot, blockTagSlotsIn, embedLine, listLinkTargets, type LinkTarget } from "@onden/markdown";
import { anchorStartingAt } from "./editorAnchors";
import { rememberCopiedPartLink } from "./copiedPartLink";
import { rememberCopiedBlock } from "./recentBlocksStore";
import { getCompletions, type TagItem } from "./editorCompletion";
import type { ContentNode } from "./api";
import { resolveEmbed } from "./embeds";
import { tagName } from "./hashtags";

const noteOfView = new WeakMap<EditorView, () => string | undefined>();

/** Say which note `view` is editing (read when asked, so it follows the editor
 *  from note to note): a block link copied from it is remembered under that
 *  note (「最近存的段落」, lib/recentBlocksStore). */
export function bindEditorNote(view: EditorView, noteId: () => string | undefined): void {
  noteOfView.set(view, noteId);
}

/** Whether a paragraph (block) is at `pos`: false in code, a table, front
 *  matter or on a blank line, where there is nothing to tag or link. */
export function hasParagraphAt(view: EditorView, pos: number): boolean {
  return blockTagSlot(view.state.doc.toString(), pos) !== null;
}

/** Where the paragraph (block) holding `pos` starts, or null where there is none
 *  (code, a table, front matter, a blank line). The desktop handle sits on this
 *  block's first line and the menu it opens acts on it. */
export function paragraphStartAt(view: EditorView, pos: number): number | null {
  return blockTagSlot(view.state.doc.toString(), pos)?.start ?? null;
}

/** The words of the paragraph holding `pos`, without its trailing `{tags}` (so an AI
 *  that rewrites it can't lose them), or null where there is no paragraph or it is empty. */
export function paragraphTextAt(view: EditorView, pos: number): string | null {
  const doc = view.state.doc.toString();
  const slot = blockTagSlot(doc, pos);
  if (!slot) return null;
  const text = doc.slice(slot.start, slot.braces ? slot.braces.from : slot.insertAt).trimEnd();
  return text.trim() ? text : null;
}

/** The edit that adds `name` to the `{…}` of the block at `offset`: null when
 *  there is no block there, an empty change when it already has the tag. */
function tagEdit(doc: string, offset: number, name: string): { from: number; to: number; insert: string } | null {
  const next = addBlockTag(doc, offset, name);
  if (next === null) return null;
  let from = 0;
  while (from < doc.length && doc[from] === next[from]) from++;
  let end = doc.length, nextEnd = next.length;
  while (end > from && nextEnd > from && doc[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return { from, to: end, insert: next.slice(from, nextEnd) };
}

/** Write `name` into the `{…}` of the block at `pos` (@onden/markdown
 *  addBlockTag) as one insertion, so one undo takes it back. False when there is
 *  no block there. */
export function insertBlockTag(view: EditorView, pos: number, name: string): boolean {
  const edit = tagEdit(view.state.doc.toString(), pos, name);
  if (edit === null) return false;
  if (edit.from !== edit.to || edit.insert !== "") view.dispatch({ changes: edit });
  return true;
}

/** 「加標籤」 on a selection: `name` goes into the `{…}` of every block the text
 *  `[from, to]` touches (blockTagSlotsIn), all in one edit, so one undo takes
 *  them all back. Blocks that already have the tag are left as they are. False
 *  when the selection touches no block (code, a table, a blank line). */
export function insertBlockTags(view: EditorView, from: number, to: number, name: string): boolean {
  const doc = view.state.doc.toString();
  const slots = blockTagSlotsIn(doc, from, to);
  if (slots.length === 0) return false;
  const changes = slots.flatMap((slot) => {
    const edit = tagEdit(doc, slot.start, name);
    return edit && (edit.from !== edit.to || edit.insert !== "") ? [edit] : [];
  }).sort((a, b) => a.from - b.from);
  // Two blocks never share a tag line; a pair that overlapped anyway would make the edit invalid.
  const apart = changes.filter((edit, i) => i === 0 || edit.from >= changes[i - 1]!.to);
  if (apart.length > 0) view.dispatch({ changes: apart });
  return true;
}

/** The tags the paragraph picker offers for `query`: exactly the rows the
 *  `{` popup offers, so typing and picking list the same names. */
export function paragraphTagChoices(tags: readonly TagItem[], query: string): TagItem[] {
  return getCompletions({ type: "blocktag", query }, {
    nodes: [], tags, attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false,
  }) as TagItem[];
}

/** The tag name `query` would create, or null when it is empty, already one of
 *  `tags` (any case; a virtual tag is not one the `{` popup offers), or not a plain name (`key: value` is an attribute entry
 *  in `{…}`, not a tag). Braces, commas and a leading `#` are not part of it. */
export function newTagName(tags: readonly TagItem[], query: string): string | null {
  const name = tagName(query).replace(/[{},]/g, "").trim();
  if (!name || name.includes(":") || /[\r\n]/.test(name)) return null;
  return tags.some((tag) => !tag.virtual && tag.name.toLowerCase() === name.toLowerCase()) ? null : name;
}

/** What 「變成子筆記」 asks the server to move for the paragraph (list item, heading with its section) at `pos`: the block
 *  by its anchor when the editor knows one for it (`ref`), else the text at its place (`from`/`to`/`text`, which the server
 *  checks against the saved note). Null where there is no such paragraph (a quote, a table, code, a blank line). */
export type ParagraphToMove = { ref: string | null; from: number; to: number; text: string };

export function paragraphToMove(view: EditorView, pos: number): ParagraphToMove | null {
  const doc = view.state.doc.toString();
  const slot = blockTagSlot(doc, pos);
  if (!slot || slot.kind === "quote") return null;
  const from = slot.start;
  const to = from + doc.slice(from, slot.end).trimEnd().length;
  return to > from ? { ref: anchorStartingAt(view.state, slot.start)?.id ?? null, from, to, text: doc.slice(from, to) } : null;
}

/** `copied`: the text is on the clipboard. When false the caller shows `link` for the person to copy by hand. */
export type BlockLinkCopy = { link: string; copied: boolean };

/** The heading, paragraph or list item at `pos` as the link-target list knows it, or null where there is none. */
function partAt(view: EditorView, pos: number): LinkTarget | null {
  const doc = view.state.doc.toString();
  const lineFrom = view.state.doc.lineAt(pos).from;
  const targets = listLinkTargets(doc);
  const heading = targets.find((t) => t.kind === "heading" && t.start === lineFrom);
  if (heading) return heading;
  const slot = blockTagSlot(doc, pos);
  if (!slot || slot.kind === "quote") return null;
  // The block whose first line starts where the slot does.
  return targets.find((t) => t.kind === "block" && t.start === slot.start) ?? targets.find((t) => t.kind === "block" && t.start <= pos && pos <= t.insertAt + 1) ?? null;
}

/** Put `[[title/first words]]` for the part at `pos` on the clipboard. The link reads by its words wherever it is
 *  pasted; pasting it into a note of Onden also binds it to the paragraph (lib/blockSafety/pendingLink), so nothing is
 *  written to the note it was copied from and copying without pasting leaves nothing behind. Null where there is no
 *  part to link. The clipboard write starts in the caller's tap, which iOS requires. */
export async function copyBlockLink(
  view: EditorView, pos: number, title: string,
  writeText: (text: string) => Promise<void> = writeClipboard,
): Promise<BlockLinkCopy | null> {
  const noteId = noteOfView.get(view)?.();
  const part = partAt(view, pos);
  const text = part ? blockLinkText(part.text) : "";
  if (!part || !text) return null;
  const link = blockLinkSource(title, text);
  if (noteId) {
    rememberCopiedPartLink({ link, noteId, at: part.start, seenText: part.text, text });
    if (part.kind === "block") rememberCopiedBlock(noteId, anchorStartingAt(view.state, part.start)?.id ?? null, part);
  }
  try {
    await writeText(link);
    return { link, copied: true };
  } catch {
    return { link, copied: false };
  }
}

/** Type `[[` at the caret, as the person would: the editor's wikilink popup
 *  opens from the edit itself. */
export function startWikilink(view: EditorView): void {
  const { head } = view.state.selection.main;
  view.dispatch({ changes: { from: head, insert: "[[" }, selection: { anchor: head + 2 }, userEvent: "input.type" });
  view.focus();
}

/** Whether the paragraph at `pos` can become a child note: a paragraph, list
 *  item or heading (with its section). A quote, table or code block stays where
 *  it is (the server refuses them too: services/blockChildNote.ts). */
export function canMoveToChild(view: EditorView, pos: number): boolean {
  const slot = blockTagSlot(view.state.doc.toString(), pos);
  return slot !== null && slot.kind !== "quote";
}

/** The child note of `hostId` the line at `pos` embeds — a line that is only
 *  `![[child]]` — or null: the line is something else, or the note it embeds is
 *  not this note's child (a note elsewhere is not ours to take back). */
export function childEmbedAt(view: EditorView, pos: number, hostId: string, nodes: readonly ContentNode[]): ContentNode | null {
  const ref = embedLine(view.state.doc.lineAt(pos).text);
  if (!ref || ref.blockId || ref.heading) return null;
  const embed = resolveEmbed(ref.body, { id: hostId, space_id: nodes.find((n) => n.id === hostId)?.space_id }, nodes);
  if (embed.kind !== "note" || embed.node.parent_id !== hostId || embed.node.deleted_at) return null;
  return embed.node;
}
