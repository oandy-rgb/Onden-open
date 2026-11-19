import { Suspense, useEffect, useLayoutEffect, useRef, useState, useCallback, useSyncExternalStore, forwardRef, useImperativeHandle, type CSSProperties } from "react";
import { SESSION_KEYS, readSession, removeSession, writeSession } from "../lib/sessionPrefs";
import { addToast } from "../lib/appStore";
import { useAutoReset } from "../hooks/useTransientFlag";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { EditorState, Annotation, Compartment, Transaction, Prec } from "@codemirror/state";

// Marks a dispatch as a programmatic value-prop sync (not a user edit), so the
// updateListener can skip onChange for it. Without this, pushing a new `value`
// in (node switch, version restore) echoes back as a fake user edit → the
// autosave marks the doc dirty and writes a redundant, identical version.
const ExternalSync = Annotation.define<boolean>();
import { clusterKeymap } from "../lib/editorCharKeys";
import { history, defaultKeymap, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { CheckSquare, Square, Plus, ChevronDown } from "lucide-react";
import type { ContentNode, NodeAttribute, SchemaField, Tag } from "../lib/api";
import { editorLinks } from "../lib/editorLinks";
import { composingEnded, composingField } from "../lib/editorComposing";
import { blockTaskTagName, editorBlocks } from "../lib/editorBlocks";
import { carriedInUpdate, editorAnchors, setEditorAnchors } from "../lib/editorAnchors";
import { anchorSpansOf, anchorsVersion, watchAnchors } from "../lib/blockAnchorStore";
import { editorCitations, editorLinkedParagraphs, pasteBlockLink, setCitations } from "../lib/blockSafety";
import { editorMarkdownLanguage, mdHighlight } from "../lib/editorMarkdownLanguage";
import { editorRendered } from "../lib/editorRendered";
import { codeHighlightOnDemand } from "../lib/editorCodeHighlightOnDemand";
import { editorPartLinks } from "../lib/editorPartLinks";
import { editorEmbeds, refreshEmbeds, type EmbedContext, type EmbedEditRequest } from "../lib/editorEmbeds";
import { mentionCardsExtension, setMentionCards } from "../lib/editorMentions";
import { setSuggestionPlaces, suggestionPlacesExtension, type SuggestionHost } from "../lib/editorSuggestions";
import type { Place } from "../lib/aiSuggestions";
import type { MentionRow, MentionsHost, SkillRow } from "../lib/agentMentions";
import { useTaskRefs } from "../lib/taskRefs";
import EmbedEditSheet from "./EmbedEditSheet";
import { useEditorLinkFollow } from "./useEditorLinkFollow";
import { emptyDocHint } from "../lib/editorEmptyHint";
import { editorFrontmatter } from "../lib/editorFrontmatter";
import { useT } from "../lib/i18n";
import { isImeComposing, isEscapeKey } from "../lib/keys";
import { selectionBubblePosition } from "../lib/selectionBubble";
import { COARSE_POINTER_QUERY, useIsMobile, useMediaQuery } from "../hooks/useIsMobile";
import { isAppliedByAppTag, isTagShown, tagKind } from "../lib/nodeTags";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { applyCompletion, detectPopupTrigger, getCompletions, inFencedCode, popupBlockedAt, writeBlockTagName, type CompletionItem, type CompletionType, type InsertPageKind, type SlashItem, type TagItem, type TaskLinkItem } from "../lib/editorCompletion";
export type { InsertPageKind } from "../lib/editorCompletion";
import { isHttpUrl, splitTaggedParagraph, storageType } from "@onden/markdown";
import HashtagScopeHint from "./HashtagScopeHint";
import { Popover, keepFocus, useInlinePopover, type PopoverPoint, Pressable, TextField, layerClass } from "./ui";
import { hashtagScopeHintAt, hashtagToScope, type HashtagScopeHint as HashtagScopeHintRange } from "../lib/hashtagScopeHint";
import { useHintOnce } from "../hooks/useHintOnce";
import { SnippetText } from "./SnippetText";
import { useLinkTargets } from "../hooks/useLinkTargets";
import { LinkTargetRow } from "./LinkTargetRow";
import { BlockRefRow } from "./BlockRefRow";
import { isBlockRefRow } from "../lib/blockRefSearch";
import { useBlockRefs } from "../hooks/useBlockRefs";
import { useLinkedParagraphs } from "../hooks/useLinkedParagraphs";
import type { LinkTargetRow as LinkTargetItem } from "../lib/wikilinkTargets";
import { blockLinkWriter } from "../lib/data";
import SelectionToolbar from "./SelectionToolbar";
import ToolbarRow, { type ToolSpecs } from "./ToolbarRow";
import { useParagraphPanels, type ParagraphExtras, type ParagraphSpan } from "./ParagraphMenu";
import { ParagraphHandle } from "./ParagraphHandle";
import type { HandToAi } from "../hooks/useHandToAi";
import type { BlockFunction } from "../lib/tagFunctions";
import { lazyWithReload } from "../lib/lazyWithReload";

const HandToAiPreview = lazyWithReload(() => import("./HandToAiPreview"));
import { editorFind, openFind, revealFirstMatch, revealRange } from "../lib/editorFind";
import { isCoarsePointer } from "../lib/mediaQuery";
import { takePendingFind } from "../lib/findInNote";
import { scrollClaimedFor } from "../lib/pageScrollRestore";
import "../lib/editorFind.css";
import "../lib/editorTools.css";
import { applyFoldMarks, foldAllHeadings, revealFolded, headingFolding, unfoldAllHeadings } from "../lib/editorFold";
import { loadFoldMarks, saveFoldMarks } from "../lib/editorFoldStore";
import { editorKeyboard, typewriterScroll } from "../lib/editorKeyboard";
import { useEditorKeyboard } from "../hooks/useEditorKeyboard";
import { editorSelectionTools } from "../lib/editorSelectionTools";
import { closeSearchPanel, searchPanelOpen, setSearchQuery, SearchQuery } from "@codemirror/search";
import { bindEditorNote, hasParagraphAt, insertBlockTag, startWikilink } from "../lib/editorParagraphActions";
import { blockHistoryPreview } from "../lib/blockHistoryPreview";
import { paragraphFrame } from "../lib/editorParagraphFrame";
import { useBlockHistory } from "./useBlockHistory";
import { confirmDialog } from "./ConfirmDialog";
import { useBlockChildNote } from "../hooks/useBlockChildNote";
import { activeFormats, formatKeyBindings, insertLink, listIndentWidth, toggleHeading, toggleLinePrefix, toggleWrap } from "../lib/editorFormat";
import { afterPause } from "../lib/afterPause";
import { INSERT_MEDIA_ACCEPT, pastedMediaFiles, splitDroppedFiles } from "../lib/mediaInsert";
import { setTaskLine, taskAtLine, type TaskLine } from "../lib/taskLines";
import { activeElement, createElement } from "../lib/documentAccess";
import { onWindow } from "../lib/globalEvents";
import { recordEditorUpdate, resetEditorChanges } from "../lib/editorChangeLog";
import type { BlockCitationRow } from "@onden/contract";

/** Ask for one file through the browser's picker (null when cancelled). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

type PopupState = {
  type: CompletionType;
  query: string;
  triggerStart: number;
  x: number;
  y: number;
  /** The top of the line being typed in (the list stays clear of it). */
  lineTop: number;
};

/** A selection-bubble entry that writes `tagName` into the block's `{…}`. */
const NO_FUNCTIONS: BlockFunction[] = [];

type ToolbarState = PopoverPoint & {
  selFrom: number;
  selTo: number;
};

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** An IME composition opened (true) or closed (false). The host keeps outside text away meanwhile
   *  (draftActions.setEditorComposing); a `value` that changes anyway waits here for the end (see the sync below). */
  onComposingChange?: (composing: boolean) => void;
  nodes: ContentNode[];
  // G5 cursor state preservation. When set, the editor writes the live caret
  // position to sessionStorage("onden.cursor.<nodeKey>") on every selection
  // change, and reads sessionStorage("onden.pendingCursor.<nodeKey>") on
  // mount — if found, applies the cursor + deletes the pending entry. This
  // is the handoff for the restore-cursor flow: RestorePreviewModal stages
  // a pending cursor after a successful restore; the editor picks it up
  // when the node is next opened.
  // Reference: Logseq worker/undo_redo.cljs:291 record-editor-info!.
  nodeKey?: string;
  /** The note's title: what "Copy block link" puts before the paragraph's words (`[[title/words]]`). */
  noteTitle?: string;
  // The `{` menu's tags (lib/moduleLibrary hashtagSuggestionTags): the
  // person's own, those of imported modules and those of modules not
  // imported yet. Choosing one of the last calls onImportModuleTag, which
  // asks first, imports, and resolves the tag's name to write (null: nothing
  // is written).
  workspaceTags?: TagItem[];
  onImportModuleTag?: (moduleId: string, name: string) => Promise<string | null>;
  // Upload a dropped/pasted image and return the markdown snippet to insert at
  // the caret (e.g. "![alt](https://…/foo.png)"). Returning null suppresses
  // the insert — caller is expected to surface its own error UI.
  onMediaInsert: (file: File) => Promise<string | null>;
  // Called when one or more dropped files were not images, so the caller can
  // surface "only images can be dropped" feedback. The editor still calls
  // preventDefault so the browser doesn't navigate to the dropped file.
  onUnsupportedDrop?: (files: File[]) => void;
  placeholder?: string;
  // Inline highlight → entity. When `extractTags` has at least one class tag
  // (one whose schema_id is non-null) AND `onExtract` is provided, the bubble
  // toolbar shows a "Sparkles" button. Clicking it opens a small popover
  // (title input + tag picker); confirm creates the entity (offline-aware)
  // and replaces the selection in markdown with [[wikilink]] back to the
  // new node.
  extractTags?: Tag[];
  onExtract?: (title: string, classTagId: string) => Promise<ContentNode | null>;
  // Slash → set attribute. When `attrClassTags` carries any class tag with
  // schema_fields and `onAttrSet` is provided, the slash menu surfaces a
  // row per schema field labelled "Set <field>". Selecting one removes the
  // slash text from the markdown and calls onAttrSet — the host prompts
  // for the value (v1 uses window.prompt to skip a second popup state).
  attrClassTags?: Tag[];
  onAttrSet?: (key: string, value: string, valueType: NodeAttribute["value_type"]) => Promise<void> | void;
  // Checkbox → agenda task. When provided, a `- [ ]` line in the body can be
  // promoted to a real task node (linked to the active note via the existing
  // addTask mutation) — so a typed checkbox stops being inert markdown and
  // joins the agenda. The source line's box is ticked to `- [x]` afterwards so
  // the note records that it was promoted; the task node owns live state from
  // then on. Returns true on success so the editor only ticks the box when the
  // task actually minted.
  onCreateTask?: (title: string) => Promise<boolean>;
  /** Slash → PDF / handwriting page: create the page under this note
   *  (a PDF from `file`) and resolve its title, or null when it failed. */
  onInsertPage?: (kind: InsertPageKind, file?: File) => Promise<string | null>;
  /** Items imported modules add to the `/` menu (OverviewEditor builds them
   *  from modules/types SlashInsert, for the open note). */
  moduleInserts?: ReadonlyArray<Extract<SlashItem, { kind: "module" }>>;
  /** An insert that waits on the network (an image upload, a created page or
   *  task, an extracted note) finished after the editor moved to another note
   *  (`nodeKey` changed). Apply `edit` to the note it was started in instead
   *  of this document. Without it, such a late insert is dropped. */
  editLeftNote?: (nodeKey: string, edit: (body: string) => string) => void;
  // Distraction-free writing. When true the editor keeps the active line
  // vertically centred as you type (typewriter-scroll) — the caret stays put
  // while text flows up around it, the way iA Writer / Typora zen modes do.
  // The host (OverviewEditor) also hides the surrounding chrome via a
  // body-level class; this prop only governs the in-editor scroll behaviour.
  zen?: boolean;
  /** The note can be read but not changed by this person (a viewer, or only a
   *  viewer of the note's space). Toggled in place, like zen. */
  readOnly?: boolean;
  /** 「看整篇當時的樣子」 in 「這段的歷史」: open the note's own history at a save. */
  onOpenNoteHistory?: (versionId: string | null) => void;
  /** The catalog's functions a paragraph can take (lib/tagFunctions blockFunctions): the tag
   *  panel's 「試試功能」, each writing the function's tag into the block's `{…}` (block nodes). */
  blockFunctions?: BlockFunction[];
  /** A checkbox line becomes a task by writing this tag
   *  (the reserved #task's name) into its `{…}` — the line IS the task
   *  (block-nodes.md B4) — instead of minting a separate task node. */
  taskTagName?: string | null;
  /** Open a note an embed shows (the 「開啟手寫頁」 button under a `![[drawing]]`,
   *  lib/editorEmbeds): its title and id, as a clicked [[link]] opens it. */
  onOpenWikilink?: (label: string, targetId: string | null, blockId?: string) => void;
  /** May this person change the note an embed shows? The embed's editor opens
   *  read-only when not. */
  canEditEmbedSource?: (node: { space_id?: string | null }) => boolean;
  /** Who cites the paragraphs of this note (hooks/useBlockCitations): a small number at the right
   *  edge of each cited paragraph, and the undo notice when one is deleted. */
  blockCitations?: readonly BlockCitationRow[];
  /** A tap on one of those numbers: the paragraph's `^id` and the number's element. */
  onOpenBlockCitations?: (blockId: string, anchor: HTMLElement) => void;
  /** `@ai` mentions: the `@` menu, and the card under each mention saying whether
   *  it was sent and how it went. Absent: `@` is only text. */
  mentions?: MentionsHost;
  /** An AI's pending places, drawn in the text with Accept / Reject each
   *  (lib/editorSuggestions). Absent: nothing is drawn. */
  suggestions?: { places: readonly Place[]; onDecide: SuggestionHost["onDecide"] };
  /** 「交給 AI」 (hooks/useHandToAi): the selection bar and the paragraph menu get an 「AI」 entry. Absent: none. */
  handToAi?: HandToAi;
};

