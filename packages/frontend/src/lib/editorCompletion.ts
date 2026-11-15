// The editor's typed completions: `/` commands, `[[` links, `((` paragraph
// references, `{` block tags, `@` mentions and `^` block ids. A body `#` is
// Markdown (heading or text) and offers nothing (decisions-ui.md). Detecting a trigger, listing what it
// offers and writing the chosen item into the document live here; MarkdownEditor only draws the
// popup and runs the follow-ups that need the page (a file picker, a new
// note, the field-value input).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  Heading1, Heading2, Heading3, Pilcrow, List, ListOrdered, ListChecks, Quote, Info, AlertTriangle,
  CodeXml, GalleryHorizontal, Table2, Minus, Image as ImageIcon, FileText, PenLine, Settings, LayoutTemplate,
  type LucideIcon,
} from "lucide-react";
import { STEPS_LANG, STEPS_TEMPLATE, blockLinkSource, blockLinkText, fenceInfoWord, fenceScanner, nodeRefTarget, type FenceLine } from "@onden/markdown";
import type { ContentNode, SchemaField, Tag } from "./api";
import type { TagKind } from "./nodeTags";
import { applyTemplateVars } from "@onden/markdown";
import { NOTE_TEMPLATES, templateVars } from "./noteTemplates";
import { dailyNotesEnabled } from "./dayNode";
import { offersTag } from "./tagSuggestions";
import { matchTitle, rankByTitle } from "./noteSearch";
import { t } from "./i18n";
import { looksLikeDate, type MentionRow, type SkillRow } from "./agentMentions";
import { tagFields } from "./tagFields";
import type { TaskRef } from "./taskRefs";
import { taskHint } from "./taskChips";
import type { LinkTargetRow } from "./wikilinkTargets";
import { RECENT_ROWS_IN_WIKILINK, type BlockRefRow } from "./blockRefSearch";

/** A page the slash menu can start from a note: the host creates it under
 *  the note and returns its title, which the editor links where `/` was. */
export type InsertPageKind = "pdf" | "ink";

export type SlashItem =
  | { kind?: "markdown"; title: string; Icon: LucideIcon; text: string; innerOffset?: number }
  | { kind: "attr"; title: string; Icon: LucideIcon; field: SchemaField; tagName: string }
  | { kind: "insert"; title: string; Icon: LucideIcon; insert: "media" | InsertPageKind }
  /** An item an imported module adds (modules/types SlashInsert); `run` does
   *  the writing once the `/` is gone. */
  | { kind: "module"; title: string; Icon: LucideIcon; run: () => void };

/** A `{` suggestion. `module` marks a tag a module ships (its module tag):
 *  `imported`, it comes with a function that is on; `needs-import`, choosing
 *  it first turns the function on and makes the tag, after a one-time
 *  confirmation the host shows when the function needs one (only offered to
 *  someone who may decide); `not-imported`, the function is off and this
 *  person cannot turn it on, so it is written as a name only.
 *  `virtual`: the tag does not exist yet (turning the function on makes it); its id is
 *  `module:<module id>`. `title` is an i18n key. `hidden`: the owner hid the
 *  tag (D104) — offered only for its full name (lib/tagSuggestions offersTag). */
export type TagItem = {
  id: string; name: string; color?: string | null;
  module?: { id: string; title: string; state: "imported" | "needs-import" | "not-imported" };
  /** Whose tag it is (lib/nodeTags tagKind): the paragraph panel lists only "own" ones by name. */
  kind?: TagKind;
  virtual?: boolean;
  hidden?: boolean;
};
export type LinkItem = { id: string; title: string; ranges?: [number, number][] };
/** A task in the `[[` list: written as a link that names it by id, so
 *  same-named tasks stay apart. `hint` is the small print that tells them apart. */
