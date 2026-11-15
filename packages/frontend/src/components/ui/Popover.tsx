import { createContext, useContext, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { floatingHost } from "./surfaceHost";
import type { PopoverState } from "./usePopover";
import { SheetHandle } from "./SheetHandle";
import "./ui.css";
import { isImeComposing } from "../../lib/keys";

// The floating surfaces every menu and popover renders through. Behaviour
// (placement, Esc, outside press, focus) lives in usePopover; these only draw.
//
//   const pop = usePopover({ open, onClose: () => setOpen(false) });
//   <button ref={pop.anchor} aria-haspopup="menu" aria-expanded={open} …/>
//   {open && <Menu popover={pop} label={t("Sort")}>
//     <MenuItem onSelect={…}>…</MenuItem>
//   </Menu>}

type SurfaceProps = {
  popover: PopoverState<HTMLElement>;
  /** Accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
};

/** A floating panel that is not a list of commands: a form, a picker, a share sheet.
 *  `sheet`: the phone layout, as for Menu. */
export function Popover({ popover, label, className, role = "dialog", sheet, children }: SurfaceProps & { role?: "dialog" | "group" | "toolbar" | "status"; sheet?: boolean }) {
  return createPortal(
    <>
      {sheet && <div className="ui-sheet-backdrop" aria-hidden="true" />}
      <div ref={popover.popup} style={{ "--popover-x": `${popover.position.left}px`, "--popover-y": `${popover.position.top}px`, "--popover-room": popover.position.room } as CSSProperties} tabIndex={-1} onKeyDown={popover.onKeyDown} onPointerDown={popover.onPointerDown} onMouseDown={popover.onMouseDown}
        className={classNames("ui-popover", sheet && "ui-menu--sheet", className)} role={role} aria-label={label}>
        {sheet && <SheetHandle onClose={popover.close} />}
        {children}
      </div>
    </>,
    floatingHost(),
  );
}

const MenuClose = createContext<() => void>(() => {});

type MenuProps = SurfaceProps & {
  /** Phone layout: slides up from the bottom edge with a grab handle and a
   *  dimmed page, instead of floating at the trigger. Esc, outside press and
   *  arrow keys are the same. Content is the caller's (rows, a tile grid). */
  sheet?: boolean;
};

/** A list of commands. Items close it after running unless told otherwise. */
export function Menu({ popover, label, className, sheet, children }: MenuProps) {
  return createPortal(
    <MenuClose.Provider value={popover.close}>
      {sheet && <div className="ui-sheet-backdrop" aria-hidden="true" />}
      <div ref={popover.popup} style={{ "--popover-x": `${popover.position.left}px`, "--popover-y": `${popover.position.top}px`, "--popover-room": popover.position.room } as CSSProperties} tabIndex={-1} onPointerDown={popover.onPointerDown} onMouseDown={popover.onMouseDown}
        // Tab leaves a menu (WAI-ARIA menu pattern): close it and let focus move on from the trigger.
        onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Tab") popover.close(); else popover.onKeyDown(event); }}
        className={classNames("ui-popover ui-menu", sheet && "ui-menu--sheet", className)} role="menu" aria-label={label}>
        {sheet && <SheetHandle onClose={popover.close} />}
        {children}
      </div>
    </MenuClose.Provider>,
    floatingHost(),
  );
}

type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect" | "role"> & {
  onSelect: () => void;
  /** Destructive: red, and kept in its own section by the caller. */
  danger?: boolean;
  /** One of a set of choices (sort order, arrow type); shows which is current. */
  checked?: boolean;
  /** Leave the menu open after running (a toggle, a submenu, a busy action). */
  keepOpen?: boolean;
};

export function MenuItem({ onSelect, danger, checked, keepOpen, className, children, ...rest }: MenuItemProps) {
  const close = useContext(MenuClose);
  return (
    <button type="button" {...rest}
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={classNames("ui-menu-item", danger && "ui-menu-item--danger", checked && "ui-menu-item--checked", className)}
      onClick={() => { onSelect(); if (!keepOpen) close(); }}>
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />;
}

/** A small heading above a group of items. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="ui-menu-label">{children}</div>;
}

/** The title row with a close button; touch screens have no Esc. */
export function MenuHeading({ children }: { children: ReactNode }) {
  const t = useT();
  const close = useContext(MenuClose);
  return (
    <div className="ui-menu-heading">
      <span>{children}</span>
      <button type="button" aria-label={t("Close")} onClick={close}><X size={16} /></button>
    </div>
  );
}
