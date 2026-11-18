import { NOTE_MODES, noteMode, previewAvailable, type NoteMode } from "../lib/viewSwitch";
import { ViewStripEnd } from "./viewTabs";
import { dateTimeId } from "../lib/localDate";
import { FIND_IN_NOTE_EVENT, setPendingFind } from "../lib/findInNote";
import { FOLD_ALL_HEADINGS_EVENT, UNFOLD_ALL_HEADINGS_EVENT } from "../lib/foldInNote";
import { useBlockCitations } from "../hooks/useBlockCitations";
import { loadInkAttributes, decodeInk, isInkReadOnly, notifyInkReadOnly } from "../lib/ink/store";
import NoteMetaLine from "./NoteMetaLine";
import type { OpenNoteHistory } from "./NoteEditedLine";
import type { NoteDisplayRow } from "./NoteActions";
import NoteBreadcrumb from "./NoteBreadcrumb";
import { noteAncestors } from "../lib/noteLocation";
import { trackNoteTitle } from "../lib/noteTitleVisibility";
import { useIsMobile } from "../hooks/useIsMobile";
import { useCapabilities, useIsOwner } from "../lib/capabilities";
import type { ContentNode } from "../lib/api";
import type { SaveStatus } from "../lib/appStore";
import { useSaveNotice } from "../lib/useSaveNotice";
import { getApiBase } from "../lib/api";
import { type InkSaveOptions, noteWriter, relationWriter, uploadMedia, drafts, writeErrors } from "../lib/data";
import { changeModuleImport, hashtagSuggestionTags } from "../lib/moduleLibrary";
import { useModuleImportConfirm } from "./ModuleImportConfirm";
import { t, useT } from "../lib/i18n";
import { Suspense, useRef, useCallback, useState, useEffect, useMemo, useLayoutEffect } from "react";
import { toggleTaskLine } from "../lib/taskCheckbox";
import { lazyWithReload } from "../lib/lazyWithReload";
import MarkdownEditor, { type InsertPageKind, type MarkdownEditorHandle } from "./MarkdownEditor";
import FeaturedFields from "./FeaturedFields";
import NoteDecisions from "./NoteDecisions";
import InlineProps from "./InlineProps";
import type { Tag } from "../lib/api";
import "./OverviewEditor.css";
import "./TagsPanel.css";
import { noteDoc, notePages, type InkPages } from "@onden/markdown/ink";
import { useInkSurfaceSaver } from "../lib/ink";
import { useDrawingRestoreSerial } from "../hooks/useDrawingRestoreSerial";
import { readPdfInk, type InkMultiPageDoc } from "../lib/pdf";
import { extractPdfText } from "../lib/pdf/extractText";
import { useAiEnabled, useModuleFilter, useModuleStatus } from "../hooks/useModuleFilter";
import { blockFunctions } from "../lib/tagFunctions";
import { moduleLineWord, slashInsertsOf } from "../modules";
import { Columns2, Eye, Minimize2, PenLine, type LucideIcon } from "lucide-react";
import EmptyState from "./EmptyState";
import { useZenMode } from "../hooks/useZenMode";
import { onWritingModeRequest } from "../lib/writingModeRequest";
import { previewOutline, registerOutlineTarget } from "../lib/noteOutline";
import { useAgentMentions } from "../hooks/useAgentMentions";
import { useAiSuggestions } from "../hooks/useAiSuggestions";
import { useHandToAi } from "../hooks/useHandToAi";
import { AiSuggestionBar } from "./AiSuggestionBar";
import { mentionRows, skillRows, type MentionsHost } from "../lib/agentMentions";
import { listenForHandOff } from "../lib/mentionHandOff";
import { useNoteSkills } from "../hooks/useNoteSkills";
import { registerNoteEditor } from "../lib/editorInsert";
import { anchorSpansOf } from "../lib/blockAnchorStore";
import { clearReveal, lineOfBlock, pendingReveal, watchReveal } from "../lib/noteReveal";
import { claimNoteTitleFocus, focusTitleField, onNoteTitleFocusRequest } from "../lib/cardTitleFocus";
import { PREFS, usePersistedFlag } from "../lib/prefs";
import { requestSplitClose, requestSplitOpen, useSplit } from "../lib/splitViewStore";
import { CONTENT_TAB } from "../lib/viewTabs";
import { addToast, getAppState, useTagRows } from "../lib/appStore";

import { ellipsize } from "@onden/markdown";
import { Segmented, TextArea, Pressable, layerClass } from "./ui";
import { isImeComposing } from "../lib/keys";
import { isPlaceholderTitle } from "../lib/noteLabel";
import { queryElement } from "../lib/documentAccess";
import { onWindow } from "../lib/globalEvents";
import { randomUUID } from "../lib/uuid";
const OverviewPreview = lazyWithReload(() => import("./OverviewPreview"));
const BlockCitationsMenu = lazyWithReload(() => import("./BlockCitationsMenu"));
const PdfNodeView = lazyWithReload(() => import("./PdfNodeView"));
const InkNodeView = lazyWithReload(() => import("./InkNodeView"));
const NoteEdgeOutline = lazyWithReload(() => import("./NoteEdgeOutline"));

// 編輯｜並排｜預覽 (NOTE_MODES): the pen, two columns, the eye.
const MODE_ICONS: Record<NoteMode, LucideIcon> = { edit: PenLine, split: Columns2, preview: Eye };

