import { Suspense, useState, type CSSProperties } from "react";
import { ChevronDown, FolderInput } from "lucide-react";
import type { ContentNode } from "../lib/api";
import { useOnline } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { collapseAncestors, noteAncestors, pathSpace } from "../lib/noteLocation";
import { spaceLabel, useSpaces } from "../lib/spaces";
import { Menu, MenuItem, Popover, usePopover, Pressable } from "./ui";
import { lazyWithReload } from "../lib/lazyWithReload";
import { loadParentPicker } from "./lateShell";
import { displayTitle } from "../lib/noteLabel";
import "./PhoneNoteLocation.css";

const ParentPicker = lazyWithReload(loadParentPicker);

// The phone's answer to "where is this note?", in the middle of the note's top
// bar (it replaces the line NoteBreadcrumb draws above the title on a wide
// screen; both read lib/noteLocation and move through the same ParentPicker).
//
//   <PhoneNoteLocation node={node} nodes={all} canEdit onOpenNote={open}
//     onOpenNotesList={list} onAssignGroup={move} titleScrolledPast={past} />
//
// Under a parent: the path and a ⌄; a tap opens the "where this note sits"
// sheet. Top level: a quiet "Put under…" for editors, nothing for a viewer.
// Once the title has scrolled under the bar, the middle becomes two lines
// (path, title) and opens the same sheet.

type Props = {
  node: ContentNode;
  nodes: readonly ContentNode[];
  canEdit: boolean;
  onOpenNote: (id: string) => void;
  /** The "Notes" row at the top of the sheet. */
  onOpenNotesList: () => void;
  onAssignGroup?: (nodeId: string, parentId: string | null) => unknown;
  /** The note's title is covered by the bar: show it here. */
  titleScrolledPast: boolean;
};

export default function PhoneNoteLocation({ node, nodes, canEdit, onOpenNote, onOpenNotesList, onAssignGroup, titleScrolledPast }: Props) {
  const t = useT();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const sheet = usePopover<HTMLButtonElement>({ open: sheetOpen, onClose: () => setSheetOpen(false), placement: "bottom-start" });
  const picking = pickingFor === node.id;
  const picker = usePopover<HTMLSpanElement>({ open: picking, onClose: () => setPickingFor(null), placement: "bottom-start" });
  const online = useOnline();
  const { spaces } = useSpaces(online);
  const ancestors = noteAncestors(node, nodes);
  // The path starts at the note's space, as the sidebar groups notes by it.
  const space = pathSpace(node, nodes, spaces);
  const rootLabel = space ? spaceLabel(space) : null;
  const canMove = canEdit && !!onAssignGroup;
  if (ancestors.length === 0 && !canMove) return null;

  const titleOf = (n: ContentNode) => displayTitle(n.title);
  const parent = ancestors[ancestors.length - 1];
  // The farther part is grey ("Only me › Projects ›"); a long path folds its
  // middle as NoteBreadcrumb does. No app name in front: it says nothing.
  const { shown, hidden } = collapseAncestors(ancestors);
  const farNotes = hidden.length ? [titleOf(shown[0]), "…"] : ancestors.slice(0, -1).map(titleOf);
  const farPath = rootLabel ? [rootLabel, ...farNotes] : farNotes;
  const trail = ancestors.length === 0 ? t("Notes") : [...farPath, titleOf(parent)].join(" › ");

  const picker_ = canMove && picking && (
    <Popover popover={picker} sheet label={t("Move…")} className="pnl-picker">
      <Suspense fallback={null}>
        <ParentPicker node={node} nodes={nodes}
          onPick={(parentId) => { if (parentId !== (node.parent_id ?? null)) onAssignGroup(node.id, parentId); }}
          onClose={() => setPickingFor(null)} />
      </Suspense>
    </Popover>
  );

  if (ancestors.length === 0) {
    return (
      <span className="pnl" ref={picker.anchor}>
        <Pressable type="button" className="pnl-put" aria-haspopup="dialog" onClick={() => setPickingFor(node.id)}>
          <FolderInput size={14} aria-hidden="true" /><span>{t("Put under…")}</span>
        </Pressable>
        {picker_}
      </span>
    );
  }

  return (
    <span className="pnl" ref={picker.anchor}>
      <Pressable ref={sheet.anchor} type="button" className="pnl-trail" data-scrolled={titleScrolledPast || undefined}
        aria-haspopup="menu" aria-expanded={sheetOpen} aria-label={`${t("Where this note sits")}: ${trail}`}
        onClick={() => setSheetOpen((v) => !v)}>
        {titleScrolledPast ? (
          <>
            <span className="pnl-small">{trail}</span>
            <span className="pnl-title">{titleOf(node)}</span>
          </>
        ) : (
          <>
            {farPath.length > 0 && <span className="pnl-far">{farPath.join(" › ")} ›</span>}
            <span className="pnl-parent">{titleOf(parent)}</span>
            <ChevronDown size={14} aria-hidden="true" className="pnl-caret" />
          </>
        )}
      </Pressable>
      {sheetOpen && (
        <Menu popover={sheet} sheet className="pnl-sheet" label={t("Where this note sits")}>
          <MenuItem onSelect={onOpenNotesList}>{rootLabel ?? t("Notes")}</MenuItem>
          {ancestors.map((a, depth) => (
            <MenuItem key={a.id} style={{ "--pnl-depth": depth + 1 } as CSSProperties} onSelect={() => onOpenNote(a.id)}>
              {titleOf(a)}
            </MenuItem>
          ))}
          <MenuItem aria-current="location" className="pnl-here" style={{ "--pnl-depth": ancestors.length + 1 } as CSSProperties} onSelect={() => {}}>
            <strong>{titleOf(node)}</strong><span className="pnl-here-badge">{t("This note")}</span>
          </MenuItem>
          {canMove && <MenuItem onSelect={() => setPickingFor(node.id)}>{t("Move elsewhere…")}</MenuItem>}
        </Menu>
      )}
      {picker_}
    </span>
  );
}
