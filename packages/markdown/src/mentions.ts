// @mentions of an agent (docs/archive/architecture/agent-mentions-2026-10-22.md §1).
//
//   @ai 幫我整理這段
//   @ai /[[摘要論文]] 重點放在方法
//   @ai /摘要論文
//
// A mention is one `@handle` in a paragraph, list item, task line or heading.
// Its block is the lines up to the next blank line, the next list item or the
// next heading; the prompt is everything after the handle to the block's end,
// the lead-in everything before it. A mention sends nothing by itself: the
// person sends it explicitly (D1), and the server parses it again at that
// moment with this function, so a client can't invent a prompt.
//
// Not mentions: frontmatter, fenced code, inline code, quotes (the agent's own
// replies are quotes, so a reply can never start a session), an `@` glued to a
// word (e-mail addresses) and the words capture syntax reads as dates.
//
// One linear pass over the lines; no Markdown parse (a note with no `@` costs
// one indexOf).

import { fenceScanner } from "./fences.js";
import { frontmatterLength } from "./frontmatter.js";
import { scanWikilinks, splitWikilink } from "./text.js";

export const MENTION_HANDLE_MAX = 32;
/** `@today` and friends are dates for capture/tasks; `@here` and `@all` are reserved for people. */
export const RESERVED_MENTION_HANDLES: readonly string[] = ["today", "tomorrow", "yesterday", "here", "all"];

/** `@ai` is not an agent's handle but the fixed alias for the space's default agent
 *  (the server picks it: services/agentSessions.ts resolveMentionRunner). An agent
 *  may still take the handle `ai` itself, and then the name means that agent. */
export const AI_MENTION_ALIAS = "ai";

const HANDLE = /^[\p{L}\p{N}_-]{1,32}$/u;
/** A handle as stored in agent_runners: lower case, the grammar above, not reserved. */
export function isMentionHandle(handle: string): boolean {
  return handle === handle.toLowerCase() && HANDLE.test(handle) && !RESERVED_MENTION_HANDLES.includes(handle);
}

export type MentionSkillRef = {
  /** The note title (`/[[title]]`) or the plain name (`/title`). */
  title: string;
  form: "wikilink" | "text";
};

export type Mention = {
  /** Lower case, without the `@`. */
  handle: string;
  /** The id of the anchor that starts the block, or null while it has none. */
  blockId: string | null;
  /** Offset of the `@`. */
  at: number;
  /** The block [start, end): where the block's anchor starts, and where its last line ends. */
  blockStart: number;
  blockEnd: number;
  /** End of the contiguous non-blank lines holding the block: the reply goes after it. */
  groupEnd: number;
  /** The block's text before the `@`, list marker and checkbox removed. */
  leadIn: string;
  /** Everything after the handle (and the skill reference), trimmed. */
  prompt: string;
  skill: MentionSkillRef | null;
};

type Line = { start: number; end: number; text: string };

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_BOX = /^\[[ xX]\]\s+/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const QUOTE = /^ {0,3}>/;
const MENTION = /(^|[^\p{L}\p{N}_@/.:-])@([\p{L}\p{N}_-]{1,32})(?![\p{L}\p{N}_-])/u;

function splitLines(markdown: string, from: number): Line[] {
  const lines: Line[] = [];
  let start = from;
  while (start <= markdown.length) {
    let end = markdown.indexOf("\n", start);
    if (end === -1) end = markdown.length;
    let trimmed = end;
    if (trimmed > start && markdown[trimmed - 1] === "\r") trimmed--;
    lines.push({ start, end: trimmed, text: markdown.slice(start, trimmed) });
    if (end === markdown.length) break;
    start = end + 1;
  }
  return lines;
}

/** `text` with inline code spans blanked (same length, so offsets hold). */
function maskInlineCode(text: string): string {
  return text.includes("`") ? text.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length)) : text;
}

type RawBlock = { lines: Line[]; groupEnd: number };

