import { ArrowDown, ArrowUp, GripVertical, Lock, MinusCircle, MoreHorizontal, Plus, PlusCircle } from "lucide-react";
import { Fragment, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useShellNavigation } from "../hooks/useShellNavigation";
import { moveDestination, PHONE_PIN_LIMIT, splitAroundCapture } from "../lib/navLayout";
import { useT } from "../lib/i18n";
import { classNames } from "../lib/utils";
import { Button, Modal, Pressable } from "./ui";
import { groupDestinations, type NavDestination } from "../hooks/shellNavigation";
import "./NavLayoutEditor.css";
import { elementAtPoint } from "../lib/documentAccess";
import { capturePointer } from "../lib/pointerDrag";

// Nav editing: NavEditor and NavBarPreview (Settings › 導覽列, the only editing
// screen; the phone's 更多 › 編輯 opens it) and the full-bar swap question the
// phone's pin menus also ask. The long press that opens a pin menu is hooks/useLongPress.

/** Drag a row by its handle; rows carry `data-reorder-index` (their place in
 *  the drawn list). Drops call `onDrop(id, index)`: before the row at
 *  `index`, as lib/navLayout placeDestination counts. */
export function useDragReorder(onDrop: (id: string, index: number) => void, onTap: (id: string) => void) {
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  // A press that never left its row is a tap (click follows pointerup), not a drop.
  const moved = useRef(false);
  const overFrom = (event: PointerEvent): number | null => {
    const row = elementAtPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-reorder-index]");
    if (!row) return null;
    const box = row.getBoundingClientRect();
    return Number(row.dataset.reorderIndex) + (event.clientY > box.top + box.height / 2 ? 1 : 0);
  };
  const handle = (id: string, index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      capturePointer(event.currentTarget, event.pointerId);
      moved.current = false;
      setDrag({ id, over: index });
    },
    onPointerMove: (event: PointerEvent) => {
      if (drag?.id !== id) return;
      const over = overFrom(event);
      if (over !== null && over !== drag.over) { moved.current = true; setDrag({ id, over }); }
    },
    onPointerUp: () => { if (drag?.id === id) { setDrag(null); if (moved.current) onDrop(id, drag.over); } },
    onPointerCancel: () => setDrag(null),
    onClick: () => { if (!moved.current) onTap(id); moved.current = false; },
  });
  return { drag, handle };
}

/** The shell the editor describes: the phone's bottom bar or the desktop's top
 *  bar (hooks/useIsMobile decides, as the app does). On the desktop, `folded`
 *  are the entries its bar folds into 「更多 ▾」 at the preview's width
 *  (AppNavigation `onFoldedChange`), so the list says what the preview shows. */
export type NavEditorShell = { shell: "phone" } | { shell: "desktop"; folded: readonly string[] };

/** The one nav editor (Settings › 導覽列): an
 *  ordered 「導覽列」 list and 「在「更多」裡」, moved between with ⊖ / ⊕. On the
 *  phone it shows the first `layout.phone` rows (at most PHONE_PIN_LIMIT); rows
 *  after that are marked 「電腦才顯示」. On the desktop every row is in the bar
 *  except those folded into 「更多 ▾」, marked 「在更多裡」, and 更多 closes the
 *  bar where it has something to hold. Reordering: drag the handle, or
 *  tap / focus the handle to show 上移 / 下移 on that row (arrow keys on the
 *  handle work too). Every change is saved at once; 「恢復預設」 goes back to the
 *  layout from before pins. */
