import { openTextStyle } from "../lib/textStyleRequest";
import { Suspense, useState, type ReactNode } from "react";
import { Download, Eye, History, MoreHorizontal, PanelRight, Pencil, Search, ChevronRight } from "lucide-react";
import { otherView, type NoteView } from "../lib/viewSwitch";
import { useT } from "../lib/i18n";
import type { NoteExportFormat, NoteExportOptions } from "../lib/noteExport";
import { NOTE_HEADER_ACTIONS, writeErrors, type NoteActionId, type NoteActionView } from "../lib/data";
import { addToast } from "../lib/appStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { Menu, MenuItem, MenuSeparator, Pressable, usePopover } from "./ui";
import { lazyWithReload } from "../lib/lazyWithReload";
import "./NoteActions.css";

// Per-note header actions (surface [per-note-actions-menu]). The imported
// modules' own header actions (FrontendModule.noteHeaderAction: skills' 交給 AI),
// the info panel's button on a phone only (a wide screen has it at the right
// of the top bar), and a "⋯" with the few things done to the note as a whole:
// its history, a copy, an export and Delete. PRESENTATIONAL — every handler is wired by OverviewEditorHost to
// the EXISTING machinery (domainWriters / nodeMutations / inline export).
//
// Which actions exist is decided by lib/data noteActionList (D112), the same
// list the context menu and the ⌘K palette render from; this menu shows the
// NOTE_HEADER_ACTIONS of it. Pin, colour, split, merge, sending a checklist
// and rename are in the sidebar's context menu and ⌘K; module commands are in
// the info panel's 「功能」 section.
//
// Two forms of one menu, drawn with the shared ui/Menu: a popover at the ⋯ on
// a wide screen; on a phone a bottom sheet — a row of big tiles (find,
// preview, history, export), a rounded block with 「複製一份」, then Delete.
// Adding a view changes how the page is shown, not the note: when offered it
// is its own 「新增檢視」 section above a 「這篇筆記」 one, in both forms, listing the
// kinds of view, each row marked ＋ — the heading and the mark say a tap adds
// a tab, not that it shows one already there. A kind that asks for a field first
// swaps the menu for that question, in the same place (sheet or popover).

export type ExportFormat = NoteExportFormat;

/** One way the open note can be shown, listed under ⋯ › 顯示… on a wide
 *  screen (OverviewEditor decides which exist for this note and runs them).
 *  `pressed` set: an on/off choice, shown checked. */
export type NoteDisplayRow = {
  id: string;
  /** i18n key. */
  label: string;
  pressed?: boolean;
  run: () => void;
};

type Props = {
  /** The imported modules' header actions for this note, shown before ⋯
   *  (OverviewEditorHost renders FrontendModule.noteHeaderAction). */
  headerActions?: ReactNode;
  /** The info panel's entry on a phone: an icon button before ⋯ that opens the
   *  Info screen in place of the note. Absent on a wide screen, where the
   *  top bar holds the switch (AppTopbar). */
  inspectorToggle?: { pressed: boolean; onToggle: () => void };
  /** What this note offers, for this person (lib/data noteActionList): the
   *  menu shows the header ones of these. The modules' commands are not here:
   *  they are in the info panel's 「功能」 tab. */
  actions: NoteActionView;
  /** The note's text and creation day, for the counts at the top of the menu. The text is
   *  read when the menu opens (it is not subscribed, so a keystroke does not redo the count). */
  stats?: { nodeId: string; body: () => string; createdAt?: string | null };

  /** Open the note's compare/restore versions dialog. */
  onVersionHistory?: () => void;

  /** Phone only: the editor toolbar is folded away, so the sheet carries its
   *  find and view switch (OverviewEditor's quiet header). */
  phoneEditor?: {
    /** The current view; null when this note has no preview (PDF, handwriting). */
    view: NoteView | null;
    onSetView: (view: NoteView) => void;
    onFind?: () => void;
  };

  /** Wide screen only: the rows of ⋯ › 顯示…; none, no 顯示…. */
  displayRows?: readonly NoteDisplayRow[];

  onDuplicate: () => void;
  onExport: (format: ExportFormat, options?: NoteExportOptions) => void | Promise<boolean>;
  onCopyMarkdown?: () => Promise<boolean>;
  exportBusy?: boolean;

  onDelete: () => void;
};