// Imperative handle so a host toolbar (OverviewEditor's "Insert image" button)
// can push a picked file through the SAME upload→insert path the paste/drop
// handlers use, inserting the returned markdown at the live caret. This is the
// mobile-reachable entry point: a hidden <input type=file> has no paste/drag
// equivalent on iOS, so the camera roll was previously unreachable.
export type MarkdownEditorHandle = {
  insertMediaFile: (file: File) => Promise<void>;
  /** Insert text at the caret (kept while a dialog had focus) and refocus. */
  insertText: (text: string, options?: { endIfNoCaret?: boolean }) => void;
  /** Open 「在本篇找字」, pre-filled with the last searched words. */
  openFind: () => void;
  /** 「全部收起」／「全部展開」 for the headings of this note. */
  foldAll: () => void;
  unfoldAll: () => void;
  /** Scroll the 0-based line to the top of the page (the info panel's 「段落」). */
  scrollToLine: (line: number) => void;
  /** Each 0-based line's top edge in viewport pixels. */
  lineTops: (lines: readonly number[]) => number[];
  /** Focus the editor with the caret at a character offset (clamped to the text). */
  focusAt: (offset: number) => void;
};

// Checkbox → task works on the items the renderer draws as boxes
// (lib/taskLines.ts): any list marker, inside quotes, never in a code block.
// A ticked box counts as already promoted, and an empty one has no title.
// Exported for unit tests (the convert-to-task gating lives here).

/** The unticked, non-empty task item on 0-based line `line`, if any. */
export function unconvertedTaskAt(markdown: string, line: number): TaskLine | null {
  const task = taskAtLine(markdown, line);
  return task && !task.checked && task.text ? task : null;
}

// Edits for an insert that finished after the editor left its note (see
// `editLeftNote`): there is no caret in that note any more, so each one says
// where the text goes instead. Exported for unit tests.

/** Add `text` as its own block at the end of `body`. */
export function appendBlock(body: string, text: string): string {
  return body.trim() ? `${body.trimEnd()}\n\n${text}` : text;
}

/** Tick the box on 0-based line `line` if it is still the unticked item
 *  `label`; otherwise leave `body` alone rather than guess. */
export function tickTaskAt(body: string, line: number, label: string): string {
  const task = unconvertedTaskAt(body, line);
  return task?.text === label ? setTaskLine(body, task, true) : body;
}

// The bullet marks that make a line a list item: one source for Enter (both paths) and Tab.
/** How long the caret must rest before the phone bar re-reads what the paragraph under it offers. */
const CARET_OFFERS_PAUSE_MS = 250;
const BULLET = "[-*+]";
const LIST_ITEM_START = new RegExp(`^(\\s*)(${BULLET}|\\d+\\.) `);
const QUOTE_OR_CHECKBOX_LINE = new RegExp(`^((?:>[ \\t]?)*)(\\s*(?:${BULLET} \\[[ xX]\\] |${BULLET} |\\d+\\. )?)(.*)$`);

// ── CodeMirror theme ──────────────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  "&": { fontSize: "0.9rem", fontFamily: "ui-monospace, 'Cascadia Code', Menlo, monospace" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "visible", lineHeight: "1.7", minHeight: "160px" },
  ".cm-content": { padding: "12px 16px", caretColor: "var(--ac-accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ac-accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":
    { background: "color-mix(in srgb, var(--ac-accent) 22%, transparent)" },
  ".cm-activeLine": { background: "transparent" },
  ".cm-gutters": { display: "none" },
});

// ── Component ─────────────────────────────────────────────────────────────────