/** A note's PDF / handwriting surface, as loaded for that note. */
type LoadedSurface = {
  nodeId: string;
  pdfUrl: string | null;
  /** The PDF's drawing state: per-page strokes and every highlight record,
   *  one ink_data envelope (lib/pdf decodePdfInk). */
  pdfInk: InkMultiPageDoc | null;
  /** Set when the note is a handwriting page (single-page ink_data). */
  ink: { pages: InkPages } | null;
  /** The drawing needs a newer version to edit (isInkReadOnly): shown, never saved. */
  inkReadOnly: boolean;
  /** The text boxes on its pages as stored (`page_text`), null when none yet. */
  pageText: string | null;
  /** The pictures on its pages as stored (`page_images`), null when none yet. */
  pageImages: string | null;
};


type Props = {
  node: ContentNode | null;
  titleDraft: string;
  onTitleChange: (title: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  view: "edit" | "preview";
  setView: (v: "edit" | "preview") => void;
  saveStatus: SaveStatus;
  onSave: () => void;
  online: boolean;
  nodes: ContentNode[];
  /** A clicked [[link]]: its label, and the target's id when the preview resolved it. */
  onOpenWikilink: (label: string, targetId?: string | null, blockId?: string) => void;
  onCreateFirst: () => void;
  onSelectNode: (id: string) => void;
  // Inline text-to-entity highlighting. When provided alongside extractTags,
  // the bubble toolbar exposes a "Sparkles" action for selecting text →
  // creating a typed entity → replacing with a wikilink.
  extractTags?: Tag[];
  onExtract?: (title: string, classTagId: string) => Promise<ContentNode | null>;
  /** Class tags applied to the active node — passed through to MarkdownEditor
   *  so the slash command can surface "Set <field>" rows from each tag's
   *  schema. Empty array (default) means no attribute slash items appear. */
  attrClassTags?: Tag[];
  onAttrSet?: (key: string, value: string, valueType: string) => Promise<void> | void;
  /** Promote a `- [ ]` checkbox line in the body to an agenda task node linked
   *  to the active note. Resolves true on success (the editor then ticks the
   *  source box). When absent, no convert-to-task affordance is shown. */
  onCreateTask?: (title: string) => Promise<boolean>;
  // Trigger a useAppData refresh after the editor has caused server-side
  // node mutations that the hook didn't initiate itself (e.g. PDF
  // highlight-as-card spawns). Optional — when absent, the sidebar simply
  // stays stale until the next external refresh.
  onRefresh?: () => void;
  /** Per-note header actions (module header controls + "⋯" overflow). Rendered at the
   *  right of the note's top row. A slot so OverviewEditor stays presentational
   *  — OverviewEditorHost builds the wired NoteActions and passes it in. */
  noteActions?: import("react").ReactNode | ((note: { previewAvailable: boolean; displayRows: readonly NoteDisplayRow[] }) => import("react").ReactNode);
  /** This note's relationships (backlinks, mentions, canvases, parent and
   *  children, links), shown under the body. A slot, like noteActions:
   *  OverviewEditorHost builds the store-bound NoteRelations. */
  relations?: import("react").ReactNode;
  /** Open the version compare/restore dialog; absent while the note has no
   *  saved versions. */
  onOpenHistory?: OpenNoteHistory;
  /** How many times an AI changed the note (saved versions an AI made); 0 or absent: not said. */
  aiEdits?: number;
  /** Open the note's history at one save (「這段的歷史」 → 看整篇當時的樣子). */
  onOpenVersion?: (versionId: string | null) => void;
  /** Move this note under another note (null = top level), from the breadcrumb's
   *  "Move…". Absent: the breadcrumb offers no move. */
  onAssignGroup?: (nodeId: string, parentId: string | null) => unknown;
};

export default function OverviewEditor({
  node, titleDraft, onTitleChange, draft, onDraftChange,
  view, setView, saveStatus, onSave, online,
  nodes,
  onOpenWikilink, onCreateFirst, onSelectNode,
  extractTags, onExtract, onRefresh,
  attrClassTags, onAttrSet, onCreateTask,
  noteActions, relations, onOpenHistory, aiEdits, onOpenVersion, onAssignGroup,
}: Props) {
  useT(); // re-render the editor chrome on a language switch (labels via t())
  const saveNotice = useSaveNotice(saveStatus, online, node?.id ?? "", draft);
  const [uploadCount, setUploadCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Insert-image toolbar button: a hidden file input is the only camera-roll-
  // reachable path on iOS (paste/drag don't exist there). Picked files flow
  // through the same uploadMediaFile pipeline the paste/drop handlers use, inserted
  // at the editor caret via the MarkdownEditor imperative handle.
  const editorRef = useRef<MarkdownEditorHandle>(null);
  // 「被引用 N 次」: the notes that cite this note's paragraphs, and the list a tap on a number opens.
  const blockCitations = useBlockCitations(node?.id, online);
  const [citeMenu, setCiteMenu] = useState<{ blockId: string; anchor: HTMLElement } | null>(null);
  useEffect(() => setCiteMenu(null), [node?.id, view]);
  const openCitations = useCallback((blockId: string, anchor: HTMLElement) => setCiteMenu({ blockId, anchor }), []);
  // Going back to editing from a click in the preview: the editor mounts after
  // the view flips, so the caret offset waits here until it does.
  const pendingCaret = useRef<number | null>(null);
  const editFromPreview = useCallback((offset: number | null) => {
    pendingCaret.current = offset;
    setView("edit");
  }, [setView]);
  useEffect(() => {
    if (view !== "edit" || pendingCaret.current === null) return;
    const offset = pendingCaret.current;
    pendingCaret.current = null;
    requestAnimationFrame(() => editorRef.current?.focusAt(offset));
  }, [view]);
  // Opened from a task ("Open note") or a source link of the info panel's AI answer: scroll to that line once the text is here.
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => watchReveal(() => setRevealTick((n) => n + 1)), []);
  useEffect(() => {
    const ref = node ? pendingReveal(node.id) : null;
    if (!ref) return;
    const line = lineOfBlock(draft, ref, anchorSpansOf(node!.id, draft));
    if (line < 0) return; // the text has not arrived yet (or the line is gone): wait for the next change
    clearReveal();
    requestAnimationFrame(() => {
      if (view === "edit") editorRef.current?.scrollToLine(line);
      else queryElement(`[data-block-id="${ref}"]`)?.scrollIntoView({ block: "center" });
    });
  }, [node, draft, view, revealTick]);
  // A viewer (or only a viewer of the note's space) reads but cannot change it.
  const capabilities = useCapabilities(online);
  const canEdit = capabilities.canEdit(node);
  // Making a tag is a tag-definition write (as NotesCenter's tag page asks).
  // What an AI proposed for this note: drawn in the text, decided one place at a time or all at once.
  // AI off (modules/ai): nothing of it is looked up or drawn; its data stays on the server.
  const aiOn = useAiEnabled();
  const aiOnline = online && aiOn;
  const aiSuggestions = useAiSuggestions({ nodeId: node?.id, markdown: draft, canEdit, online: aiOnline, onNoteChanged: () => void onRefresh?.() });
  const stepAt = useRef(-1);
  useEffect(() => { stepAt.current = -1; }, [node?.id]);
  const stepSuggestion = useCallback((direction: 1 | -1) => {
    const places = aiSuggestions.ordered;
    if (places.length === 0) return;
    const forward = places.find((p) => p.at > stepAt.current);
    const backward = [...places].reverse().find((p) => p.at < stepAt.current);
    const target = direction === 1 ? forward ?? places[0]! : backward ?? places[places.length - 1]!;
    stepAt.current = target.at;
    if (view === "edit") editorRef.current?.focusAt(target.at);
    else { pendingCaret.current = target.at; setView("edit"); }
  }, [aiSuggestions.ordered, view, setView]);
  const handToAi = useHandToAi({ nodeId: node?.id, canEdit, online: aiOnline, onDone: () => void aiSuggestions.refresh() });
  const suggestionsHost = useMemo(
    () => (aiSuggestions.layout.places.length > 0 ? { places: aiSuggestions.layout.places, onDecide: aiSuggestions.onDecide } : undefined),
    [aiSuggestions.layout.places, aiSuggestions.onDecide],
  );
  // `@ai` in the note: the menu, the card under each mention, and the skill buttons.
  const waitingReplies = useMemo(() => new Set((aiSuggestions.view?.suggestions ?? []).flatMap((s) => (s.session_id ? [s.session_id] : []))), [aiSuggestions.view]);
  const agentMentions = useAgentMentions({
    nodeId: node?.id, markdown: draft, canEdit, online: aiOnline, onMarkdownChange: onDraftChange,
    waitingReplies, onReplyInserted: () => void aiSuggestions.refresh(),
  });
  const noteSkills = useNoteSkills({ autoload: false, online: aiOnline });
  const mentionsHost: MentionsHost = useMemo(() => ({
    cards: agentMentions.cards,
    onAction: (key, action) => { void agentMentions.act(key, action); },
    rows: (query) => mentionRows(query, agentMentions.known),
    skillRows: (query) => skillRows(query, noteSkills.skills),
    onMenuOpen: (menu) => { void (menu === "mention" ? agentMentions.refreshKnown() : noteSkills.refresh()); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agentMentions.cards, agentMentions.known, agentMentions.act, agentMentions.refreshKnown, noteSkills.skills, noteSkills.refresh]);
  // A skill button in the header (modules/skills) hands the note over with its skill.
  const handOff = agentMentions.handOff;
  useEffect(() => {
    if (!node || !canEdit || !aiOn) return;
    return listenForHandOff(node.id, (skillTitle) => { setView("edit"); handOff(skillTitle); });
  }, [node?.id, canEdit, aiOn, handOff, setView]); // eslint-disable-line react-hooks/exhaustive-deps
  // A task box in the preview flips its line in the draft (and so saves like a
  // typed edit). One identity across renders: the renderer rebuilds its
  // elements when a handler changes, which would swallow a press (see CardNode).
  const draftNow = useRef({ draft, onDraftChange });
  draftNow.current = { draft, onDraftChange };
  const toggleTaskInPreview = useCallback((index: number) => {
    const { draft: current, onDraftChange: change } = draftNow.current;
    change(toggleTaskLine(current, index));
  }, []);
  // A function's block action (「把這段做成複習卡」, lib/tagFunctions) writes its own tag on the
  // block (docs/architecture/block-nodes.md) — for imported modules (B3).
  const isImported = useModuleFilter();
  const moduleStatus = useModuleStatus();
  const tags = useTagRows();
  // Text imported modules write at the caret join the `/` menu.
  const moduleInserts = useMemo(() => canEdit && node
    ? slashInsertsOf(isImported)
      .map(({ insert }) => ({ kind: "module" as const, title: insert.title, Icon: insert.Icon, run: () => insert.run({ node }) }))
    : undefined, [canEdit, isImported, node]);
  // A checkbox line becomes a task by carrying the tasks module's own word `{task}` (B4), which the module's save
  // reads; it is never a tag.
  const taskTagName = moduleLineWord("tasks", tags ?? []);
  // The { menu: own tags, tags of functions that are on, and tags a function
  // has not made yet or that is turned off; the owner picks one and its tag is
  // made and written, asking once first only for a function that waits for the
  // owner's yes (ModuleImportConfirm; docs/architecture/module-library.md).
  const isOwner = useIsOwner();
  const hashtagTags = useMemo(() => hashtagSuggestionTags(tags ?? [], moduleStatus, { canImport: isOwner && online }),
    [tags, moduleStatus, isOwner, online]);
  const importer = useModuleImportConfirm();
  // The catalog's functions a paragraph can take (the tag panel's 「試試功能」); turning one on is the owner's.
  const paragraphFunctions = useMemo(
    () => blockFunctions(tags ?? [], moduleStatus, { canImport: isOwner && online }),
    [tags, moduleStatus, isOwner, online],
  );
  const importModuleTag = async (moduleId: string, name: string): Promise<string | null> => {
    let written: string | null = null;
    const run = async () => {
      try {
        const { moduleTagId } = await changeModuleImport(moduleId, true, online);
        written = getAppState().data.tags?.find((tag) => tag.id === moduleTagId)?.name ?? name;
        return true;
      } catch { return false; } // the writer reported it
    };
    if (moduleStatus(moduleId) !== "ask") await run();
    else await importer.confirm(moduleId, { target: { kind: "insert", name: `{${name}}` }, run });
    return written;
  };
  // Menu and dialog actions (a module's `/` insert) insert at this editor's caret.
  const editorNodeId = node?.id;
  // 「在本篇找字」 from the ⋯ menu or Cmd/Ctrl+F outside the text: the reading
  // view has no text to search, so it switches to the (read-only if need be)
  // editor first, then opens the one panel.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const open = () => {
      if (viewRef.current !== "edit") setView("edit");
      requestAnimationFrame(() => requestAnimationFrame(() => editorRef.current?.openFind()));
    };
    return onWindow(FIND_IN_NOTE_EVENT, open);
  }, [setView]);
  // 「全部收起」／「全部展開」 from the command palette: only the open note's text editor.
  useEffect(() => {
    const offFold = onWindow(FOLD_ALL_HEADINGS_EVENT, () => editorRef.current?.foldAll());
    const offUnfold = onWindow(UNFOLD_ALL_HEADINGS_EVENT, () => editorRef.current?.unfoldAll());
    return () => { offFold(); offUnfold(); };
  }, []);

  useEffect(() => {
    if (!editorNodeId) return;
    return registerNoteEditor(editorNodeId, (text, options) => editorRef.current?.insertText(text, options));
  }, [editorNodeId]);
  // The info panel's 「段落」 tab scrolls and measures the text on screen: the
  // editor's lines while editing, the drawn headings while reading.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!editorNodeId) return;
    const scroller = () => mainRef.current;
    return registerOutlineTarget(editorNodeId, view === "edit" ? {
      scrollTo: (heading) => editorRef.current?.scrollToLine(heading.line),
      tops: (headings) => editorRef.current?.lineTops(headings.map((heading) => heading.line)) ?? headings.map(() => NaN),
      scroller,
    } : previewOutline(scroller, scroller));
  }, [editorNodeId, view]);
  // A note just made from a note's menu (「在裡面新增」) opens with its
  // title selected, ready to be named (lib/cardTitleFocus).
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const phone = useIsMobile();
  // The phone's top bar swaps in the title once it scrolls under the bar.
  const hasNode = !!node;
  useEffect(() => {
    if (!phone || !hasNode) return;
    trackNoteTitle(titleInputRef.current);
    return () => trackNoteTitle(null);
  }, [phone, hasNode]);
  // Claimed only once the title field exists: a request that arrives before the
  // note's data is loaded must not be used up on a field that is not there yet.
  useEffect(() => {
    if (!editorNodeId || !hasNode) return;
    let stop = () => {};
    const focusTitle = () => { stop(); stop = focusTitleField(() => titleInputRef.current); };
    if (claimNoteTitleFocus(editorNodeId)) focusTitle();
    const off = onNoteTitleFocusRequest((id) => { if (id === editorNodeId && claimNoteTitleFocus(id)) focusTitle(); });
    return () => { off(); stop(); };
  }, [editorNodeId, hasNode]);
  // The title wraps onto more lines as it grows (never one clipped line).
  const shownTitle = isPlaceholderTitle(titleDraft) ? "" : titleDraft;
  useLayoutEffect(() => {
    const el = titleInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [shownTitle, hasNode, phone]);
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || isImeComposing(e)) return;
    e.preventDefault(); // a title is one paragraph: no line break, with or without Shift
    if (!e.shiftKey && view === "edit") editorRef.current?.focusAt(0);
  };
  // An upload or created page that finished after the user moved to another
  // note goes into the note it was started in, and says so.
  const editLeftNote = useCallback((nodeId: string, edit: (body: string) => string) => {
    const title = nodes.find((n) => n.id === nodeId)?.title || t("Untitled");
    void drafts.beginSession(nodeId).edit(edit).then((result) => {
      if (result === "applied") addToast(t("Added to “{title}”", { title }), "info");
      else if (result === "missing") addToast(t("Could not add it to “{title}”. Open that note and try again.", { title }), "error");
      // "refused": the note writer has already reported it.
    });
  }, [nodes]);
  const [zen, toggleZen] = useZenMode();
  const zenRef = useRef(zen);
  zenRef.current = zen;
  useEffect(() => onWritingModeRequest(() => { if (!zenRef.current) toggleZen(); }), [toggleZen]);
  const [wide, setWide] = usePersistedFlag(PREFS.noteWide, false);
  // 並排 is the workspace's side by side (lib/splitViewStore) with this note's text on the
  // right: the editor here, the rendered page there (SplitPane), for checking images,
  // tables and maths while writing.
  const splitRight = useSplit().right;
  const besideItself = !!node && splitRight?.kind === "note" && splitRight.id === node.id && splitRight.tab === CONTENT_TAB;

  // ── Specialised surfaces (attribute-driven branching) ────────────────────
  // The editor swaps based on attributes the node carries:
  //   pdf_url       → PdfNodeView
  //   ink_data      → InkNodeView (lib/ink handwriting engine); board_ink (the whiteboard's pen layer) is not read here
  //   (none)        → MarkdownEditor / preview
  //
  // Attribute fetch happens once per node change. Nothing else in the
  // codebase preloads attributes for the currently-selected node.
  //
  // The loaded surface records the note it belongs to, and is shown only while
  // that note is open. This editor is not remounted per note, so on the first
  // render after a switch the previous note's surface used to stay mounted
  // with the NEW note's save callbacks, and its unmount flush wrote the last
  // strokes into the new note. Now that render already unmounts it, with the
  // callbacks bound to its own note (persist* below).
  const [loaded, setLoaded] = useState<LoadedSurface | null>(null);
  const surface = loaded && loaded.nodeId === node?.id ? loaded : null;
  const surfaceNodeId = surface?.nodeId ?? null;
  const pdfUrl = surface?.pdfUrl ?? null;
  const pdfInkDoc = surface?.pdfInk ?? null;
  const inkActive = !!surface?.ink;
  const canPreview = previewAvailable({ pdfUrl, inkActive });
  const inkPages = surface?.ink?.pages ?? null;
  const inkReadOnly = !!surface?.inkReadOnly;
  const viewOnlyInkNotice = t("You can read this note but not change it, so this opens read-only.");
  const pageText = useMemo(
    () => (surface ? { nodeId: surface.nodeId, initial: surface.pageText } : undefined),
    [surface?.nodeId, surface?.pageText], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const pageImages = useMemo(
    () => (surface ? { nodeId: surface.nodeId, initial: surface.pageImages } : undefined),
    [surface?.nodeId, surface?.pageImages], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const updateSurface = useCallback((nodeId: string, change: Partial<LoadedSurface>) => {
    setLoaded((current) => current?.nodeId === nodeId ? { ...current, ...change } : current);
  }, []);

  const { rebase: rebaseInk, save: saveSurfaceInk } = useInkSurfaceSaver();
  // A version put back from History: the surface loads it again (hooks/useDrawingRestoreSerial).
  const drawingRestored = useDrawingRestoreSerial(node?.id);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null); // a note opened again reloads; never re-show an older copy
    if (!node?.id) return;
    const nodeId = node.id;
    (async () => {
      // lib/ink/store: the server, or the local mirror while this note's
      // attribute writes are still queued (a reconnect must not load an older
      // copy over strokes drawn offline) or when the network is unavailable.
      // pdf_annotations is read only for PDFs saved before their highlights
      // moved into the ink_data envelope (decodePdfInk folds it in).
      const values = await loadInkAttributes(nodeId, ["pdf_url", "pdf_annotations", "ink_data", "page_text", "page_images"] as const);
      try {
        if (cancelled) return;
        const next: LoadedSurface = { nodeId, pdfUrl: values.pdf_url, pdfInk: null, ink: null, inkReadOnly: false, pageText: values.page_text, pageImages: values.page_images };
        if (values.pdf_url) {
          next.pdfInk = readPdfInk(values.ink_data, values.pdf_annotations);
        } else if (values.ink_data != null) {
          // ink_data on a non-PDF note: a handwriting page (an unreadable value
          // opens an empty page). A PDF envelope never flips a note into
          // handwriting, where a save would overwrite it with a page.
          const ink = decodeInk(values.ink_data);
          if (ink.kind !== "pdf") next.ink = { pages: notePages(ink.kind === "page" ? ink.doc : null) };
        }
        const noteInk = next.ink ? noteDoc(next.ink.pages) : null;
        rebaseInk(nodeId, next.pdfInk ?? noteInk);
        next.inkReadOnly = isInkReadOnly(next.pdfInk ?? noteInk);
        if (next.inkReadOnly) notifyInkReadOnly();
        setLoaded(next);
      } catch {
        // network blip; specialised branches silently stay disabled
      }
    })();
    return () => { cancelled = true; };
  }, [node?.id, rebaseInk, drawingRestored]);

  // Saves from a surface go to the note that surface was loaded for — never to
  // node?.id, which may already be the next note when an unmount flush runs.
  // One PDF edit (a drawing, shape, highlight or clear) is one envelope save:
  // strokes and highlight records together, so undoing or refusing it can
  // never leave half of a drawing behind. Drawings arrive settled (the ink
  // engine debounces); highlights are single decisions — neither needs
  // another wait here.
  const persistPdfInk = useCallback((next: InkMultiPageDoc, options?: InkSaveOptions) => {
    if (!surfaceNodeId || inkReadOnly) return;
    updateSurface(surfaceNodeId, { pdfInk: next });
    saveSurfaceInk(surfaceNodeId, next, options);
  }, [surfaceNodeId, inkReadOnly, updateSurface, saveSurfaceInk]);

  // Handwriting saves ride the same spine-routed ATTRIBUTE_SET path
  // (⇒ event-log undo / inbox governance). The ink engine already debounces
  // and flushes on unmount, so every call is a settled document.
  // A note's one page is stored as its ink_data as it is: the page of the pages.
  const persistInkPages = useCallback((next: InkPages, options?: InkSaveOptions) => {
    const doc = noteDoc(next);
    if (!surfaceNodeId || inkReadOnly || !doc) return;
    saveSurfaceInk(surfaceNodeId, doc, options);
  }, [surfaceNodeId, inkReadOnly, saveSurfaceInk]);

  // Heptabase-style highlight → first-class node. Fires once per text
  // selection inside the PDF reader. The new node carries the quote as its
  // markdown; the edge type='highlight_source' from new → PDF is the only
  // source-tracking — no source_pdf_node_id attribute, the substrate is
  // the edge graph (see TYPED-EDGE header in schema.sql).
  const spawnHighlightNode = useCallback(async ({ text, page }: { text: string; page: number }): Promise<boolean> => {
    if (!node?.id) return false;
    const trimmed = text.trim().replace(/\s+/g, " ");
    const title = ellipsize(trimmed, 80);
    // One creation carries the card, its parent (the PDF, so the sidebar tree
    // groups highlights under it) and its page, under one Idempotency-Key: a
    // retry after a lost response cannot make a second card (GAP-225). The
    // highlight_source edge is a separate relation write; the writer reports it
    // if it fails, and the card is still found under its PDF.
    let cardId: string;
    try {
      cardId = (await noteWriter.create({
        id: randomUUID(),
        title,
        markdown: `> ${trimmed}\n\n— page ${page}`,
        parent_id: node.id,
        attributes: [{ key: "pdf_page", value: String(page), value_type: "number" }],
      })).node.id;
    } catch {
      // The writer reported it. The highlight itself stays on the PDF
      // (pdf_annotations); only the card failed.
      return false;
    }
    await relationWriter.connect(cardId, node.id, "highlight_source").catch(() => null);
    return true;
  }, [node?.id]);

  // ⌘S is not bound here: it is the "save-draft" entry in lib/shortcuts, run
  // by the one dispatcher (hooks/useKeyboardShortcuts). The editor does not
  // bind Mod-s, so the key reaches that window listener from inside it too.

  // Uploads an image, audio or video file to /api/media and returns the
  // markdown snippet to splice into the editor at the caret / drop position. Returns null on offline / failure;
  // the caller (MarkdownEditor) skips the insert and we surface the error via
  // setUploadError so the user sees what happened instead of a silent no-op.
  const uploadMediaFile = useCallback(async (file: File): Promise<string | null> => {
    if (!online) {
      setUploadError(t("Can't upload files while offline. Connect to the internet and try again."));
      setTimeout(() => setUploadError(null), 4000);
      return null;
    }
    setUploadCount((n) => n + 1);
    setUploadError(null);
    try {
      const url = await uploadMedia(file);
      const base = getApiBase();
      const src = url.startsWith("/") && base ? `${base}${url}` : url;
      const alt = file.name.replace(/\.[^.]+$/, "");
      return `\n![${alt}](${src})\n`;
    } catch (err) {
      setUploadError(writeErrors.message(err));
      setTimeout(() => setUploadError(null), 4000);
      return null;
    } finally {
      setUploadCount((n) => n - 1);
    }
  }, [online]);

  // Drag a PDF onto the editor → POST /api/media, create a node with the
  // pdf_url attribute set, refresh the sidebar, and jump to the new node.
  // The editor will detect pdf_url on its next render and swap MarkdownEditor
  // for the PdfNodeView. Replaces the curl-required onboarding for new PDFs.
  const uploadPdfAsNode = useCallback(async (file: File, parentId: string | null = null): Promise<{ id: string; title: string } | null> => {
    if (!online) {
      setUploadError(t("Can't upload PDFs while offline"));
      setTimeout(() => setUploadError(null), 4000);
      return null;
    }
    setUploadCount((n) => n + 1);
    setUploadError(null);
    try {
      // 1. media upload
      const url = await uploadMedia(file);

      // 2. node create — title from filename, no extension. Extract the PDF's
      // full text into the body so the paper is embedded (embeddings run on
      // title+markdown) and therefore retrievable by RAG Ask — without it the
      // node body is '' and the corpus is invisible to search. Best-effort:
      // extractPdfText returns '' on encrypted/scanned/corrupt PDFs so the
      // upload still succeeds (the file just won't be searchable).
      const title = file.name.replace(/\.pdf$/i, "");
      const markdown = await extractPdfText(file);
      // 3. the note WITH its pdf_url attribute (what makes OverviewEditor branch
      //    to PdfNodeView) — one request, so it never exists as a plain note.
      const newNode = (await noteWriter.create({ id: randomUUID(), title, markdown, parent_id: parentId, attributes: [{ key: "pdf_url", value: url }] })).node;

      return { id: newNode.id, title: newNode.title };
    } catch (err) {
      setUploadError(writeErrors.message(err));
      setTimeout(() => setUploadError(null), 4000);
      return null;
    } finally {
      setUploadCount((n) => n - 1);
    }
  }, [online]);

  const handleUnsupportedDrop = useCallback(async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const others = files.filter((f) => !pdfs.includes(f));

    let lastNewNodeId: string | null = null;
    for (const pdf of pdfs) {
      const created = await uploadPdfAsNode(pdf);
      if (created) lastNewNodeId = created.id;
    }

    if (others.length > 0) {
      const name = others[0]?.name ?? "";
      setUploadError(others.length > 1
        ? t("Only images, audio, video and PDFs can be dropped here: {name} and {n} more", { name, n: others.length - 1 })
        : t("Only images, audio, video and PDFs can be dropped here: {name}", { name }));
      setTimeout(() => setUploadError(null), 4000);
    }

    if (lastNewNodeId) {
      // The note writer already put the PDF note (with pdf_url) in the store;
      // jump to it and the editor swaps to PdfNodeView on the next render.
      onSelectNode(lastNewNodeId);
    }
  }, [uploadPdfAsNode, onSelectNode]);

  // Slash → PDF / handwriting page: a page under this note, linked
  // where `/` was typed. A handwriting page opens right after, once
  // the editor has inserted the link (switching notes saves the draft).
  const insertPage = useCallback(async (kind: InsertPageKind, file?: File): Promise<string | null> => {
    if (!node) return null;
    if (kind === "pdf") return file ? (await uploadPdfAsNode(file, node.id))?.title ?? null : null;
    const stamp = dateTimeId();
    const attribute = { key: "ink_data", value: JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } }) };
    const title = `${t("Handwriting page")} ${stamp}`;
    try {
      const created = (await noteWriter.create({ id: randomUUID(), title, markdown: "", parent_id: node.id, attributes: [attribute] })).node;
      setTimeout(() => onSelectNode(created.id), 0);
      return created.title;
    } catch {
      return null; // the note writer reported it
    }
  }, [node, uploadPdfAsNode, onSelectNode]);

  const breadcrumb = node ? noteAncestors(node, nodes) : [];

  // ⋯ › 顯示… (wide screens): the ways to show this note. The note's PDF and
  // handwriting surfaces fill the page already, so they have no width or split.
  const showsText = !pdfUrl && !inkActive;
  const mode = noteMode(view, besideItself);
  const setMode = (next: NoteMode) => {
    if (next === "split" && node) requestSplitOpen({ kind: "note", id: node.id, tab: CONTENT_TAB }, "right");
    else if (besideItself) requestSplitClose();
    setView(next === "preview" ? "preview" : "edit");
  };
  const displayRows: NoteDisplayRow[] = node ? [
    ...(showsText ? [{ id: "wide", label: "Full width", pressed: wide, run: () => setWide((value) => !value) }] : []),
    ...(zen ? [] : [{ id: "zen", label: "Writing mode", run: toggleZen }]),
  ] : [];

  return (
    <section ref={mainRef} className="obsidian-main note-document" data-wide={wide}
      data-media={!!pdfUrl || inkActive} data-scroll-memory={view === "preview" ? "note-preview" : "note-edit"}>
      {node ? (
        <>
          <div className="note-topbar">
            {/* On a phone the path lives in the top bar (PhoneNoteLocation). */}
            {!phone && <NoteBreadcrumb node={node} ancestors={breadcrumb} nodes={nodes} canEdit={canEdit}
              onOpenNote={onSelectNode} onAssignGroup={onAssignGroup} />}
            <div className={phone ? `${layerClass.narrow} obsidian-actions` : "obsidian-actions"}>
              {zen && <Pressable className="editor-zen-toggle active tap-target" onClick={toggleZen} title={t("Exit writing mode (Esc)")}
                aria-label={t("Exit writing mode (Esc)")} aria-pressed={true}>
                <Minimize2 size={14} /><span>{t("Exit writing mode")}</span>
              </Pressable>}
              {/* 編輯｜並排｜預覽 and the ⋯ sit at the right of the page's title strip (docs/agents/decisions-ui.md);
                  where there is none, here. A phone flips edit ⇄ preview in ⋯. */}
              <ViewStripEnd slot="more">
                {!phone && !zen && canPreview && (
                  <Segmented className="note-mode-switch" label={t("Display")} value={mode} onChange={setMode}
                    options={NOTE_MODES.map(({ mode: each, label }) => ({ value: each, label: t(label), Icon: MODE_ICONS[each] }))} />
                )}
                {typeof noteActions === "function" ? noteActions({ previewAvailable: canPreview, displayRows }) : noteActions}
              </ViewStripEnd>
              {/* Autosave is silent. Only a problem is shown (see useSaveNotice), so
                  the row does not change width while typing. aria-live: screen
                  readers hear problems, not every save. */}
              <span className="obsidian-save-notice" aria-live="polite">
                {saveNotice === "rejected" ? (
                  <Pressable className="obsidian-save-button rejected tap-target" onClick={onSave}>{t("Retry saving")}</Pressable>
                ) : saveNotice === "queued" ? (
                  <span className="obsidian-save-state">{t("Waiting to sync")}</span>
                ) : saveNotice === "slow" ? (
                  <span className="obsidian-save-state">{t("Saving…")}</span>
                ) : null}
              </span>
            </div>
          </div>

          <div className="note-heading">
            <TextArea
              ref={titleInputRef}
              className="obsidian-title-input"
              rows={1}
              value={shownTitle}
              readOnly={!canEdit}
              onChange={(e) => onTitleChange(e.target.value.replace(/[\r\n]+/g, " "))}
              onKeyDown={onTitleKeyDown}
              placeholder={t("Untitled")}
              aria-label={t("Note title")}
            />
            {/* One grey line: space, edited, tags and ＋. A #word in the body is
                not a tag (T10) and is not listed there. Word count and reading
                time are in the info panel. */}
            <NoteMetaLine node={node} tags={extractTags ?? []} canEdit={canEdit} online={online}
              onOpenTag={(id) => onSelectNode(id)} onMoved={() => void onRefresh?.()} onOpenHistory={onOpenHistory} aiEdits={aiEdits} />
          </div>

          <NoteDecisions nodeId={node.id} onOpenNode={onSelectNode} />
          {showsText && <Suspense fallback={null}><NoteEdgeOutline nodeId={node.id} markdown={draft} /></Suspense>}

          {/* doc 09 #4 — the applied class-tag schema fields pinned as compact
              editable cells ON the node (not just the inspector). Renders
              nothing when the node carries no schema-bearing class tag. */}
          <FeaturedFields classTags={attrClassTags ?? []} attrs={node.attrs ?? {}} onAttrSet={canEdit ? onAttrSet : undefined} />

          {/* The note's own plain properties (the tag sidebar's "Other properties")
              pulled up as a thin read-only metadata strip — important facts
              read in-place, not buried in the right panel. Full editing stays
              in the Inspector. */}
          <InlineProps classTags={attrClassTags ?? []} attrs={node.attrs ?? {}} />

          {aiOn && <AiSuggestionBar
            layout={aiSuggestions.layout} markdown={draft} canDecide={aiSuggestions.view?.can_decide ?? false} online={online} busy={aiSuggestions.busy}
            onDecideAll={(decision) => void aiSuggestions.decideAll(decision)}
            onDecideRow={(row, decision) => void aiSuggestions.decide(row.suggestionId, [row.itemId], decision)}
            decide={aiSuggestions.decide}
            onStep={stepSuggestion}
          />}

          <div className="obsidian-tiptap-wrap">
            {uploadError && <div className="editor-upload-error">{uploadError}</div>}
            {uploadCount > 0 && <div className="editor-upload-progress">{uploadCount > 1 ? t("Uploading {count} files…", { count: uploadCount }) : t("Uploading file…")}</div>}

            {pdfUrl ? (
              // PDF mode — markdown editor + preview hidden in favour of the
              // annotation surface. The node's markdown still lives in `draft`
              // and is preserved; switching the node back to markdown only
              // needs the pdf_url attribute to be cleared.
              <div className="obsidian-tiptap-wrap obsidian-tiptap-wrap--media">
                <Suspense fallback={<div className="obsidian-preview obsidian-preview--md" />}>
                  <PdfNodeView
                    key={surfaceNodeId ?? "empty"}
                    nodeId={surfaceNodeId ?? undefined}
                    pdfUrl={pdfUrl.startsWith("/") ? `${getApiBase()}${pdfUrl}` : pdfUrl}
                    initialDoc={pdfInkDoc}
                    onChange={persistPdfInk}
                    readOnly={inkReadOnly || !canEdit}
                    readOnlyNotice={inkReadOnly ? undefined : viewOnlyInkNotice}
                    onTextHighlightCreated={spawnHighlightNode}
                    pageText={pageText}
                  />
                </Suspense>
              </div>
            ) : inkActive ? (
              // Handwriting mode — lib/ink engine. Same swap pattern as PDF:
              // parent owns persistence, the view is the surface.
              <div className="obsidian-tiptap-wrap obsidian-tiptap-wrap--media">
                <Suspense fallback={<div className="obsidian-preview obsidian-preview--md" />}>
                  <InkNodeView
                    key={surfaceNodeId ?? "empty"}
                    initialPages={inkPages}
                    onPagesChange={persistInkPages}
                    readOnly={inkReadOnly || !canEdit}
                    readOnlyNotice={inkReadOnly ? undefined : viewOnlyInkNotice}
                    pageText={pageText}
                    nodeId={surfaceNodeId ?? undefined}
                    pageImages={pageImages}
                    quoteAs={node ? { title: node.title, nodes } : undefined}
                  />
                </Suspense>
              </div>
            ) : view === "edit" ? (
              <>
              <MarkdownEditor
                readOnly={!canEdit}
                onOpenNoteHistory={onOpenVersion}
                blockFunctions={paragraphFunctions}
                taskTagName={taskTagName}
                ref={editorRef}
                value={draft}
                onChange={onDraftChange}
                nodes={nodes}
                nodeKey={node?.id}
                noteTitle={node?.title}
                editLeftNote={editLeftNote}
                onMediaInsert={uploadMediaFile}
                onInsertPage={canEdit ? insertPage : undefined}
                moduleInserts={moduleInserts}
                onUnsupportedDrop={handleUnsupportedDrop}
                placeholder={t("Start writing… (/ for commands, [[ to link notes)")}
                extractTags={extractTags}
                onExtract={onExtract}
                attrClassTags={attrClassTags}
                onAttrSet={onAttrSet}
                onCreateTask={onCreateTask}
                onOpenWikilink={onOpenWikilink}
                blockCitations={blockCitations}
                onOpenBlockCitations={openCitations}
                canEditEmbedSource={(source) => capabilities.canEdit({ node_type: "content", space_id: source.space_id ?? null })}
                workspaceTags={hashtagTags}
                onImportModuleTag={canEdit ? importModuleTag : undefined}
                zen={zen}
                mentions={aiOn && (canEdit || agentMentions.cards.length > 0) ? mentionsHost : undefined}
                suggestions={aiOn ? suggestionsHost : undefined}
                handToAi={aiOn ? handToAi : undefined}
              />
              {importer.element}
              </>
            ) : (
              <div className="obsidian-tiptap-wrap">
                <Suspense fallback={<div className="obsidian-preview obsidian-preview--md" />}>
                  <OverviewPreview draft={draft} nodes={nodes} from={node} onOpenWikilink={onOpenWikilink} onToggleTask={canEdit ? toggleTaskInPreview : undefined} citations={blockCitations} onOpenCitations={openCitations}
                    onRequestEdit={canEdit && canPreview ? editFromPreview : undefined} />
                </Suspense>
              </div>
            )}
          </div>

          {citeMenu && (
            <Suspense fallback={null}>
              <BlockCitationsMenu rows={blockCitations.filter((row) => row.block_ref === citeMenu.blockId)} anchor={citeMenu.anchor}
                onClose={() => setCiteMenu(null)}
                onPick={(row) => { setPendingFind(row.source_id, `#^${citeMenu.blockId}`); onOpenWikilink(row.source_title, row.source_id); }} />
            </Suspense>
          )}
          {relations}
        </>
      ) : (
        <div className="obsidian-empty">
          <EmptyState
            size="page"
            variant="empty"
            title={nodes.length > 0 ? t("No note is open") : t("No notes yet")}
            description={nodes.length > 0 ? t("Pick one from the list, or start a new one.") : t("This space is yours — create your first note.")}
            ctaLabel={t("New note")}
            onCta={onCreateFirst}
          />
        </div>
      )}

    </section>
  );
}