export type TaskLinkItem = { __task: true; id: string; title: string; ranges?: [number, number][]; done: boolean; hint: string };
/** The miss-state row of the `[[` popup: makes the typed note. */
export type CreateItem = { __create: "note"; query: string };
export type CompletionItem = SlashItem | LinkItem | TaskLinkItem | LinkTargetRow | BlockRefRow | TagItem | CreateItem | MentionRow | SkillRow;

export type CompletionType = "slash" | "wikilink" | "blockref" | "blocktag" | "mention" | "skill";
export type Trigger = { type: CompletionType; query: string };

// Insert items: an image, audio or video file lands in the text; a PDF or a handwriting page
// becomes a page under this note, linked here.
const INSERT_SLASH_ITEMS: Array<Extract<SlashItem, { kind: "insert" }>> = [
  { kind: "insert", title: "Image, audio or video", Icon: ImageIcon, insert: "media" },
  { kind: "insert", title: "PDF",              Icon: FileText,  insert: "pdf" },
  { kind: "insert", title: "Handwriting page", Icon: PenLine,   insert: "ink" },
];

const MARKDOWN_SLASH_ITEMS: SlashItem[] = [
  { title: "Text",          Icon: Pilcrow,       text: "" },
  { title: "Heading 1",     Icon: Heading1,      text: "# " },
  { title: "Heading 2",     Icon: Heading2,      text: "## " },
  { title: "Heading 3",     Icon: Heading3,      text: "### " },
  { title: "Bullet List",   Icon: List,          text: "- " },
  { title: "Numbered List", Icon: ListOrdered,   text: "1. " },
  { title: "Task List",     Icon: ListChecks,    text: "- [ ] " },
  { title: "Quote",         Icon: Quote,         text: "> " },
  { title: "Callout",       Icon: Info,          text: "> [!note]\n> " },
  { title: "Warning",       Icon: AlertTriangle, text: "> [!warning]\n> " },
  { title: "Code Block",    Icon: CodeXml,       text: "```\n\n```", innerOffset: 4 },
  // The cursor lands at the first step's title; the outer fence is already four backticks.
  { title: "Step-by-step",  Icon: GalleryHorizontal, text: STEPS_TEMPLATE, innerOffset: STEPS_TEMPLATE.indexOf("\n", STEPS_TEMPLATE.indexOf("## ")) },
  { title: "Table",         Icon: Table2,        text: "| Col 1 | Col 2 | Col 3 |\n|-------|-------|-------|\n|       |       |       |\n" },
  { title: "Divider",       Icon: Minus,         text: "---\n" },
];

/** An `@name` being typed: the `@` starts a word (so an e-mail address is not one)
 *  and the name so far is letters, digits, `_` or `-`. */
