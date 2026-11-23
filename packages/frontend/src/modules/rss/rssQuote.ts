import { appendedBody, blockLinkSource, blockLinkText, excerptBlock, excerptsOfPage, sameExcerpt, sourceLine as excerptSourceLine, type Excerpt, type ExcerptSource } from "@onden/markdown";
import { getAppState, getNode } from "../../lib/appStore";
import { nodeNeedsBody } from "../../lib/api";
import { anchorSpansOf } from "../../lib/blockAnchorStore";
import { dayNotes, noteWriter, reads, WriteActionError } from "../../lib/data";
import { t } from "../../lib/i18n";
import { PREFS, getPref, setPref } from "../../lib/prefs";
import { randomUUID } from "../../lib/uuid";
import type { RssDestination } from "./useRssUnread";
import { displayTitle } from "../../lib/noteLabel";
import { untitledTitle } from "../../lib/noteLabel";
import { isNote } from "@onden/markdown/contract";

// Quote, don't hoard: what the reader writes into notes.
//
//   appendQuote(targetId, { passage, source }) — 「放進筆記」: the selection as
//     an EXCERPT (@onden/markdown excerpt.ts: a quote with its source link),
//     APPENDED to the end of a note;
//   loadPageExcerpts(url) / knownExcerpt(...) — which excerpts of a page this
//     device already knows (worked out once, in the background, when the
//     article opens), so a passage is not written twice without a click ever
//     waiting on a lookup;
//   appendToNote(targetId, block)             — the same append for any block
//     (「引用到筆記」 › 加到現有筆記… with this session's excerpts);
//   startDraft({ embeds, source, destination }) — 「引用到筆記」 › 新草稿.
//
// An excerpt lives in a note YOU write (today's note by default); the
// embed `![[Note/first words]]` shows it elsewhere without copying it
// (docs/architecture/excerpts.md).
//
// Every write is the normal note writer (lib/data/noteWriter): optimistic,
// mirrored, sent or durably queued offline. An append never overwrites: it
// sends the note's body as it was read (`baseMarkdown`), so the server's
// three-way merge keeps edits made elsewhere meanwhile (docs/architecture/
// note-writes.md). Its `undo` removes exactly the appended text — again
// through the merge — and nothing else; it is one undo step.

export type QuoteSource = ExcerptSource;

/** The selected text and the words around it in the article. */
export type Passage = { text: string; prefix: string; suffix: string };

/** "— [title](url) · feed" (the untitled name is the app's). */
export const quoteSourceLine = (source: QuoteSource): string => excerptSourceLine(source, untitledTitle());

/** `status`: "synced" accepted by the server, "queued" durably saved on this
 *  device (it syncs later). `undo` removes the appended text: true when it
 *  did, false when the note no longer ends with it anywhere (edited away). */
export type AppendResult = { status: "synced" | "queued"; undo: () => Promise<boolean> };

/** A note's current body: the store's copy, or the server's when the store
 *  holds a slim row without one. */
async function bodyOf(targetId: string): Promise<string> {
  const node = getNode(targetId);
  if (!node) throw new WriteActionError(t("This note is no longer available. Keep your draft and reopen the note."));
  if (!nodeNeedsBody(node)) return node.markdown ?? "";
  try {
    return (await reads.notes.full(targetId)).markdown ?? "";
  } catch {
    // Appending to a body this device does not have could overwrite it.
    throw new WriteActionError(t("Connect to add to this note: its text is not on this device yet."));
  }
}

/** Append `block` to the end of note `targetId` (`block` may be made from the
 *  body being appended to).
 *  Throws (already reported by the writer, or a WriteActionError for the
 *  caller to show) when refused. */
export async function appendToNote(targetId: string, block: string | ((base: string) => string)): Promise<AppendResult> {
  const base = await bodyOf(targetId);
  const next = appendedBody(base, typeof block === "string" ? block : block(base));
  // What the append put after the note's last text, and the trailing
  // whitespace it replaced (undo puts that back, so the body is as before).
  const kept = base.replace(/\s+$/, "");
  const added = next.slice(kept.length);
  const tail = base.slice(kept.length);
  const res = await noteWriter.patch(targetId, { markdown: next }, { baseMarkdown: base });
  return {
    status: res.status === "queued" ? "queued" : "synced",
    undo: async () => {
      const now = await bodyOf(targetId);
      const at = now.lastIndexOf(added);
      if (at < 0) return false;
      await noteWriter.patch(targetId, { markdown: now.slice(0, at) + tail + now.slice(at + added.length) }, { baseMarkdown: now });
      return true;
    },
  };
}

/** `![[Note/first words]]` — the embed that shows an excerpt in another note, by the words the quote begins with (a part
 *  link, like the ones the editor's `!((` completion writes). Nothing is written into the note the excerpt is in. */
