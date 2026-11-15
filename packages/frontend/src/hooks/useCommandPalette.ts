import { isSystemNode } from "../lib/systemNodes";
import { setPendingFind } from "../lib/findInNote";
import { FOLD_ALL_HEADINGS_EVENT, UNFOLD_ALL_HEADINGS_EVENT } from "../lib/foldInNote";
import { requestWritingMode } from "../lib/writingModeRequest";
import { isNoteSwitchTag, isTagShown, isShownNote } from "../lib/nodeTags";
import { addToast, selectTagsById, useAppSelector, type OverviewPane, useOnline, useTagRows } from "../lib/appStore";
import { drafts, NOTE_ACTION_PALETTE_LABELS, noteActionsFor, noteMarkActions, reads, writeErrors, type NoteSearchOutcome, type NoteSearchRow } from "../lib/data";
import type { Capabilities } from "../lib/capabilities";
import { useEffect, useMemo, useRef, useState } from "react";
import { OPEN_NOTE_HISTORY_EVENT, type PaletteState } from "./usePaletteState";
import { loadFuse, loadedFuse } from "../lib/lazyFuse";
import { t, useT, getLocale } from "../lib/i18n";
import { getFrecency, rankByFrecency } from "../lib/frecency";
import { PREFS, getPrefJson, setPrefJson } from "../lib/prefs";
import type { CanvasMeta, ContentNode } from "../lib/api";
import type { PaletteItem, PaletteAction } from "../lib/paletteItem";
import { NOTE_TEMPLATES } from "../lib/noteTemplates";
import type { AppMode, NotesView } from "./useUiMode";
import { requestFocus } from "../lib/focus";
import { NOTE_COMMANDS, importedModules, noteCommandsOf, openQuickAddTask, openQuickCapture, slashInsertsOf, type ModuleTarget, type NoteCommand } from "../modules";
import { useCanvasImported, useDailyNotesEnabled, useModuleFilter, useTasksEnabled } from "../hooks/useModuleFilter";
import { containsTitle, rankByTitle } from "../lib/noteSearch";
import { createKindsFor } from "../lib/createKinds";
import { byUpdatedDesc } from "../lib/noteOrder";
import { isTag } from "@onden/markdown/contract";

// Action-recency (lastRun) store — a small localStorage list of the most
// recently RUN action ids, newest-first, capped. Node-open recency already
// lives in lib/frecency (recordOpen); this is the action-only twin so the
// empty-query default list can float "recently-run actions" alongside
// "recently-opened notes". Local-only habit signal; degrades to empty.
const LAST_RUN_CAP = 8;