// The note's counts pull in the Markdown parser, so the block is loaded when the menu opens.
const NoteStatsBlock = lazyWithReload(() => import("./NoteStatsBlock"));

export default function NoteActions(props: Props) {
  const t = useT();
  const phone = useIsMobile();
  const { actions } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileFailed, setFileFailed] = useState(false);

  const closeMenu = () => { setMenuOpen(false); setExportOpen(false); setDisplayOpen(false); };
  const actionMenu = usePopover({ open: menuOpen, onClose: closeMenu });
  const exporting = fileBusy || props.exportBusy;
  const offered = (id: NoteActionId) => NOTE_HEADER_ACTIONS.includes(id) && actions.has(id);
  const showHistory = offered("version-history") && !!props.onVersionHistory;
  const showCopyMarkdown = offered("copy-markdown") && !!props.onCopyMarkdown;
  const showExport = offered("export");
  const displayRows = props.displayRows ?? [];
  const showDisplay = offered("display") && displayRows.length > 0;
  const showTextStyle = offered("text-style");
  const showDuplicate = offered("duplicate");
  const showDelete = offered("delete");

  const runFileAction = async (action: () => void | Promise<boolean>) => {
    if (exporting) return;
    setFileBusy(true);
    setFileFailed(false);
    try {
      const accepted = await action();
      if (accepted === false) setFileFailed(true);
      else closeMenu();
    } catch (error) {
      writeErrors.report(error, addToast);
      setFileFailed(true);
    } finally { setFileBusy(false); }
  };

  // The export choices, the same in the desktop submenu and the phone sheet.
  const exportRows = (
    <>
      {showCopyMarkdown && (
        <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(props.onCopyMarkdown!); }}>{t("Copy Markdown")}</MenuItem>
      )}
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("markdown")); }}>{t("Markdown file")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("markdown", { partLinks: "footnote" })); }}>{t("Markdown file (paragraph links as footnotes)")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("markdown", { partLinks: "obsidian" })); }}>{t("Markdown file (Obsidian compatible)")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("html")); }}>{t("HTML")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("pdf")); }}>{t("Print / save as PDF")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("docx", { font: "sans" })); }}>{t("Word (sans-serif)")}</MenuItem>
      <MenuItem keepOpen disabled={exporting} onSelect={() => { void runFileAction(() => props.onExport("docx", { font: "serif" })); }}>{t("Word (serif)")}</MenuItem>
      <p className="note-actions-export-help">{t("Exports include the current text. HTML and PDF keep images as links; Word embeds them. HTML, PDF and Word need a connection.")}</p>
      {exporting && <p className="note-actions-export-help" role="status">{t("Preparing export…")}</p>}
      {fileFailed && <p className="note-actions-export-help" role="status">{t("The export did not finish. You can try again.")}</p>}
    </>
  );

  const statsBlock = menuOpen && props.stats && <Suspense fallback={null}><NoteStatsBlock nodeId={props.stats.nodeId} body={props.stats.body} createdAt={props.stats.createdAt} /></Suspense>;
  const phoneEditor = props.phoneEditor;
  const tiles = (
    <div className="note-sheet-tiles">
      {phoneEditor?.onFind && (
        <MenuItem className="note-sheet-tile" onSelect={phoneEditor.onFind}><Search size={22} aria-hidden="true" /><span>{t("Find")}</span></MenuItem>
      )}
      {phoneEditor?.view && (
        <MenuItem className="note-sheet-tile" onSelect={() => phoneEditor.onSetView(otherView(phoneEditor.view!))}>
          {phoneEditor.view === "edit" ? <Eye size={22} aria-hidden="true" /> : <Pencil size={22} aria-hidden="true" />}
          <span>{phoneEditor.view === "edit" ? t("Preview") : t("Edit")}</span>
        </MenuItem>
      )}
      {showHistory && (
        <MenuItem className="note-sheet-tile" onSelect={props.onVersionHistory!}><History size={22} aria-hidden="true" /><span>{t("History")}</span></MenuItem>
      )}
      {showExport && (
        <MenuItem keepOpen className="note-sheet-tile" aria-haspopup="menu" aria-expanded={exportOpen} onSelect={() => setExportOpen((v) => !v)}>
          <Download size={22} aria-hidden="true" /><span>{t("Export")}</span>
        </MenuItem>
      )}
    </div>
  );

  return (
    <div className="note-actions">
      {props.headerActions}

      {props.inspectorToggle && (
        <Pressable
          type="button"
          className="note-actions-more-btn note-actions-info-btn notes-inspector-toggle tap-target"
          onClick={props.inspectorToggle.onToggle}
          aria-pressed={props.inspectorToggle.pressed}
          aria-label={t("Info")}
          title={t("Info")}
        >
          <PanelRight size={18} aria-hidden="true" />
        </Pressable>
      )}

      <div className="note-actions-overflow" ref={actionMenu.anchor}>
        <Pressable
          className="note-actions-more-btn tap-target"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("More actions")} title={t("More actions")}
        >
          <MoreHorizontal size={18} />
        </Pressable>
        {menuOpen && phone && (
          <Menu popover={actionMenu} sheet className="note-actions-sheet" label={t("More actions")}>
            {statsBlock}
            {tiles}
            {exportOpen && <div className="note-sheet-group note-sheet-export" role="group" aria-label={t("Export as")}>{exportRows}</div>}
            {showTextStyle && (
              <div className="note-sheet-group">
                <MenuItem onSelect={() => openTextStyle(actionMenu.anchor.current)}>{t(actions.label("text-style"))}</MenuItem>
              </div>
            )}
            {showDuplicate && (
              <div className="note-sheet-group">
                <MenuItem onSelect={props.onDuplicate}>{t(actions.label("duplicate"))}</MenuItem>
              </div>
            )}
            {showDelete && (
              <div className="note-sheet-group">
                <MenuItem danger onSelect={props.onDelete}>{t(actions.label("delete"))}</MenuItem>
              </div>
            )}
          </Menu>
        )}
        {menuOpen && !phone && (
          <Menu popover={actionMenu} className="note-actions-pop" label={t("More actions")}>
            {statsBlock}
            {showHistory && <MenuItem onSelect={props.onVersionHistory!}>{t(actions.label("version-history"))}</MenuItem>}
            {showDuplicate && <MenuItem onSelect={props.onDuplicate}>{t(actions.label("duplicate"))}</MenuItem>}
            {showExport && (
              <div className="note-actions-submenu">
                <MenuItem
                  keepOpen
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                  className="note-actions-submenu-trigger"
                  onSelect={() => setExportOpen((v) => !v)}
                >
                  {t(actions.label("export"))}<ChevronRight size={13} className="note-actions-submenu-caret" />
                </MenuItem>
                {exportOpen && <div className="note-actions-export-options" role="menu" aria-label={t("Export as")}>{exportRows}</div>}
              </div>
            )}
            {showDisplay && (
              <div className="note-actions-submenu">
                <MenuItem
                  keepOpen
                  aria-haspopup="menu"
                  aria-expanded={displayOpen}
                  className="note-actions-submenu-trigger"
                  onSelect={() => setDisplayOpen((v) => !v)}
                >
                  {t(actions.label("display"))}<ChevronRight size={13} className="note-actions-submenu-caret" />
                </MenuItem>
                {displayOpen && (
                  <div className="note-actions-export-options" role="menu" aria-label={t("Display")}>
                    {displayRows.map((row) => (
                      <MenuItem key={row.id} checked={row.pressed}
                        onSelect={row.run}>{t(row.label)}</MenuItem>
                    ))}
                  </div>
                )}
              </div>
            )}
            {showTextStyle && <MenuItem onSelect={() => openTextStyle(actionMenu.anchor.current)}>{t(actions.label("text-style"))}</MenuItem>}
            {showDelete && (
              <>
                <MenuSeparator />
                <MenuItem danger onSelect={props.onDelete}>{t(actions.label("delete"))}</MenuItem>
              </>
            )}
          </Menu>
        )}
      </div>
    </div>
  );
}
