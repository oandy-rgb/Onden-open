import type { CtxMenu } from "../lib/ctxMenu";
import ColorSwatchRow from "./ColorSwatchRow";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { addToast, selectOverviewNodes, useAppSelector, useOnline, useTagRows, useAllNodes } from "../lib/appStore";
import { nodeActions, noteActionsFor, noteMarkActions, relationWriter, runBackgroundWrite, tagWriter, writeErrors } from "../lib/data";
import { useCapabilities } from "../lib/capabilities";
import { t } from "../lib/i18n";
import { canDelete, canRetype, DERIVED_ARROW_HINT, useEdgeKinds } from "../lib/edgeKinds";
import type { ContentNode, NodeEdge } from "../lib/api";
import { ChevronRight } from "lucide-react";
import { createKindsFor } from "../lib/createKinds";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { usePopover, Menu, MenuHeading, MenuItem, MenuLabel, MenuSeparator } from "./ui";
import MoveToDialog from "./MoveToDialog";
import { displayTitle } from "../lib/noteLabel";
import { canDuplicateOnBoard, duplicateCardOnBoard } from "../lib/boardClipboard";
import "./ContextMenu.css";
import { isNote } from "@onden/markdown/contract";

// A note's actions (duplicate, delete, move) and the
// arrow actions run straight from lib/data (`nodeActions`, `relationWriter`).
// Which note actions show comes from lib/data noteActionList (D112) — the
// same list the header ⋯ menu, the ⌘K palette and the sidebar rows use, so a
// viewer is never offered a write the server refuses. The props are what
// only the shell knows: navigation, the rename form, the
// open board and pins.
type Props = {
  menu: CtxMenu;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onStartRename: (id: string, title: string) => void;
  onCreateAt: (flowX: number, flowY: number) => void;
  /** Resolves after server acceptance or durable queueing; rejects on failure. */
  onRemoveFromCanvas?: (nodeId: string) => Promise<unknown>;
  onSetNodeColor?: (nodeId: string, color: string | null) => void;
  /** 以此為中心: shown on a card of a board that follows its sub-notes. */
  onCenterBoard?: (nodeId: string) => void;
  /** Symlink-style pointer clone. Right-clicking a note in the sidebar
   *  surfaces "Pin under another note…" (a picker: a pin always has a parent
   *  note); right-clicking a pointer row surfaces "Remove pin".  */
  onCreatePointer?: (targetId: string, parentId: string) => void;
  onDeletePointer?: (pointerId: string) => void;
  /** 「在裡面新增」: make a `kindId` (lib/createKinds) under this note. */
  onCreateInside?: (kindId: string, parentId: string) => void;
};

// Change type = delete + recreate, since the unique-index on (workspace,
// src, tgt, edge_type, origin) means a type swap is semantically a new
// row. The local state update happens optimistically inside the writer.
// Only for an edge canRetype allows: a derived edge would be re-created by
// its note's next save, next to the new one.
function changeEdgeType(edge: NodeEdge, newType: string) {
  if (edge.edge_type === newType || !canRetype(edge)) return;
  runBackgroundWrite(relationWriter.remove(edge.id).then(() => relationWriter.connect(edge.source_node_id, edge.target_node_id, newType)));
}

export default function ContextMenu(props: Props) {
  // Each opening owns its pending operation; a late result must not close a
  // newer menu, even when it targets the same card.
  return <MenuHost key={JSON.stringify(props.menu)} {...props} />;
}

// "Move to…" (a space and a place in it, the top level included) and "Pin
// under another note…" replace the menu with a picker dialog (MoveToDialog)
// instead of listing every note in the menu. The picker
// belongs to this opening: closing it closes the whole menu. Both offer only
// the places lib/data placementCandidates allows (D101). 「在裡面新增」 swaps
// the menu for the list of kinds the same way (InsideMenu).
function MenuHost(props: Props) {
  const [picking, setPicking] = useState<{ nodeId: string; purpose: "move" | "pin" | "inside" } | null>(null);
  const nodes = useAllNodes();
  const overviewNodes = useAppSelector(selectOverviewNodes);
  const node = picking ? nodes.find((n) => n.id === picking.nodeId) : undefined;
  const { onCreatePointer } = props;
  if (node && picking?.purpose === "move") {
    return (
      <MoveToDialog node={node} nodes={overviewNodes} onClose={props.onClose}
        onPick={(parentId) => void nodeActions.assignToGroup(node.id, parentId)} />
    );
  }
  if (node && picking?.purpose === "inside" && props.onCreateInside) {
    return <InsideMenu menu={props.menu} parent={node} onClose={props.onClose} onCreateInside={props.onCreateInside} />;
  }
  if (node && picking?.purpose === "pin" && onCreatePointer) {
    return (
      <MoveToDialog purpose="pin" node={node} nodes={overviewNodes} onClose={props.onClose}
        onPick={(parentId) => { if (parentId) onCreatePointer(node.id, parentId); }} />
    );
  }
  return <MenuContents {...props} onMoveTo={(nodeId) => setPicking({ nodeId, purpose: "move" })}
    onPinUnder={(nodeId) => setPicking({ nodeId, purpose: "pin" })}
    onPickInside={(nodeId) => setPicking({ nodeId, purpose: "inside" })} />;
}