export function NavEditor(shellState: NavEditorShell = { shell: "phone" }) {
  const t = useT();
  const nav = useShellNavigation();
  const { layout, pinned } = nav;
  const [selected, setSelected] = useState<string | null>(null);
  const last = pinned.length - 1;
  const canMove = (id: string, delta: -1 | 1) => moveDestination(layout, id, delta) !== layout;
  const desktop = shellState.shell === "desktop";
  // placeDestination counts the phone's cut as a row. The phone draws it (更多), so its rows are
  // numbered as placeDestination counts them and a drop on either side of 更多 is told apart. The
  // desktop does not draw the cut: a drop up to its place joins the bar, any later one stays after it.
  const rowOf = (index: number) => !desktop && index >= layout.phone ? index + 1 : index;
  const place = (id: string, row: number) => nav.place(id, !desktop || row <= layout.phone ? row : row + 1);
  // Room in the phone's bar: ⊕ joins it; otherwise it goes to the end of the list.
  const add = (id: string) => { nav.pin(id, layout.phone < PHONE_PIN_LIMIT ? "phone" : "desktop"); setSelected(id); };
  const { drag, handle } = useDragReorder(place, (id) => setSelected((current) => current === id ? null : id));
  const keys = (id: string) => (event: KeyboardEvent) => {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    if (canMove(id, delta)) nav.move(id, delta);
  };
  const folded = new Set(shellState.shell === "desktop" ? shellState.folded : []);
  // 更多 is drawn where the shell's bar has it: the phone's after its share (before
  // the 「電腦才顯示」 rows), the desktop's at the end — and only if it holds
  // something (folded or unpinned entries), as AppNavigation draws it.
  const moreAt = desktop ? pinned.length : Math.min(layout.phone, pinned.length);
  const showMore = !desktop || folded.size > 0 || nav.unpinned.length > 0;
  const moreRow = !showMore ? null : (
    <li className={classNames("nav-reorder-row nav-reorder-row--fixed", !desktop && drag && drag.over === layout.phone && "is-drop-target")}
      data-destination="more" data-reorder-index={desktop ? undefined : layout.phone}>
      <span className="nav-reorder-handle" aria-hidden="true"><Lock size={14} /></span>
      <MoreHorizontal size={18} aria-hidden="true" className="nav-reorder-icon" />
      <span className="nav-reorder-label">{t("More")}</span>
    </li>
  );
  return (
    <div className="nav-editor" data-testid="nav-settings">
      <h4 className="nav-settings-heading">{t("Navigation bar")}</h4>
      <ul className="nav-reorder-list" aria-label={t("Navigation bar")}>
        <li className="nav-reorder-row nav-reorder-row--fixed" data-destination={nav.notes.id}>
          <span className="nav-reorder-handle" aria-hidden="true"><Lock size={14} /></span>
          <nav.notes.Icon size={18} aria-hidden="true" className="nav-reorder-icon" />
          <span className="nav-reorder-label">{t(nav.notes.label)}</span>
        </li>
        {pinned.map((destination, index) => {
          const { id, label, Icon } = destination;
          const open = selected === id;
          return (
            <Fragment key={id}>
            {index === moreAt && moreRow}
            <li data-reorder-index={rowOf(index)} data-destination={id}
              className={classNames("nav-reorder-row", drag?.id === id && "is-dragging", drag && drag.over === rowOf(index) && drag.id !== id && "is-drop-target")}>
              <Pressable type="button" className="nav-reorder-handle" aria-label={t("Reorder “{name}”", { name: t(label) })} aria-expanded={open}
                title={t("Drag, or use the arrow keys")} {...handle(id, rowOf(index))} onKeyDown={keys(id)}>
                <GripVertical size={16} aria-hidden="true" />
              </Pressable>
              <Icon size={18} aria-hidden="true" className="nav-reorder-icon" />
              <span className="nav-reorder-label">{t(label)}</span>
              {desktop
                ? folded.has(id) && <span className="nav-reorder-note">{t("In More menu")}</span>
                : index >= layout.phone && <span className="nav-reorder-note">{t("Computer only")}</span>}
              <span className="nav-reorder-actions">
                {open && <>
                  <Button variant="icon" size="sm" aria-label={t("Move “{name}” up", { name: t(label) })}
                    disabled={index === 0 || !canMove(id, -1)} onClick={() => nav.move(id, -1)}><ArrowUp size={14} /></Button>
                  <Button variant="icon" size="sm" aria-label={t("Move “{name}” down", { name: t(label) })}
                    disabled={index === last || !canMove(id, 1)} onClick={() => nav.move(id, 1)}><ArrowDown size={14} /></Button>
                </>}
                <Button variant="icon" size="sm" aria-label={t("Remove “{name}” from the navigation bar", { name: t(label) })}
                  onClick={() => nav.unpin(id, "desktop")}><MinusCircle size={16} /></Button>
              </span>
            </li>
            </Fragment>
          );
        })}
        {moreAt === pinned.length && moreRow}
        {drag && <li className={classNames("nav-reorder-end", drag.over === rowOf(pinned.length) && "is-drop-target")} data-reorder-index={rowOf(pinned.length)} aria-hidden="true" />}
      </ul>
      {nav.unpinned.length > 0 && <>
        <h4 className="nav-settings-heading">{t("In More")}</h4>
        {groupDestinations(nav.unpinned).map((group) => (
          <Fragment key={group.id}>
            <h5 className="nav-settings-subheading">{t(group.label)}</h5>
            <ul className="nav-reorder-list" aria-label={t(group.label)}>
              {group.destinations.map(({ id, label, Icon }) => (
                <li key={id} className="nav-reorder-row" data-destination={id}>
                  <span className="nav-reorder-handle" aria-hidden="true" />
                  <Icon size={18} aria-hidden="true" className="nav-reorder-icon" />
                  <span className="nav-reorder-label">{t(label)}</span>
                  <span className="nav-reorder-actions">
                    <Button variant="icon" size="sm" aria-label={t("Pin “{name}” to the navigation bar", { name: t(label) })}
                      onClick={() => add(id)}><PlusCircle size={16} /></Button>
                  </span>
                </li>
              ))}
            </ul>
          </Fragment>
        ))}
      </>}
      <div className="nav-editor-actions">
        <Button disabled={nav.isDefault} onClick={nav.reset}>{t("Reset")}</Button>
      </div>
    </div>
  );
}

