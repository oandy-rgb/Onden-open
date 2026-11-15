import { useState } from "react";
import type { ContentNode } from "../lib/api";
import { useT } from "../lib/i18n";
import { collapseAncestors } from "../lib/noteLocation";
import { Menu, MenuItem, Popover, usePopover, Pressable, keepFocus } from "./ui";
import ParentPicker from "./ParentPicker";
import { displayTitle } from "../lib/noteLabel";
import "./NoteBreadcrumb.css";

// Where the open note sits, at the left of the note's top row: the ancestors
// only (each opens that note; the note itself is the title right below), then
// — for someone who can edit — "Move…", a quiet word that shows when the row
// is hovered or focused. It opens the shared parent picker (the placement
// rules in lib/data/placement.ts are applied inside it). This is the one place
// the parent is shown and changed. The picker floats over the page (Popover:
// above the content, flips and shrinks near the screen edge, closes on an outside
// press or Esc). It is not inline: the editor column is a height-capped flex
// column whose rows shrink, so an inline list overflowed the top row and printed
// over the title.
//
//   <NoteBreadcrumb node={node} ancestors={path} nodes={all}
//     canEdit onOpenNote={open} onAssignGroup={move} />
//
// A top-level note has no ancestors: an editor still gets "Set parent"; a
// read-only viewer gets nothing. Reparenting queues offline
// like any note write, so there is no online gate here.

type Props = {
  node: ContentNode;
  /** Root first, the note's parent last. */
  ancestors: readonly ContentNode[];
  /** The notes a parent can be picked from. */
  nodes: readonly ContentNode[];
  canEdit: boolean;
  onOpenNote: (id: string) => void;
  /** Called with the new parent (null = top level); not called for the current one. */
  onAssignGroup?: (nodeId: string, parentId: string | null) => unknown;
};

function CollapsedAncestors({ hidden, onOpenNote }: { hidden: readonly ContentNode[]; onOpenNote: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  const label = t("Show {n} more parent notes", { n: hidden.length });
  return (
    <>
      <Pressable ref={pop.anchor} type="button" className="breadcrumb-item breadcrumb-more tap-target"
        aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        onClick={() => setOpen((v) => !v)}>…</Pressable>
      {open && (
        <Menu popover={pop} label={t("Parent notes in the path")} className="breadcrumb-menu">
          {hidden.map((p) => (
            <MenuItem key={p.id} title={p.title || undefined} onSelect={() => onOpenNote(p.id)}>
              <span className="breadcrumb-menu-title">{displayTitle(p.title)}</span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

export default function NoteBreadcrumb({ node, ancestors, nodes, canEdit, onOpenNote, onAssignGroup }: Props) {
  const t = useT();
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const canMove = canEdit && !!onAssignGroup;
  // A switch to another note closes the picker.
  const picking = pickingFor === node.id;
  const picker = usePopover<HTMLButtonElement>({ open: picking, onClose: () => setPickingFor(null), placement: "bottom-start" });
  if (ancestors.length === 0 && !canMove) return null;

  const { shown, hidden } = collapseAncestors(ancestors);
  const collapse = hidden.length > 0;
  const ancestorItem = (p: ContentNode) => {
    const title = displayTitle(p.title);
    return (
      <li key={p.id}>
        <Pressable type="button" className="breadcrumb-item" title={title} onClick={() => onOpenNote(p.id)}>{title}</Pressable>
      </li>
    );
  };

  return (
    <div className="note-breadcrumb">
      <nav className="obsidian-breadcrumb" aria-label={t("Where this note sits")}>
        {ancestors.length > 0 && (
          <ol className="breadcrumb-trail">
            {ancestorItem(shown[0])}
            {collapse && <li><CollapsedAncestors hidden={hidden} onOpenNote={onOpenNote} /></li>}
            {shown.slice(1).map(ancestorItem)}
          </ol>
        )}
        {canMove && (
          <Pressable ref={picker.anchor} type="button" className="breadcrumb-move tap-target"
            aria-haspopup="dialog" aria-expanded={picking}
            // Pressing it must not blur the picker's field: that closes the list, and the click would reopen it.
            onMouseDown={keepFocus} onClick={() => setPickingFor(picking ? null : node.id)}>
            {ancestors.length > 0 ? t("Move…") : t("Set parent")}
          </Pressable>
        )}
      </nav>
      {canMove && picking && (
        <Popover popover={picker} label={ancestors.length > 0 ? t("Move…") : t("Set parent")} className="breadcrumb-picker">
          <ParentPicker node={node} nodes={nodes}
            onPick={(parentId) => { if (parentId !== (node.parent_id ?? null)) onAssignGroup(node.id, parentId); }}
            onClose={() => setPickingFor(null)} />
        </Popover>
      )}
    </div>
  );
}