function MarkdownEditor({
  value, onChange, onComposingChange, nodes, nodeKey, noteTitle, workspaceTags = [], onMediaInsert, onUnsupportedDrop, placeholder,
  extractTags = [], onExtract, attrClassTags = [], onAttrSet, onCreateTask, onInsertPage, moduleInserts, editLeftNote, zen = false, readOnly = false, blockFunctions = NO_FUNCTIONS, taskTagName = null,
  onOpenWikilink, onImportModuleTag, canEditEmbedSource, blockCitations, onOpenBlockCitations, onOpenNoteHistory, mentions, suggestions, handToAi,
}: Props, ref: React.Ref<MarkdownEditorHandle>) {
  const t = useT();
  const onInsertPageRef = useRef(onInsertPage);
  const onImportModuleTagRef = useRef(onImportModuleTag);
  onImportModuleTagRef.current = onImportModuleTag;
  useEffect(() => { onInsertPageRef.current = onInsertPage; }, [onInsertPage]);
  // The editor is not remounted per note: an insert that awaited the network
  // must check it is still in the note it started in (stillOn below).
  const openCitationsRef = useRef(onOpenBlockCitations);
  openCitationsRef.current = onOpenBlockCitations;
  const nodeKeyRef = useRef(nodeKey);
  // Where the typed `[[…` of a note being created sits, kept current as the text around it is edited.
  const pendingLinkSpots = useRef(new Set<{ from: number; to: number }>());
  const editLeftNoteRef = useRef(editLeftNote);
  useEffect(() => { nodeKeyRef.current = nodeKey; }, [nodeKey]);
  // An extract started in the previous note does not carry over to this one.
  // A selection toolbar (and its half-typed link or new note) belongs to the note it opened on.
  // The suggestion list belongs to the note it opened in too: its trigger position is meaningless in another text.
  useEffect(() => { setToolbar(null); setTouchSel(null); setPopup(null); }, [nodeKey]);
  useEffect(() => { editLeftNoteRef.current = editLeftNote; }, [editLeftNote]);
  const attrClassTagsRef = useRef<Tag[]>(attrClassTags);
  const onAttrSetRef = useRef(onAttrSet);
  const onCreateTaskRef = useRef(onCreateTask);
  useEffect(() => { attrClassTagsRef.current = attrClassTags; }, [attrClassTags]);
  useEffect(() => { onAttrSetRef.current = onAttrSet; }, [onAttrSet]);
  useEffect(() => { onCreateTaskRef.current = onCreateTask; }, [onCreateTask]);
  // Filter to actual class tags (those carrying schema_id / Behaviour / Policy);
  // plain label tags don't make sense as entity types.
  // A picker: a hidden tag (D104) is not offered (lib/nodeTags isTagShown).
  const classTagOptions = extractTags.filter((t) => t.schema_id !== null && isTagShown(t) && !isAppliedByAppTag(t) && tagKind(t) !== "system");
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef      = useRef<EditorView | null>(null);
  /** After an await: the live view when the editor still shows the note the
   *  insert started in (`startedOn`). Otherwise hand `edit` to that note and
   *  return null — the result belongs there, not in the note now open. */
  const stillOn = useCallback((startedOn: string | undefined, edit: (body: string) => string): EditorView | null => {
    if (startedOn === nodeKeyRef.current) return viewRef.current;
    if (startedOn) editLeftNoteRef.current?.(startedOn, edit);
    return null;
  }, []);
  // Typewriter-scroll lives in a compartment so toggling zen reconfigures the
  // running editor in place (no remount, no lost caret).
  const typewriterRef = useRef(new Compartment());
  const readOnlyRef = useRef(new Compartment());
  // Keeps the caret above the mobile bottom bar while the bar is up.
  // The note whose saved folds the editor last applied (see the restore effect).
  const foldsAppliedFor = useRef<string | undefined>(undefined);
  const taskTagNameRef = useRef(taskTagName);
  const blockTaskTagRef = useRef(new Compartment());
  taskTagNameRef.current = taskTagName;
  // Undo history lives in a compartment so a note switch can start it afresh.
  const historyRef = useRef(new Compartment());
  // The note the editor's text (and its undo history) belongs to.
  const shownKeyRef = useRef(nodeKey);
  const valueSeenRef = useRef(value);
  const textIsCarried = useRef(false);
  /** The note whose last caret has been put back for this visit (the restore effect below), or that the person has
   *  typed in since it was shown: either way the caret is where it should be, and the restore must not run again. */
  const restoredForRef = useRef<string | null>(null);
  const carriedTextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [carriedSettled, setCarriedSettled] = useState(0);
  useEffect(() => () => { if (carriedTextTimer.current) clearTimeout(carriedTextTimer.current); }, []);
  const readOnlyExtension = (on: boolean) => (on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

  // Keep latest prop values accessible from CM closures
  const onChangeRef       = useRef(onChange);
  const onComposingChangeRef = useRef(onComposingChange);
  onComposingChangeRef.current = onComposingChange;
  // An outside text that arrived during an IME composition, waiting for its end; `compositionEnds` re-runs the sync.
  const outsideWaiting = useRef(false);
  const [compositionEnds, setCompositionEnds] = useState(0);
  const nodesRef          = useRef(nodes);
  const workspaceTagsRef  = useRef(workspaceTags);
  const onMediaInsertRef  = useRef(onMediaInsert);
  const onUnsupportedDropRef = useRef(onUnsupportedDrop);
  useEffect(() => { onChangeRef.current = onChange; },       [onChange]);
  // A task embed (`![[onden://node/…]]`) is drawn from the tasks the reader holds.
  const taskRefs = useTaskRefs();
  useEffect(() => {
    nodesRef.current = nodes;
    viewRef.current?.dispatch({ effects: refreshEmbeds.of(null) });
  }, [nodes, taskRefs]);
  const canEditEmbedSourceRef = useRef(canEditEmbedSource);
  canEditEmbedSourceRef.current = canEditEmbedSource;
  const readOnlyRef2 = useRef(readOnly);
  readOnlyRef2.current = readOnly;
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  useEffect(() => { onOpenWikilinkRef.current = onOpenWikilink; }, [onOpenWikilink]);
  // Tap / Ctrl+click on a link follows it; the touch "Open" chip (lib/editorLinkFollow).
  const linkFollow = useEditorLinkFollow({ viewRef, nodes, nodeKey, onOpenWikilink });
  // A tap on a block / section / note embed edits its source here.
  const [embedEdit, setEmbedEdit] = useState<EmbedEditRequest | null>(null);
  // `![[…]]` lines show their embed (lib/editorEmbeds), resolved against the
  // latest notes from the note being edited.
  // The `@` menu and the cards under mentions; read through a ref so the
  // editor keeps one extension for its whole life.
  const mentionsRef = useRef(mentions);
  useEffect(() => { mentionsRef.current = mentions; }, [mentions]);
  const [mentionCards] = useState(() => mentionCardsExtension({ onAction: (key, action) => mentionsRef.current?.onAction(key, action) }));
  // An AI's pending places: one extension for the editor's life, the host read through a ref.
  const suggestionsRef = useRef(suggestions);
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
  const [suggestionPlaces] = useState(() => suggestionPlacesExtension({ onDecide: (place, decision) => suggestionsRef.current?.onDecide(place, decision) }));
  // `[[筆記/段落]]` shows the paragraph's words as they are now (lib/editorPartLinks).
  const [partLinksExtension] = useState(() => editorPartLinks(() => {
    const notes = nodesRef.current;
    const self = notes.find((n) => n.id === nodeKeyRef.current);
    return { nodes: notes, from: self ? { id: self.id, space_id: self.space_id } : null };
  }));
  // Deleting a paragraph that part links in other notes point to says so (lib/blockSafety).
  const linkedParagraphs = useLinkedParagraphs(nodeKey);
  const [linkedParagraphsExtension] = useState(() => editorLinkedParagraphs(() => linkedParagraphs.current));
  const [renderedExtensions] = useState(() => { const context = (): EmbedContext => {
    const notes = nodesRef.current;
    const self = notes.find((n) => n.id === nodeKeyRef.current);
    return {
      nodes: notes,
      from: self ? { id: self.id, space_id: self.space_id } : null,
      onEdit: setEmbedEdit,
      // 「救回」 on a deleted paragraph's embed: only where this person may edit the note it was in.
      canRestoreBlock: (source) => !readOnlyRef2.current && (canEditEmbedSourceRef.current?.(source as { space_id?: string | null }) ?? false),
      onOpen: (nodeId) => {
        const open = onOpenWikilinkRef.current;
        if (open) open(notes.find((n) => n.id === nodeId)?.title ?? "", nodeId);
      },
    };
  }; return editorRendered(editorEmbeds(context), context); });
  useEffect(() => { workspaceTagsRef.current = workspaceTags; }, [workspaceTags]);
  useEffect(() => { onUnsupportedDropRef.current = onUnsupportedDrop; }, [onUnsupportedDrop]);
  useEffect(() => { onMediaInsertRef.current = onMediaInsert; }, [onMediaInsert]);

  // Upload one image, audio or video file and splice the returned markdown at the live caret. Shared
  // by the paste handler and the imperative insertMediaFile handle so all file
  // entry points (paste / drop / file-picker button) take the identical path.
  const insertMediaAtCaret = useCallback(async (file: File) => {
    if (!viewRef.current || viewRef.current.state.readOnly) return;
    const startedOn = nodeKeyRef.current;
    const snippet = await onMediaInsertRef.current(file);
    if (!snippet) return;
    const view = stillOn(startedOn, (body) => appendBlock(body, snippet));
    if (!view) return;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: snippet },
      selection: { anchor: pos + snippet.length },
    });
    view.focus();
  }, [stillOn]);

  const insertTextAtCaret = useCallback((text: string, options?: { endIfNoCaret?: boolean }) => {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return;
    const { head, empty } = view.state.selection.main;
    // A caret still at the very start of a text that has some, in an editor nobody is typing in, was never placed.
    const pos = options?.endIfNoCaret && head === 0 && empty && !view.hasFocus && view.state.doc.length > 0 ? view.state.doc.length : head;
    view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    view.focus();
  }, []);

  useImperativeHandle(ref, () => ({ insertMediaFile: insertMediaAtCaret, insertText: insertTextAtCaret, openFind: () => { const v = viewRef.current; if (v) openFind(v); },
    foldAll: () => { const v = viewRef.current; if (v) foldAllHeadings(v); },
    unfoldAll: () => { const v = viewRef.current; if (v) unfoldAllHeadings(v); },
    scrollToLine: (line) => {
      const v = viewRef.current;
      if (!v) return;
      const from = v.state.doc.line(Math.min(Math.max(line + 1, 1), v.state.doc.lines)).from;
      revealFolded(v, from);
      v.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 16 }) });
    },
    lineTops: (lines) => {
      const v = viewRef.current;
      return lines.map((line) => v ? v.documentTop + v.lineBlockAt(v.state.doc.line(Math.min(Math.max(line + 1, 1), v.state.doc.lines)).from).top : NaN);
    },
    focusAt: (offset) => {
      const v = viewRef.current;
      if (!v) return;
      const anchor = Math.min(Math.max(offset, 0), v.state.doc.length);
      v.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
      v.focus();
    },
  }), [insertMediaAtCaret, insertTextAtCaret]);

  const [popup,    setPopup]    = useState<PopupState | null>(null);
  // The one-time "#word → {word}" note (lib/hashtagScopeHint): shown at most
  // once per account, so it is marked seen when it appears, not when closed.
  const [hashtagHint, setHashtagHint] = useState<(HashtagScopeHintRange & { x: number; y: number }) | null>(null);
  const hashtagHintOnce = useHintOnce("hashtag-to-scope");
  const hashtagHintRef = useRef({ once: hashtagHintOnce, hint: hashtagHint, readOnly });
  hashtagHintRef.current = { once: hashtagHintOnce, hint: hashtagHint, readOnly };
  const [selIdx,   setSelIdx]   = useState(0);
  const [toolbar,  setToolbar]  = useState<ToolbarState | null>(null);
  // Mobile above-keyboard formatting toolbar (pillar 2 of the two-axis mobile
  // nav). Headings/bold/lists/checkbox are painful to hand-type on a phone; this
  // bar sits pinned to the top of the on-screen keyboard while the editor is
  // focused (useVirtualKeyboard below).
  const [editorFocused, setEditorFocused] = useState(false);
  // The ¶ menu or "# Tag" picker is open: focus is in it, not the editor, and the bar must stay.
  const [paragraphOpen, setParagraphOpen] = useState(false);
  // What the phone bar's paragraph buttons offer at the caret, as a key: a change re-draws the bar.
  const [, setCaretOffers] = useState("");
  const paragraphExtrasRef = useRef<(from: number) => ParagraphExtras>(() => ({}));
  const caretOffersRef = useRef(afterPause(() => {
    const view = viewRef.current;
    const { from, to, head } = view?.state.selection.main ?? { from: 0, to: 1, head: 0 };
    if (!view || from !== to) return;
    const extras = paragraphExtrasRef.current(head);
    setCaretOffers([hasParagraphAt(view, head), !!extras.onConvertTask, !!extras.blockChild?.expand, !!extras.blockChild?.move].join());
  }, CARET_OFFERS_PAUSE_MS));
  useEffect(() => { const pending = caretOffersRef.current; return () => pending.cancel(); }, []);
  const isMobile = useIsMobile();
  // Touch screens never get the floating selection toolbar: the OS draws its
  // selection handles and cut/copy/paste menu around the selection, and a
  // third bar there covers both. The bottom bar switches to "selection mode"
  // instead (Notion, Bear, Apple Notes). A mouse keeps the floating toolbar.
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const touchRef = useRef(touch);
  /** The non-empty selection on a touch screen, with the formats it has. */
  const [touchSel, setTouchSel] = useState<{ from: number; to: number; active: ReadonlySet<string> } | null>(null);
  useLayoutEffect(() => {
    touchRef.current = touch;
    setToolbar(null);
    setTouchSel(null);
  }, [touch]);
  const barRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Inline "set attribute value" input, replacing the old window.prompt() leak.
  // When non-null, a small theme-tokened text box is rendered at the slash
  // trigger's coordinates (x/y captured from the popup before it closes).
  // Enter commits via onAttrSet; Escape cancels. The slash text is already
  // removed from the doc by applyItem before this opens.
  const [attrInput, setAttrInput] = useState<null | {
    field: SchemaField;
    value: string;
    x: number;
    y: number;
  }>(null);
  const attrInputRef = useRef<HTMLInputElement>(null);

  // Refs for synchronous keymap access
  const popupRef      = useRef<PopupState | null>(null);
  const selIdxRef     = useRef(0);
  const popupItemsRef = useRef<unknown[]>([]);
  const applyItemRef  = useRef<(item: unknown) => void>(() => {});

  // Layout effects, not passive ones: the popup's buttons are in the DOM as
  // soon as React commits, and a click (or key) can land before passive
  // effects run — applyItem would then read a stale null popup and do nothing.
  useLayoutEffect(() => { popupRef.current  = popup; },  [popup]);
  useLayoutEffect(() => { selIdxRef.current = selIdx; }, [selIdx]);
  useEffect(() => setSelIdx(0), [popup?.query]);
  // `[[Note#` lists that note's headings and paragraphs (lib/wikilinkTargets).
  const linkTargets = useLinkTargets(popup?.type === "wikilink" ? popup.query : null, {
    nodes, currentId: nodeKey, currentText: () => viewRef.current?.state.doc.toString() ?? "",
  });
  // `((` searches every note's paragraphs; 「最近存的段落」 lead it and the plain `[[` list.
  // The words being typed are left out of the open note's text, or `((words`
  // would find its own line.
  const blockRefs = useBlockRefs(popup, {
    nodes, currentId: nodeKey, currentText: () => {
      const state = viewRef.current?.state;
      const p = popupRef.current;
      if (!state) return "";
      return p?.type === "blockref" ? state.doc.sliceString(0, p.triggerStart) + state.doc.sliceString(state.selection.main.head) : state.doc.toString();
    },
  });

  // ── Editor helpers ─────────────────────────────────────────────────────────

  // Formatting from the toolbars: one edit (lib/editorFormat), then the editor
  // keeps focus and the selection toolbar closes.
  const wrapAtSel = useCallback((from: number, to: number, before: string, after: string) => {
    const view = viewRef.current;
    if (!view) return;
    toggleWrap(view, from, to, before, after);
    view.focus();
    setToolbar(null);
  }, []);

  const applyHeading = useCallback((view: EditorView, level: number) => {
    toggleHeading(view, level);
    view.focus();
    setToolbar(null);
  }, []);

  const applyBlockPrefix = useCallback((view: EditorView, prefix: string) => {
    toggleLinePrefix(view, prefix);
    view.focus();
    setToolbar(null);
  }, []);

  // ── Checkbox → task ─────────────────────────────────────────────────────────
  // Promote the checkbox line at `pos` to a real agenda task node (via the
  // host's addTask mutation, which links it to the active note) and tick the
  // source box so the note records it was promoted. No-op for non-checkbox /
  // already-ticked / empty lines, or when no host handler is wired.
  const convertCheckboxToTask = useCallback(async (pos: number) => {
    const create = onCreateTaskRef.current;
    const view = viewRef.current;
    // With the #task name known, the line becomes the task (`{task}`), box left as is.
    if (view && taskTagNameRef.current) {
      if (insertBlockTag(view, pos, taskTagNameRef.current)) { view.focus(); setToolbar(null); }
      return;
    }
    if (!create || !view) return;
    const lineIndex = view.state.doc.lineAt(pos).number - 1;
    const label = unconvertedTaskAt(view.state.doc.toString(), lineIndex)?.text;
    if (!label) return;
    const startedOn = nodeKeyRef.current;
    const ok = await create(label);
    if (!ok) return;
    // Tick the box on the line it started on — an autosave-driven value sync
    // may have changed the text while the task minted, so bail if that line
    // is no longer the same unconverted item (e.g. the user edited it).
    const view2 = stillOn(startedOn, (body) => tickTaskAt(body, lineIndex, label));
    if (!view2) return;
    const task = unconvertedTaskAt(view2.state.doc.toString(), lineIndex);
    if (task?.text === label) {
      view2.dispatch({ changes: { from: task.markOffset, to: task.markOffset + 1, insert: "x" } });
    }
    view2.focus();
    setToolbar(null);
  }, [stillOn]);

  // ── Hashtag hint ───────────────────────────────────────────────────────────

  const hashtagHintName = hashtagHint?.name ?? null;
  const trackHashtagHint = useCallback((update: ViewUpdate) => {
    const { once, hint, readOnly: locked } = hashtagHintRef.current;
    if (hint) {
      // Follow the typed word as the text moves; gone or changed → no hint.
      const from = update.changes.mapPos(hint.from, 1), to = update.changes.mapPos(hint.to, -1);
      setHashtagHint(update.state.doc.sliceString(from, to) === `#${hint.name}` ? { ...hint, from, to } : null);
      return;
    }
    const sel = update.state.selection.main;
    if (locked || !once.show || !sel.empty || !update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
    const found = hashtagScopeHintAt(update.state.doc.toString(), sel.head, (pos) => popupBlockedAt(update.state, pos));
    const at = found && update.view.coordsAtPos(found.to);
    if (!found || !at) return;
    setHashtagHint({ ...found, x: at.left, y: at.bottom + 6 });
    once.markSeen();
  }, []);

  const applyHashtagHint = useCallback(() => {
    const view = viewRef.current;
    const hint = hashtagHintRef.current.hint;
    setHashtagHint(null);
    if (!view || !hint || view.state.doc.sliceString(hint.from, hint.to) !== `#${hint.name}`) return;
    const doc = view.state.doc.toString();
    const next = hashtagToScope(doc, hint);
    // One change from the first differing character to the last, so undo is one step.
    let start = 0;
    while (start < doc.length && start < next.length && doc[start] === next[start]) start++;
    let endOld = doc.length, endNew = next.length;
    while (endOld > start && endNew > start && doc[endOld - 1] === next[endNew - 1]) { endOld--; endNew--; }
    view.dispatch({ changes: { from: start, to: endOld, insert: next.slice(start, endNew) }, userEvent: "input.complete" });
  }, []);

  useAutoReset(hashtagHintName, () => setHashtagHint(null), 12_000);

  // ── Trigger detection ──────────────────────────────────────────────────────

  const detectTrigger = useCallback((view: EditorView) => {
    const pos  = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const txt  = view.state.doc.sliceString(line.from, pos);

    // No list in code or a formula (lib/editorCompletion popupBlockedAt).
    const m = detectPopupTrigger(txt, popupBlockedAt(view.state, pos));
    // `@` is only text where mentions are not wired (read-only host, no note).
    if (!m || ((m.type === "mention" || m.type === "skill") && !mentionsRef.current)) { setPopup(null); return; }
    const triggerStart = line.from + m.markerIndex;
    // No position to draw at (the line is not laid out): close rather than
    // leave the previous popup open over text it no longer belongs to.
    const c = view.coordsAtPos(triggerStart);
    setPopup(c ? { type: m.type, query: m.query, triggerStart, x: c.left, y: c.bottom + 6, lineTop: c.top } : null);
  }, []);

  // ── Apply autocomplete item ────────────────────────────────────────────────

  const applyItem = useCallback((item: unknown) => {
    const view = viewRef.current;
    const p    = popupRef.current;
    if (!view || !p) return;
    const next = applyCompletion(view, p, item as CompletionItem);
    setPopup(null);
    if (next?.kind === "attr") {
      // The value input opens where the popup was; focus goes to it, not the editor.
      setAttrInput({ field: next.field, value: "", x: p.x, y: p.y });
      return;
    }
    if (next?.kind === "create-note") {
      if (!next.title || !onExtract || classTagOptions.length === 0) return;
      // Reuse the extract/create path: mint the node, then replace the `[[query`
      // trigger with a resolved [[title]] wikilink (the server may disambiguate).
      // The link only goes in while this is still the note it was started in and the typed trigger text
      // is still exactly where it was; otherwise the note is made and the person is told, the text is left.
      const startedOn = nodeKeyRef.current;
      const spot = { from: next.triggerStart, to: Math.max(next.triggerStart, view.state.selection.main.head) };
      const typed = view.state.sliceDoc(spot.from, spot.to);
      pendingLinkSpots.current.add(spot);
      void (async () => {
        let created: Awaited<ReturnType<typeof onExtract>> = null;
        try { created = await onExtract(next.title, classTagOptions[0].id); } finally { pendingLinkSpots.current.delete(spot); }
        const v = viewRef.current;
        const sameNote = nodeKeyRef.current === startedOn;
        if (created) {
          const link = `[[${created.title}]]`;
          const { from, to } = spot;
          if (v && sameNote && to <= v.state.doc.length && v.state.sliceDoc(from, to) === typed) {
            const caretAtEnd = v.state.selection.main.head === to;
            v.dispatch({
              changes: { from, to, insert: link },
              ...(caretAtEnd ? { selection: { anchor: from + link.length } } : {}),
            });
          } else {
            addToast(sameNote
              ? t("The new note was created, but its link was not added because the text changed meanwhile.")
              : t("The new note was created, but its link was not added because you opened another note."), "info");
          }
        }
        if (v && sameNote) v.focus();
      })();
      return;
    }
    if (next?.kind === "bind-part-link") {
      // The link is written and already reads by its words; the server now anchors the part and binds the link to it.
      const startedOn = nodeKeyRef.current;
      if (startedOn) {
        void blockLinkWriter.bind(startedOn, next.noteId, { at: next.target.start, seenText: next.target.text, suggestedText: next.text }).then((bound) => {
          // Another paragraph of this note already used those words: the server settled on others, so the text follows.
          const written = `${next.embed ? "!" : ""}[[${bound?.link}]]`;
          if (!bound || written === next.link) return;
          const v = stillOn(startedOn, (body) => body.includes(next.link) ? body.replace(next.link, () => written) : body);
          const at = v?.state.doc.toString().indexOf(next.link) ?? -1;
          if (v && at !== -1) v.dispatch({ changes: { from: at, to: at + next.link.length, insert: written } });
        });
      }
      view.focus();
      return;
    }
    if (next?.kind === "import-module") {
      // Write the tag name over the trigger once the function is on (the caret
      // may have moved; a different note opened meanwhile gets nothing).
      const startedOn = nodeKeyRef.current;
      void (async () => {
        const name = await onImportModuleTagRef.current?.(next.moduleId, next.name) ?? null;
        const v = viewRef.current;
        if (!v || !name || nodeKeyRef.current !== startedOn) return;
        writeBlockTagName(v, next.triggerStart, name);
        v.focus();
      })();
      return;
    }
    if (next?.kind === "module-insert") {
      // The `/` is gone and the caret is where it was: the module writes there.
      view.focus();
      next.run();
      return;
    }
    if (next?.kind === "insert") {
      // Insert at the trigger once the file is picked or the page exists (the
      // caret may have moved meanwhile, or the note may have changed).
      const startedOn = nodeKeyRef.current;
      const insertAt = (text: string) => {
        const v = stillOn(startedOn, (body) => appendBlock(body, text));
        if (!v) return;
        const from = Math.min(next.at, v.state.doc.length);
        v.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length } });
      };
      void (async () => {
        if (next.insert === "media") {
          const file = await pickFile(INSERT_MEDIA_ACCEPT);
          const snippet = file ? await onMediaInsertRef.current(file) : null;
          if (snippet) insertAt(snippet);
          return;
        }
        const file = next.insert === "pdf" ? await pickFile("application/pdf,.pdf") : undefined;
        if (next.insert === "pdf" && !file) return;
        const title = await onInsertPageRef.current?.(next.insert, file ?? undefined);
        if (title) insertAt(`[[${title}]]`);
      })();
    }
    view.focus();
  }, [onExtract, classTagOptions, stillOn, t]);

  useLayoutEffect(() => { applyItemRef.current = applyItem; }, [applyItem]);

  // ── Inline attribute-value input ─────────────────────────────────────────────
  // Commit the typed value through onAttrSet, then close the input and return
  // focus to the editor. Empty value is a no-op commit (treated as cancel) so
  // an accidental Enter doesn't write a blank attribute.
  const commitAttrInput = useCallback(() => {
    const ai = attrInput;
    if (!ai) return;
    const raw = ai.value.trim();
    if (raw && onAttrSetRef.current) {
      void onAttrSetRef.current(ai.field.name, raw, storageType(ai.field.type));
    }
    setAttrInput(null);
    viewRef.current?.focus();
  }, [attrInput]);

  const cancelAttrInput = useCallback(() => {
    setAttrInput(null);
    viewRef.current?.focus();
  }, []);

  // Focus the inline attr input when it opens (after the doc-edit that removed
  // the slash trigger has settled the editor's own focus).
  useEffect(() => { if (attrInput) attrInputRef.current?.focus(); }, [attrInput]);

  // ── Popup items (filtered) ─────────────────────────────────────────────────

  const popupItems = popup ? getCompletions(popup, {
    nodes: nodesRef.current,
    tasks: taskRefs,
    tags: workspaceTagsRef.current,
    attrClassTags: attrClassTagsRef.current,
    canSetAttr: !!onAttrSetRef.current,
    canInsertPage: !!onInsertPageRef.current,
    moduleItems: moduleInserts,
    canCreateNote: !!onExtract && classTagOptions.length > 0,
    linkTargets: linkTargets?.rows,
    blockRefs: blockRefs.rows,
    recentBlocks: blockRefs.recentForWikilink,
    mentionRows: mentions ? mentions.rows : undefined,
    skillRows: mentions ? mentions.skillRows : undefined,
  }) : [];

  useLayoutEffect(() => { popupItemsRef.current = popupItems; });
  // The menus sit just under the caret and never take focus from the text being typed in
  // (their keys, Esc included, are the editor's keymap above); the popover keeps them in the window.
  const completionPop = useInlinePopover({
    open: !!popup && ((popup.type !== "mention" && popup.type !== "skill") || popupItems.length > 0),
    onClose: () => setPopup(null),
    at: popup ? { x: popup.x + 12, y: popup.y + 4, lineTop: popup.lineTop - 4 } : undefined,
  });
  const attrPop = useInlinePopover({ open: !!attrInput, onClose: () => setAttrInput(null), at: attrInput ? { x: attrInput.x + 12, y: attrInput.y + 4 } : undefined });

  // ── Keymap handlers ────────────────────────────────────────────────────────

  // The Enter cases the markdown language's own Enter (continue a list) gets wrong or lacks: the open
  // suggestion list, a quote, an empty checkbox. Registered ahead of it (Prec.highest: lang-markdown's is Prec.high); anything else
  // returns false and lang-markdown continues the list (renumbering what follows).
  const handleBlockEnter = useCallback((view: EditorView, soft = false): boolean => {
    // IME guard: an Enter mid-composition is the user committing a CJK
    // candidate, not confirming the autocomplete popup. Let CodeMirror /
    // the IME handle it (return false → fall through to default).
    if (view.composing) return false;
    if (popupRef.current && popupItemsRef.current.length > 0) {
      applyItemRef.current(popupItemsRef.current[selIdxRef.current]);
      return true;
    }
    const sel  = view.state.selection.main;
    // Several carets: each line's own continuation is lang-markdown's job.
    if (!sel.empty || view.state.selection.ranges.length > 1) return false;
    const pos  = sel.head;
    const line = view.state.doc.lineAt(pos);

    // A paragraph with a `{…}` is one item (task, review card) because of it, and the `{…}` counts only on its last line:
    // Enter anywhere in it cuts it into two paragraphs, and the item stays with the half that has the `{…}` (業主
    // 2026-11-08, @onden/markdown splitTaggedParagraph / splitAnchorSpan). Shift+Enter is `soft`: a line break inside
    // the same paragraph. A touch keyboard has no Shift, so there Enter always cuts.
    if (!soft && line.text.length > 0) {
      const cut = splitTaggedParagraph(view.state.doc.toString(), pos);
      if (cut) {
        view.dispatch({ changes: { from: cut.at, insert: cut.insert }, selection: { anchor: cut.caret }, userEvent: "input" });
        return true;
      }
    }

    // A quote (`> `, nested `> > `, a callout's `> [!note]` title included) and a checkbox item: the
    // next line keeps the same marks; Enter on a line with nothing after its marks leaves them, one
    // level at a time (the list mark inside a quote, then one `>`), as on an empty list item.
    // Judged on the whole line, so Enter right after the marks splits the line and keeps them.
    const m = line.text.match(QUOTE_OR_CHECKBOX_LINE);
    if (!m) return false;
    const [, quoteMarks, listMark, rest] = m as unknown as [string, string, string, string];
    const isCheckbox = /\[[ xX]\] $/.test(listMark);
    // Plain bullets and numbers outside a quote are lang-markdown's (it renumbers what follows).
    if (!quoteMarks && !isCheckbox) return false;
    const marksEnd = line.from + quoteMarks.length + listMark.length;
    // Inside the marks is lang-markdown's; a checkbox is one unit, so a caret just after its `]` (before
    // the space) counts as after it.
    if (pos < marksEnd - (isCheckbox ? 1 : 0)) return false;
    const at = Math.max(pos, marksEnd);
    if (inFencedCode(view.state.doc.sliceString(0, line.from))) return false;
    if (!rest.trim()) {
      const left = listMark.trim() ? quoteMarks : quoteMarks.replace(/>[ \t]?$/, "");
      view.dispatch({ changes: { from: line.from, to: line.to, insert: left }, selection: { anchor: line.from + left.length } });
      return true;
    }
    const quoteNext = quoteMarks ? quoteMarks.trimEnd() + " " : "";
    const listNext = isCheckbox ? listMark.replace(/\[[ xX]\]/, "[ ]")
      : /^\s*\d+\. $/.test(listMark) ? listMark.replace(/\d+/, (n) => String(Number(n) + 1)) : listMark;
    const prefix = `\n${quoteNext}${listNext}`;
    view.dispatch({ changes: { from: at, insert: prefix }, selection: { anchor: at + prefix.length } });
    return true;
  }, []);

  // Enter where lang-markdown's Enter is not in front (touch keyboards reach it through beforeinput): the list
  // continues the way it does on a desktop, by lang-markdown's own command (whole-line judgement, renumbering, nothing
  // in a code block; a selection is left to the caller's plain newline, which replaces it).
  const handleEnter = useCallback((view: EditorView, soft = false): boolean => {
    if (handleBlockEnter(view, soft)) return true;
    if (view.composing) return false;
    return insertNewlineContinueMarkup(view);
  }, [handleBlockEnter]);

  const handleTab = useCallback((view: EditorView): boolean => {
    if (view.composing) return false;
    const pos  = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    if (LIST_ITEM_START.test(line.text)) {
      // A child item must start at or after its parent's content ("1. " is 3 wide: two spaces would leave it a sibling).
      view.dispatch({ changes: { from: line.from, insert: " ".repeat(listIndentWidth(line.text)) } });
    } else {
      view.dispatch({ changes: { from: pos, insert: "  " } });
    }
    return true;
  }, []);

  const handleShiftTab = useCallback((view: EditorView): boolean => {
    if (view.composing) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (line.text.startsWith("  ")) {
      view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "" } });
      return true;
    }
    if (line.text.startsWith("\t")) {
      view.dispatch({ changes: { from: line.from, to: line.from + 1, insert: "" } });
      return true;
    }
    return false;
  }, []);

  // ── Initialize editor ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    if (nodeKeyRef.current) resetEditorChanges(nodeKeyRef.current);
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          historyRef.current.of(history()),
          editorMarkdownLanguage(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": t("Note content") }),
          syntaxHighlighting(mdHighlight),
          editorLinks,
          editorTheme,
          typewriterRef.current.of(zen ? typewriterScroll : []),
          readOnlyRef.current.of(readOnlyExtension(readOnly)),
          blockHistoryPreview,
          paragraphFrame,
          editorKeyboard(),
          headingFolding((marks) => saveFoldMarks(nodeKeyRef.current, marks), ExternalSync),
          editorSelectionTools(),
          editorBlocks,
          editorAnchors(() => nodeKeyRef.current),
          blockTaskTagRef.current.of(blockTaskTagName.of(taskTagName)),
          editorCitations((blockId, anchor) => openCitationsRef.current?.(blockId, anchor)),
          renderedExtensions,
          codeHighlightOnDemand,
          partLinksExtension,
          linkedParagraphsExtension,
          mentionCards,
          suggestionPlaces,
          linkFollow.extension,
          emptyDocHint(placeholder ?? ""),
          editorFrontmatter,
          editorFind,
          // A read-only note takes no paste at all. CodeMirror's own paste checks that, but the handlers ahead of it
          // (lang-markdown's paste-a-URL-over-a-selection, ours below) do not, so this one stands in front of them.
          Prec.highest(EditorView.domEventHandlers({
            paste(e, view) { if (!view.state.readOnly) return false; e.preventDefault(); return true; },
          })),
          Prec.highest(keymap.of([
            { key: "Enter", run: (v) => handleBlockEnter(v) },
            // Shift+Enter: a line break inside the same paragraph, never a cut (a touch keyboard has no Shift: its Enter cuts).
            { key: "Shift-Enter", run: (v) => { if (v.composing) return false; if (!handleEnter(v, true)) insertNewlineAndIndent(v); return true; } },
          ])),
          keymap.of([
            // Popup navigation. IME guard (CJK/IME): while a composition is
            // active, Arrow/Escape/Enter belong to the IME candidate picker —
            // the popup must NOT hijack them, or a Chinese-speaking user can't
            // select a candidate. Mirrors CommandPalette's isComposing guard;
            // here we read CodeMirror's view.composing (the keymap has no DOM
            // event to read isComposing from). Enter is guarded inside
            // handleBlockEnter and handleEnter.
            { key: "ArrowDown", run: (v) => {
              if (v.composing) return false;
              if (!popupRef.current || !popupItemsRef.current.length) return false;
              setSelIdx(i => (i + 1) % popupItemsRef.current.length); return true;
            }},
            { key: "ArrowUp", run: (v) => {
              if (v.composing) return false;
              if (!popupRef.current || !popupItemsRef.current.length) return false;
              setSelIdx(i => (i - 1 + popupItemsRef.current.length) % popupItemsRef.current.length); return true;
            }},
            { key: "Escape", run: (v) => { if (v.composing) return false; if (!popupRef.current) return false; setPopup(null); return true; }},
            // Formatting shortcuts
            ...formatKeyBindings((_v, from, to, before, after) => wrapAtSel(from, to, before, after)),
            // Structural keys
            { key: "Enter",     run: (v) => handleEnter(v) },
            { key: "Mod-Shift-Enter", run: v => {
              // Promote the caret's checkbox line to a task. Only consumes the
              // key when the line is actually an unconverted checkbox AND a
              // host handler is wired — otherwise it falls through.
              if (!onCreateTaskRef.current && !taskTagNameRef.current) return false;
              const line = v.state.doc.lineAt(v.state.selection.main.head);
              if (!unconvertedTaskAt(v.state.doc.toString(), line.number - 1)) return false;
              void convertCheckboxToTask(v.state.selection.main.head);
              return true;
            }},
            { key: "Tab",       run: handleTab },
            { key: "Shift-Tab", run: handleShiftTab },
            ...clusterKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of(update => {
            const wasComposing = update.startState.field(composingField, false) === true;
            if (wasComposing !== (update.state.field(composingField, false) === true)) onComposingChangeRef.current?.(!wasComposing);
            if (composingEnded(update) && outsideWaiting.current) setCompositionEnds((n) => n + 1);
            // Skip onChange for programmatic value syncs — they aren't user edits.
            const external = update.transactions.some(tr => tr.annotation(ExternalSync));
            if (update.docChanged && nodeKeyRef.current) recordEditorUpdate(nodeKeyRef.current, update.changes, { external, carried: carriedInUpdate(update) });
            if (update.docChanged) {
              for (const spot of pendingLinkSpots.current) {
                spot.from = update.changes.mapPos(spot.from, 1);
                spot.to = Math.max(spot.from, update.changes.mapPos(spot.to, -1));
              }
            }
            if (update.docChanged && !external) {
              // The person typed: the caret is theirs. An empty note (a new one) had nothing to restore a caret into,
              // so the restore was still waiting for "the body" — and took the first key for it: it put the caret
              // back with a second transaction, which closed the list that key had just opened (`/` in a new note).
              if (nodeKeyRef.current) restoredForRef.current = nodeKeyRef.current;
              onChangeRef.current(update.state.doc.toString());
              detectTrigger(update.view);
              setToolbar(null);
              trackHashtagHint(update);
            } else if (update.selectionSet && !update.docChanged && !external) {
              // The caret moved without typing (End, Home, arrows, a tap): it left the text the list was
              // completing, and Enter would replace everything up to wherever the caret now is.
              setPopup(null);
            }
            // G5: live cursor stash. Writes the current selection main range
            // to sessionStorage so BuilderApp's save handler can pull it
            // into the PATCH cursor_state field. Cheap (sync write to ~32
            // bytes); no debounce needed for a single-key sessionStorage.
            // ExternalSync transactions are NOT the user moving the caret —
            // the mount-time body swap carries selection 0 and would clobber
            // the stash the P0-2 restore is about to read.
            const shownNote = nodeKeyRef.current;
            if ((update.docChanged || update.selectionSet) && !external && shownNote) {
              const sel = update.state.selection.main;
              writeSession(SESSION_KEYS.cursor(shownNote), JSON.stringify({ anchor: sel.anchor, head: sel.head }));
            }
            if (touchRef.current) {
              if (update.selectionSet || update.docChanged) {
                const { from, to, head } = update.state.selection.main;
                setTouchSel(from === to ? null : { from, to, active: activeFormats(update.state.doc, from, to, head) });
                // Each of these parses the whole note: once typing pauses, not on every key.
                if (from === to) caretOffersRef.current.schedule(); else caretOffersRef.current.cancel();
              }
            } else if (update.selectionSet && !update.docChanged) {
              const { from, to } = update.state.selection.main;
              if (from !== to) {
                const at = selectionBubblePosition(update.view, from, to);
                if (at) setToolbar({ ...at, selFrom: from, selTo: to });
              } else {
                setToolbar(null);
              }
            }
          }),
          EditorView.domEventHandlers({
            // Mobile toolbar focus tracking. Toolbar buttons preventDefault on
            // pointerdown so tapping one never blurs the editor — so a real blur
            // here means focus genuinely left (keyboard dismissed) → hide the bar.
            // Focus moving into the bar (its link or new-note form) stays "in the editor".
            focus() { setEditorFocused(true); return false; },
            blur(e) {
              if (e.relatedTarget instanceof Node && barRef.current?.contains(e.relatedTarget)) return false;
              setEditorFocused(false);
              return false;
            },
            // Android Chrome (and its emulation) routes Enter through
            // CM6's delayAndroidKey path, which waits for the virtual
            // keyboard's own DOM mutation and silently DROPS the key when
            // none arrives (e.g. right after typing, force=false) — Enter
            // produced no line break on mobile. Handle the input intent
            // directly: insertParagraph/insertLineBreak becomes a real
            // newline via the same path as the desktop Enter keymap.
            // Desktop is unaffected (the keydown keymap preventDefaults
            // first, so beforeinput never fires); IME composition is left
            // alone — preventDefault mid-composition breaks GBoard.
            beforeinput(e, view) {
              if (e.inputType !== "insertParagraph" && e.inputType !== "insertLineBreak") return false;
              if (view.composing) return false;
              e.preventDefault();
              if (!handleEnter(view)) insertNewlineAndIndent(view);
              return true;
            },
            paste(e, view) {
              // Pictures only when the clipboard holds no text (a spreadsheet range brings a preview image along).
              const clip = e.clipboardData;
              const media = pastedMediaFiles(
                Array.from(clip?.items ?? []).flatMap((i) => (i.kind === "file" ? [i.getAsFile()] : [])).filter((f): f is File => !!f),
                clip?.getData("text/plain") ?? "",
              );
              if (media.length > 0) {
                e.preventDefault();
                // Each lands where the caret is, in order, so the person can keep typing after the last.
                void (async () => { for (const f of media) await insertMediaAtCaret(f); })();
                return true;
              }
              // A part link copied from a paragraph: it goes in, and is bound to that paragraph.
              const pastedText = e.clipboardData?.getData("text/plain") ?? "";
              if (pastedText.includes("[[") && pasteBlockLink(view, pastedText, {
                noteId: nodeKeyRef.current,
                stillOn: (id) => (id === nodeKeyRef.current ? viewRef.current : null),
              })) {
                e.preventDefault();
                return true;
              }
              // Paste-over-selection: if the clipboard is a bare URL and text is
              // selected, wrap the selection as a [text](url) markdown link
              // instead of replacing it. Mirrors the iA Writer / VS Code behaviour.
              const { from, to } = view.state.selection.main;
              if (from === to) return false;
              const pasted = e.clipboardData?.getData("text/plain")?.trim() ?? "";
              if (!pasted || /\s/.test(pasted) || !isHttpUrl(pasted)) return false;
              e.preventDefault();
              const sel  = view.state.doc.sliceString(from, to);
              const link = `[${sel}](${pasted})`;
              view.dispatch({
                changes:   { from, to, insert: link },
                selection: { anchor: from + link.length },
              });
              view.focus();
              return true;
            },
            // A file over the editor is ours to take or refuse, never the browser's to open: without a
            // dragover default prevented it would navigate away (a read-only editor is not editable, so it
            // gets no drop at all unless this says it may).
            dragover(e) {
              if (!e.dataTransfer?.types.includes("Files")) return false;
              e.preventDefault();
              return true;
            },
            drop(e, view) {
              const all = Array.from(e.dataTransfer?.files ?? []);
              if (!all.length) return false;
              // Always preventDefault once a file lands on the editor — stops
              // the browser from navigating to a PDF / random file dropped by
              // accident, even if no image survives the filter.
              e.preventDefault();
              if (view.state.readOnly) return true;
              const { media, rest } = splitDroppedFiles(all);
              // Drop position translates from page coords to a doc offset, so
              // the image lands where the cursor dropped — not at the end.
              const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
              if (media.length > 0) {
                const startedOn = nodeKeyRef.current;
                void (async () => {
                  let cursor = dropPos;
                  for (const f of media) {
                    const snippet = await onMediaInsertRef.current(f);
                    if (!snippet) continue;
                    const view = stillOn(startedOn, (body) => appendBlock(body, snippet));
                    if (!view) continue;
                    // The upload await can let an autosave value-sync shrink the
                    // doc, so the captured absolute `cursor` may now exceed doc
                    // length → RangeError (the rest of the images silently dropped).
                    // Clamp to the live doc before each insert.
                    const from = Math.min(cursor, view.state.doc.length);
                    view.dispatch({
                      changes: { from, insert: snippet },
                      selection: { anchor: from + snippet.length },
                    });
                    cursor = from + snippet.length;
                  }
                })();
              }
              if (rest.length > 0) onUnsupportedDropRef.current?.(rest);
              return true;
            },
            scroll() { setToolbar(null); return false; },
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    bindEditorNote(view, () => nodeKeyRef.current);

    return () => {
      // A composition the editor goes away in never sends its end: the host must not keep waiting for it.
      if (view.state.field(composingField, false)) onComposingChangeRef.current?.(false);
      view.destroy(); viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The numbers beside cited paragraphs follow the host's latest answer.
  useEffect(() => { viewRef.current?.dispatch({ effects: setCitations.of(blockCitations ?? []) }); }, [blockCitations, nodeKey]);

  // The cards under mentions follow the host's latest.
  const mentionCardList = mentions?.cards;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMentionCards.of(mentionCardList ? [...mentionCardList] : []) });
  }, [mentionCardList]);

  // Which AI can be asked is looked up when the menu opens, not on every keystroke.
  const mentionMenu = popup?.type === "mention" || popup?.type === "skill" ? popup.type : null;
  useEffect(() => { if (mentionMenu) mentionsRef.current?.onMenuOpen(mentionMenu); }, [mentionMenu]);

  // Sync the text from outside: a save's reflection, a remote edit, a restore,
  // or another note. None of these is an edit the user can undo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const switched = shownKeyRef.current !== nodeKey;
    shownKeyRef.current = nodeKey;
    const valueMoved = valueSeenRef.current !== value;
    valueSeenRef.current = value;
    // A new id with the previous note's text unchanged: the host has not handed over this note's text yet
    // (its draft resets in an ancestor effect, after this one). The folds, caret and search position below
    // wait for it; the timer is for two notes whose text is identical, where no other render comes.
    if (carriedTextTimer.current) { clearTimeout(carriedTextTimer.current); carriedTextTimer.current = null; }
    textIsCarried.current = switched && !valueMoved;
    if (textIsCarried.current) {
      carriedTextTimer.current = setTimeout(() => { textIsCarried.current = false; setCarriedSettled((n) => n + 1); }, 250);
    }
    const cur = view.state.doc.toString();
    if (switched) {
      // Another note: its text replaces this one and the undo history starts
      // over, so undo can never bring the previous note's text into this one.
      // The caret is clamped here; the nav-position effect below restores it.
      if (cur !== value) {
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: 0, to: cur.length, insert: value },
          selection: { anchor: Math.min(sel.anchor, value.length), head: Math.min(sel.head, value.length) },
          annotations: [ExternalSync.of(true), Transaction.addToHistory.of(false)],
        });
      }
      view.dispatch({ effects: historyRef.current.reconfigure([]) });
      view.dispatch({ effects: historyRef.current.reconfigure(history()) });
      return;
    }
    if (cur === value) { outsideWaiting.current = false; return; }
    // An IME is composing: replacing text now cuts the composition (the candidate is lost or lands in the wrong
    // place). The text waits; the composition's end re-runs this effect (compositionEnds) and the newest `value`
    // is applied by the same replacement below. Not a timer: the end is the browser's compositionend.
    if (view.composing || view.state.field(composingField, false)) { outsideWaiting.current = true; return; }
    outsideWaiting.current = false;
    // The same note changed elsewhere: replace only the span that differs, so
    // the caret and the undo history map through it instead of collapsing to
    // a whole-document replace (which made undo/redo jump to stale text).
    let start = 0;
    const limit = Math.min(cur.length, value.length);
    while (start < limit && cur.charCodeAt(start) === value.charCodeAt(start)) start++;
    let end = 0;
    while (end < limit - start && cur.charCodeAt(cur.length - 1 - end) === value.charCodeAt(value.length - 1 - end)) end++;
    view.dispatch({
      changes: { from: start, to: cur.length - end, insert: value.slice(start, value.length - end) },
      annotations: [ExternalSync.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value, nodeKey, compositionEnds]);

  // The headings this device folded in the note, put back once its text is in
  // (after the sync above, so they are matched against this note's text).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || foldsAppliedFor.current === nodeKey || textIsCarried.current) return;
    if (view.state.doc.length > 0) foldsAppliedFor.current = nodeKey;
    applyFoldMarks(view, loadFoldMarks(nodeKey));
  }, [value, nodeKey, carriedSettled]);

  // Where the note's paragraphs are, as the server last measured them (the editor moves them with each keystroke:
  // lib/editorAnchors). After the text sync above, so they are checked against this note's text; again whenever the
  // server's anchors change.
  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: setEditorAnchors.of(nodeKey ? anchorSpansOf(nodeKey, view.state.doc.toString()) : []) });
  }, [nodeKey, anchorsSeen]);

  // The places under an AI's suggestions follow the host's latest. After the
  // text sync above, and again when the text changes: the places were counted
  // on the host's text, and a sync that lands after them would move them.
  const suggestionList = suggestions?.places;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setSuggestionPlaces.of(suggestionList ? [...suggestionList] : []) });
  }, [suggestionList, value]);

  // Another note starts without the previous note's find panel and marks.
  // Words from the Ctrl+K search that opened this note: scroll to the first
  // hit and mark it briefly (one-shot; the next Ctrl+F is pre-filled with them).
  const findShownKeyRef = useRef(nodeKey);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (findShownKeyRef.current !== nodeKey) {
      findShownKeyRef.current = nodeKey;
      if (searchPanelOpen(view.state)) closeSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    }
    if (!nodeKey || view.state.doc.length === 0 || textIsCarried.current) return;
    const words = takePendingFind(nodeKey);
    if (words) revealFirstMatch(view, words);
  }, [nodeKey, value, carriedSettled]);

  // P0-2 nav-position: restore this node's last caret on mount AND node
  // switch (the editor never remounts — a `?node=` change only swaps props).
  // Priority: the pendingCursor restore-handoff (G5 — previously read only on
  // mount, so it silently never fired for an already-mounted editor), then
  // the live cursor stash written on every selection change. Net effect:
  // reload, back/forward, and switching notes all land where you left off,
  // scrolled into view, instead of jumping to the top.
  // Declared AFTER the value-sync effect: effects run in order, so the doc
  // for the new node is already in place when we clamp + apply.
  // One restore per node VISIT, and only once the real body is in the doc:
  // on a cold boot the editor can mount before the draft seeds (store-driven
  // drafts arrive via a parent effect), and a restore applied to that empty
  // doc clamps the caret to 0 — the later body swap then PRESERVES position 0
  // (by design, see the value-sync effect) and the note opens at the top.
  // (restoredForRef is declared with the other refs: the person's own first edit also settles the visit.)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !nodeKey) return;
    if (view.state.doc.length === 0 || textIsCarried.current) return; // body not seeded yet — wait
    const pendingRaw = readSession(SESSION_KEYS.pendingCursor(nodeKey));
    // pendingCursor is a one-shot navigation SIGNAL (a backlink/mention jump) and
    // must be honored even on a repeat visit to an already-restored node — the
    // once-per-nodeKey guard only governs the PASSIVE last-caret restore.
    if (!pendingRaw && restoredForRef.current === nodeKey) return;
    restoredForRef.current = nodeKey;
    try {
      const raw = pendingRaw ?? readSession(SESSION_KEYS.cursor(nodeKey));
      if (!raw) return;
      const sel = JSON.parse(raw) as { anchor: number; head: number };
      // Clamp to current doc length in case the body changed since the stash.
      const docLen = view.state.doc.length;
      const anchor = Math.min(Math.max(0, sel.anchor), docLen);
      const head = Math.min(Math.max(0, sel.head), docLen);
      if (pendingRaw) {
        // A jump to where another note mentions this one (one-shot): the caret
        // lands at the mention and the mention flashes, instead of being
        // selected. On a phone, focusing the editor with a range selected let
        // the browser move the anchor to the top, so everything from the first
        // line to the link came out selected (2026-11-02); and a finger that
        // only wanted to look gets no keyboard. A mouse keeps the focus (G5).
        view.dispatch({ selection: { anchor }, annotations: ExternalSync.of(true) });
        revealRange(view, { from: anchor, to: head });
        if (!isCoarsePointer()) view.focus();
        removeSession(SESSION_KEYS.pendingCursor(nodeKey));
      } else {
        // A plain position restore must NOT steal focus. Like the body swap, it is not the person moving the caret
        // (ExternalSync): it closes no list and does not overwrite the stash it was read from.
        // After a Back or Forward that put the page's scroll back (lib/pageScrollRestore) the caret stays where it
        // was but does not scroll the page again: the entry's own position is the one to see.
        view.dispatch({
          selection: { anchor, head },
          ...(scrollClaimedFor(nodeKey) ? {} : { effects: EditorView.scrollIntoView(head, { y: "center" }) }),
          annotations: ExternalSync.of(true),
        });
      }
    } catch { /* a stash that is not JSON: no caret to restore */ }
  }, [nodeKey, value, carriedSettled]);

  // Reconfigure typewriter-scroll when zen toggles live (the editor never
  // remounts — only this compartment swaps, so the caret is preserved). On
  // turning zen ON, immediately centre the current line so the jump happens
  // once on toggle rather than only on the next keystroke.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: blockTaskTagRef.current.reconfigure(blockTaskTagName.of(taskTagName)) });
  }, [taskTagName]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyRef.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: typewriterRef.current.reconfigure(zen ? typewriterScroll : []) });
    if (zen) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    }
  }, [zen]);

  // Hide toolbar on window scroll
  useEffect(() => {
    const h = () => setToolbar(null);
    return onWindow("scroll", h, true);
  }, []);

  // Focus link input when link mode opens

  // ── Mobile above-keyboard toolbar ───────────────────────────────────────────
  // The bar rides the on-screen keyboard (see useVirtualKeyboard). Android's
  // Back key and iOS's ⌄ close the keyboard WITHOUT blurring the editor, which
  // would strand the bar at the bottom of the screen. Treat a keyboard that
  // closes under a focused editor as leaving the editor: blur it, the bar goes,
  // and the next tap brings both back.
  // Switching keyboards or IME panels can drop the keyboard for a moment, so
  // only a keyboard that stays closed for a moment counts (lib/editorKeyboard).
  // The bar is up while the editor (or a form in the bar) has focus, on a phone
  // layout or any touch screen. Nothing shows while the editor is blurred or
  // read-only, even with text selected: formatting needs the editor, and the
  // OS menu covers copying; a bar there would only cover the note.
  const barUp = (isMobile || touch) && (editorFocused || paragraphOpen) && !readOnly;
  /** Leave the editor: blur it, or the bar's form holding focus. */
  const leaveEditor = useCallback(() => {
    const active = activeElement();
    if (active instanceof HTMLElement && barRef.current?.contains(active)) active.blur();
    viewRef.current?.contentDOM.blur();
    setEditorFocused(false);
  }, []);
  // lib/editorKeyboard owns the bar's place on the keyboard, the caret's clearance and the room under the last line.
  const keyboard = useEditorKeyboard({ viewRef, barRef, barUp, writing: editorFocused && !readOnly, onKeyboardClosed: leaveEditor });
  // Run a formatting action against the live view, keeping focus (so the keyboard
  // — and this bar — stay up). The button's pointerdown already preventDefaulted
  // the focus steal; we re-focus defensively.
  const runOnView = useCallback((fn: (v: EditorView) => void) => {
    const v = viewRef.current;
    if (!v) return;
    fn(v);
    v.focus();
  }, []);

  const applyLink = useCallback((from: number, to: number, url: string) => {
    const view = viewRef.current;
    if (!view) return;
    insertLink(view, from, to, url);
    setToolbar(null);
    view.focus();
  }, []);

  // ── Popup item renderer ────────────────────────────────────────────────────

  function renderPopupItem(item: unknown, i: number) {
    const active = i === selIdx ? " active" : "";
    const renderHintRow = (row: { text: string }) => (
      <Pressable key="hint" className={`slash-menu-item slash-menu-item--mention slash-menu-item--hint${active}`}
        onMouseDown={() => applyItem(row)}
        onMouseEnter={() => setSelIdx(i)}>
        <span className="slash-menu-title">{row.text}</span>
      </Pressable>
    );
    // Create-action row (miss-state of the wikilink popup).
    const create = item as { __create?: "note"; query?: string };
    if (create.__create) {
      const label = t("Create note “{query}”", { query: create.query ?? "" });
      return (
        <Pressable key={`__create-${create.__create}`} className={`slash-menu-item slash-menu-item--create${active}`}
          onMouseDown={() => applyItem(item)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon"><Plus size={14} /></span>
          <span className="slash-menu-title">{label}</span>
        </Pressable>
      );
    }
    if (popup?.type === "slash") {
      const si = item as SlashItem;
      return (
        <Pressable key={si.title} className={`slash-menu-item${active}`}
          onMouseDown={() => applyItem(si)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon"><si.Icon size={14} /></span>
          <span className="slash-menu-title">{t(si.title)}</span>
        </Pressable>
      );
    }
    if (isBlockRefRow(item)) {
      const before = popupItems[i - 1];
      return <BlockRefRow key={`${item.origin}-${item.noteId}-${item.target.start}`} row={item} active={i === selIdx}
        firstOfOrigin={!isBlockRefRow(before) || before.origin !== item.origin}
        onPick={() => applyItem(item)} onHover={() => setSelIdx(i)} />;
    }
    if ("__target" in (item as object)) {
      const row = item as LinkTargetItem;
      const before = popupItems[i - 1] as LinkTargetItem | undefined;
      return <LinkTargetRow key={`${row.target.kind}-${row.target.start}`} row={row} active={i === selIdx}
        firstOfKind={!before || before.target.kind !== row.target.kind}
        onPick={() => applyItem(row)} onHover={() => setSelIdx(i)} />;
    }
    if (popup?.type === "wikilink" && "__task" in (item as object)) {
      const task = item as TaskLinkItem;
      return (
        <Pressable key={`task-${task.id}`} className={`slash-menu-item slash-menu-item--task${active}`}
          onMouseDown={() => applyItem(task)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon" aria-hidden="true">{task.done ? <CheckSquare size={14} /> : <Square size={14} />}</span>
          <span className="slash-menu-title"><SnippetText snippet={{ text: task.title, ranges: task.ranges ?? [] }} markClassName="search-hl" /></span>
          <span className="slash-menu-source">{task.hint}</span>
        </Pressable>
      );
    }
    if (popup?.type === "wikilink") {
      const n = item as { id: string; title: string; ranges?: [number, number][] };
      return (
        <Pressable key={n.id} className={`slash-menu-item${active}`}
          onMouseDown={() => applyItem(n)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon slash-menu-icon--brackets">[[</span>
          <span className="slash-menu-title"><SnippetText snippet={{ text: n.title, ranges: n.ranges ?? [] }} markClassName="search-hl" /></span>
        </Pressable>
      );
    }
    if (popup?.type === "blocktag") {
      const tg = item as TagItem;
      return (
        <Pressable key={tg.id} className={`slash-menu-item${active}`}
          onMouseDown={() => applyItem(tg)}
          onMouseEnter={() => setSelIdx(i)}>
          <span
            className="slash-menu-icon tag-color-dot"
            style={tg.color ? ({ "--dot-color": tg.color } as CSSProperties) : undefined}
          />
          <span className="slash-menu-title">{tg.name}</span>
          {tg.module && (
            <span className={`slash-menu-source${tg.module?.state === "needs-import" ? " is-needs-import" : ""}`}>
              {tg.module.state === "imported" ? t("From the “{module}” module", { module: t(tg.module.title) })
                : tg.module.state === "needs-import" ? t("Adds the “{module}” function", { module: t(tg.module.title) })
                : t("The “{module}” function is off", { module: t(tg.module.title) })}
            </span>
          )}
        </Pressable>
      );
    }
    if (popup?.type === "mention") {
      const row = item as MentionRow;
      if (row.kind === "hint") return renderHintRow(row);
      return (
        <Pressable key={row.handle} className={`slash-menu-item slash-menu-item--mention${row.available ? "" : " is-unavailable"}${active}`}
          onMouseDown={() => applyItem(row)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon">@</span>
          <span className="slash-menu-title">@{row.handle}</span>
          {row.detail && <span className="slash-menu-source">{row.detail}</span>}
        </Pressable>
      );
    }
    if (popup?.type === "skill") {
      const row = item as SkillRow;
      if (row.kind === "hint") return renderHintRow(row);
      return (
        <Pressable key={row.title} className={`slash-menu-item slash-menu-item--mention${active}`}
          onMouseDown={() => applyItem(row)}
          onMouseEnter={() => setSelIdx(i)}>
          <span className="slash-menu-icon">/</span>
          <span className="slash-menu-title">{row.title}</span>
          {row.detail && <span className="slash-menu-source">{row.detail}</span>}
        </Pressable>
      );
    }
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Mobile toolbar buttons — each reuses an existing formatting helper.
  // `block`/`wrap`/`head` map to applyBlockPrefix/wrapAtSel/applyHeading.
  // A button keeps editor focus by preventDefault on pointerdown (keyboard +
  // bar stay) and acts on click, like the selection bar: a swipe that starts
  // on a button scrolls the bar (the browser cancels the pointer) instead of
  // pressing it.
  const barPress = (run: () => void) => ({ onMouseDown: keepFocus, onClick: run });
  const formatTool = (run: (v: EditorView) => void) => ({ run: () => runOnView(run) });
  const wrapSel = (mark: string) => (v: EditorView) => { const s = v.state.selection.main; wrapAtSel(s.from, s.to, mark, mark); };

  // What the selection toolbar does with the selection [from, to) — the same
  // handlers whether it floats over the text or fills the bottom bar.
  const formatActions = (from: number, to: number) => {
    const v = viewRef.current;
    return {
      onWrap: (before: string, after: string) => wrapAtSel(from, to, before, after),
      onQuote: () => { if (v) applyBlockPrefix(v, "> "); },
      onHeading: (level: 1 | 2 | 3) => { if (v) applyHeading(v, level); },
      onLink: (url: string) => applyLink(from, to, url),
    };
  };
  // What the paragraph the selection starts in offers beyond formatting. One answer for every
  // surface that draws the paragraph tools (the phone bar, the selection bar, the handle's menu):
  // lib/../ParagraphMenu `tools`. `span`: the selected text, for 「變成子筆記」 on a selection.
  const blockHistory = useBlockHistory({ viewRef, nodeKey, readOnly, onOpenNoteHistory });
  const blockChild = useBlockChildNote({ viewRef, nodeKey, readOnly, confirmDialog });
  const paragraphExtras = (from: number, span?: ParagraphSpan) => {
    const v = viewRef.current;
    const line = v && (onCreateTask || taskTagName) ? v.state.doc.lineAt(from) : null;
    const entries = blockChild.entries(from);
    return {
      onBlockHistory: blockHistory.open && (() => blockHistory.open!(from)),
      blockChild: span && v ? { move: blockChild.selectionEntry({ ...span, text: v.state.doc.sliceString(span.from, span.to) }), expand: entries.expand } : entries,
      onConvertTask: v && line && unconvertedTaskAt(v.state.doc.toString(), line.number - 1) ? () => void convertCheckboxToTask(from) : undefined,
    };
  };
  const paragraphMenu = {
    getView: () => viewRef.current, noteTitle, tags: workspaceTags, functions: blockFunctions, handToAi: handToAi && !readOnly ? handToAi : undefined,
    onOpenChange: setParagraphOpen, extrasAt: paragraphExtras, readOnly, onImportModuleTag,
  };
  const panels = useParagraphPanels(paragraphMenu);
  // The paragraph tools' buttons, drawn on the bar's own surface: the caret's paragraph (the phone bar)
  // or the selection's paragraphs (the bubble and the phone's selection bar). The bar is drawn from the
  // caret, so the editor's update listener re-draws it when the caret moves to a paragraph that offers
  // something else (`setCaretOffers`).
  paragraphExtrasRef.current = paragraphExtras;
  // The selection toolbar's buttons, for the same toolbar whether it floats or fills the bottom bar.
  const selectionActions = (from: number, to: number) => ({
    ...formatActions(from, to),
    paragraphTools: panels.tools({ span: { from, to } }, touch || isMobile ? "top-start" : "bottom-start"),
    panelOpen: paragraphOpen,
    onPanelOpenChange: setParagraphOpen,
  });
  // The phone bar's buttons: the paragraph tools (they open their panels next to the button pressed), then the formats.
  const barTools: ToolSpecs = {
    ...panels.tools(),
    // Types `[[` for the person: the note-link popup opens as if they had.
    wikilink: formatTool(startWikilink),
    // The picker opens from the click (a user gesture iOS accepts).
    insertFile: { run: () => { void pickFile(INSERT_MEDIA_ACCEPT).then((file) => file && insertMediaAtCaret(file)); } },
    h1: formatTool((v) => applyHeading(v, 1)),
    h2: formatTool((v) => applyHeading(v, 2)),
    bold: formatTool(wrapSel("**")),
    italic: formatTool(wrapSel("*")),
    code: formatTool(wrapSel("`")),
    bullet: formatTool((v) => applyBlockPrefix(v, "- ")),
    number: formatTool((v) => applyBlockPrefix(v, "1. ")),
    task: formatTool((v) => applyBlockPrefix(v, "- [ ] ")),
    quote: formatTool((v) => applyBlockPrefix(v, "> ")),
  };

  return (
    <div ref={wrapRef} className="md-editor-wrap">
      <div ref={containerRef} className="md-editor-cm" />
      {/* A mouse on a wide screen gets the handle beside each paragraph; the phone bar has the same actions as buttons. */}
      {!isMobile && !touch && (
        <ParagraphHandle viewRef={viewRef} wrapRef={wrapRef} readOnly={readOnly}
          menu={{ getView: paragraphMenu.getView, noteTitle, tags: workspaceTags, functions: blockFunctions, handToAi: paragraphMenu.handToAi, extrasAt: paragraphExtras, onImportModuleTag }} />
      )}
      {linkFollow.chip}
      {blockHistory.sheet}
      {embedEdit && (
        <EmbedEditSheet
          embed={embedEdit.embed} hostNodeId={nodeKey ?? null}
          canEdit={canEditEmbedSource?.(embedEdit.embed.node) ?? false}
          onOpenSource={(id, title) => onOpenWikilink?.(title, id)}
          onRevealSyntax={embedEdit.revealSource}
          onExpand={embedEdit.embed.kind === "note" && !embedEdit.embed.heading ? blockChild.expandEntry(embedEdit.embed.node.id) : undefined}
          onClose={() => setEmbedEdit(null)}
        />
      )}

      {barUp && (
        <div ref={barRef} className={`${layerClass.fixed} md-mobile-toolbar${touchSel ? " md-mobile-toolbar--selection" : ""}`}
          data-keyboard-bar role="toolbar" aria-label={t("Formatting")} style={{ "--kb-inset": keyboard.barInset } as CSSProperties}
          onBlur={(e) => {
            // Focus left the bar's form for somewhere other than the editor.
            const next = e.relatedTarget;
            if (next instanceof Node && (barRef.current?.contains(next) || viewRef.current?.contentDOM.contains(next))) return;
            setEditorFocused(false);
          }}>
          {touchSel ? (
            <SelectionToolbar variant="bar" active={touchSel.active} onCancel={() => viewRef.current?.focus()}
              {...selectionActions(touchSel.from, touchSel.to)} />
          ) : (
            <ToolbarRow surface="bar" variant="bar" tools={barTools} onMoreOpenChange={setParagraphOpen} />
          )}
          <Pressable
            type="button"
            className="md-mobile-tool md-mobile-tool--dismiss"
            title={t("Hide keyboard")}
            aria-label={t("Hide keyboard")}
            {...barPress(leaveEditor)}
          >
            <ChevronDown size={18} />
          </Pressable>
        </div>
      )}

      {hashtagHint && (
        <HashtagScopeHint name={hashtagHint.name} x={hashtagHint.x} y={hashtagHint.y}
          onApply={applyHashtagHint} onClose={() => setHashtagHint(null)} />
      )}

      {popup && ((popup.type !== "mention" && popup.type !== "skill") || popupItems.length > 0) && (
        <Popover popover={completionPop} label={t("Suggestions")} role="group" className="slash-menu-popup">
          {popupItems.length === 0
            ? <div className="slash-menu-empty">
                {popup.type === "slash" ? t("No results")
                  : popup.type === "wikilink" ? (
                    linkTargets?.status === "loading" ? t("Loading…")
                    : linkTargets?.status === "unavailable" ? t("Could not read that note.")
                    : linkTargets ? t("No matching headings or paragraphs")
                    : t("Type a note title…"))
                  : popup.type === "blockref" ? (
                    blockRefs.searching ? t("Searching…")
                    : popup.query.trim() ? t("No matching paragraphs")
                    : t("Type words to search the paragraphs of all your notes"))
                  : popup.type === "blocktag" ? t("A new tag: close with } and it is made when the note saves")
                  : t("Type a tag name…")}
              </div>
            : <div className="slash-menu">{popupItems.map((item, i) => renderPopupItem(item, i))}</div>
          }
        </Popover>
      )}

      {attrInput && (
        <Popover popover={attrPop} label={t("Set {field}", { field: attrInput.field.label ?? attrInput.field.name })} role="group" className="slash-menu-popup">
          {/* Inline attribute-value input — replaces the old window.prompt().
              Reuses the slash-menu surface + settings-input control (both
              theme-tokened, globally loaded) so it reads as part of the editor,
              not a browser chrome dialog. Enter commits, Escape cancels. */}
          <div className="slash-menu">
            <label className="slash-menu-empty">
              {t("Set {field}", { field: attrInput.field.label ?? attrInput.field.name })}
              {attrInput.field.type === "select" && attrInput.field.options
                ? ` (${attrInput.field.options.join(" / ")})`
                : attrInput.field.type !== "text"
                  ? ` (${attrInput.field.type})`
                  : ""}
            </label>
            <TextField
              ref={attrInputRef}
              className="settings-input"
              value={attrInput.value}
              placeholder={t("Value…")}
              autoFocus
              onChange={e => setAttrInput(prev => prev ? { ...prev, value: e.target.value } : prev)}
              onKeyDown={e => {
                // IME guard: don't commit while a CJK candidate is being picked.
                if (isImeComposing(e)) return;
                if (e.key === "Enter") { e.preventDefault(); commitAttrInput(); }
                if (isEscapeKey(e)) { e.preventDefault(); cancelAttrInput(); }
              }}
              onBlur={cancelAttrInput}
            />
          </div>
        </Popover>
      )}

      {handToAi && <Suspense fallback={null}><HandToAiPreview hand={handToAi} /></Suspense>}
      {toolbar && <SelectionToolbar at={toolbar} onDismiss={() => setToolbar(null)} {...selectionActions(toolbar.selFrom, toolbar.selTo)} />}
      {panels.nodes}
    </div>
  );
}

export default forwardRef<MarkdownEditorHandle, Props>(MarkdownEditor);