/** The kinds that can be made under `parent`, from the same list as the
 *  sidebar "+" (a kind that only opens a screen is not offered). */
function InsideMenu({ menu, parent, onClose, onCreateInside }: {
  menu: CtxMenu & { x: number; y: number };
  parent: ContentNode;
  onClose: () => void;
  onCreateInside: (kindId: string, parentId: string) => void;
}) {
  const online = useOnline();
  const isImported = useModuleFilter();
  const popover = usePopover({ open: true, onClose, at: { x: menu.x, y: menu.y } });
  return (
    <Menu popover={popover} label={t("New inside")}>
      <MenuHeading>{t("New inside")}</MenuHeading>
      {createKindsFor(isImported).filter((kind) => kind.placeable).map(({ id, label, Icon, needsServer }) => (
        <MenuItem key={id} disabled={needsServer && !online} title={needsServer && !online ? t("Needs a connection") : undefined}
          onSelect={() => onCreateInside(id, parent.id)}>
          <Icon size={13} /> {t(label)}
        </MenuItem>
      ))}
    </Menu>
  );
}

function MenuContents({
  menu, onClose, onSelectNode, onStartRename, onCreateAt,
  onRemoveFromCanvas, onSetNodeColor, onCenterBoard, onCreatePointer, onDeletePointer, onCreateInside, onMoveTo, onPinUnder, onPickInside,
}: Props & { onMoveTo: (nodeId: string) => void; onPinUnder: (nodeId: string) => void; onPickInside: (nodeId: string) => void }) {
  const nodes = useAllNodes();
  const edges = useAppSelector((s) => s.data.edges);
  const activeCanvasId = useAppSelector((s) => s.activeCanvas?.id ?? null);
  const online = useOnline();
  const caps = useCapabilities(online);
  const tags = useTagRows();
  const moduleFilter = useModuleFilter();
  const edgeKinds = useEdgeKinds();
  const actionsOf = (node: ContentNode) => noteActionsFor(node, { canEdit: caps.canEdit(node), isOwner: caps.isOwner, online, tags, isImported: moduleFilter });
  // 「隱藏標籤」 / 「取消隱藏」 (D104): only a tag, never a reserved one, by who
  // may edit tags — noteActionList decides.
  const tagHideItem = (node: ContentNode, actions: ReturnType<typeof actionsOf>) => actions.has("toggle-tag-hidden") ? (
    <MenuItem onSelect={() => runBackgroundWrite(tagWriter.setHidden(node.id, actions.label("toggle-tag-hidden") === "Hide tag"))}>
      {t(actions.label("toggle-tag-hidden"))}
    </MenuItem>
  ) : null;
  const mounted = useRef(true);
  const busy = useRef(false);
  const [removing, setRemoving] = useState(false);
  const popover = usePopover({ open: true, onClose, at: { x: menu.x, y: menu.y } });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function remove(nodeId: string) {
    if (busy.current || !onRemoveFromCanvas) return;
    busy.current = true; setRemoving(true);
    try {
      await onRemoveFromCanvas(nodeId);
      if (mounted.current) onClose();
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally {
      busy.current = false;
      if (mounted.current) setRemoving(false);
    }
  }

  return (
    <Menu popover={popover} className="ctx-menu" label={menu.kind === "graph-node" ? t("Card actions") : t("Actions")}>
      {menu.kind === "graph-node" && (() => {
        const node = nodes.find((n) => n.id === menu.nodeId);
        if (!node) return null;
        const actions = actionsOf(node);
        return (
          <>
            <MenuHeading>{displayTitle(node.title)}</MenuHeading>
            <fieldset className="ctx-actions" role="none" disabled={removing} aria-busy={removing}>
            {actions.has("open") && <MenuItem onSelect={() => onSelectNode(node.id)}>{t(actions.label("open"))}</MenuItem>}
            {onCenterBoard && <MenuItem onSelect={() => onCenterBoard(node.id)}>{t("Centre the board on this note")}</MenuItem>}
            {actions.has("rename") && <MenuItem onSelect={() => onStartRename(node.id, node.title)}>{t(actions.label("rename"))}</MenuItem>}
            {/* On a board the copy is a card on that board (the board's ⌘D); elsewhere just the note. */}
            {actions.has("duplicate") && <MenuItem onSelect={() => activeCanvasId && canDuplicateOnBoard() ? duplicateCardOnBoard(node.id) : void nodeActions.duplicate(node.id)}>{t(actions.label("duplicate"))}</MenuItem>}

            {/* Color picker */}
            {onSetNodeColor && activeCanvasId && (
              <>
                <MenuSeparator />
                <MenuLabel>{t("Card color")}</MenuLabel>
                <ColorSwatchRow onPick={(color) => { onSetNodeColor(node.id, color); onClose(); }} />
              </>
            )}

            <MenuSeparator />
            {activeCanvasId && onRemoveFromCanvas && (
              <MenuItem keepOpen className="ctx-remove-card" onSelect={() => void remove(node.id)}>
                <span>{t("Remove from canvas")}</span>
                <small>{t("The note stays in your library.")}</small>
              </MenuItem>
            )}
            {removing && <div className="ctx-status" role="status">{t("Removing…")}</div>}
            {tagHideItem(node, actions)}
            <MenuSeparator />
            {actions.has("delete") && <MenuItem danger onSelect={() => void nodeActions.delete(node.id)}>{t(actions.label("delete"))}</MenuItem>}
            </fieldset>
          </>
        );
      })()}
      {menu.kind === "graph-edge" && (() => {
        const edge = edges.find((e) => e.id === menu.edgeId);
        // Not a stored edge (a parent line): nothing here to retype or delete.
        if (!edge) return null;
        // A [[link]]'s arrow is the note's text drawn on the board: it is
        // changed in the note, never here (lib/edgeRoles; the server refuses
        // with 409 derived_edge too).
        if (!canRetype(edge) && !canDelete(edge)) {
          return <p className="ctx-status ctx-status--note" role="note">{t(DERIVED_ARROW_HINT)}</p>;
        }
        return (
          <>
            {canRetype(edge) && (
              <>
                <MenuLabel>{t("Arrow type")}</MenuLabel>
                {/* The types a person may pick, from the edge manifest (lib/edgeKinds). */}
                {edgeKinds.pickable.map(({ kind: typ }) => (
                  <MenuItem
                    key={typ}
                    checked={edge.edge_type === typ}
                    onSelect={() => changeEdgeType(edge, typ)}
                  >
                    {/* Tiny inline swatch + label so the user reads the type by its
                        rendered colour, matching what they see on the canvas. */}
                    <span className="ctx-edge-swatch" style={{ "--edge-color": edgeKinds.color(typ) } as CSSProperties} />
                    {edgeKinds.label(typ)}
                  </MenuItem>
                ))}
                <MenuSeparator />
              </>
            )}
            {canDelete(edge) && (
              <MenuItem danger onSelect={() => runBackgroundWrite(relationWriter.remove(edge.id))}>
                {t("Delete arrow")}
              </MenuItem>
            )}
          </>
        );
      })()}
      {menu.kind === "graph-canvas" && (
        <MenuItem onSelect={() => onCreateAt(menu.flowX, menu.flowY)}>{t("Create note here")}</MenuItem>
      )}
      {menu.kind === "sidebar-node" && (() => {
        const node = nodes.find((n) => n.id === menu.nodeId);
        if (!node) return null;
        const actions = actionsOf(node);
        return (
          <>
            {actions.has("rename") && <MenuItem onSelect={() => onStartRename(node.id, node.title)}>{t(actions.label("rename"))}</MenuItem>}
            {actions.has("duplicate") && <MenuItem onSelect={() => void nodeActions.duplicate(node.id)}>{t(actions.label("duplicate"))}</MenuItem>}
            {actions.has("new-inside") && onCreateInside && (
              <MenuItem keepOpen onSelect={() => onPickInside(node.id)}>
                {t(actions.label("new-inside"))} <ChevronRight size={13} aria-hidden="true" />
              </MenuItem>
            )}
            {/* Pin and colour left the note's ⋯ menu; the list still offers them. */}
            {isNote(node) && actions.has("toggle-pin") && (
              <MenuItem onSelect={() => noteMarkActions.togglePin(node)}>{t(actions.label("toggle-pin"))}</MenuItem>
            )}
            {isNote(node) && actions.has("set-color") && (
              <>
                <MenuLabel>{t("Color")}</MenuLabel>
                <ColorSwatchRow onPick={(color) => { noteMarkActions.setColor(node.id, color); onClose(); }} />
              </>
            )}
            <MenuSeparator />
            {/* Moving writes the note (parent_id): editors only, like the Parent field. */}
            {actions.has("move") && <MenuItem keepOpen onSelect={() => onMoveTo(node.id)}>{t(actions.label("move"))}</MenuItem>}
            <MenuSeparator />
            {onCreatePointer && (
              <MenuItem keepOpen onSelect={() => onPinUnder(node.id)}>{t("📎 Pin under another note…")}</MenuItem>
            )}
            {tagHideItem(node, actions)}
            <MenuSeparator />
            {actions.has("delete") && <MenuItem danger onSelect={() => void nodeActions.delete(node.id)}>{t(actions.label("delete"))}</MenuItem>}
          </>
        );
      })()}
      {menu.kind === "sidebar-pointer" && onDeletePointer && (() => {
        const target = nodes.find((n) => n.id === menu.targetId);
        return (
          <>
            {target && (
              <MenuItem onSelect={() => onSelectNode(target.id)}>{t("Open pinned note")}</MenuItem>
            )}
            <MenuSeparator />
            <MenuItem danger onSelect={() => onDeletePointer(menu.pointerId)}>{t("Remove pin")}</MenuItem>
          </>
        );
      })()}
    </Menu>
  );
}
