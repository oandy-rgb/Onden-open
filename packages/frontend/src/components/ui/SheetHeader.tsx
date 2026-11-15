import type { ReactNode } from "react";
import { classNames } from "../../lib/utils";
import { CloseButton } from "./CloseButton";
import "./ui.css";

/**
 * The header row of a bottom sheet or dialog: the title at the left, then the text actions
 * (「編輯」…) and the ✕ at the right. The row owns the controls' size and look, so an action and
 * the ✕ are always the same height and frame (38px, 44px where the pointer is a finger) and the
 * title is centred against them. A caller never sets `size` on an action; `ui-owners.guard.test.ts`
 * checks that, and that `CloseButton` appears only here and in PanelHeader.
 *
 *   <SheetHeader title={t("More")} onClose={close}
 *     actions={<Button variant="ghost" onClick={edit}>{t("Edit")}</Button>} />
 */
export function SheetHeader({ title, actions, onClose, closeDisabled, className }: {
  title: ReactNode;
  /** Text buttons (`Button variant="ghost"`) shown before the ✕. */
  actions?: ReactNode;
  onClose: () => void;
  /** The ✕ is off while the dialog is busy; the sheet keeps its layout. */
  closeDisabled?: boolean;
  className?: string;
}) {
  return (
    <header className={classNames("ui-sheet-header", className)}>
      <h2 className="ui-sheet-header__title">{title}</h2>
      <div className="ui-sheet-header__actions">
        {actions}
        <CloseButton disabled={closeDisabled} onClick={onClose} />
      </div>
    </header>
  );
}