export function excerptEmbed(noteTitle: string, words: string): string {
  return `!${blockLinkSource(noteTitle, blockLinkText(words))}`;
}

/** 「放進筆記」: the passage as an excerpt, appended to note `targetId`. `words`
 *  is what the quote begins with, for embedding it (excerptEmbed). */
export async function appendQuote(targetId: string, quote: { passage: Passage; source: QuoteSource }): Promise<AppendResult & { words: string }> {
  const res = await appendToNote(targetId, excerptBlock({ exact: quote.passage.text, prefix: quote.passage.prefix, suffix: quote.passage.suffix }, quote.source, untitledTitle()));
  return { ...res, words: quote.passage.text };
}

/** An excerpt of a page this device knows of, and the note that holds it. */
export type KnownExcerpt = { noteId: string; excerpt: Excerpt };

/** The excerpts of `url`'s page the notes of this device hold: those the
 *  store holds with their text, then — for notes held without it — what the
 *  search finds for the page's address (the on-device index offline). Meant
 *  to run in the background when an article opens: a failed search just finds
 *  fewer, never an error. */
export async function loadPageExcerpts(url: string | null): Promise<KnownExcerpt[]> {
  if (!url) return [];
  const found: KnownExcerpt[] = [];
  const nodes = getAppState().data.nodes.filter((n) => isNote(n) && !n.deleted_at);
  for (const node of nodes) {
    if (!nodeNeedsBody(node)) for (const excerpt of excerptsOfPage(node.markdown ?? "", url, anchorSpansOf(node.id, node.markdown ?? ""))) found.push({ noteId: node.id, excerpt });
  }
  if (!nodes.some(nodeNeedsBody)) return found;
  try {
    for (const row of (await reads.notes.search(url.split("#")[0]!)).rows.slice(0, 8)) {
      const node = nodes.find((n) => n.id === row.id);
      if (!node || !nodeNeedsBody(node)) continue;
      const full = (await reads.notes.full(row.id)).markdown ?? "";
      for (const excerpt of excerptsOfPage(full, url, anchorSpansOf(row.id, full))) found.push({ noteId: row.id, excerpt });
    }
  } catch { /* offline or refused: what was found so far stands */ }
  return found;
}

/** The known excerpt of this passage of this page, if any. */
export function knownExcerpt(known: readonly KnownExcerpt[], url: string | null, text: string): KnownExcerpt | null {
  return url ? known.find((k) => sameExcerpt(k.excerpt, { url, exact: text })) ?? null : null;
}

/** 「引用到筆記」 › 新草稿: a plain note, created the way quick capture creates
 *  one (noteWriter.create with a client id), at `destination` — its parent
 *  note and tags; with no parent, under today's note, as quick capture
 *  does. Carries this session's excerpts as embeds (or just the source line)
 *  and room to write. */
export async function startDraft({ embeds, source, destination }: { embeds: readonly string[]; source: QuoteSource; destination: RssDestination }): Promise<{ nodeId: string; status: "synced" | "queued" }> {
  return createDraft(t("On “{title}”", { title: displayTitle(source.title.trim()) }), `${draftBlock(embeds, source)}\n\n`, destination);
}

/** 「這週讀到的」 › a draft: the week's excerpts shown as embeds (never copied), room to write. */
export async function startWeekDraft({ embeds, destination }: { embeds: readonly string[]; destination: RssDestination }): Promise<{ nodeId: string; status: "synced" | "queued" }> {
  return createDraft(t("What I read this week"), `${embeds.join("\n\n")}\n\n`, destination);
}

async function createDraft(title: string, markdown: string, destination: RssDestination): Promise<{ nodeId: string; status: "synced" | "queued" }> {
  const parentId = destination.parentId ?? (await dayNotes.openToday())!.node.id;
  const created = await noteWriter.create({
    id: randomUUID(),
    title,
    markdown,
    parent_id: parentId,
    ...(destination.tagIds.length ? { tagIds: destination.tagIds } : {}),
  });
  return { nodeId: created.node.id, status: created.status === "queued" ? "queued" : "synced" };
}

/** What 「引用到筆記」 starts with: the excerpts' embeds, each showing its quote
 *  and source; the article's source line when there are none. */
export function draftBlock(embeds: readonly string[], source: QuoteSource): string {
  return embeds.length > 0 ? embeds.join("\n\n") : quoteSourceLine(source);
}

/** The note quotes go to by default: the last one chosen while it still
 *  exists, else the feed's default parent note, else none (the picker). */
export function defaultQuoteTarget(feedParentId: string | null): string | null {
  const live = (id: string | null) => isNote(getNode(id));
  const last = getPref(PREFS.rssQuoteTarget);
  if (live(last)) return last;
  return live(feedParentId) ? feedParentId : null;
}

export function rememberQuoteTarget(id: string): void {
  setPref(PREFS.rssQuoteTarget, id);
}
