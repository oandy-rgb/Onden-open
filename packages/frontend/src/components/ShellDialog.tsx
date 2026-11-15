import type { ReactNode } from "react";
import { Modal, Sheet } from "./ui";
import "./ShellDialog.css";

/** A ui/Modal with the shell's card: the account and More sheets, the
 *  first-run feature picker, the module dialogs. Keep dismissal blocked
 *  (`busy`) while an operation owns the screen.
 *  `sheet`: a bottom sheet on a phone (ui/Sheet); above the phone breakpoint a
 *  centred card, or with "bottom" docked to the bottom edge there too. */
export default function ShellDialog({ label, className, busy = false, sheet, onClose, children }: {
  label: string; className: string; busy?: boolean; sheet?: true | "bottom"; onClose: () => void; children: ReactNode;
}) {
  if (sheet) {
    return (
      <Sheet label={label} className="shell-dialog-layer" cardClassName={`shell-dialog ${className}`} desktop={sheet === "bottom" ? "bottom" : "center"} busy={busy} onClose={onClose}>
        <div className="shell-dialog-content">{children}</div>
      </Sheet>
    );
  }
  return (
    <Modal label={label} className="shell-dialog-layer" busy={busy} onClose={onClose}>
      <div className={`shell-dialog ${className}`}>
        <div className="shell-dialog-content">{children}</div>
      </div>
    </Modal>
  );
}