/** The navigation bar as the phone draws it (MobileNav): 筆記 and the pinned
 *  entries the bar has room for, the central ＋ capture where the bar puts it
 *  (lib/navLayout splitAroundCapture), then 更多. ＋ and 更多 are the bar's own:
 *  not buttons, not editable. Only what the phone's bar holds is drawn: the
 *  entries past its share are the list's 「電腦才顯示」 rows. Settings › 導覽列 puts it above
 *  the lists so a change is seen where it lands. */
export function NavBarPreview() {
  const t = useT();
  const { notes, phoneBar } = useShellNavigation();
  const { left, right } = splitAroundCapture([notes, ...phoneBar]);
  const slot = ({ id, label, Icon }: NavDestination) => (
    <li key={id} className="nav-bar-preview-slot" data-destination={id}>
      <Icon size={20} aria-hidden="true" /><span>{t(label)}</span>
    </li>
  );
  return (
    <ul className="nav-bar-preview" aria-hidden="true">
      {left.map((destination) => slot(destination))}
      <li className="nav-bar-preview-slot nav-bar-preview-capture" data-destination="capture"><span className="nav-bar-preview-plus"><Plus size={16} /></span></li>
      {right.map((destination) => slot(destination))}
      <li className="nav-bar-preview-slot" data-destination="more"><MoreHorizontal size={20} /><span>{t("More")}</span></li>
    </ul>
  );
}

/** 「導覽列已滿，要換掉哪一個？」: the bar's entries to give up for `incoming`. */
export function NavSwapDialog({ incoming, bar, onSwap, onCancel }: {
  incoming: NavDestination;
  bar: readonly NavDestination[];
  onSwap: (out: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal label={t("The navigation bar is full. Which one should it replace?")} className="nav-swap-layer" onClose={onCancel}>
      <div className="nav-swap-card" data-incoming={incoming.id}>
        <h2 className="nav-swap-title">{t("The navigation bar is full. Which one should it replace?")}</h2>
        <p className="nav-swap-hint">{t("“{name}” takes its place; the one you pick moves to More.", { name: t(incoming.label) })}</p>
        <ul className="nav-swap-options">
          {bar.map(({ id, label, Icon }) => (
            <li key={id}>
              <Pressable type="button" className="nav-swap-option" data-destination={id} onClick={() => onSwap(id)}>
                <Icon size={18} aria-hidden="true" /><span>{t(label)}</span>
              </Pressable>
            </li>
          ))}
        </ul>
        <div className="nav-swap-actions"><Button onClick={onCancel}>{t("Cancel")}</Button></div>
      </div>
    </Modal>
  );
}
