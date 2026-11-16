import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { FileText, LayoutDashboard, Plus, Table2, type LucideIcon } from "lucide-react";
import type { FieldDef } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { CANVAS_TAB, defaultTabKey, isFixedFirstTab, type ViewTab } from "../../lib/viewTabs";
import { NOTE_VIEW_MODULES, VIEW_MODULES } from "../../modules";
import type { ViewOwner } from "../../lib/data";
import { Menu, MenuItem, MenuSeparator, Pressable, Tab, TabList, usePopover } from "../ui";
import AddViewPanel from "./AddViewPanel";
import { useViewTabActions } from "./useViewTabActions";
import { useAddView, useOwnerTabs } from "./useAddView";
import "./ViewTabs.css";
import { isEnterKey, isEscapeKey } from "../../lib/keys";
import { requestViewSettings } from "../../lib/viewSettingsRequest";
import { holdSurface, beginTouchHold, createEdgeAutoScroll, createTouchPressGuard } from "../../lib/touchHold";
import { VIEW_NAME_MAX } from "@onden/markdown";
import { TextField } from "../ui";
import { elementAtPoint } from "../../lib/documentAccess";
import { useIsMobile } from "../../hooks/useIsMobile";
import { requestSplitOpen, splitDrag } from "../../lib/splitViewStore";

// The row of tabs at the left of a page's title strip (ViewStrip): 「內容」 first, then the
// ways of seeing it that this page uses — whiteboard, table, calendar, board,
// cards — then 「＋」, for a note as for a tag (a note shows the row even with only
// 「內容」, or there would be no 「＋」). One component for notes and tags (docs/agents/decisions-ui.md,
// 筆記與標籤頁的視角分頁). It only lists, adds, renames, moves and removes the
// tabs; which tab is open is the caller's (it is in the URL), and what a tab
// shows is the page's.

type Props = {
  owner: ViewOwner & { name: string };
  /** The open tab: "content", "canvas" or a saved view's id. */
  activeKey: string;
  /** The page already has cards on its board: the whiteboard tab shows before
   *  anything is stored. */
  earnsWhiteboard: boolean;
  /** The person may change this page's views (add, rename, move, remove). */
  canManage: boolean;
  /** The fields a calendar, board or cards view could be placed by. */
  fields: FieldDef[];
  onSelect: (key: string) => void;
  /** A tag's page can open its field settings from a board's hint. */
  onEditFields?: () => void;
};

function iconOf(tab: ViewTab): LucideIcon {
  if (tab.kind === "content") return FileText;
  if (tab.kind === "canvas") return LayoutDashboard;
  return [...VIEW_MODULES, ...NOTE_VIEW_MODULES].find((mod) => mod.id === tab.view?.layout)?.library.Icon ?? Table2;
}

// 「＋」 and the panel it opens.
function AddViewButton({ ownerId, tabs, actions, fields, ownerKind, onSelect, onEditFields }: Pick<Props, "fields" | "onSelect" | "onEditFields"> & {
  ownerId: string; tabs: readonly ViewTab[]; actions: ReturnType<typeof useViewTabActions>; ownerKind: ViewOwner["kind"];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const addView = useAddView({ ownerId, open, tabs, actions, fields, ownerKind, onSelect });
  const close = () => setOpen(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: close, placement: "bottom-start" });
  return (
    <>
      <Pressable ref={pop.anchor} type="button" className="view-tab view-tab--add" aria-haspopup="dialog" aria-expanded={open}
        aria-label={t("Add a view")} title={t("Add a view")} disabled={actions.busy} onClick={() => setOpen((o) => !o)}>
        <Plus size={14} aria-hidden="true" />
        <span className="view-tab-add-label">{t("Add a view")}</span>
      </Pressable>
      {open && <AddViewPanel popover={pop} source={addView} onEditFields={onEditFields} onClose={close} />}
    </>
  );
}