function getLastRunActions(): string[] {
  const ids = getPrefJson(PREFS.paletteLastRun);
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

function recordLastRunAction(id: string): void {
  if (!id) return;
  setPrefJson(PREFS.paletteLastRun, [id, ...getLastRunActions().filter((x) => x !== id)].slice(0, LAST_RUN_CAP));
}

export interface UseCommandPaletteOptions {
  setMode: (mode: AppMode) => void;
  /** 「前往標籤」: open and focus the sidebar's tag list. */
  showTags: () => void;
  setNotesView: (view: NotesView) => void;
  setSelectedId: (id: string | null) => void;
  setCreateOpen: (open: boolean) => void;
  setOverviewPane: (pane: OverviewPane) => void;
  refresh: () => Promise<void>;
  nodes: ContentNode[];
  canvases: CanvasMeta[];
  activeCanvasId: string | null;
  selectedNode: ContentNode | null;
  selectCanvas: (id: string) => void;
  /** What this person may do (lib/capabilities useCapabilities): the note
   *  commands are those noteActionList offers on the selected note. */
  capabilities: Capabilities;
  /** Whether the focused node earns a Canvas lens (has a canvas membership or
   *  children) — gates the "Switch to Canvas" action so it matches the strip. */
  canvasAvailable?: boolean;
  /** The one create entry (useNodeCreation): kind "ink" is handwriting, "template" stamps `templateId`. */
  create?: (kind: string, options?: { templateId?: string }) => Promise<unknown> | void;
  /** Open today's daily note (creates it if needed). */
  openDailyNote?: () => Promise<void | boolean> | void | boolean;
  /** Download workspace as a zip of markdown files. */
  exportMarkdown?: () => void;
  /** Re-layout the active canvas with generous spacing (Heptabase-style
   *  Tidy Up). No-op when no canvas is open. */
  tidyActiveCanvas?: () => Promise<void> | void;
  /** ⑩ export the focused note as a self-contained themed HTML file. */
  exportNoteHtml?: PaletteAction;
  /** Copy the focused note's markdown source to the clipboard. */
  copyNoteMarkdown?: PaletteAction;
  /** Auto-arrange the active canvas as a horizontal tree rooted at the
   *  selected card (Heptabase / Miro mindmap layout). One-shot —
   *  subsequent drags stay where the user puts them. */
  autoArrangeCanvasAsTree?: () => Promise<void> | void;
  /** Open a module screen (modules/index); each module's openCommand and
   *  note commands become palette actions. */
  openModule?: (id: string, target?: ModuleTarget) => void;
  /** Run a module note command on the selected note. */
  runNoteCommand?: (command: NoteCommand) => void;
  /** Open an imported module's add dialog (SKILL.md). */
  openDialogEntry?: (moduleId: string) => void;
  /** Open the colour choice for one note (components/NoteColorDialog; hooks may not import components). */
  openNoteColor?: (nodeId: string) => void;
  /** Note templates: stamp a scaffold (daily/meeting/reading/character) into a
   *  fresh node pre-filled with title pattern, body and default tags. */
  /** Create-on-miss: create a note titled with the live palette query and open
   *  it (search + capture in one gesture). Routes through the app's offline-safe
   *  create rail — NOT a raw fetch. Optional: when absent the create-on-miss row
   *  falls back to opening the create dialog (setCreateOpen). */
  createNamedNote?: (title: string) => Promise<boolean> | boolean;
  /** The three side-pane switches (hooks/useWorkspacePanes) and Settings: the top bar's controls, also here. */
  toggleSidebar?: () => void;
  toggleInspector?: () => void;
  toggleFocusMode?: () => void;
  openSettings?: () => void;
}

type SearchRow = NoteSearchRow;
const NO_RESULTS: SearchRow[] = [];

export function useCommandPalette({
  setMode, showTags, setNotesView, setSelectedId, setCreateOpen, setOverviewPane: _setOverviewPane,
  refresh, nodes, canvases, activeCanvasId, selectedNode, selectCanvas: _selectCanvas, capabilities,
  canvasAvailable = false,
  create,
  openDailyNote,
  exportMarkdown,
  tidyActiveCanvas,
  exportNoteHtml,
  copyNoteMarkdown,
  autoArrangeCanvasAsTree,
  openModule,
  runNoteCommand,
  openDialogEntry,
  openNoteColor,
  createNamedNote,
  toggleSidebar, toggleInspector, toggleFocusMode, openSettings,
}: UseCommandPaletteOptions, { paletteOpen, setPaletteOpen, paletteQuery, setPaletteQuery, paletteIndex, setPaletteIndex }: PaletteState) {
  const tagIndex = useAppSelector(selectTagsById);
  const online = useOnline();
  const tags = useTagRows();
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const running = useRef(false);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  // One identity per opening/query/retry. The response cannot become current
  // again after A → B → A, nor during the render before effect cleanup.
  const searchRequest = useMemo(() => {
    const raw = paletteQuery.trim();
    const query = raw.startsWith("?") ? raw.slice(1).trimStart() : raw;
    return { query, attempt: searchAttempt, enabled: paletteOpen && !raw.startsWith(">") && !raw.startsWith("#") && query.length >= 2 };
  }, [paletteQuery, paletteOpen, searchAttempt]);
  const [searchState, setSearchState] = useState<{ request: typeof searchRequest; rows: SearchRow[]; failed: boolean; outcome: NoteSearchOutcome | null } | null>(null);
  const currentSearch = searchState?.request === searchRequest ? searchState : null;
  const searchResults = currentSearch?.rows ?? NO_RESULTS;
  const searchOutcome = currentSearch?.outcome ?? null;
  const searchLoading = searchRequest.enabled && !currentSearch;
  const searchError = searchRequest.enabled && !!currentSearch?.failed;
  const retrySearch = () => { setPaletteIndex(0); setSearchAttempt(attempt => attempt + 1); };

  // The items array is frozen on first render (useMemo []), so run handlers
  // MUST NOT close over the caller's callbacks directly — those first-render
  // closures see boot state (no node, offline) and every action silently
  // no-ops against it (the palette-vs-toolbar "it only works from the
  // toolbar" class of bug). All callbacks route through this per-render ref.
  const cbRef = useRef({ setMode, showTags, setNotesView, setCreateOpen, create, openDailyNote, exportMarkdown, tidyActiveCanvas, exportNoteHtml, copyNoteMarkdown, autoArrangeCanvasAsTree, refresh, openModule, runNoteCommand, openDialogEntry, openNoteColor, createNamedNote, setSelectedId, selectedNode, activeCanvasId, toggleSidebar, toggleInspector, toggleFocusMode, openSettings });
  cbRef.current = { setMode, showTags, setNotesView, setCreateOpen, create, openDailyNote, exportMarkdown, tidyActiveCanvas, exportNoteHtml, copyNoteMarkdown, autoArrangeCanvasAsTree, refresh, openModule, runNoteCommand, openDialogEntry, openNoteColor, createNamedNote, setSelectedId, selectedNode, activeCanvasId, toggleSidebar, toggleInspector, toggleFocusMode, openSettings };

  // i18n: subscribe to the locale so the action labels re-translate on a
  // language switch; `locale` is the memo dep that triggers the recompute.
  // (The frozen-array concern was about run handlers closing over boot state —
  // cbRef solves that, so recomputing the array on a locale change is safe.)
  useT();
  const locale = getLocale();
  const isImported = useModuleFilter();
  const canvasImported = useCanvasImported();
  const dailyOn = useDailyNotesEnabled();
  const tasksOn = useTasksEnabled();

  // when()-helpers for context-availability. They read cbRef.current so the
  // closures captured in the memo'd array always see the live selection — the
  // memo only recomputes on locale/canvasAvailable, but the gates must reflect
  // the current focused node / open canvas at render time.
  const hasNode = () => !!cbRef.current.selectedNode;
  const hasCanvas = () => !!cbRef.current.activeCanvasId;
  const NEED_NOTE = "Select a note first";
  const NEED_CANVAS = "Open a canvas first";
  // The rows that are a note's actions, by palette id → note action id (or the
  // module command's own id). Which of them the selected note offers comes from
  // lib/data noteActionList (D112) — the header ⋯ menu's list: a module command
  // its `available`, and a viewer gets none that write. With no note selected they stay listed,
  // greyed ("Select a note first").
  const NOTE_ROWS: Record<string, string> = {
    "a-pin-note": "toggle-pin", "a-set-color": "set-color",
    ...Object.fromEntries(NOTE_COMMANDS.map(({ command }) => [command.id, command.id])),
  };

  const paletteStaticActions = useMemo<PaletteItem[]>(() => [
    // Lenses on the current node (keep the focused node, change the view) and
    // PLACES (doc 01: node = home, lenses vs places). These carry NO kbd badge:
    // they have no SHORTCUTS entry, so the palette no longer advertises the
    // fictional ⌘1–⌘5 chords that the dispatcher never bound.
    { kind: "action", id: "a-editor",    label: t("Switch to Content"),         hint: "lens",   group: "Navigate", keywords: ["edit", "write", "document", "editor", "內容", "編輯", "寫作", "編輯器"], run: () => { cbRef.current.setMode("notes"); cbRef.current.setNotesView("editor"); } },
    // Canvas is a per-node lens like Editor/History, gated to nodes that earn it
    // (a board or children) so the palette matches the lens strip.
    ...(canvasAvailable
      ? [{ kind: "action" as const, id: "a-canvas", label: t("Switch to Canvas"), hint: "lens", group: "Navigate", keywords: ["board", "whiteboard", "map", "白板", "畫布"], run: () => { cbRef.current.setMode("notes"); cbRef.current.setNotesView("canvas"); } }]
      : []),
    { kind: "action", id: "a-timeline",  label: t("Workspace changes"),         hint: "place",  group: "Navigate", keywords: ["activity", "feed", "history", "timeline", "log", "versions", "restore", "trash", "歷史", "版本", "復原", "變更", "活動", "垃圾桶", "時間軸", "整個工作區的變更"], run: () => cbRef.current.setMode("timeline") },
    // The note's own history: its dialog lives in the editor host.
    { kind: "action", id: "a-note-history", label: t("History of this note"), hint: "editor", group: "Actions", keywords: ["history", "versions", "restore", "changes", "log", "歷史", "版本", "復原", "變更", "這篇筆記的歷史", "這則筆記的歷史"], when: hasNode, disabledReason: NEED_NOTE, run: () => { window.dispatchEvent(new CustomEvent(OPEN_NOTE_HISTORY_EVENT)); } },
    // Headings' sections of the open note (the editor listens; lib/foldInNote).
    { kind: "action", id: "a-fold-all", label: t("Collapse all headings"), hint: "editor", group: "Actions", keywords: ["fold", "collapse", "headings", "outline", "收起", "摺疊", "折疊", "標題", "全部收起"], when: hasNode, disabledReason: NEED_NOTE, run: () => { window.dispatchEvent(new CustomEvent(FOLD_ALL_HEADINGS_EVENT)); } },
    { kind: "action", id: "a-unfold-all", label: t("Expand all headings"), hint: "editor", group: "Actions", keywords: ["unfold", "expand", "headings", "outline", "展開", "摺疊", "折疊", "標題", "全部展開"], when: hasNode, disabledReason: NEED_NOTE, run: () => { window.dispatchEvent(new CustomEvent(UNFOLD_ALL_HEADINGS_EVENT)); } },
    // Same visible capture form as the topbar and the registered shortcut.
    { kind: "action", id: "a-new",       label: t("Quick capture"),                  hint: "action", group: "Actions",  shortcutId: "quick-capture", keywords: ["add", "create", "page", "new note", "quick capture", "捕捉", "快速捕捉", "新增", "新筆記", "建立"], run: openQuickCapture },
    ...(tasksOn ? [{ kind: "action" as const, id: "a-add-task", label: t("Add task"), hint: "action", group: "Actions", keywords: ["task", "todo", "to-do", "quick add", "任務", "待辦", "新增", "新增任務", "待辦事項"], run: () => openQuickAddTask() }] : []),
    // Nothing in particular to focus on; a task's own row, sheet and day block begin one on it.
    ...(tasksOn ? [{ kind: "action" as const, id: "a-start-focus", label: t("Start focus"), hint: "action", group: "Actions", keywords: ["focus", "pomodoro", "timer", "專注", "番茄鐘", "計時"], run: () => requestFocus(null) }] : []),
    // Note templates — one palette action per seeded template ("New from
    // template" surface). Each stamps the scaffold via createFromTemplate.
    // The day template ("Daily note") only while daily notes are on.
    ...NOTE_TEMPLATES.filter((tpl) => !tpl.day || dailyOn).map((tpl): PaletteItem => ({
      kind: "action" as const,
      id: `a-template-${tpl.id}`,
      label: t("New from template: {name}", { name: t(tpl.label) }),
      hint: "template",
      group: "Templates",
      run: async () => { await cbRef.current.create?.("template", { templateId: tpl.id }); },
    })),
    { kind: "action", id: "a-new-ink",   label: t("New handwritten note"),      hint: "action", group: "Actions",  keywords: ["pen", "ink", "write", "stylus", "手寫", "筆", "畫", "新增"], run: async () => { await cbRef.current.create?.("ink"); } },
    // shortcutId "daily-note" → real ⌘⇧D chord (was mislabeled ⌘D before).
    // Today's note: only while daily notes (日記) are on.
    ...(dailyOn ? [{ kind: "action" as const, id: "a-daily",     label: t("Open today's note"),        hint: "action", group: "Actions",  shortcutId: "daily-note", keywords: ["today", "journal", "diary", "log", "今日", "今天", "日記", "每日"], run: () => cbRef.current.openDailyNote?.() }] : []),
    { kind: "action", id: "a-export-all-zip", label: t("Download all notes (.zip)"), hint: "action", group: "Actions", keywords: ["export", "backup", "download", "archive", "markdown", "save", "zip", "匯出", "備份", "下載", "封存", "儲存", "全部"], run: () => cbRef.current.exportMarkdown?.() },
    // Board actions, with the whiteboard imported (module library).
    ...(canvasImported ? [
      { kind: "action" as const, id: "a-new-canvas", label: t("New canvas"), hint: "action", group: "Actions", keywords: ["board", "whiteboard", "create", "白板", "新增", "建立"], run: async () => { await cbRef.current.create?.("canvas"); } },
      { kind: "action" as const, id: "a-tidy-canvas", label: t("Tidy up canvas (grid)"), hint: "canvas", group: "Actions", keywords: ["arrange", "align", "clean", "layout", "整理", "排列", "對齊", "網格", "白板"], when: hasCanvas, disabledReason: NEED_CANVAS, run: () => cbRef.current.tidyActiveCanvas?.() },
      { kind: "action" as const, id: "a-arrange-tree", label: t("Auto-arrange canvas as tree"), hint: "canvas", group: "Actions", keywords: ["layout", "mindmap", "organize", "arrange", "排版", "心智圖", "樹狀", "整理", "白板"], when: hasCanvas, disabledReason: NEED_CANVAS, run: () => cbRef.current.autoArrangeCanvasAsTree?.() },
    ] : []),
    // Left the note's ⋯ menu (lib/data NOTE_HEADER_ACTIONS); still here and in the sidebar's context menu.
    { kind: "action", id: "a-pin-note", label: t(NOTE_ACTION_PALETTE_LABELS["toggle-pin"]), hint: "editor", group: "Actions", keywords: ["pin", "unpin", "star", "favorite", "釘選", "取消釘選", "置頂"], when: hasNode, disabledReason: NEED_NOTE, run: () => { const node = cbRef.current.selectedNode; if (node) noteMarkActions.togglePin(node); } },
    { kind: "action", id: "a-set-color", label: t(NOTE_ACTION_PALETTE_LABELS["set-color"]), hint: "editor", group: "Actions", keywords: ["color", "colour", "paint", "顏色", "設定顏色", "標色"], when: hasNode, disabledReason: NEED_NOTE, run: () => { const node = cbRef.current.selectedNode; if (node) cbRef.current.openNoteColor?.(node.id); } },
    { kind: "action", id: "a-writing-mode", label: t("Writing mode"), hint: "editor", group: "Actions", keywords: ["zen", "focus", "distraction", "fullscreen", "寫作", "專注", "全螢幕"], when: hasNode, disabledReason: NEED_NOTE, run: requestWritingMode },
    // Module actions on the selected note (extract cards, review this deck…).
    ...noteCommandsOf(isImported).map(({ command }): PaletteItem => ({
      kind: "action", id: command.id, label: t(command.label), hint: "editor", group: "Actions", keywords: command.keywords,
      when: hasNode, disabledReason: NEED_NOTE, run: () => cbRef.current.runNoteCommand?.(command),
    })),
    // Text a module writes at the caret (none ships now): the editor's `/` menu has it too.
    ...slashInsertsOf(isImported).map(({ insert }): PaletteItem => ({
      kind: "action", id: insert.id, label: t(insert.title), hint: "editor", group: "Actions", keywords: [insert.title],
      when: hasNode, disabledReason: NEED_NOTE, run: () => { const node = cbRef.current.selectedNode; if (node) insert.run({ node }); },
    })),
    // What a module adds through a dialog in the "+" menu (a new skill).
    ...createKindsFor(isImported).filter((kind) => kind.id.startsWith("module:") && kind.placeable).map((kind): PaletteItem => ({
      kind: "action", id: `a-${kind.id}`, label: t(kind.label), hint: "action", group: "Actions", keywords: [kind.label],
      run: async () => { await cbRef.current.create?.(kind.id); },
    })),
    { kind: "action", id: "a-export-html",   label: t("Export this note as HTML"),  hint: "editor", group: "Actions", keywords: ["download", "share", "web", "page", "html", "匯出", "分享", "下載", "網頁"], when: () => hasNode() && !!cbRef.current.exportNoteHtml, disabledReason: NEED_NOTE, run: () => cbRef.current.exportNoteHtml?.() },
    { kind: "action", id: "a-copy-md",   label: t("Copy this note as Markdown"),  hint: "editor", group: "Actions", keywords: ["clipboard", "source", "text", "md", "markdown", "複製", "剪貼簿", "原始碼"], when: () => hasNode() && !!cbRef.current.copyNoteMarkdown, disabledReason: NEED_NOTE, run: () => cbRef.current.copyNoteMarkdown?.() },
    // The top bar's switches for the notes list and the info pane, and focus mode (both at once).
    { kind: "action", id: "a-toggle-sidebar",   label: t("Toggle notes list"),      hint: "view", group: "Actions", shortcutId: "toggle-sidebar",   keywords: ["sidebar", "list", "left", "hide", "show", "側欄", "清單", "筆記列表", "收起", "顯示"], run: () => cbRef.current.toggleSidebar?.() },
    { kind: "action", id: "a-toggle-inspector", label: t("Toggle inspector"),       hint: "view", group: "Actions", shortcutId: "toggle-inspector", keywords: ["info", "inspector", "right", "hide", "show", "資訊", "檢視窗", "右側", "收起", "顯示"], run: () => cbRef.current.toggleInspector?.() },
    { kind: "action", id: "a-toggle-focus",     label: t("Toggle focus mode"),      hint: "view", group: "Actions", shortcutId: "focus-mode",       keywords: ["focus", "zen", "both", "sidebars", "專注", "兩側", "全部收起"], run: () => cbRef.current.toggleFocusMode?.() },
    { kind: "action", id: "a-settings",         label: t("Settings"),               hint: "action", group: "Actions", keywords: ["preferences", "options", "account", "設定", "偏好", "選項"], run: () => cbRef.current.openSettings?.() },
    { kind: "action", id: "a-shortcuts-help", label: t("Keyboard shortcuts"), hint: "action", group: "Actions", shortcutId: "shortcuts-help", keywords: ["shortcut", "hotkey", "keys", "help", "快捷鍵", "快速鍵", "說明"], run: () => { window.dispatchEvent(new CustomEvent("onden-open-shortcuts-help")); } },
    { kind: "action", id: "a-refresh",   label: t("Refresh data"),             hint: "action", group: "Actions",  keywords: ["reload", "sync", "update", "refresh", "重新整理", "同步", "更新", "重新載入"], run: () => cbRef.current.refresh() },
    // Open a module's screen (Review due cards, RSS reader…).
    ...importedModules(isImported).flatMap(({ id, openCommand }): PaletteItem[] => openCommand ? [{
      kind: "action", id: openCommand.id, label: t(openCommand.label), hint: openCommand.hint ?? "action", group: openCommand.group ?? "Actions", keywords: openCommand.keywords,
      run: () => cbRef.current.openModule?.(id),
    }] : []),
    // A module's add dialog (Import SKILL.md…).
    ...importedModules(isImported).flatMap(({ id, dialogEntry }): PaletteItem[] => dialogEntry ? [{
      kind: "action", id: `a-dialog-${id}`, label: t(dialogEntry.label), hint: "action", group: "Actions", keywords: dialogEntry.keywords,
      run: () => cbRef.current.openDialogEntry?.(id),
    }] : []),
    ...(tasksOn || dailyOn ? [{ kind: "action" as const, id: "a-today",     label: t("Go to Today"),              hint: "place",  group: "Navigate", keywords: ["today", "day", "journal", "plan", "今天", "日記", "規劃", "時間軸"], run: () => cbRef.current.setMode("today") }] : []),
    ...(tasksOn ? [{ kind: "action" as const, id: "a-tasks",     label: t("Go to Tasks"),              hint: "place",  group: "Navigate", keywords: ["tasks", "todo", "todos", "checklist", "任務", "待辦", "清單"], run: () => cbRef.current.setMode("tasks") }] : []),
    { kind: "action", id: "a-graph",     label: t("Go to Graph"),              hint: "place",  group: "Navigate", keywords: ["graph", "network", "links", "map", "關係圖", "連結", "圖譜", "網路"], run: () => cbRef.current.setMode("graph") },
    { kind: "action", id: "a-tags",      label: t("Go to Tags"),               hint: "place",  group: "Navigate", keywords: ["tags", "modules", "library", "import", "標籤", "功能", "模組", "匯入", "分類"], run: () => cbRef.current.showTags() },
  ], [locale, canvasAvailable, canvasImported, dailyOn, tasksOn, isImported]); // eslint-disable-line react-hooks/exhaustive-deps -- labels via t(): recompute on locale switch; run()/when() read cbRef.current

  const paletteCanvasActions = useMemo<PaletteItem[]>(
    () => !canvasImported ? [] : canvases.map((c) => ({
      kind: "canvas" as const,
      id: `cv-${c.id}`,
      label: c.title,
      hint: activeCanvasId === c.id ? "current" : "canvas",
      group: "Canvases",
      // Canvas-in-Editor polymorphism: focusing a canvas NODE opens its board
      // in the editor (the editor is polymorphic by node content). This is
      // distinct from the per-node Canvas lens ("Switch to Canvas" above),
      // which lays out a *non-canvas* node's children on a board.
      run: () => { setMode("notes"); setNotesView("editor"); setSelectedId(c.id); },
    })),
    [canvases, activeCanvasId, canvasImported], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Build the create-on-miss row for a given (already-trimmed) query. Surfaces
  // only when there's a real query AND no exact title match — "search + capture
  // in one gesture". Routes through createNamedNote (the offline-safe create
  // rail); when that callback isn't wired it degrades to opening the create
  // dialog so the row is never a dead-end.
  const makeCreateRow = (title: string): PaletteItem => ({
    kind: "create",
    id: "create-on-miss",
    title,
    label: t("Create note: {title}", { title }),
    hint: "create",
    group: "Create",
    run: () => {
      if (cbRef.current.createNamedNote) return cbRef.current.createNamedNote(title);
      else cbRef.current.setCreateOpen(true);
    },
  });

  // Fuzzy + accent-folded action matching. Replaces the old substring
  // (label.includes(q)) filter: Fuse tolerates typos/partials and
  // searches keyword synonyms; ignoreDiacritics folds accents (café ↔ cafe) and
  // ignoreLocation matches anywhere in the string. Disabled rows are NOT
  // dropped here — they render greyed downstream so the user still sees them.
  const filterActionsFuzzy = (actions: PaletteItem[], q: string): PaletteItem[] => {
    if (!q) return actions;
    const Fuse = loadedFuse();
    // Fuse is still on its way (first opening): a plain substring match meanwhile.
    if (!Fuse) return actions.filter((a) => "label" in a && (containsTitle(q, a.label) !== null || (a.kind === "action" && !!a.keywords?.some((k) => containsTitle(q, k) !== null))));
    const fuse = new Fuse(actions, {
      keys: [
        { name: "label", weight: 2 },
        { name: "keywords", weight: 0.6 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      ignoreDiacritics: true,
      minMatchCharLength: 1,
    });
    return fuse.search(q).map((r) => r.item);
  };

  // The selected note's actions, read when the palette opens or the selection,
  // store or permissions change. The body is the open draft when it is this
  // note's (read, not subscribed: a keystroke must not re-render the palette).
  const selectedActions = useMemo(() => selectedNode ? noteActionsFor(selectedNode, {
    canEdit: capabilities.canEdit(selectedNode), isOwner: capabilities.isOwner, online, tags,
    body: drafts.read(selectedNode.id)?.markdown,
    commands: noteCommandsOf(isImported).map(({ command }) => command),
  }) : null, [selectedNode, capabilities, online, tags, isImported, paletteOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- paletteOpen: re-read the draft on each opening
  const offered = (item: PaletteItem) =>
    !selectedActions || item.kind !== "action" || !(item.id in NOTE_ROWS) || selectedActions.has(NOTE_ROWS[item.id]!);
  const visibleStaticActions = useMemo(() => paletteStaticActions.filter(offered), [paletteStaticActions, selectedActions]); // eslint-disable-line react-hooks/exhaustive-deps -- offered reads selectedActions

  // Fuse loads when the palette first opens; the list is recomputed once it is there.
  const [fuseReady, setFuseReady] = useState(loadedFuse() !== null);
  useEffect(() => {
    if (!paletteOpen || fuseReady) return;
    let live = true;
    loadFuse().then(() => { if (live) setFuseReady(true); }, () => { /* substring match stays */ });
    return () => { live = false; };
  }, [paletteOpen, fuseReady]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const raw = paletteQuery.trim();
    const cmdMode = raw.startsWith(">");
    const tagMode = raw.startsWith("#");
    const searchMode = raw.startsWith("?");
    const prefixed = cmdMode || tagMode || searchMode;
    const q = (prefixed ? raw.slice(1).trimStart() : raw).toLowerCase();
    const allActions: PaletteItem[] = [...visibleStaticActions, ...paletteCanvasActions];

    // '>' commands — actions only. Fuzzy-matched (typos/synonyms/accents).
    if (cmdMode) {
      const cmds = allActions.filter((a) => a.kind !== "node");
      return q ? filterActionsFuzzy(cmds, q) : cmds;
    }

    // '#' jump-to-tag — tags are nodes (node=tag thesis); class_tag nodes are
    // the named, sidebar-#'d tags. Selecting one navigates to it like any node.
    if (tagMode) {
      // A hidden tag (D104) only for its full name (lib/nodeTags isTagShown).
      const tags = nodes.filter((n) => isTag(n) && !isSystemNode(n, tagIndex) && !isNoteSwitchTag(tagIndex.get(n.id))
        && (isTagShown(n) || n.title.toLowerCase() === q));
      return rankByTitle(q, tags, (n) => n.title, 12)
        .map((n) => ({ kind: "node" as const, id: n.id, title: n.title, hint: "tag", group: "Tags" }));
    }

    // '?' full-content search — same backend search results, but no actions mixed
    // in (an explicit "search my notes" gesture). Empty query: prompt via empty.
    if (searchMode) {
      return searchResults
        .slice(0, 12)
        .map((n) => ({ kind: "node" as const, id: n.id, title: n.title, hint: n.node_type, group: "Search", snippet: n.snippet }));
    }

    if (q.length >= 2) {
      const nodeItems: PaletteItem[] = searchResults
        .slice(0, 8)
        .map((n) => ({ kind: "node" as const, id: n.id, title: n.title, hint: n.node_type, group: "Notes", snippet: n.snippet }));
      const filteredActions = filterActionsFuzzy(allActions, q);
      // Create-on-miss: append a create row unless a result already titles
      // exactly the query (case-insensitive) — search and capture in one gesture.
      const exact =
        searchResults.some((n) => n.title.toLowerCase() === q) ||
        nodes.some((n) => isShownNote(n) && !isSystemNode(n, tagIndex) && n.title.toLowerCase() === q);
      const createRow: PaletteItem[] = exact || searchLoading || searchError ? [] : [makeCreateRow(raw)];
      return [...nodeItems, ...filteredActions, ...createRow];
    }
    // ⌘K default (empty query): recently-opened notes + recently-run actions, then
    // the full action list. New users with no history fall back to the
    // updated_at-ordered frecency list (rankByFrecency keeps input order at 0
    // score), so they see no change.
    const eligible = [...nodes]
      .filter((n) => isShownNote(n) && !isSystemNode(n, tagIndex) && (n.class_tag_ids?.length ?? 0) === 0)
      .sort(byUpdatedDesc);
    const byId = new Map(eligible.map((n) => [n.id, n]));
    const recentNodes: PaletteItem[] = rankByFrecency(eligible.map((n) => n.id), getFrecency())
      .slice(0, 5)
      .map((id) => byId.get(id)!)
      .map((n) => ({ kind: "node" as const, id: n.id, title: n.title, hint: n.node_type, group: "Recent Notes" }));
    // Recently-run actions: resolve the persisted lastRun ids back to live
    // action items (drops any that no longer exist), capped to a short list.
    const actionById = new Map(allActions.map((a) => [a.id, a]));
    const recentActions: PaletteItem[] = getLastRunActions()
      .map((id) => actionById.get(id))
      .filter((a): a is PaletteItem => !!a)
      .slice(0, 3)
      .map((a) => ({ ...a, group: "Recent Actions" }));
    return [...recentNodes, ...recentActions, ...visibleStaticActions, ...paletteCanvasActions];
    // paletteOpen is a dep so the recency lists are recomputed fresh each time
    // the palette opens (they read the localStorage open/run-history stores).
  }, [paletteQuery, nodes, tagIndex, searchResults, searchLoading, searchError, visibleStaticActions, paletteCanvasActions, paletteOpen, fuseReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPaletteIndex(0);
    setActionFailed(false);
  }, [paletteQuery, setPaletteIndex]);

  useEffect(() => {
    if (!searchRequest.enabled) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const outcome = await reads.notes.search(searchRequest.query, { signal: controller.signal });
        if (active) setSearchState({ request: searchRequest, rows: outcome.rows, failed: false, outcome });
      } catch {
        if (active) setSearchState({ request: searchRequest, rows: NO_RESULTS, failed: true, outcome: null });
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [searchRequest]);

  async function runPaletteItem(item: PaletteItem) {
    if (running.current || !paletteOpen || searchLoading || !paletteItems.includes(item)) return;
    if (item.kind === "action" && item.when && !item.when()) return;
    running.current = true; setActionBusy(true); setActionFailed(false);
    try {
      if (item.kind === "node") {
        setPendingFind(item.id, paletteQuery); // the note opens at the first hit
        setSelectedId(item.id);
        setMode("notes");
      } else {
        // false means the owner refused the operation and already explained
        // why. Preserve the search/capture input; don't infer success from a
        // callback merely having started a request.
        let accepted = item.run();
        if (accepted instanceof Promise) accepted = await accepted;
        if (accepted === false) { setActionFailed(true); return; }
        if (item.kind === "action" || item.kind === "canvas") recordLastRunAction(item.id);
      }
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteIndex(0);
    } catch (error) {
      setActionFailed(true);
      writeErrors.report(error, addToast);
    } finally { running.current = false; setActionBusy(false); }
  }

  return {
    paletteOpen, setPaletteOpen,
    paletteQuery, setPaletteQuery,
    paletteIndex, setPaletteIndex,
    paletteInputRef,
    paletteItems,
    searchLoading, searchError, searchOutcome, retrySearch, actionBusy, actionFailed,
    runPaletteItem,
  };
}
