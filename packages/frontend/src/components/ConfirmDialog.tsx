// ConfirmDialog — the ONE in-app replacement for window.confirm()/alert().
//
// Imperative on purpose: the natives it replaces are called from plain event
// handlers across a dozen components, and threading per-host dialog state
// through each of them would be invasive for zero UX gain. confirmDialog()
// mounts its own React root on a body-level host, resolves with the user's
// answer, and unmounts — modal and one-shot, exactly like the natives.
//
// Visual language follows RestorePreviewModal (backdrop + surface card +
// footer buttons) so it reads as part of the same family.

import { useRef } from "react";
import { createRoot } from "react-dom/client";
import "./ConfirmDialog.css";
import { Button, Modal } from "./ui";
import { t } from "../lib/i18n";
import { appendToBody, createElement, hasDocument } from "../lib/documentAccess";

export type ConfirmDialogOptions = {
  /** Optional heading above the message. */
  title?: string;
  confirmLabel?: string;
  /** null = no cancel button (alert-style acknowledgement). */
  cancelLabel?: string | null;
  /** Tint the confirm button for destructive actions. */
  danger?: boolean;
};

type DialogProps = ConfirmDialogOptions & {
  message: string;
  onResolve: (confirmed: boolean) => void;
};

function ConfirmDialogView({ message, title, confirmLabel = t("OK"), cancelLabel = t("Cancel"), danger = false, onResolve }: DialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Parity with window.confirm: the affirmative button starts focused (Enter
  // confirms); Escape and a press outside cancel. A ui/Modal stacks above any
  // other modal it is opened from (Settings, imports).
  return (
    <Modal label={title ?? message} role="alertdialog" className="confirm-dialog-backdrop" onClose={() => onResolve(false)} initialFocus={confirmRef}>
      <div className="confirm-dialog">
        {title && <h3 className="confirm-dialog-title">{title}</h3>}
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          {cancelLabel !== null && (
            <Button type="button" variant="secondary" onClick={() => onResolve(false)}>
              {cancelLabel}
            </Button>
          )}
          <Button
            ref={confirmRef}
            type="button"
            variant={danger ? "danger" : "primary"}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Drop-in async replacement for window.confirm(). Resolves true on confirm,
 *  false on cancel / Escape / backdrop click. */
export function confirmDialog(message: string, opts: ConfirmDialogOptions = {}): Promise<boolean> {
  if (!hasDocument()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const host = createElement("div");
    const removeHost = appendToBody(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      // Unmount on the next tick — a synchronous unmount from inside the
      // dialog's own click handler would tear the root down mid-render.
      setTimeout(() => { root.unmount(); removeHost(); }, 0);
      resolve(confirmed);
    };
    root.render(<ConfirmDialogView message={message} {...opts} onResolve={finish} />);
  });
}

/** Drop-in async replacement for window.alert() — one OK button. */
export async function alertDialog(message: string, opts: Omit<ConfirmDialogOptions, "cancelLabel"> = {}): Promise<void> {
  await confirmDialog(message, { ...opts, cancelLabel: null });
}