export default function ViewTabs({ owner, activeKey, earnsWhiteboard, canManage, fields, onSelect, onEditFields }: Props) {
  const t = useT();
  const canSplitHere = !useIsMobile();
  // The owner as the views are addressed: kind and id, not the name shown.
  const ownerRef = useMemo<ViewOwner>(() => ({ kind: owner.kind, id: owner.id }), [owner.kind, owner.id]);
  const { views, status, tabs } = useOwnerTabs(ownerRef, { earnsWhiteboard, canManage, activeKey });
  const actions = useViewTabActions(ownerRef, tabs, views);

  const [menu, setMenu] = useState<{ tab: ViewTab; x: number; y: number } | null>(null);
  const tabMenu = usePopover<HTMLButtonElement>({ open: !!menu, onClose: () => setMenu(null), at: menu ? { x: menu.x, y: menu.y } : undefined });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // A tab held by a finger or pen (lifted); the mouse drag uses dragKey alone.
  const [liftedKey, setLiftedKey] = useState<string | null>(null);
  // The last press was touch / pen: tabs are then not `draggable`, or the browser's own drag takes the hold.
  const [touchPress, setTouchPress] = useState(false);
  const touchGuard = useRef(createTouchPressGuard()).current;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const rowEl = useCallback((el: HTMLDivElement | null) => { rowRef.current = el; holdSurface(el); }, []);
  const listEl = () => rowRef.current?.querySelector<HTMLElement>(".view-tabs-list") ?? null;
  const autoScroll = useRef(createEdgeAutoScroll(() => liftedRef.current !== null, (x) => setOverKey(tabKeyAt(x)), { list: () => listEl(), axis: "x" })).current;
  const liftedRef = useRef<string | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // The open tab is gone (deleted or hidden here or elsewhere, a module turned off, an
  // old link, a tab remembered from before 「內容」 was removed): fall back to the page's
  // default tab instead of showing a page no tab names.
  // Not before the views are known: a saved tab id is valid until they say otherwise.
  const known = tabs.some((tab) => tab.key === activeKey);
  useEffect(() => {
    if (status === "loading" || known) return;
    if (status === "failed" && activeKey !== CANVAS_TAB) return;
    onSelect(defaultTabKey(tabs));
  }, [status, known, activeKey, onSelect, tabs]);
  useEffect(() => { activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeKey, tabs.length]);

  const movable = tabs.filter((tab) => !isFixedFirstTab(tab));
  // 「Remove tab」 is a view's delete or the whiteboard's or 「內容」's hide; the built-in 「內容」 has nothing else but 「開在右邊」,
  // which a phone does not offer: then there is no menu to open.
  const canRemove = (tab: ViewTab) => (tab.kind === "content" ? tab.hideable : tab.editable);
  const openMenu = (tab: ViewTab, x: number, y: number) => { if (tab.editable || canRemove(tab) || canSplitHere) setMenu({ tab, x, y }); };
  const startRename = (tab: ViewTab) => { setDraft(tab.name); setRenaming(tab.key); };
  const finishRename = (tab: ViewTab, commit: boolean) => {
    setRenaming(null);
    if (commit) void actions.rename(tab, draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: ViewTab) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(tab, box.left, box.bottom);
  };
  // Touch / pen is the shared hold gesture (lib/touchHold, as the sidebar's rows): hold → the tab
  // lifts; move → it drags along the row; let go in place → its menu. The mouse keeps HTML5 drag
  // and the right click.
  const tabKeyAt = (x: number) => {
    // Only the finger's x counts: the row is hit at its middle, so a finger drifting off it still lands on a tab.
    const box = listEl()?.getBoundingClientRect();
    const key = elementAtPoint(x, box ? box.top + box.height / 2 : 0)?.closest<HTMLElement>("[data-tab-key]")?.dataset.tabKey ?? null;
    const target = tabs.find((tab) => tab.key === key);
    return target && !isFixedFirstTab(target) ? target.key : null;
  };
  const endTouchDrag = () => { autoScroll.stop(); liftedRef.current = null; setLiftedKey(null); setOverKey(null); };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, tab: ViewTab) => {
    if (actions.busy) return;
    const startX = event.clientX;
    const startY = event.clientY;
    // beginTouchHold takes a finger / pen press and leaves the mouse alone.
    setTouchPress(beginTouchHold(event, touchGuard, {
      onLift: () => { liftedRef.current = tab.key; setLiftedKey(tab.key); },
      onDrag: (x) => { setOverKey(tabKeyAt(x)); autoScroll.start(x, startY); },
      onRelease: (x, _y, moved) => {
        const target = moved ? tabs.find((candidate) => candidate.key === tabKeyAt(x)) : undefined;
        endTouchDrag();
        if (!moved) openMenu(tab, startX, startY);
        else if (target) dropOn(tab, target);
      },
      onAbort: endTouchDrag,
    }));
  };

  const dropOn = (source: ViewTab | undefined, target: ViewTab) => {
    setDragKey(null); setOverKey(null);
    if (!source || !source.editable || source.key === target.key) return;
    void actions.move(source, movable.findIndex((tab) => tab.key === target.key));
  };

  const menuIndex = menu ? movable.findIndex((tab) => tab.key === menu.tab.key) : -1;
  return (
    <div ref={rowEl} className="view-tabs">
      <TabList className="view-tabs-list" label={t("Views of {name}", { name: owner.name })}>
      {tabs.map((tab) => {
        const Icon = iconOf(tab);
        const active = tab.key === activeKey;
        if (renaming === tab.key) {
          return (
            <TextField key={tab.key} className="view-tab-rename" aria-label={t("View name")} value={draft} maxLength={VIEW_NAME_MAX} autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => finishRename(tab, true)}
              onKeyDown={(event) => { if (isEnterKey(event)) finishRename(tab, true); else if (isEscapeKey(event)) finishRename(tab, false); }} />
          );
        }
        return (
          <Tab
            key={tab.key}
            ref={active ? activeRef : undefined}
            selected={active}
            tapTarget={false}
            className={classNames("view-tab", active && "view-tab--active", overKey === tab.key && dragKey !== tab.key && "view-tab--drop", (dragKey === tab.key || liftedKey === tab.key) && "view-tab--dragging", liftedKey === tab.key && "view-tab--lifted")}
            data-tab-key={tab.key}
            draggable={!actions.busy && !touchPress}
            title={tab.inheritedName !== null ? t("via #{name}", { name: tab.inheritedName }) : undefined}
            onClick={() => onSelect(tab.key)}
            onDoubleClick={() => { if (tab.editable && tab.kind !== "content") startRename(tab); }}
            onContextMenu={(event) => { if (touchGuard.swallow(event)) return; event.preventDefault(); openMenu(tab, event.clientX, event.clientY); }}
            onKeyDown={(event) => onKeyDown(event, tab)}
            onPointerDown={(event) => onPointerDown(event, tab)}
            onDragStart={(event) => { if (touchPress) { event.preventDefault(); return; } setDragKey(tab.key); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.key);
              // Dragged out of the row to the right half it opens beside (lib/splitViewStore); inside the row it only reorders.
              splitDrag.begin({ kind: "note", id: owner.id, tab: tab.key }, "tab"); }}
            onDragOver={(event) => { if (dragKey && !isFixedFirstTab(tab)) { event.preventDefault(); setOverKey(tab.key); } }}
            onDrop={(event) => { event.preventDefault(); dropOn(tabs.find((candidate) => candidate.key === dragKey), tab); }}
            onDragEnd={() => { setDragKey(null); setOverKey(null); splitDrag.cancel(); }}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="view-tab-name">{tab.name}</span>
            {tab.inheritedName !== null && <span className="view-tab-via">{t("via #{name}", { name: tab.inheritedName })}</span>}
          </Tab>
        );
      })}
      </TabList>
      {canManage && (
        <AddViewButton ownerId={owner.id} tabs={tabs} actions={actions} fields={fields} ownerKind={owner.kind} onSelect={onSelect} onEditFields={onEditFields} />
      )}
      {menu && (
        <Menu popover={tabMenu} label={t("Tab options")}>
          {canSplitHere && <MenuItem onSelect={() => requestSplitOpen({ kind: "note", id: owner.id, tab: menu.tab.key }, "right")}>{t("Open on the right")}</MenuItem>}
          {menu.tab.editable && (
            <>
          {/* 「內容」 keeps its name: 「＋」, the question and the removal all call it that. */}
          {menu.tab.kind !== "content" && <MenuItem onSelect={() => startRename(menu.tab)}>{t("Rename")}</MenuItem>}
          <MenuItem disabled={menuIndex <= 0} onSelect={() => void actions.move(menu.tab, menuIndex - 1)}>{t("Move left")}</MenuItem>
          <MenuItem disabled={menuIndex < 0 || menuIndex >= movable.length - 1} onSelect={() => void actions.move(menu.tab, menuIndex + 1)}>{t("Move right")}</MenuItem>
          {menu.tab.kind === "view" && (
            <MenuItem onSelect={() => {
              const { tab } = menu;
              void actions.duplicate(tab).then((id) => { if (id) { requestViewSettings(id); onSelect(id); } });
            }}>{t("Make a variation…")}</MenuItem>
          )}
            </>
          )}
          {canRemove(menu.tab) && (
            <>
          {(menu.tab.editable || canSplitHere) && <MenuSeparator />}
          <MenuItem danger onSelect={() => {
            const { tab } = menu;
            // The open tab is left once the removal is confirmed, before it is written: for the tab the page then opens on.
            void actions.remove(tab, () => { if (tab.key === activeKey) onSelect(defaultTabKey(tabs.filter((other) => other.key !== tab.key))); });
          }}>{menu.tab.kind === "view" ? t("Delete view") : t("Remove tab")}</MenuItem>
            </>
          )}
        </Menu>
      )}
    </div>
  );
}