const MENTION_TYPED = /(?:^|[\s(（])@([\p{L}\p{N}_-]*)$/u;

/** `/` after an `@name `: the skill the mention names, typed so far. */
const MENTION_SKILL_TYPED = /(?:^|[\s(（])@[\p{L}\p{N}_-]+[ \t]+\/([^\s[\]]*)$/u;


/** A block tag being typed: `{` (or `{a, `) then the name so far, with no
 *  closing brace yet (docs/architecture/block-nodes.md: `{…}` at the end of
 *  a block makes it a block node). `\{` is literal text. */
const BLOCK_TAG_TYPED = /(?:^|[^\\])\{(?:[^{}\n]*,\s*)?([^{},\n]*)$/u;

/** `((` (or `!((` to embed) being typed: the words so far, with no `(` or `)`
 *  in them yet (a `)` ends it, as `]` ends a `[[`). */
const BLOCK_REF_TYPED = /(!?)\(\(([^()\n]*)$/;

/** Syntax nodes where typed trigger characters are text, not a request for a
 *  list: code (fenced, indented, inline) and formulas (editorMathSyntax). */
const LITERAL_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "InlineMath", "BlockMath"]);

/** Whether a code span is still open at the end of `lineBefore` (the line up
 *  to the caret): a run of backticks with no later run of the same length,
 *  as Markdown pairs them. `\`` is a literal backtick, and a longer or shorter
 *  run inside a span is content (so ``a`b`` is closed). The tree only knows
 *  closed spans; this is the one being typed. */
function codeSpanOpen(lineBefore: string): boolean {
  let open = 0;
  for (const run of lineBefore.matchAll(/(\\*)(`+)/g)) {
    const len = run[2]!.length;
    if (open === 0) {
      // An odd number of backslashes escapes the first backtick of the run.
      if (run[1]!.length % 2 === 1 && len === 1) continue;
      open = len;
    } else if (len === open) open = 0;
  }
  return open !== 0;
}

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** The info word of a FencedCode node (```steps → "steps"), or "". */
function fenceInfo(state: EditorState, node: SyntaxNode): string {
  const info = node.getChild("CodeInfo");
  return info ? fenceInfoWord(state.doc.sliceString(info.from, info.to)) : "";
}

/** Whether the caret, at the end of `textBefore` (the document up to it), is
 *  inside a fenced code block (``` or ~~~ not yet closed). */
export function inFencedCode(textBefore: string): boolean {
  const scan = fenceScanner();
  let state: FenceLine = "outside";
  for (const line of textBefore.split("\n")) state = scan(line);
  return state === "open" || state === "inside";
}

/** Whether the character just before `pos` sits in code or a formula: no
 *  popup opens there. The one place that decides "may a list open here";
 *  MarkdownEditor passes the answer to detectPopupTrigger. A steps block
 *  (```steps) is fenced but its text is Markdown, so lists open in it. */
export function popupBlockedAt(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  for (let node = tree.resolveInner(pos, -1) as SyntaxNode | null; node; node = node.parent) {
    if (!LITERAL_NODES.has(node.name)) continue;
    if (node.name === "FencedCode" && fenceInfo(state, node) === STEPS_LANG) continue;
    return true;
  }
  return codeSpanOpen(state.doc.sliceString(line.from, pos));
}

/** Which popup the text BEFORE the caret on its line opens, its typed query,
 *  and the marker's index within that text (0 for the line-leading slash).
 *  `{` offers tag names (block nodes). The marker of a
 *  block tag is where its name starts (what a chosen name replaces).
 *  `blocked`: the caret is in code or a formula (popupBlockedAt): nothing opens. */
export function detectPopupTrigger(text: string, blocked = false): (Trigger & { markerIndex: number }) | null {
  if (blocked) return null;
  const bt = text.match(BLOCK_TAG_TYPED);
  // Not before a name has started, so a lone `{` + Enter stays a newline.
  if (bt && bt[1]!.trim() && !bt[1]!.includes(":")) return { type: "blocktag", query: bt[1]!.trimStart(), markerIndex: text.length - bt[1]!.trimStart().length };
  // `((` searches the paragraphs of every note.
  const br = text.match(BLOCK_REF_TYPED);
  if (br) return { type: "blockref", query: br[2]!, markerIndex: br.index! };
  const wl = text.match(/\[\[([^\]]*)$/);
  if (wl) return { type: "wikilink", query: wl[1], markerIndex: text.lastIndexOf("[[") };
  // Any script: the menu is translated, so 「/草圖」 must filter it too.
  // Line-leading, or right after a quote's `> ` marks: a quoted line is a line too.
  const sl = text.match(/^((?:>[ \t]?)*)\/([\p{L}\p{N}_ -]*)$/u);
  if (sl) return { type: "slash", query: sl[2], markerIndex: sl[1].length };
  // `@` offers the AI. Dates (`@today`, `@2026-10-24`: quick capture and tasks
  // read them) are not an AI being named.
  const ms = text.match(MENTION_SKILL_TYPED);
  if (ms) return { type: "skill", query: ms[1]!, markerIndex: text.lastIndexOf("/") };
  const mt = text.match(MENTION_TYPED);
  if (mt && !looksLikeDate(mt[1]!)) return { type: "mention", query: mt[1]!, markerIndex: text.lastIndexOf("@") };
  return null;
}

export type CompletionContext = {
  nodes: readonly Pick<ContentNode, "id" | "title">[];
  /** The tasks the reader holds: offered after the notes once something is typed. */
  tasks?: readonly TaskRef[];
  tags: readonly TagItem[];
  /** The note's class tags: each schema field becomes a "Set <field>" row. */
  attrClassTags: readonly Tag[];
  canSetAttr: boolean;
  /** The host can start a PDF or handwriting page under this note. */
  canInsertPage: boolean;
  /** Items imported modules add to the `/` menu, after the built-in inserts. */
  moduleItems?: readonly Extract<SlashItem, { kind: "module" }>[];
  /** `[[unknown` may offer to create the note. */
  canCreateNote: boolean;
  /** `[[Note#…` names a note: the rows of its headings and blocks, which
   *  replace the note list (hooks/useLinkTargets). */
  linkTargets?: readonly LinkTargetRow[];
  /** What `((` found for the typed words, 「最近存的段落」 first (hooks/useBlockRefs). */
  blockRefs?: readonly BlockRefRow[];
  /** 「最近存的段落」 for the plain `[[` list, already narrowed by what was typed. */
  recentBlocks?: readonly BlockRefRow[];
  /** The rows of the `@` menu (lib/agentMentions mentionRows), by what was typed. */
  mentionRows?: (query: string) => readonly MentionRow[];
  /** The rows of the `@ai /` menu (lib/agentMentions skillRows). */
  skillRows?: (query: string) => readonly SkillRow[];
};

/** How many task rows the `[[` popup adds under the notes. */
const TASK_ROWS = 4;

/** How many `{` rows the popup shows, and how many of them may be module tags. */
const BLOCKTAG_ROWS = 8;
const BLOCKTAG_MODULE_ROWS = 3;

/** The rows a popup offers for what was typed. */
export function getCompletions(trigger: Trigger, ctx: CompletionContext): CompletionItem[] {
  const query = trigger.query;
  const q = query.toLowerCase();
  if (trigger.type === "slash") {
    const attrItems: SlashItem[] = !ctx.canSetAttr ? [] : ctx.attrClassTags.flatMap((tag) =>
      tagFields(tag).map((field) => ({
        kind: "attr" as const, title: t("Set {field} (#{tag})", { field: field.label ?? field.name, tag: tag.name }),
        Icon: Settings, field, tagName: tag.name,
      })));
    // A template's TEXT, written where `/` was ({date}/{datetime} resolve
    // now). Only the text, and the label says so: typing in a note does not
    // tag it, so the template's tags and fields are not applied here — a
    // class tag (with its child notes and required fields) is added with
    // "+ Tag", where the note visibly changes kind. Its own notes come from
    // "New from template" (D69).
    const vars = templateVars();
    // The day template only while daily notes (日記) are on.
    const templateItems: SlashItem[] = NOTE_TEMPLATES.filter((tpl) => !tpl.day || dailyNotesEnabled()).map((tpl) => ({
      title: t("Template text: {label}", { label: t(tpl.label) }), Icon: LayoutTemplate,
      text: applyTemplateVars(tpl.body, vars), innerOffset: 0,
    }));
    const insertItems = INSERT_SLASH_ITEMS.filter((item) => item.insert === "media" || ctx.canInsertPage);
    const items: SlashItem[] = [...MARKDOWN_SLASH_ITEMS, ...insertItems, ...(ctx.moduleItems ?? []), ...templateItems, ...attrItems];
    // The shared title rule; slash items keep their declared order, the priority.
    return query ? items.filter((i) => matchTitle(query, i.title) || matchTitle(query, t(i.title))) : items;
  }
  if (trigger.type === "blockref") return [...(ctx.blockRefs ?? [])];
  if (trigger.type === "wikilink") {
    if (ctx.linkTargets) return [...ctx.linkTargets];
    const matches: LinkItem[] = rankByTitle(query, ctx.nodes, (n) => n.title, 8)
      .map((n) => ({ id: n.id, title: n.title, ranges: n.match.ranges }));
    const create = ctx.canCreateNote && query.trim().length > 0 && !matches.some((m) => m.title.toLowerCase() === q);
    // Tasks only once something is typed: a bare `[[` lists notes, not every todo.
    const tasks: TaskLinkItem[] = query.trim() ? rankByTitle(query, ctx.tasks ?? [], (task) => task.title, TASK_ROWS)
      .map((task) => ({ __task: true, id: task.id, title: task.title, ranges: task.match.ranges, done: task.task.done, hint: taskHint(task.task) })) : [];
    const recent = (ctx.recentBlocks ?? []).slice(0, RECENT_ROWS_IN_WIKILINK);
    return create ? [...recent, ...matches, ...tasks, { __create: "note", query: query.trim() }] : [...recent, ...matches, ...tasks];
  }
  if (trigger.type === "blocktag") {
    // Existing names first; a new name is just typed (the save creates it).
    // Order: the person's own tags, tags of imported modules, tags of modules
    // not imported yet (choosing one turns the function on first). A hidden
    // tag of any kind (D104) only for its full name (lib/tagSuggestions offersTag).
    const matches = ctx.tags.filter((tg) => offersTag(tg, q));
    const own = matches.filter((tg) => !tg.module);
    const shipped = matches.filter((tg) => tg.module?.state === "imported");
    const others = matches.filter((tg) => tg.module && tg.module.state !== "imported");
    // Module tags keep a place even when the person has many tags of their own.
    const moduleRows = [...shipped, ...others].slice(0, BLOCKTAG_MODULE_ROWS);
    return [...own.slice(0, BLOCKTAG_ROWS - moduleRows.length), ...moduleRows];
  }
  if (trigger.type === "mention") return [...(ctx.mentionRows?.(query) ?? [])];
  if (trigger.type === "skill") return [...(ctx.skillRows?.(query) ?? [])];
  return [];
}

/** What the editor still has to do after an item was written in. */
export type CompletionFollowUp =
  | { kind: "attr"; field: SchemaField }
  | { kind: "insert"; insert: "media" | InsertPageKind; at: number }
  /** A module's `/` item: run it (the `/` is already removed). */
  | { kind: "module-insert"; run: () => void }
  | { kind: "create-note"; title: string; triggerStart: number }
  /** Import the module (after the host's confirmation), then write its tag
   *  name with writeBlockTagName. */
  | { kind: "import-module"; moduleId: string; name: string; triggerStart: number }
  /** A `[[Note/words]]` link to a part of a note was written (it reads by its words at once). The host asks the server to
   *  anchor the part and bind the link to it (blockLinkWriter.bind), and swaps `link` for the words the server settled on
   *  when another paragraph of this note already uses them. Nothing is undone when the binding cannot be made. */
  | { kind: "bind-part-link"; noteId: string; target: { start: number; text: string }; link: string; text: string; embed: boolean };

/** Write a block tag's name over what was typed after `{` (from `from` to the
 *  caret, which may have moved while a module was being turned on), and the
 *  closing brace unless one (or a `,` for more) already follows. */
export function writeBlockTagName(view: EditorView, from: number, name: string): void {
  const doc = view.state.doc;
  const to = Math.max(from, Math.min(view.state.selection.main.head, doc.length));
  const next = doc.sliceString(to, to + 1);
  const text = `${name}${next === "}" || next === "," ? "" : "}"}`;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
}

/** Write the chosen item over the trigger (`triggerStart` to the caret). */
export function applyCompletion(view: EditorView, popup: { type: CompletionType; triggerStart: number }, item: CompletionItem): CompletionFollowUp | null {
  const caret = view.state.selection.main.head;
  // The caret went back before the trigger (Home, a tap): there is no typed query to replace, and from > to is no range.
  if (caret < popup.triggerStart) return null;
  const replace = (text: string) => view.dispatch({
    changes: { from: popup.triggerStart, to: caret, insert: text },
    selection: { anchor: popup.triggerStart + text.length },
  });
  if ("__create" in item) {
    return { kind: "create-note", title: item.query.trim(), triggerStart: popup.triggerStart };
  }
  switch (popup.type) {
    case "slash": {
      const si = item as SlashItem;
      if (si.kind === "attr" || si.kind === "insert" || si.kind === "module") {
        replace("");
        if (si.kind === "module") return { kind: "module-insert", run: si.run };
        return si.kind === "attr" ? { kind: "attr", field: si.field } : { kind: "insert", insert: si.insert, at: popup.triggerStart };
      }
      // From the `/`, so a quote's `> ` marks stay in front of what it becomes.
      view.dispatch({
        changes: { from: popup.triggerStart, to: caret, insert: si.text },
        selection: { anchor: popup.triggerStart + (si.innerOffset ?? si.text.length) },
      });
      return null;
    }
    // `((`: the same link as `[[Note#`; `!((` writes the embed of it.
    case "blockref":
      return applyLinkTarget(view, popup.triggerStart, item as BlockRefRow, view.state.doc.sliceString(popup.triggerStart, popup.triggerStart + 1) === "!");
    case "wikilink":
      if ("__target" in item) return applyLinkTarget(view, popup.triggerStart, item);
      if ("__task" in item) {
        // By id, with the title as the shown text; the title must not end or split the link.
        replace(`[[${nodeRefTarget(item.id)}|${item.title.replace(/[[\]|\r\n\s]+/g, " ").trim()}]]`);
        return null;
      }
      replace(`[[${(item as LinkItem).title}]]`);
      return null;
    // The name, then the closing brace unless one (or a `,` for more) follows.
    case "blocktag": {
      const tag = item as TagItem;
      // Nothing is written until the module is imported (the host asks first).
      if (tag.module?.state === "needs-import") return { kind: "import-module", moduleId: tag.module.id, name: tag.name, triggerStart: popup.triggerStart };
      writeBlockTagName(view, popup.triggerStart, tag.name);
      return null;
    }
    // The skill as a link, so a rename follows it; a hint row writes nothing.
    case "skill": {
      const row = item as SkillRow;
      if (row.kind === "skill") replace(`/[[${row.title}]] `);
      return null;
    }
    // The handle and a space to type the request after; a hint row writes nothing.
    case "mention": {
      const row = item as MentionRow;
      if (row.kind === "agent") replace(`@${row.handle} `);
      return null;
    }
  }
}

/** Write the link for a heading or paragraph of a note over `[[…` or `((…` (from
 *  `triggerStart` to the caret): `[[Note/first words]]`, or `[[/first words]]` in the note itself.
 *
 *  The link is complete as written — it is found by its words, like one typed by hand — so nothing waits for the
 *  server and nothing is marked in the target. The host then anchors the part and binds the link (`bind-part-link`)
 *  so the paragraph is followed by identity after its words change. A part with no words to name it gets the plain
 *  note link. */
function applyLinkTarget(view: EditorView, triggerStart: number, row: LinkTargetRow, embed = false): CompletionFollowUp | null {
  const caret = view.state.selection.main.head;
  const write = (text: string) => view.dispatch({
    changes: [{ from: triggerStart, to: caret, insert: text }],
    selection: { anchor: triggerStart + text.length },
  });
  const bang = embed ? "!" : "";
  const text = blockLinkText(row.target.text);
  // An embed (`!((`) shows the paragraph; where no paragraph can be named the
  // fallback is the plain note link, never an embed of the whole note.
  if (!text) { write(`[[${row.noteTitle}]]`); return null; }
  const link = `${bang}${blockLinkSource(row.sameNote ? null : row.noteTitle, text)}`;
  write(link);
  return { kind: "bind-part-link", noteId: row.noteId, target: row.target, link, text, embed };
}