/** The blocks that can hold a mention, in document order. */
function mentionBlocks(markdown: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const lines = splitLines(markdown, frontmatterLength(markdown));
  let group: Line[] = []; // contiguous non-blank lines
  let current: Line[] = [];
  const flushGroup = () => {
    if (group.length === 0) return;
    const groupEnd = group[group.length - 1]!.end;
    if (current.length) blocks.push({ lines: current, groupEnd });
    // blocks of this group made before its end was known share it
    for (const b of blocks) if (b.groupEnd === -1) b.groupEnd = groupEnd;
    group = []; current = [];
  };
  const fence = fenceScanner();
  for (const line of lines) {
    const state = fence(line.text);
    if (state === "inside" || state === "close") { group.push(line); continue; } // fenced code is opaque
    if (line.text.trim() === "") { flushGroup(); continue; }
    if (state === "open") { if (current.length) { blocks.push({ lines: current, groupEnd: -1 }); current = []; } group.push(line); continue; }
    group.push(line);
    if (QUOTE.test(line.text)) { if (current.length) { blocks.push({ lines: current, groupEnd: -1 }); current = []; } continue; }
    const startsBlock = LIST_ITEM.test(line.text) || HEADING.test(line.text) || (current.length > 0 && HEADING.test(current[0]!.text));
    if (startsBlock && current.length) { blocks.push({ lines: current, groupEnd: -1 }); current = []; }
    current.push(line);
  }
  flushGroup();
  return blocks;
}

function parseBlock(markdown: string, block: RawBlock, anchorAt: ReadonlyMap<number, string>): Mention | null {
  const first = block.lines[0]!;
  const last = block.lines[block.lines.length - 1]!;
  const textEnd = last.end;
  const raw = markdown.slice(first.start, textEnd);
  const hit = MENTION.exec(maskInlineCode(raw));
  if (!hit) return null;
  const handle = hit[2]!.toLowerCase();
  if (RESERVED_MENTION_HANDLES.includes(handle)) return null;
  const at = first.start + hit.index + hit[1]!.length;
  const afterHandle = at + 1 + hit[2]!.length;
  const lead = markdown.slice(first.start, at).replace(LIST_ITEM, "").replace(TASK_BOX, "").trim();
  let rest = markdown.slice(afterHandle, textEnd).trim();
  let skill: MentionSkillRef | null = null;
  // `/[[Skill]]`: a link right after the slash (a start further on is not it).
  const link = rest.startsWith("/[[") ? scanWikilinks(rest).find((m) => m.start === 1) ?? null : null;
  const plain = link ? null : /^\/([^\s/[]+)(?=\s|$)/.exec(rest);
  if (link) {
    skill = { title: splitWikilink(link.body).target.trim(), form: "wikilink" };
    rest = rest.slice(link.end).trim();
  } else if (plain) {
    skill = { title: plain[1]!, form: "text" };
    rest = rest.slice(plain[0].length).trim();
  }
  return {
    handle, blockId: anchorAt.get(first.start) ?? null, at,
    blockStart: first.start, blockEnd: textEnd,
    groupEnd: block.groupEnd, leadIn: lead, prompt: rest, skill,
  };
}

function trimEndAt(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/.test(text[end - 1]!)) end--;
  return end;
}

/** Every mention in `markdown`, one per block (the first), in document order. `anchors`: the note's valid anchors
 *  (a block's identity is not in its text); a block's id is the anchor that starts at its first line. */
export function findMentions(markdown: string, anchors: ReadonlyArray<{ id: string; from: number }> = []): Mention[] {
  if (!markdown.includes("@")) return [];
  const anchorAt = new Map<number, string>();
  for (const a of anchors) if (!anchorAt.has(a.from)) anchorAt.set(a.from, a.id);
  const out: Mention[] = [];
  for (const block of mentionBlocks(markdown)) {
    const mention = parseBlock(markdown, block, anchorAt);
    if (mention) out.push(mention);
  }
  return out;
}

/** Which mention: the one in the block with this anchor id, or — before it has
 *  one — the one whose block reads exactly `blockText` (the text as the editor
 *  shows it). Null when none; `ambiguous` when `blockText`
 *  matches several (the caller refuses rather than guesses). */
export type MentionTarget = { blockId: string } | { blockText: string };

export function parseMention(
  markdown: string, target: MentionTarget, anchors: ReadonlyArray<{ id: string; from: number }> = [],
): Mention | null | "ambiguous" {
  const all = findMentions(markdown, anchors);
  if ("blockId" in target) return all.find((m) => m.blockId === target.blockId) ?? null;
  const wanted = target.blockText.trim();
  const hits = all.filter((m) => markdown.slice(m.blockStart, m.blockEnd).trim() === wanted);
  return hits.length > 1 ? "ambiguous" : hits[0] ?? null;
}
